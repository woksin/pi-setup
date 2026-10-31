"""Per-user host-wide, cooperative phase leases. POSIX flock and process groups required.

Only the child's own process group is signalled. Lock FDs stay in the supervisor;
metadata guards against orphaned producers and authenticated nested phases.
"""
import argparse
from collections import deque, namedtuple
from datetime import datetime, timezone, timedelta
import errno
import fcntl
import fnmatch
import hashlib
from itertools import chain
import json
import math
import os
from pathlib import Path
import signal
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import random
import re
import time
import uuid

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
CONFIG = ROOT / "config.json"
HEARTBEAT = 5.0
TICK = 0.2
# Queued waiters re-scan less often: each scan runs `ps -A`, and dozens of waiters at TICK
# saturated the CPU with system time (2026-10-19: 45 waiters, 47% sys).
QUEUE_TICK = 2.0
# Cleanup must tolerate transient ps failures under load without releasing unknown groups.
CLEANUP_PROBE_TIMEOUTS = (2, 5, 10)
# Memory ceilings while a phase runs (woksin/pi-setup#3): sample the whole process tree this often.
MEMORY_SAMPLE_INTERVAL = 15.0
SWAP_WARN_INTERVAL = 300.0
DEFAULT_MIN_SWAP_FREE_MB = 2048
# macOS grows swap on demand, so "free swap" is always small and never signals pressure (false alarms,
# 2026-10-22). There the swap floor is not enforced; memory pressure is judged by min_free_percent
# (memory_pressure -Q, the same figure as kern.memorystatus_level). Elsewhere (Linux) the floor applies.
SWAP_FLOOR_ENFORCED = sys.platform != "darwin"
LEVEL_WARN_PERCENT = 15
# Distinct exit status: a descendant exceeded rss_cap_mb and the phase's process group was killed.
EXIT_RSS_CAP = 76
EXIT_WITHDRAWN = 77
# Consecutive over-cap samples (same pid + start time) before the kill: ~45 s at the 15 s interval, so a
# transient spike never kills a phase.
OVER_CAP_SAMPLES = 3


def note(message):
    print(f"pi-phase: {message}", flush=True)


KINDS = ("build", "test", "integration", "ci")
POLICIES = ("direct", "fast", "queued")
OUTCOMES = ("passed", "failed", "queue-timeout", "timeout", "cancelled", "rejected", "error", "skipped", "withdrawn")


def stack_name(value):
    if not re.fullmatch(r"[a-z0-9-]{1,20}", value):
        raise argparse.ArgumentTypeError("stack must match ^[a-z0-9-]{1,20}$")
    return value


def unwrap_command(command, stop_at_shell=False):
    """Best effort only: strip env/nice/bash -c wrappers, never evaluate shell code.

    Returns the inner argv, or None when the invocation cannot be unwrapped safely."""
    command = list(command)
    for _ in range(20):
        if not command:
            return None
        name = Path(command[0]).name
        if name == "env":
            index = 1
            while index < len(command):
                arg = command[index]
                if arg == "--":
                    index += 1
                    break
                if arg in ("-i", "--ignore-environment") or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", arg):
                    index += 1
                elif arg in ("-u", "--unset") and index + 1 < len(command):
                    index += 2
                elif arg.startswith("--unset="):
                    index += 1
                elif arg.startswith("-"):
                    return None
                else:
                    break
            command = command[index:]
        elif name == "nice":
            index = 1
            if index < len(command) and command[index] in ("-n", "--adjustment"):
                index += 2
            elif index < len(command) and (re.fullmatch(r"-\d+", command[index])
                                          or command[index].startswith("--adjustment=")):
                index += 1
            if index < len(command) and command[index] == "--":
                index += 1
            command = command[index:]
        elif name in ("bash", "sh") and len(command) >= 3 and command[1] == "-c":
            if stop_at_shell:
                return command
            try:
                lexer = shlex.shlex(command[2], posix=True, punctuation_chars=";&|<>()")
                lexer.whitespace_split = True
                command = list(lexer)
            except ValueError:
                return None
            if any(arg and all(c in ";&|<>()" for c in arg) for arg in command):
                return None
        else:
            return command
    return None


SPEC_EXECUTABLE = re.compile(r".+\.(Specs|Tests)(\.exe)?$")


def is_spec_executable(argument):
    return SPEC_EXECUTABLE.fullmatch(Path(argument).name) is not None


def tool_stack(name):
    """Stack of a known tool name, or None."""
    if name == "dotnet":
        return "dotnet"
    if name in ("node", "npm", "npx", "yarn", "pnpm", "corepack", "tsc", "tsgo", "vite",
                "vitest", "jest", "playwright", "eslint", "prettier", "turbo", "nx"):
        return "node"
    if name in ("python", "python3", "pytest"):
        return "python"
    if name in ("docker", "docker-compose"):
        return "docker"
    return {"cargo": "rust", "go": "go"}.get(name)


def command_stack(command):
    """Best effort only: unwrap simple invocations, never evaluate shell code."""
    command = unwrap_command(command)
    if not command:
        return "other"
    # Built xUnit v3 / Specifications executables run as their own process; they are dotnet work.
    return tool_stack(Path(command[0]).name) or ("dotnet" if is_spec_executable(command[0]) else "other")


def utc_stamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def env_hash():
    """Hash selected build inputs without storing environment values (or secret names)."""
    names = r"^(PI_PHASE_|DOTNET_|NUGET_|MSBUILD|NODE_|NPM_|YARN_|VITE_|CONFIGURATION$|ASPNETCORE_|CI$)"
    pairs = sorted(f"{name}={value}" for name, value in os.environ.items()
                   if re.match(names, name) and not re.search(r"TOKEN|SECRET|PASSWORD|KEY", name, re.I))
    return hashlib.sha256(os.fsencode("\0".join(pairs))).hexdigest()


def untracked_state(cwd, paths, max_files, max_bytes):
    """Frame sorted paths and content digests; called in a deadline-bounded subprocess."""
    if len(paths) > max_files:
        raise ValueError("too many untracked files")
    payload = bytearray()
    total = 0
    for path in sorted(paths):
        fd = os.open(os.path.join(os.fsencode(cwd), path), os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode) or total + before.st_size > max_bytes:
                raise ValueError("untracked file cannot be hashed within bounds")
            digest = hashlib.sha256()
            while chunk := stream.read(min(1024 * 1024, max_bytes - total + 1)):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("too many untracked bytes")
                digest.update(chunk)
            after = os.fstat(stream.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("untracked file changed while hashing")
        payload.extend(path + b"\0" + digest.digest())
    return bytes(payload)


def git_state(cwd, timeout=None):
    """Capture code without optional index writes, filenames or diffs in the ledger."""
    head = dirty = None
    if cwd is None:
        return head, dirty
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    deadline = time.monotonic() + timeout if timeout is not None else None

    def budget(default):
        remaining = default if deadline is None else min(default, deadline - time.monotonic())
        if remaining <= 0:
            raise subprocess.TimeoutExpired("git", timeout)
        return remaining

    try:
        head = subprocess.run(["git", "--no-optional-locks", "rev-parse", "HEAD"], cwd=cwd, env=environment, capture_output=True,
                              text=True, check=True, timeout=budget(2)).stdout.strip()
    except subprocess.TimeoutExpired:
        return head, None
    except (OSError, subprocess.SubprocessError):
        pass
    dirty_deadline = time.monotonic() + 5
    try:
        status = subprocess.run(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
                                cwd=cwd, env=environment, capture_output=True, check=True, timeout=budget(5)).stdout
        if not status:
            dirty = "clean"
        else:
            diff = subprocess.run(["git", "--no-optional-locks", "diff", "HEAD", "--binary"], cwd=cwd,
                                  env=environment, capture_output=True, check=True,
                                  timeout=budget(dirty_deadline - time.monotonic())).stdout
            paths = subprocess.run(["git", "--no-optional-locks", "ls-files", "-o", "--exclude-standard", "-z"],
                                   cwd=cwd, env=environment, capture_output=True, check=True,
                                   timeout=budget(dirty_deadline - time.monotonic())).stdout.split(b"\0")[:-1]
            if len(paths) > 2000:
                return head, None
            contents = b""
            if paths:
                # File opens/reads can block even on a regular file. Kill this helper on the
                # remaining snapshot deadline rather than leaving a reader thread behind.
                script = ("import sys;sys.path.insert(0,sys.argv[1]);from pi_phase import untracked_state;"
                          "sys.stdout.buffer.write(untracked_state('.',sys.stdin.buffer.read().split(b'\\0')[:-1],2000,200_000_000))")
                contents = subprocess.run([sys.executable, "-B", "-c", script, str(ROOT)], cwd=cwd,
                                          input=b"\0".join(paths) + b"\0", capture_output=True, check=True,
                                          timeout=budget(dirty_deadline - time.monotonic())).stdout
            budget(1)
            dirty = hashlib.sha256(status + diff + contents).hexdigest()
        budget(1)
    except (OSError, subprocess.SubprocessError):
        dirty = None
    return head, dirty


def append_ledger(state, record):
    """One bounded append; a broken ledger must never change a phase result."""
    try:
        directory = state / "ledger"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        payload = (json.dumps(record, separators=(",", ":")) + "\n").encode()
        # Environment values and even rejected labels can be arbitrarily large. Bound only
        # descriptive strings, retaining hashes, times and measurements in their entirety.
        while len(payload) >= 4096:
            key = max(("session", "lane", "cwd", "label", "priority"),
                      key=lambda k: len(json.dumps(record[k])))
            record[key] = record[key][:len(record[key]) // 2]
            payload = (json.dumps(record, separators=(",", ":")) + "\n").encode()
        fd = os.open(directory / (record["ts"][:10] + ".jsonl"),
                     os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            if os.write(fd, payload) != len(payload):
                raise OSError("short ledger write")
        finally:
            os.close(fd)
        cutoff = datetime.now(timezone.utc).date() - timedelta(days=60)
        for path in directory.glob("????-??-??.jsonl"):
            try:
                day = datetime.strptime(path.stem, "%Y-%m-%d").date()
            except ValueError:
                continue
            if day < cutoff:
                path.unlink(missing_ok=True)
    except Exception as exc:
        try:
            print(f"pi-phase: ledger write failed: {exc}", file=sys.stderr, flush=True)
        except OSError:
            pass  # Even a full/broken stderr must not change the phase's exit.


WAIT_REASONS = ("slots", "order", "memory", "other")  # "cpu" (cpu_budget enforce) is added to the output lazily.


def would_hold_kind(scan):
    """'host' or 'cpu' when an observe-mode check would have held this scan (scan['wouldHold'] = '<kind>:<why>')."""
    kind = str(scan.get("wouldHold") or "").split(":", 1)[0]
    return kind if kind in ("host", "cpu") else None


class WaitTelemetry:
    """In-process samples only; optional diagnostics must never affect admission."""

    def __init__(self, start, clock=time.monotonic):
        self.clock = clock
        self.seconds = dict.fromkeys(WAIT_REASONS, 0.0)
        self.scans = dict.fromkeys(WAIT_REASONS, 0)
        self.current, self.at, self.closed = "other", start, False
        self.load_sum, self.load_max, self.load_count = 0.0, None, 0
        self.mem_free_min = None
        self.busy = {}
        self.would, self.would_seconds = None, {}

    def record(self, scan):
        try:
            if self.closed:
                return
            reason = scan.get("reason", "other")
            now = self.clock()
            self.seconds[self.current] = self.seconds.get(self.current, 0.0) + now - self.at
            self.credit_would_hold(now - self.at)
            self.current, self.at = reason, now
            self.scans[reason] = self.scans.get(reason, 0) + 1
            self.would = would_hold_kind(scan)
            self.sample_load()
            self.sample_memory(scan.get("memFree"))
            self.sample_pools(scan.get("busy", {}))
        except Exception:
            pass  # Optional telemetry must not interrupt a queued phase.

    def credit_would_hold(self, seconds):
        if self.would:
            self.would_seconds[self.would] = self.would_seconds.get(self.would, 0.0) + seconds

    def sample_load(self):
        try:
            load = os.getloadavg()[0]
            self.load_sum += load
            self.load_max = load if self.load_max is None else max(self.load_max, load)
            self.load_count += 1
        except (OSError, AttributeError):
            pass

    def sample_memory(self, free):
        if free is not None:
            self.mem_free_min = free if self.mem_free_min is None else min(self.mem_free_min, free)

    def sample_pools(self, pools):
        for pool in ("heavy", "fast", "integration"):
            if pool not in pools:
                continue
            busy, slots = pools[pool]
            sample = self.busy.setdefault(pool, dict(total=0, max=0, n=0, of=0))
            sample["total"] += busy
            sample["max"] = max(sample["max"], busy)
            sample["n"] += 1
            sample["of"] = max(sample["of"], slots)

    def close(self, end):
        try:
            if not self.closed:
                self.seconds[self.current] = self.seconds.get(self.current, 0.0) + max(0, end - self.at)
                self.credit_would_hold(max(0, end - self.at))
                self.closed = True
        except Exception:
            pass

    def fields(self):
        try:
            samples = dict(n=sum(self.scans.values()),
                           load1Mean=round(self.load_sum / self.load_count, 3) if self.load_count else None,
                           load1Max=self.load_max, cpus=os.cpu_count(), memFreeMin=self.mem_free_min)
            samples.update({pool: dict(mean=round(sample["total"] / sample["n"], 3),
                                       max=sample["max"], of=sample["of"])
                            for pool, sample in self.busy.items()})
            fields = dict(waitV=1, waitBreakdown={key: round(value, 3) for key, value in self.seconds.items()},
                          waitScans=dict(self.scans), waitSamples=samples)
            if self.would_seconds:  # Observe-mode holds only; absent when no observed pressure/budget hold.
                fields["waitWouldHold"] = {key: round(value, 3) for key, value in self.would_seconds.items()}
            return fields
        except Exception:
            return {}


FAILURE_TAIL_BYTES = 256 * 1024
FAILURE_CODE = re.compile(rb"\berror ((?:[A-Z][A-Za-z]{0,9}|xUnit)\d{3,5})\s*:")
FAILURE_RESTORE = re.compile(rb"\berror NU\d{4}\b|\bNETSDK1004\b|unable to load the service index", re.I)
FAILURE_INFRA = re.compile(
    rb"\bMSB(?:3021|3026|3027|4018|4166)\b|No space left on device|"
    rb"Cannot connect to the Docker daemon|address already in use|OutOfMemoryException", re.I)
FAILURE_SUMMARY = re.compile(
    rb"\bfailed\s*:\s*([1-9]\d*)\b|\bTests\s*:?\s*([1-9]\d*)\s+failed\b|"
    rb"\b([1-9]\d*)\s+failing\b", re.I)


def failure_match(category, tail, match, **fields):
    return {"category": category, "offset": tail.rfind(b"\n", 0, match.start()) + 1, **fields}


def classify_failure(tail: bytes, code: int, outcome: str, expect_red: bool) -> dict:
    """Classify an already bounded log tail; never determine a phase's outcome."""
    if outcome == "timeout":
        match = re.search(rb"inactivity time of .*? elapsed|hang diagnostics", tail, re.I)
        return failure_match("timeout", tail, match, detail="hang") if match else {"category": "timeout"}
    if code == 76:
        return {"category": "infrastructure", "detail": "rss-cap"}
    if code in (137, 143):
        return {"category": "infrastructure", "detail": "killed"}
    if expect_red:
        return {"category": "expected-red"}
    match = FAILURE_RESTORE.search(tail)
    if match:
        return failure_match("restore", tail, match)
    match = FAILURE_INFRA.search(tail)
    if match:
        return failure_match("infrastructure", tail, match)
    codes = list(FAILURE_CODE.finditer(tail))
    if codes:
        return failure_codes(tail, codes)
    match = FAILURE_SUMMARY.search(tail)
    if match:
        count = next(value for value in match.groups() if value is not None)
        return failure_match("assertion", tail, match, failedTests=int(count))
    match = re.search(rb"Test host process crashed", tail, re.I)
    if match:
        return failure_match("infrastructure", tail, match)
    return {"category": "unknown"}


def failure_codes(tail, codes):
    compile_prefixes = (b"CS", b"BC", b"FS", b"RZ", b"TS", b"MSB")
    category = "analyzer"
    if any(re.match(rb"[A-Za-z]+", match[1])[0] in compile_prefixes for match in codes):
        category = "compile"
    unique = list(dict.fromkeys(match[1].decode("ascii")[:12] for match in codes))[:5]
    return failure_match(category, tail, codes[0], codes=unique)


def failure_diagnostic(log, code, outcome, expect_red):
    """Read once, after completion, without external parsers or unbounded I/O."""
    if not log:
        return classify_failure(b"", code, outcome, expect_red)
    with open(log, "rb") as stream:
        stream.seek(0, os.SEEK_END)
        start = max(0, stream.tell() - FAILURE_TAIL_BYTES)
        stream.seek(start)
        tail = stream.read(FAILURE_TAIL_BYTES)
    if start:
        # The window may start mid-line. Only complete lines have a known byte offset.
        first_line = tail.find(b"\n") + 1
        start += first_line
        tail = tail[first_line:] if first_line else b""
    result = classify_failure(tail, code, outcome, expect_red)
    if "offset" in result:
        result["offset"] += start
    result["log"] = str(log)[:240]
    return result


class PhaseLedger:
    def __init__(self, args):
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        try:
            cwd = os.path.realpath(os.getcwd())
        except OSError:
            cwd = None
        self.record = dict(v=1, ts=None, session=os.environ.get("PI_SESSION_ID") or None,
                           lane=os.environ.get("PI_ORCH_ID") or os.environ.get("PI_LANE_ID") or None,
                           cwd=cwd, kind=args.kind, label=args.label, priority=args.priority,
                           policy="queued", source="default",
                           stack=getattr(args, "stack", None) or command_stack(command),
                           queuedAt=utc_stamp(), startedAt=None, endedAt=None, waitS=0, runS=0,
                           exit=None, outcome="rejected", head=None, dirty=None, verified=False, envHash=env_hash(),
                           profile=getattr(args, "profile", None) or "full",
                           argvHash=hashlib.sha256(os.fsencode("\0".join(command))).hexdigest(),
                           fingerprint=test_fingerprint(cwd, command) if cwd is not None else None)
        self.args, self.command = args, command
        self.records = []
        self.queued = time.monotonic()
        self.started = None
        self.enqueued = False
        self.wait = None
        self.running_memory = None
        self.host_pressure = None
        self.failure_categories = True
        self.snapshot_thread = None
        self.git_result = (None, None)
        self.snapshot_ready = False

    def prepare_snapshot(self):
        try:
            result = git_state(self.record["cwd"], timeout=3)
            self.record["head"], self.record["dirty"] = self.git_result = result
            self.snapshot_ready = all(value is not None for value in result)
        except Exception:
            pass  # Timeout/non-Git cwd retains the post-registration best-effort snapshot.
        self.compute_gate_key()

    def compute_gate_key(self):
        if self.snapshot_ready and self.record["kind"] != "ci":
            try:
                key = gate_key(self.record["cwd"], self.command, self.record["kind"], self.record["head"],
                               self.record["dirty"], self.record["stack"], self.record["envHash"],
                               getattr(self.args, "profile", None) or "full")
            except Exception:
                key = None  # Optional metadata; a failure only disables deduplication.
            if key:
                self.record["gateKey"] = key

    def passed_state(self, state):
        if not self.snapshot_ready or self.record["dirty"] is None:
            return None, None
        try:
            records, _ = read_ledger(state, days=14)
        except (OSError, ValueError):
            return None, None  # Unreadable history must not prevent execution.
        self.records = records
        matches = [r for r in reversed(records) if self.matches_state(r)]
        passed = next((r for r in matches if r["outcome"] == "passed" and r.get("label") == self.record["label"]), None)
        failed = next((r for r in matches if repeat_failure(r)), None)
        return passed, failed

    def cross_worktree_passed(self):
        """A verified passed build/test record of the same gateKey from any worktree (never integration or ci)."""
        key = self.record.get("gateKey")
        if not key or self.record["kind"] not in ("build", "test"):
            return None
        return next((r for r in reversed(self.records)
                     if r.get("gateKey") == key and r.get("verified") is True and r.get("outcome") == "passed"
                     and r.get("kind") == self.record["kind"]), None)

    def matches_state(self, record):
        keys = ("cwd", "kind", "argvHash", "head", "dirty", "stack", "envHash")
        return record.get("verified") is True and all(record.get(key) == self.record[key] for key in keys)

    def record_failure(self, log, code, expect_red):
        if not self.failure_categories or code == 0:
            return
        try:
            self.record["failure"] = failure_diagnostic(log, code, self.record["outcome"], expect_red)
        except Exception:
            pass  # Diagnostics must never change a phase's result.

    def enqueue(self):
        self.record["queuedAt"] = utc_stamp()
        self.queued = time.monotonic()
        self.enqueued = True
        self.wait = WaitTelemetry(self.queued)
        if self.snapshot_ready:
            return
        self.snapshot_thread = threading.Thread(target=self.snapshot, daemon=True)
        try:
            self.snapshot_thread.start()
        except RuntimeError:
            self.snapshot_thread = None  # Thread exhaustion is only missing optional metadata.

    def waited(self, scan):
        if self.wait:
            self.wait.record(scan)

    def admitted_with_would_hold(self, scan):
        kind = would_hold_kind(scan)
        if kind:
            self.record["wouldHoldAtAdmit"] = kind

    def snapshot(self):
        try:
            self.git_result = git_state(self.record["cwd"])
        except Exception:
            pass  # Optional metadata must not interrupt the phase or print a traceback.

    def start(self):
        self.record["outcome"] = "failed"
        self.record["startedAt"] = utc_stamp()
        self.started = time.monotonic()
        try:
            self.record["host"] = {"load1": round(os.getloadavg()[0], 1)}
        except (OSError, AttributeError):
            pass
        if self.host_pressure is not None:
            self.record.setdefault("host", {}).update(self.host_pressure.cached_fields())  # cache only, never probes
        self.record["waitS"] = max(0, self.started - self.queued)
        if self.wait:
            self.wait.close(self.started)

    def outcome(self, value):
        self.record["outcome"] = value

    def finish_wait(self):
        end = time.monotonic()
        self.record["waitS"] = max(0, end - self.queued)
        if self.wait:
            self.wait.close(end)

    def finish(self, state, code):
        self.record["ts"] = self.record["endedAt"] = utc_stamp()
        self.record["exit"] = code
        if self.record["outcome"] == "skipped":
            self.record["waitS"] = self.record["runS"] = 0
        elif self.started is None:
            self.finish_wait()
        else:
            self.record["runS"] = max(0, time.monotonic() - self.started)
            if self.record["outcome"] == "failed" and code == 0:
                self.record["outcome"] = "passed"
        if self.snapshot_thread is not None:
            self.snapshot_thread.join(timeout=1)
            if not self.snapshot_thread.is_alive():
                self.record["head"], self.record["dirty"] = self.git_result
        if self.started is not None:
            try:
                # main calls finish only after run's finally has released all permits.
                end = git_state(self.record["cwd"], timeout=3)
                self.record["verified"] = (self.snapshot_ready and all(value is not None for value in end)
                                           and end == self.git_result and env_hash() == self.record["envHash"])
            except Exception:
                pass  # Failed verification never changes the producer's result.
        if self.wait and self.record["outcome"] != "skipped":
            self.record.update(self.wait.fields())
        self.finish_memory()
        append_ledger(state, self.record)

    def finish_memory(self):
        if self.running_memory is not None:
            self.record.update(peakRssMb=int(self.running_memory.peak_rss_mb),
                               peakProcRssMb=int(self.running_memory.peak_proc_rss_mb))


def rejected_ledger(argv):
    """Argparse may reject before producing a Namespace; retain only known metadata."""
    if not argv or argv[0] != "run":
        return None
    options, command = [], []
    valued = {"--kind", "--label", "--priority", "--timeout", "--queue-timeout", "--repo", "--pr",
              "--commit", "--log", "--tail", "--vstest-hang-minutes", "--stack", "--policy", "--profile"}
    index = 1
    while index < len(argv):
        arg = argv[index]
        if arg == "--":
            command = argv[index + 1:]
            break
        if not arg.startswith("-"):
            command = argv[index:]
            break
        options.append(arg)
        index += 1
        if arg in valued and index < len(argv):
            options.append(argv[index])
            index += 1
    def value(name, default=None):
        for i, arg in enumerate(options):
            if arg.startswith(name + "="):
                return arg.split("=", 1)[1]
            if arg == name and i + 1 < len(options):
                return options[i + 1]
        return default
    kind = value("--kind")
    if kind not in KINDS:
        return None
    stack = value("--stack", "")
    return PhaseLedger(argparse.Namespace(kind=kind, label=value("--label", ""),
                                         priority=value("--priority", "normal"), command=command,
                                         stack=stack if re.fullmatch(r"[a-z0-9-]{1,20}", stack) else None))


def read_ledger(state, days=7, kind=None, stack=None):
    today = datetime.now(timezone.utc).date()
    first = today - timedelta(days=min(days - 1, (today - datetime.min.date()).days))
    records, skipped = [], 0
    for path in sorted((state / "ledger").glob("????-??-??.jsonl")):
        try:
            day = datetime.strptime(path.stem, "%Y-%m-%d").date()
        except ValueError:
            continue
        if not first <= day <= today:
            continue
        with open(path, "rb") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                    record.setdefault("stack", "other")
                    if (type(record.get("v")) is not int or record["v"] != 1 or record.get("kind") not in KINDS
                            or not isinstance(record["stack"], str)
                            or not re.fullmatch(r"[a-z0-9-]{1,20}", record["stack"])
                            or record.get("outcome") not in OUTCOMES
                            or type(record.get("startedAt")) not in (str, type(None))
                            or "startedAt" not in record
                            or any(type(record.get(k)) not in (int, float)
                                   or not math.isfinite(record[k]) or record[k] < 0
                                   for k in ("waitS", "runS"))):
                        raise ValueError("invalid ledger record")
                    stamp = datetime.fromisoformat(record["ts"].replace("Z", "+00:00"))
                    if stamp.utcoffset() != timedelta(0):
                        raise ValueError("not UTC")
                    if (first <= stamp.date() <= today and (kind is None or record["kind"] == kind)
                            and (stack is None or record["stack"] == stack)):
                        records.append(record)
                except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                    skipped += 1
    return records, skipped


def percentile(values, percent):
    return sorted(values)[math.ceil(len(values) * percent / 100) - 1] if values else None


def repeat_failure(record):
    failure = record.get("failure") or {}
    return record.get("outcome") == "failed" and failure.get("category") in ("compile", "analyzer", "assertion")


def warn_repeat_failure(record):
    if record is not None:
        category = record["failure"]["category"]
        note(f"same state previously failed ({category}); change code before rerunning or inspect the previous log")


def summary_stats(state, args):
    if args.failures:
        return failure_stats(state, args)
    return stats(state, args.days, args.kind, args.json, args.stack)


def failure_stats(state, args):
    records, skipped = read_ledger(state, args.days)
    records = failure_records(records, args)
    counts = {}
    for record in records:
        key = (record.get("kind", "?"), (record.get("failure") or {}).get("category", "unknown"))
        counts[key] = counts.get(key, 0) + 1
    rows = [dict(kind=kind, category=category, count=count)
            for (kind, category), count in sorted(counts.items())]
    print_failure_stats(rows, skipped, args)
    return 0


def failure_records(records, args):
    records = (r for r in records if r.get("outcome") in ("failed", "timeout", "cancelled"))
    records = (r for r in records if not args.kind or r.get("kind") == args.kind)
    return (r for r in records if not args.stack or r.get("stack") == args.stack)


def print_failure_stats(rows, skipped, args):
    if args.json:
        print(json.dumps({"days": args.days, "skipped": skipped, "rows": rows}, sort_keys=True))
        return
    print(f"pi-phase: failures last {args.days}d ({skipped} malformed records skipped)")
    for row in rows:
        print("{kind:10s} {category:14s} count={count:3d}".format(**row))


def stats(state, days, kind, as_json, stack=None):
    records, skipped = read_ledger(state, days, kind, stack)
    groups = {}
    for record in records:
        for day in (record["ts"][:10], "total"):
            groups.setdefault((day, record["kind"], record["stack"]), []).append(record)
    rows = []
    for (day, kind, stack), entries in sorted(groups.items()):
        started = [r for r in entries if r["startedAt"] is not None]
        rows.append(dict(day=day, kind=kind, stack=stack, count=len(entries), started=len(started),
                         waitS={f"p{p}": percentile([r["waitS"] for r in entries], p) for p in (50, 90)},
                         runS={f"p{p}": percentile([r["runS"] for r in started], p) for p in (50, 90)},
                         withdrawn=sum(r["outcome"] == "withdrawn" for r in entries),
                         skipped=sum(r["outcome"] == "skipped" for r in entries),
                         queueTimeouts=sum(r["outcome"] == "queue-timeout" for r in entries),
                         failures=sum(r["outcome"] in ("failed", "timeout", "error") for r in entries)))
    if as_json:
        print(json.dumps(dict(days=days, skipped=skipped, rows=rows)))
    else:
        print("day kind stack count started waitS.p50 waitS.p90 runS.p50 runS.p90 queue-timeouts failures skipped withdrawn")
        for row in rows:
            print(row["day"], row["kind"], row["stack"], row["count"], row["started"],
                  *("-" if v is None else f"{v:g}" for v in (*row["waitS"].values(), *row["runS"].values())),
                  row["queueTimeouts"], row["failures"], row["skipped"], row["withdrawn"])
        print(f"skipped {skipped} malformed ledger lines")
    return 0


def readonly_busy(path):
    """Probe existing locks only: ETA never creates or removes live state."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except FileNotFoundError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
    finally:
        os.close(fd)


def eta_fast(state, settings, request, history=None, identity=None):
    if request is None or not request.command:
        return False
    command = request.command[1:] if request.command[0] == "--" else request.command
    if not command:
        return False
    return fast_phase(state, request, settings, test_fingerprint(os.getcwd(), command),
                      history=history, identity=identity)


def wait_eta(state, configuration, kind, request=None):
    records, _ = read_ledger(state)
    durations = {k: [r["runS"] for r in records if r["kind"] == k and r["startedAt"] is not None]
                 for k in KINDS}
    basis = len(durations[kind])
    if not basis:
        print("eta unknown (no ledger data)")
        return 0
    median = percentile(durations[kind], 50)
    medians = {k: percentile(v, 50) if v else median for k, v in durations.items()}
    settings = config(configuration)
    heavy, integration = settings
    fast = settings.options["fast_lane"]
    free = dict(heavy=heavy, integration=integration, fast=fast["slots"] if fast else 0)
    events, running = [], set()
    now = time.time()
    # Probe once for orphan metadata as well as live locks, as admission does.
    live = live_groups(2) if state.exists() else set()
    try:
        coordinator = os.open(state / "coordinator.lock", os.O_RDONLY)
    except FileNotFoundError:
        waiters = []
    else:
        try:
            fcntl.flock(coordinator, fcntl.LOCK_SH)
            for path in state.glob("*.lock"):
                resource = path.stem.split("-", 1)[0]
                if resource not in free:
                    continue
                data = metadata(path.with_suffix(".json"))
                if not (readonly_busy(path) or data.get("unreadable") or live is None or lease_groups(data) & live):
                    continue
                free[resource] -= 1
                running.add(data.get("token", path.stem))
                remaining = max(0, medians.get(data.get("kind"), median) - max(0, now - data.get("started", now)))
                events.append((remaining, resource))
            waiters = all_waiters(state, readonly=True, now=now)
        finally:
            os.close(coordinator)
    # Unpromoted low waiters stay behind the caller; promoted ones compete as aged normal.
    waiters = [w for w in waiters if PRIORITIES[w["priority"]] >= PRIORITIES["normal"] or low_promoted(w, now)]
    # The caller joins at its comparator position, as a real registration would rank.
    order = settings.options["queue_order"]
    history, identity, caller_basis = PhaseHistory(records), None, "default"
    expected = order["default_expected_s"]
    command = [c for c in (request.command if request else []) if c != "--"]
    if command:
        identity = work_identity(os.getcwd(), command, kind)
        expected, caller_basis = history.estimate(identity, test_fingerprint(os.getcwd(), command), kind,
                                                  order["default_expected_s"])
    caller = dict(priority="normal", enqueued=now, seq=float("inf"), kind=kind, expected=expected,
                  basis=caller_basis, caller=True, fast=eta_fast(state, fast, request, history, identity),
                  ageAt=now + (min(order["aging_s"], 0.5 * getattr(request, "queue_timeout", 1200))
                               if order["mode"] == "shortest-first" else 0))
    ordered = ranked_waiters([*waiters, caller], now)
    ahead = ordered.index(caller)
    pending = [(w["kind"], w.get("fast", False), w.get("caller", False),
                w["expected"] if w.get("basis", "default") != "default" else medians[w["kind"]])
               for w in ordered]
    elapsed = 0
    if kind == "ci":
        pending, ahead = [(kind, False, True, medians[kind])], 0
    while pending:
        for index, (candidate, is_fast, caller, seconds) in list(enumerate(pending)):
            needs = eta_resources(candidate, is_fast, free)
            if not all(free[r] > 0 for r in needs):
                continue
            if caller:
                print(f"eta ~{math.ceil(elapsed / 60)}m (ahead={ahead} running={len(running)} "
                      f"p50run={median:g}s, basis={basis} runs)")
                return 0
            pending[index] = None
            for resource in needs:
                free[resource] -= 1
                events.append((elapsed + seconds, resource))
        pending = [k for k in pending if k is not None]
        if not events:
            print("eta unknown (live capacity unavailable)")
            return 0
        elapsed = min(t for t, _ in events)
        for t, resource in events:
            if t == elapsed:
                free[resource] += 1
        events = [(t, r) for t, r in events if t != elapsed]
    return 0


def eta_resources(kind, fast, free):
    if kind == "ci":
        return []
    if fast and free["fast"] > 0:
        return ["fast"]
    return ["heavy"] + (["integration"] if kind == "integration" else [])


def safe_label(value):
    if not value or len(value) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("label must be 1-120 printable characters (no control characters)")
    return value


class PhaseConfig(tuple):
    """Keep the slot-pair API while carrying optional performance settings."""
    def __new__(cls, heavy, integration, options):
        result = super().__new__(cls, (heavy, integration))
        result.options = options
        return result


def merge_config(base, overlay):
    """Merge objects recursively; scalars and arrays in the overlay replace the base."""
    result = base.copy()
    for key, value in overlay.items():
        result[key] = merge_config(result[key], value) if isinstance(result.get(key), dict) and isinstance(value, dict) else value
    return result


def local_config(path, data, warn):
    overlay = path.with_name("config.local.json")
    if not overlay.exists():
        return data
    try:
        local = json.loads(overlay.read_text())
        if not isinstance(local, dict):
            raise ValueError("expected an object")
    except (ValueError, OSError) as exc:
        warn(f"invalid config.local.json ({exc}); ignoring local overlay")
        return data
    return merge_config(data, local)


def config(path, *, notes=None):
    def warn(message):
        if notes is None or message not in notes:
            note(message)
            if notes is not None:
                notes.add(message)

    defaults = dict(heavy_slots=2, integration_slots=1, msbuild_max_cpu=0,
                    container_test_detection="hint", cold_worktree_hint=True, memory_admission=False,
                    phase_nice=0, rss_cap_mb=12288, skip_passed_integration=False, max_high=3,
                    host_pressure=dict(mode="off"), cpu_budget=dict(mode="off"),
                    failure_categories=True, hang_timeout=dict(mode="off"), reap_build_servers=dict(mode="off"),
                    skip_cross_worktree=False,
                    fast_lane=dict(slots=2, max_expected_s=90, kinds=["build", "test"], shape=True),
                    queue_order=dict(QUEUE_ORDER_DEFAULTS), policy=[])
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(data, dict):
            raise ValueError("expected an object")
    except (ValueError, OSError) as exc:
        warn(f"invalid config.json ({exc}); using defaults")
        data = {}
    data = local_config(path, data, warn)
    for key in data.keys() - defaults.keys():
        warn(f"unknown config key {key}; ignored")
    values = defaults.copy()
    for key, default in configure_policy(defaults, values, data, warn).items():
        value = data.get(key, default)
        if key in ("heavy_slots", "integration_slots"):
            valid = type(value) is int and 1 <= value <= 32
        elif key == "max_high":
            valid = type(value) is int and 1 <= value <= 10
        elif key == "msbuild_max_cpu":
            valid = value == "auto" or type(value) is int and value >= 0
        elif key == "rss_cap_mb":
            valid = type(value) is int and value >= 0  # 0 = off
        elif key == "phase_nice":
            valid = type(value) is int and 0 <= value <= 19
        elif key == "fast_lane":
            values[key] = fast_lane_config(value, warn)
            continue
        elif key == "memory_admission":
            values[key] = memory_admission_config(value, warn)
            continue
        elif key == "queue_order":
            values[key] = queue_order_config(value, warn)
            continue
        elif key == "host_pressure":
            values[key] = host_pressure_config(value, warn)
            continue
        elif key == "cpu_budget":
            values[key] = cpu_budget_config(value, warn)
            continue
        elif key == "hang_timeout":
            values[key] = hang_timeout_config(value, warn)
            continue
        elif key == "reap_build_servers":
            values[key] = reap_build_servers_config(value, warn)
            continue
        elif key == "container_test_detection":
            valid = value in ("off", "hint", "promote")
        else:
            valid = type(value) is bool
        if valid:
            values[key] = value
        else:
            warn(f"invalid {key}; using default {default!r}")
    heavy = values.pop("heavy_slots")
    integration = values.pop("integration_slots")
    return PhaseConfig(heavy, integration, values)


QUEUE_ORDER_DEFAULTS = dict(mode="shortest-first", aging_s=600, default_expected_s=180, low_promote_after_s=900)


def queue_order_config(value, warn):
    settings = dict(QUEUE_ORDER_DEFAULTS)
    if not isinstance(value, dict):
        warn("invalid queue_order; using defaults")
        return settings
    validators = dict(mode=lambda v: v in ("fifo", "shortest-first"),
                      aging_s=lambda v: type(v) in (int, float) and 30 <= v <= 3600,
                      default_expected_s=lambda v: type(v) in (int, float) and 1 <= v <= 7200,
                      low_promote_after_s=lambda v: type(v) in (int, float) and 30 <= v <= 7200)
    for key, item in value.items():
        if key not in validators:
            warn(f"unknown queue_order key {key}; ignored")
        elif validators[key](item):
            settings[key] = item
        else:
            warn(f"invalid queue_order.{key}; using default {QUEUE_ORDER_DEFAULTS[key]!r}")
    return settings


def configure_policy(defaults, values, data, warn):
    defaults = defaults.copy()
    default = defaults.pop("policy")
    values["policy"] = policy_config(data.get("policy", default), warn)
    return defaults


def policy_config(value, warn):
    if not isinstance(value, list):
        warn("invalid policy; using no rules")
        return []
    rules = []
    for rule in value:
        if valid_policy_rule(rule):
            rules.append(rule)
        else:
            warn("invalid policy rule; ignored")
    return rules


def valid_policy_rule(rule):
    if not isinstance(rule, dict):
        return False
    if not isinstance(rule.get("path"), str) or rule.get("policy") not in POLICIES:
        return False
    if not valid_policy_kinds(rule.get("kinds")):
        return False
    limit = rule.get("max_expected_s", 90)
    return type(limit) in (int, float) and 0 < limit <= sys.float_info.max / 3


def valid_policy_kinds(kinds):
    if not isinstance(kinds, list):
        return False
    return bool(kinds) and all(kind in KINDS for kind in kinds)


def requested_policy(args):
    if getattr(args, "policy", None):
        return args.policy, "flag"
    if getattr(args, "expect_fast", False):
        return "fast", "flag"
    value = os.environ.get("PI_PHASE_POLICY")
    if value:
        if value not in POLICIES:
            raise ValueError("PI_PHASE_POLICY must be direct, fast or queued")
        return value, "env"
    return None, "default"


def main_worktree(cwd):
    """Resolve a checkout's shared .git directory; failed probes never inherit rules."""
    try:
        result = subprocess.run(["git", "--no-optional-locks", "rev-parse", "--git-common-dir"],
                                cwd=cwd, capture_output=True, text=True, check=True, timeout=1)
        common = (Path(cwd) / result.stdout.strip()).resolve()
        if common.name == ".git" and common.is_dir():
            return str(common.parent)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def matching_policy_rules(kind, rules):
    cwd = os.path.realpath(os.getcwd())
    inherited = main_worktree(cwd) if rules else None
    paths = (cwd, inherited) if inherited is not None else (cwd,)
    for rule in rules:
        if kind in rule["kinds"] and any(fnmatch.fnmatchcase(path, os.path.expanduser(rule["path"])) for path in paths):
            yield rule


def configured_policy(state, args, options, fingerprint, *, history=None, identity=None):
    for rule in matching_policy_rules(args.kind, options["policy"]):
        policy = rule_policy(state, rule, fingerprint, history=history, identity=identity)
        if policy == "direct":
            args.config_direct_limit = rule.get("max_expected_s", 90)
        return policy, "config"
    fast, source = fast_decision(state, args, options["fast_lane"], fingerprint, history=history, identity=identity)
    return ("fast", source) if fast else ("queued", "default")


def rule_policy(state, rule, fingerprint, *, history=None, identity=None):
    if rule["policy"] != "direct":
        return rule["policy"]
    records = history.exact_runs(fingerprint) if history is not None else policy_history(state, fingerprint)
    if len(records) >= 3 and percentile([r["runS"] for r in records], 90) > rule.get("max_expected_s", 90):
        return "fast"
    return "direct"


def policy_history(state, fingerprint):
    try:
        return fast_history(state, fingerprint)
    except (OSError, ValueError) as exc:
        note(f"fast history unavailable: {exc}")
        return []


def select_policy(state, args, options, fingerprint, *, history=None, identity=None):
    policy, source = requested_policy(args)
    if policy is None:
        policy, source = configured_policy(state, args, options, fingerprint, history=history, identity=identity)
    if policy == "direct":
        policy = safe_direct_policy(state, args.kind, fingerprint, identity)
    if policy == "fast":
        policy = hinted_fast_policy(state, args, options["fast_lane"], fingerprint, history=history, identity=identity)
    return policy, source


def safe_direct_policy(state, kind, fingerprint, identity=None):
    refusal = direct_refusal(state, kind, fingerprint, identity)
    if refusal:
        note(f"direct policy ignored: {refusal}; queued")
        return "queued"
    return "direct"


def hinted_fast_policy(state, args, settings, fingerprint, *, history=None, identity=None):
    fast_args = argparse.Namespace(**vars(args))
    fast_args.expect_fast = True
    return "fast" if fast_phase(state, fast_args, settings, fingerprint, history=history, identity=identity) else "queued"


def container_test_known(state, fingerprint, identity=None):
    known = metadata(state / "container-tests.json")
    return known.get(fingerprint) is True or (identity is not None and known.get(f"family:{identity.family_key}") is True)


def direct_refusal(state, kind, fingerprint, identity=None):
    if kind == "integration":
        return "integration phase"
    if container_test_known(state, fingerprint, identity):
        return "recorded container test"
    return None


def fast_lane_config(value, warn):
    defaults = dict(slots=2, max_expected_s=90, kinds=["build", "test"], shape=True)
    if value is False:
        return False
    if not isinstance(value, dict):
        warn("invalid fast_lane; using defaults")
        return defaults
    settings = defaults.copy()
    validators = fast_lane_fields()
    for key, item in value.items():
        if key not in validators:
            warn(f"unknown fast_lane key {key}; ignored")
        elif validators[key](item):
            settings[key] = item
        else:
            warn(f"invalid fast_lane.{key}; using default {defaults[key]!r}")
    return settings


def fast_lane_fields():
    return dict(slots=lambda v: type(v) is int and 1 <= v <= 32,
                max_expected_s=lambda v: type(v) in (int, float) and 0 < v <= sys.float_info.max / 3,
                kinds=lambda v: isinstance(v, list) and all(k in ("build", "test") for k in v),
                shape=lambda v: type(v) is bool)


def fast_history(state, fingerprint):
    records, _ = read_ledger(state, days=8)
    since = datetime.now(timezone.utc) - timedelta(days=7)
    return [r for r in records if fast_record(r, fingerprint, since)]


def fast_record(record, fingerprint, since):
    if record.get("fingerprint") != fingerprint or record["startedAt"] is None:
        return False
    if record["outcome"] not in ("passed", "failed", "timeout"):
        return False
    return datetime.fromisoformat(record["ts"].replace("Z", "+00:00")) >= since


def slow_fast_history(history, threshold):
    p90 = percentile([r["runS"] for r in history], 90)
    return any(r.get("fastBudgetExceeded") is True for r in history) or (p90 is not None and p90 > threshold)


def fast_refusal(state, fingerprint, history, threshold, *, phase_history=None, identity=None):
    if container_test_known(state, fingerprint, identity):
        return "recorded container test"
    if slow_fast_history(history, threshold):
        return "history says this phase is slow"
    if phase_history is not None and identity is not None:
        if phase_history.family_overran(identity):
            return "this command family overran the fast budget"
        scope = phase_history.work.get(identity.work_key) or phase_history.family.get(identity.family_key)
        if scope and percentile([r["runS"] for r in scope], 90) > threshold:
            return "history says this phase is slow"
    return None


def shape_fast(phase_history, identity, args, settings):
    """First-ever short spec run: no history for the family, a run (no compile) shape."""
    if not settings.get("shape", True) or args.kind != "test" or identity.shape != "run":
        return False
    if phase_history.family.get(identity.family_key):
        return False
    if phase_history.shape_breaker(identity):
        note("shape-based fast lane off for this repository (3 shape overruns in 24h)")
        return False
    return True


def fast_decision(state, args, settings, fingerprint, *, history=None, identity=None):
    """(fast, source); source is history or shape."""
    if not settings or args.kind not in settings["kinds"]:
        return False, None
    if history is None:
        try:
            runs = fast_history(state, fingerprint)
        except (OSError, ValueError):
            runs = []
    else:
        runs = history.exact_runs(fingerprint)
    refusal = fast_refusal(state, fingerprint, runs, settings["max_expected_s"],
                           phase_history=history, identity=identity)
    if refusal:
        if getattr(args, "expect_fast", False):
            note(f"--expect-fast ignored: {refusal}")
        return False, None
    if getattr(args, "expect_fast", False) or len(runs) >= 3:
        return True, "history"
    if history is not None and identity is not None:
        work = history.work.get(identity.work_key, [])
        if len(work) >= 2 and percentile([r["runS"] for r in work], 90) <= settings["max_expected_s"]:
            return True, "history"
        if shape_fast(history, identity, args, settings):
            return True, "shape"
    return False, None


def fast_phase(state, args, settings, fingerprint, *, history=None, identity=None):
    return fast_decision(state, args, settings, fingerprint, history=history, identity=identity)[0]


def fast_budget(settings):
    return max(3 * settings["max_expected_s"], 120)


def memory_admission_config(value, warn=None):
    warn = warn or note
    defaults = dict(min_free_percent=30, min_swap_free_mb=DEFAULT_MIN_SWAP_FREE_MB)
    if value is False:
        return False
    if value is True:
        return defaults
    if isinstance(value, dict):
        for key in value.keys() - defaults.keys() - {"integration_burst"}:
            warn(f"unknown memory_admission key {key}; ignored")
        settings = {key: value.get(key, default) for key, default in defaults.items()}
        if (all(type(n) in (int, float) and 0 <= n <= sys.float_info.max for n in settings.values())
                and settings["min_free_percent"] <= 100):
            burst = integration_burst_config(value.get("integration_burst"), warn)
            if burst:
                settings["integration_burst"] = burst
            return settings
    warn("invalid memory_admission; using default False")
    return False


def integration_burst_config(value, warn):
    if value is None or value is False:
        return None
    defaults = dict(slots=2, min_free_percent=50, max_load_per_core=1.5,
                    max_docker_mem_percent=70)
    if isinstance(value, dict):
        for key in value.keys() - defaults.keys():
            warn(f"unknown integration_burst key {key}; ignored")
        settings = {key: value.get(key, default) for key, default in defaults.items()}
        if (type(settings["slots"]) is int and 1 <= settings["slots"] <= 32
                and all(type(n) in (int, float) and 0 <= n <= sys.float_info.max
                        for key, n in settings.items() if key != "slots")
                and settings["min_free_percent"] <= 100 and settings["max_docker_mem_percent"] <= 100):
            return settings
    warn("invalid integration_burst; burst disabled")
    return None


def parse_macos_memory(pressure, swap):
    free = re.search(r"System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%", pressure)
    swap_free = re.search(r"\bfree\s*=\s*(\d+(?:\.\d+)?)([KMGT])\b", swap)
    if not free or not swap_free:
        raise ValueError("unrecognized macOS memory output")
    percent = float(free[1])
    megabytes = float(swap_free[1]) * {"K": 1 / 1024, "M": 1, "G": 1024, "T": 1024 ** 2}[swap_free[2]]
    if not 0 <= percent <= 100 or not math.isfinite(megabytes):
        raise ValueError("invalid macOS memory values")
    total = re.search(r"\btotal\s*=\s*(\d+(?:\.\d+)?)[KMGT]\b", swap)
    return percent, None if total and float(total[1]) == 0 else megabytes


def parse_linux_memory(text):
    values = {}
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] in ("MemAvailable:", "MemTotal:", "SwapFree:"):
            if len(fields) != 3 or fields[2] != "kB":
                raise ValueError("unrecognized /proc/meminfo units")
            values[fields[0][:-1]] = int(fields[1])
    total, available, swap = (values[key] for key in ("MemTotal", "MemAvailable", "SwapFree"))
    if total <= 0 or not 0 <= available <= total or swap < 0:
        raise ValueError("invalid /proc/meminfo values")
    return available * 100 / total, swap / 1024


def read_host_memory(deadline):
    if sys.platform == "darwin":
        outputs = []
        for command in (["memory_pressure", "-Q"], ["sysctl", "-n", "vm.swapusage"]):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("memory probe queue deadline expired")
            outputs.append(subprocess.run(command, capture_output=True, text=True, check=True,
                                          timeout=min(1, remaining)).stdout)
        return parse_macos_memory(*outputs)
    if sys.platform.startswith("linux"):
        with open("/proc/meminfo") as stream:
            return parse_linux_memory(stream.read(65536))
    raise ValueError("memory admission is unsupported on this platform")


class MemoryAdmission:
    """Per-phase, at-most-five-second cache; all probes run outside the coordinator."""
    def __init__(self, thresholds):
        self.thresholds = thresholds
        self.checked = None
        self.sample = None
        self.noted = False
        self.failure_noted = False

    def reading(self, deadline):
        now = time.monotonic()
        if self.checked is None or now - self.checked >= 5:
            self.checked = now
            try:
                self.sample = read_host_memory(deadline)
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
                self.sample = None
                if not self.failure_noted:
                    note(f"memory measurement failed ({exc}); admitting (fail-open)")
                    self.failure_noted = True
        return self.sample

    def reason(self, deadline):
        self.reading(deadline)
        if self.sample is None:
            return None
        free, swap_free = self.sample
        minimum = self.thresholds["min_free_percent"]
        if free < minimum:
            return f"memory free {free:g}% < {minimum:g}%"
        minimum = self.thresholds["min_swap_free_mb"]
        if SWAP_FLOOR_ENFORCED and swap_free is not None and swap_free < minimum:
            return f"swap free {swap_free:g} MB < {minimum:g} MB"
        return None

    def waiting(self, reason):
        if not self.noted:
            note(f"waiting: {reason}")
            self.noted = True


def read_docker_memory_percent(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Docker memory probe queue deadline expired")
    result = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemPerc}}"],
                            capture_output=True, text=True, check=True, timeout=min(5, remaining))
    total = 0
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        if not line.strip().endswith("%"):
            raise ValueError("unrecognized Docker memory percentage")
        value = float(line.strip()[:-1])
        if not math.isfinite(value) or value < 0:
            raise ValueError("invalid Docker memory percentage")
        total += value
    return total


class IntegrationBurst:
    def __init__(self, admission, settings):
        self.admission = admission
        self.settings = settings
        self.docker_checked = None
        self.docker_percent = None

    def effective(self, configured, deadline):
        try:
            sample = self.admission.reading(deadline)
            if sample is None or sample[0] < self.settings["min_free_percent"]:
                return configured
            load = os.getloadavg()[1]
            if not math.isfinite(load) or load > (os.cpu_count() or 1) * self.settings["max_load_per_core"]:
                return configured
            now = time.monotonic()
            if self.docker_checked is None or now - self.docker_checked >= 30:
                self.docker_checked = now
                self.docker_percent = None
                self.docker_percent = read_docker_memory_percent(deadline)
            if self.docker_percent is None or self.docker_percent >= self.settings["max_docker_mem_percent"]:
                return configured
            return max(configured, self.settings["slots"])
        except (OSError, ValueError, subprocess.SubprocessError):
            return configured  # Burst is strictly fail-closed, unlike memory admission.


HOST_PRESSURE_DEFAULTS = dict(max_pressure_level=2, max_compressor_percent=30,
                              max_swap_growth_mb_per_min=256, sample_ttl_s=5)
HOST_SAMPLE_WINDOW_S = 600
HOST_SAMPLE_MIN_SPAN_S = 60
HOST_MODES = ("off", "observe", "enforce")


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def mode_config(name, value, warn, defaults, valid):
    """Shared shape of the host_pressure and cpu_budget keys: {"mode": off|observe|enforce, ...thresholds}."""
    off = dict(mode="off")
    if not isinstance(value, dict):
        warn(f"invalid {name}; using default {off!r}")
        return off
    for key in value.keys() - defaults.keys() - {"mode"}:
        warn(f"unknown {name} key {key}; ignored")
    settings = {key: value.get(key, default) for key, default in defaults.items()}
    mode = value.get("mode", "off")
    if mode not in HOST_MODES or not valid(settings):
        warn(f"invalid {name}; using default {off!r}")
        return off
    return off if mode == "off" else dict(settings, mode=mode)


REAP_BUILD_SERVERS_DEFAULTS = dict(idle_s=600, min_age_s=900, max_cpu_ms_per_min=200)


def reap_build_servers_config(value, warn=None):
    def valid(settings):
        return all(number(settings[key]) and settings[key] > 0 for key in REAP_BUILD_SERVERS_DEFAULTS)
    return mode_config("reap_build_servers", value, warn or note, REAP_BUILD_SERVERS_DEFAULTS, valid)


def host_pressure_config(value, warn=None):
    def valid(settings):
        return (type(settings["max_pressure_level"]) is int and settings["max_pressure_level"] >= 1
                and all(number(settings[key]) and settings[key] > 0 for key in HOST_PRESSURE_DEFAULTS)
                and settings["max_compressor_percent"] <= 100 and settings["sample_ttl_s"] <= 3600)
    return mode_config("host_pressure", value, warn or note, HOST_PRESSURE_DEFAULTS, valid)


def parse_host_pressure(text):
    """Output of `sysctl -n vm.swapusage vm.compressor_bytes_used hw.memsize kern.memorystatus_vm_pressure_level
    kern.memorystatus_level` (one line per name): swapMb (used), cmpPct, pl (1 normal, 2 warn, 4 critical), level."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 5:
        raise ValueError("unrecognized host pressure output")
    swap = re.search(r"\bused\s*=\s*([0-9.]+)M", lines[0])
    compressor, memsize, level, free = int(lines[1]), int(lines[2]), int(lines[3]), float(lines[4])
    if not swap or compressor < 0 or memsize <= 0 or level < 0:
        raise ValueError("invalid host pressure values")
    return dict(swapMb=float(swap.group(1)), cmpPct=round(compressor * 100 / memsize, 2), pl=level, level=free)


def read_host_pressure(timeout):
    if sys.platform != "darwin":
        raise ValueError("host pressure is unsupported on this platform")
    names = ["vm.swapusage", "vm.compressor_bytes_used", "hw.memsize", "kern.memorystatus_vm_pressure_level",
             "kern.memorystatus_level"]
    return parse_host_pressure(subprocess.run(["sysctl", "-n", *names], capture_output=True, text=True, check=True,
                                              timeout=timeout).stdout)


def swap_growth(history):
    """MB/min between the oldest and newest samples, or None when they are under a minute apart."""
    if len(history) < 2:
        return None
    (first, before), (last, after) = history[0], history[-1]
    return round((after - before) / ((last - first) / 60), 2) if last - first >= HOST_SAMPLE_MIN_SPAN_S else None


class HostPressure:
    """Pressure level, compressor share and swap growth. One shared sample (state/host-sample.json) serves every
    waiter; the probe runs in the caller's thread, never under the coordinator lock. Fails open."""
    def __init__(self, settings, state, probe=read_host_pressure, clock=time.time):
        self.settings, self.mode = settings, settings["mode"]
        self.path = state / "host-sample.json"
        self.probe, self.clock = probe, clock
        self.noted = self.failure_noted = False

    def cached(self):
        try:
            data = json.loads(self.path.read_text())
            if isinstance(data, dict) and number(data.get("t")) and isinstance(data.get("hist"), list):
                return data
        except (OSError, ValueError):
            pass
        return None  # missing or corrupt: probe again

    def cached_fields(self):
        data = self.cached() or {}
        return {key: data[key] for key in ("pl", "cmpPct", "swapMb", "swapGrowth") if number(data.get(key))}

    def sample(self, deadline):
        now = self.clock()
        cached = self.cached()
        if cached and 0 <= now - cached["t"] < self.settings["sample_ttl_s"]:
            return cached
        remaining = deadline - time.monotonic()
        try:
            if remaining <= 0:
                raise TimeoutError("host pressure probe queue deadline expired")
            reading = self.probe(min(1, remaining))
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            if not self.failure_noted:
                note(f"host pressure measurement failed ({exc}); admitting (fail-open)")
                self.failure_noted = True
            return None
        history = [item for item in (cached or {}).get("hist", []) if isinstance(item, list) and len(item) == 2
                   and number(item[0]) and number(item[1]) and 0 <= now - item[0] <= HOST_SAMPLE_WINDOW_S]
        history.append([now, reading["swapMb"]])
        data = dict(reading, t=now, hist=history, swapGrowth=swap_growth(history))
        try:
            save(self.path, data)
        except OSError:
            pass  # An unwritable cache only costs the next waiter a probe.
        return data

    def reason(self, deadline):
        data = self.sample(deadline)
        if data is None:
            return None
        limits = self.settings
        if data["pl"] >= limits["max_pressure_level"]:
            return f"memory pressure level {data['pl']} >= {limits['max_pressure_level']}"
        if data["cmpPct"] >= limits["max_compressor_percent"]:
            return f"compressor {data['cmpPct']:g}% >= {limits['max_compressor_percent']:g}%"
        growth = data.get("swapGrowth")
        if growth is not None and growth >= limits["max_swap_growth_mb_per_min"]:
            return f"swap growth {growth:g} MB/min >= {limits['max_swap_growth_mb_per_min']:g}"
        return None

    def waiting(self, reason):
        if not self.noted:
            note(f"waiting: {reason}")
            self.noted = True


CPU_BUDGET_DEFAULTS = dict(max_units="auto", costs=dict(heavy="msbuild", fast=1, direct=1, integration=2),
                           max_load_per_core=4.0)
CPU_POOLS = ("heavy", "fast", "direct", "integration")


def cpu_budget_config(value, warn=None):
    warn = warn or note

    def valid(settings):
        costs = settings["costs"]
        if not isinstance(costs, dict) or not costs.keys() <= set(CPU_POOLS):
            return False
        if not all(cost == "msbuild" and pool == "heavy" or type(cost) is int and cost >= 0
                   for pool, cost in costs.items()):
            return False
        return ((settings["max_units"] == "auto" or type(settings["max_units"]) is int and settings["max_units"] >= 1)
                and number(settings["max_load_per_core"]) and settings["max_load_per_core"] > 0)
    settings = mode_config("cpu_budget", value, warn, CPU_BUDGET_DEFAULTS, valid)
    if settings["mode"] != "off" and isinstance(value, dict):
        settings["costs"] = dict(CPU_BUDGET_DEFAULTS["costs"], **value.get("costs", {}))
    return settings


class CpuBudget:
    """Units per live lease by pool prefix; the unit total and the load average gate every policy except ci."""
    def __init__(self, settings, msbuild_max_cpu, cpus=None, loadavg=None):
        self.mode, self.loadavg = settings["mode"], loadavg or (lambda: os.getloadavg())
        self.cpus = cpus or os.cpu_count() or 1
        units = settings["max_units"]
        self.max_units = round(1.5 * self.cpus) if units == "auto" else units
        msbuild = msbuild_max_cpu if type(msbuild_max_cpu) is int and msbuild_max_cpu > 0 else 2
        self.costs = {pool: msbuild if cost == "msbuild" else cost for pool, cost in settings["costs"].items()}
        self.max_load = settings["max_load_per_core"]

    def cost(self, path):
        return self.costs.get(path.name.split("-", 1)[0], 0)

    def load_per_core(self):
        try:
            return self.loadavg()[0] / self.cpus
        except (OSError, AttributeError):
            return None  # Unmeasurable load never holds.

    def running_units(self, state, available, prior, live):
        """Caller holds the coordinator."""
        return sum(self.cost(path) for path in state.glob("*.lock")
                   if path.name.startswith(tuple(pool + "-" for pool in CPU_POOLS)) and path not in available
                   and lease_running(path, prior, live))

    def reason(self, units, candidate, load):
        need = sum(self.cost(path) for path in candidate)
        if need <= 0:
            return None  # ci (and unpriced pools) are never held
        if units + need > self.max_units:
            return f"cpu:{units + need}/{self.max_units}"
        if load is not None and load > self.max_load:
            return f"cpu:load {load:.1f}/core > {self.max_load:g}"
        return None


def lease_running(path, prior, live):
    """Caller holds the coordinator; account for both locked and orphan leases."""
    fd = lock_file(path)
    if fd is None:
        return True
    try:
        entry = metadata(path.with_suffix(".json"))
        return entry != prior.get(path) or entry.get("unreadable") or bool(lease_groups(entry) & live)
    finally:
        unlock(fd)


def burst_available(state, available, prior, live, ceiling):
    active = sum(bool(lease_running(path, prior, live)) for path in state.glob("integration-*.lock")
                 if path not in available)
    free = sorted(path for path in available if path.name.startswith("integration-"))
    allowed = set(free[:max(0, ceiling - active)])
    return {path: fd for path, fd in available.items()
            if not path.name.startswith("integration-") or path in allowed}


def phases_running(state, available, prior, live):
    """Caller holds the coordinator; do not mistake our tentative locks for owners."""
    return any(lease_running(path, prior, live) for path in state.glob("*.lock")
               if path.name.startswith(("heavy-", "integration-", "ci-", "fast-", "direct-")) and path not in available)


def sample_tree(root_pid):
    """[(pid, rss_mb, command, start_time)] for the phase's whole process tree: its process group plus every descendant."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,pgid=,rss=,lstart=,command="], capture_output=True, text=True,
                         timeout=5, check=True).stdout
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 9)  # lstart is five tokens ("Thu Oct 22 21:10:00 2026")
        if len(parts) >= 9 and all(p.isdigit() for p in parts[:4]):
            rows[int(parts[0])] = (int(parts[1]), int(parts[2]), int(parts[3]) / 1024,
                                   (" ".join(parts[4:9]), parts[9] if len(parts) > 9 else ""))
    members = {pid for pid, (_, pgid, _, _) in rows.items() if pgid == root_pid} | ({root_pid} & rows.keys())
    grew = True
    while grew:
        grew = False
        for pid, (ppid, _, _, _) in rows.items():
            if pid not in members and ppid in members:
                members.add(pid)
                grew = True
    return [(pid, rows[pid][2], rows[pid][3][1], rows[pid][3][0]) for pid in sorted(members)]


def low_memory_reason(swap_floor_mb):
    """Why memory is low right now, or None (also None when it cannot be measured: fail-open, warning only).

    macOS: kern.memorystatus_level below LEVEL_WARN_PERCENT (free swap is meaningless there). Elsewhere: swap free
    below the floor."""
    try:
        if sys.platform == "darwin":
            level = float(subprocess.run(["sysctl", "-n", "kern.memorystatus_level"], capture_output=True,
                                         text=True, timeout=2, check=True).stdout.strip())
            return f"memory available {level:g}% < {LEVEL_WARN_PERCENT}%" if level < LEVEL_WARN_PERCENT else None
        if sys.platform.startswith("linux") and swap_floor_mb:
            with open("/proc/meminfo") as stream:
                swap_free = parse_linux_memory(stream.read(65536))[1]
            return f"swap free {swap_free:g} MB < {swap_floor_mb:g} MB" if swap_free < swap_floor_mb else None
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    return None


class RunningMemory:
    """Re-checks memory while a phase runs: RSS cap kill (descendant above rss_cap_mb) and a swap warning."""
    def __init__(self, rss_cap_mb, swap_floor_mb, warn=True):
        self.enabled = True
        self.cap = rss_cap_mb
        self.floor = swap_floor_mb
        self.warn = warn
        self.last_warning = None
        self.streaks = {}  # (pid, start time) -> consecutive over-cap samples
        self.peak_rss_mb = 0
        self.peak_proc_rss_mb = 0

    def offender(self, root_pid):
        """(pid, rss_mb, command) of the largest process that was above the cap in OVER_CAP_SAMPLES consecutive
        samples (same pid and start time), else None. A dip below the cap or a changed pid resets its streak.
        Also warns on low memory."""
        now = time.monotonic()
        if self.warn and (self.last_warning is None or now - self.last_warning >= SWAP_WARN_INTERVAL):
            reason = low_memory_reason(self.floor)
            if reason:
                self.last_warning = now
                note(f"warning: {reason} while phase is running (no action taken)")
        try:
            samples = self.sample(root_pid)
        except (OSError, ValueError, subprocess.SubprocessError):
            self.streaks = {}  # a failed measurement breaks every streak: "consecutive" means consecutive samples
            return None  # fail-open: never kill on a failed measurement
        self.sample_peaks(samples)
        if not self.cap:
            return None
        over = {(item[0], item[3] if len(item) > 3 else None): item for item in samples if item[1] > self.cap}
        self.streaks = {identity: self.streaks.get(identity, 0) + 1 for identity in over}
        sustained = [over[identity] for identity, count in self.streaks.items() if count >= OVER_CAP_SAMPLES]
        return max(sustained, key=lambda item: item[1]) if sustained else None

    def sample(self, root_pid):
        return sample_tree(root_pid) if self.enabled else []

    def sample_peaks(self, samples):
        self.peak_rss_mb = max(self.peak_rss_mb, sum(item[1] for item in samples))
        self.peak_proc_rss_mb = max(self.peak_proc_rss_mb, max((item[1] for item in samples), default=0))


def phase_memory(options, kind, ledger):
    enabled = kind in ("build", "test", "integration")
    memory = RunningMemory(options["rss_cap_mb"] if enabled else 0,
                           (options["memory_admission"] or {}).get("min_swap_free_mb", DEFAULT_MIN_SWAP_FREE_MB),
                           enabled)
    memory.enabled = enabled
    if ledger and enabled:
        ledger.running_memory = memory
    return memory


def msbuild_cap(value, heavy):
    return max(2, (os.cpu_count() or 1) // heavy) if value == "auto" else value


COMPILER_ID_PREFIX = "pi-phase-"


def shared_compilation_id(env, token):
    """A phase-specific SharedCompilationId when the user opted into shared compilation (PI_PHASE_SHARED_COMPILATION=1).

    A SharedCompilationId already present in the environment belongs to the caller: it is kept and never cleaned up."""
    if env.get("PI_PHASE_SHARED_COMPILATION") != "1" or env.get("SharedCompilationId"):
        return None
    return COMPILER_ID_PREFIX + re.sub(r"[^A-Za-z0-9]", "", str(token))[:24]


def stop_phase_compiler_server(compiler_id, listing=None, kill=os.kill):
    """SIGTERM only this phase's own server (same user, exact -pipename), after the phase's compiles have ended."""
    try:
        listing = listing if listing is not None else subprocess.run(
            ["ps", "-axo", "pid=,uid=,rss=,command="], capture_output=True, text=True, timeout=5, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    stopped = []
    for line in listing.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or not all(item.isdigit() for item in parts[:3]) or int(parts[1]) != os.getuid():
            continue
        words = parts[3].split()
        if "VBCSCompiler" in words[0] and f"-pipename:{compiler_id}" in words[1:]:
            try:
                kill(int(parts[0]), signal.SIGTERM)
            except OSError:
                continue
            stopped.append(int(parts[0]))
            note(f"stopped phase compiler server pid={parts[0]} rss={int(parts[2]) // 1024}MB")
    return stopped


def shim_environment(directory, cap):
    shim = directory / "dotnet"
    shim.write_bytes((ROOT / "dotnet-shim.sh").read_bytes())
    shim.chmod(0o700)
    (directory / "test-runner.py").write_bytes((ROOT / "dotnet-test-runner.py").read_bytes())
    env = os.environ.copy()
    original_path = os.environ.get("PATH", os.defpath)
    inherited_shim = env.get("PI_PHASE_SHIM_DIR")
    if inherited_shim:
        # Nested phases must not select their parent's shim as the real dotnet.
        original_path = os.pathsep.join(part for part in original_path.split(os.pathsep)
                                        if os.path.realpath(part or ".") != inherited_shim)
    env.update(PI_PHASE_ORIGINAL_PATH=original_path,
               PI_PHASE_SHIM_DIR=str(directory.resolve()), PI_PHASE_MSBUILD_MAX_CPU=str(cap),
               PI_PHASE_PYTHON=sys.executable)
    env["PATH"] = str(directory) + os.pathsep + env["PI_PHASE_ORIGINAL_PATH"]
    return env


def fingerprint_argument(argument):
    """Remove volatile version/stamp values without changing ordinary command tokens."""
    # Compound MSBuild properties may alter the workload; keep the whole argument exact.
    if re.match(r"^[-/]p:.*[;,]", argument, flags=re.DOTALL):
        return argument
    argument = re.sub(r"^([-/]p:(?:Version|PackageVersion)=).*$", r"\1<version>", argument)
    argument = re.sub(r"^\d+\.\d+\.\d+-(?:local|train)\.\S+$", "<version>", argument)
    return re.sub(r"\.g[0-9a-fA-F]{7}$", ".g<sha>", argument)


def test_fingerprint(cwd, command):
    normalized = [fingerprint_argument(argument) for argument in command]
    return hashlib.sha1("\0".join([os.path.realpath(cwd), *normalized]).encode()).hexdigest()


WorkIdentity = namedtuple("WorkIdentity", "repo_key work_key family_key project shape filtered")
TARGET_SUFFIXES = (".dll", ".exe", ".csproj", ".fsproj", ".sln", ".slnx")
FILTER_ARGUMENT = re.compile(r"^--?(filter|treenode-filter|filter-[a-z-]+|class|method|namespace|trait|query)\b",
                             re.IGNORECASE)


def digest(*parts):
    return hashlib.sha1("\0".join(parts).encode()).hexdigest()


def repository_layout(cwd):
    """(common git dir without .git, path of cwd relative to the checkout, real checkout top, top as git printed it)."""
    try:
        real = os.path.realpath(cwd)
    except OSError:
        real = str(cwd)
    try:
        lines = subprocess.run(["git", "--no-optional-locks", "rev-parse", "--path-format=absolute",
                                "--git-common-dir", "--show-toplevel"], cwd=cwd, capture_output=True,
                               text=True, check=True, timeout=1,
                               env=dict(os.environ, GIT_OPTIONAL_LOCKS="0")).stdout.splitlines()
        common, top = os.path.realpath(lines[0]), os.path.realpath(lines[1])
        if Path(common).name == ".git":
            common = str(Path(common).parent)
        return common, os.path.relpath(real, top), top, lines[1]
    except (OSError, IndexError, subprocess.SubprocessError):
        return real, "", None, None


def repository_location(cwd):
    """(common git dir without .git, path of cwd relative to the checkout), one bounded git call."""
    common, rel, _, _ = repository_layout(cwd)
    return common, rel


GATE_OPERAND_LIMIT = 1_000_000


def gate_argv_hash(command, cwd, top, given_top):
    """Argv with the worktree top replaced by <root>, plus the content of every operand file inside the top."""
    roots = sorted({item for item in (top, given_top) if item}, key=len, reverse=True)
    parts, contents = [], []
    for argument in command:
        shown = argument
        for root in roots:
            shown = shown.replace(root, "<root>")
        parts.append(shown)
        try:
            path = Path(argument) if os.path.isabs(argument) else Path(cwd) / argument
            real = os.path.realpath(path)
            if (os.path.commonpath([real, top]) == top and os.path.isfile(real)
                    and os.path.getsize(real) <= GATE_OPERAND_LIMIT):
                contents.append(f"{os.path.relpath(real, top)}:{hashlib.sha256(Path(real).read_bytes()).hexdigest()}")
        except (OSError, ValueError):
            continue
    return digest(*parts, "--", *contents)


def gate_toolchain_hash(command, cwd, top):
    """global.json bytes up to the checkout top, installed SDK names and the resolved tool executable."""
    parts = []
    directory = Path(os.path.realpath(cwd))
    for candidate in (directory, *directory.parents):
        file = candidate / "global.json"
        if file.is_file():
            try:
                parts.append(hashlib.sha256(file.read_bytes()).hexdigest())
            except OSError:
                parts.append("unreadable")
            break
        if str(candidate) == top:
            break
    dotnet = shutil.which("dotnet")
    if dotnet:
        sdk = Path(os.path.realpath(dotnet)).parent / "sdk"
        try:
            parts.append(",".join(sorted(item.name for item in sdk.iterdir())))
        except OSError:
            parts.append("no-sdk-list")
    argv = unwrap_command(command) or command
    tool = shutil.which(argv[0]) if argv else None
    parts.append(os.path.realpath(tool) if tool else "")
    return digest(*parts)


def gate_key(cwd, command, kind, head, dirty, stack, env, profile):
    """Worktree-independent identity of one gate run; None when it cannot be computed safely."""
    if head is None or dirty is None:
        return None
    common, rel, top, given_top = repository_layout(cwd)
    if top is None:
        return None
    return digest("gate-v1", digest(common), rel or ".", kind, head, dirty, stack or "", env,
                  gate_argv_hash(command, cwd, top, given_top), gate_toolchain_hash(command, cwd, top), profile)


def strip_target(argument):
    name = Path(argument).name
    for suffix in TARGET_SUFFIXES:
        if name.lower().endswith(suffix):
            return name[:-len(suffix)] or name
    return name


def work_shape(argv):
    """How the command works: run (no compile), build+run, build, or tool:<name>:<first operand>."""
    name = Path(argv[0]).name
    rest = argv[1:]
    if name == "dotnet" and rest:
        if rest[0] == "test":
            return "run" if "--no-build" in rest else "build+run"
        if rest[0] in ("build", "publish", "pack"):
            return "build"
        if any(arg.lower().endswith(".dll") for arg in rest) and rest[0] != "test":
            return "run"
    if is_spec_executable(argv[0]):
        return "run"
    operand = next((arg for arg in rest if not arg.startswith("-")), "")
    return f"tool:{name}:{operand}"


def work_identity(cwd, command, kind):
    """Stable identity of the work, independent of raw argv, filter values, bin paths and worktrees."""
    common, rel = repository_location(cwd)
    repo_key = digest(common)
    argv = unwrap_command(command)
    if not argv:
        return WorkIdentity(repo_key, digest(kind, repo_key, rel or ".", "other", "0"),
                            digest(kind, repo_key, rel or "."), rel or ".", "other", False)
    target = next((arg for arg in argv if arg.lower().endswith(TARGET_SUFFIXES)), None)
    if target is not None:
        project = strip_target(target)
    elif tool_stack(Path(argv[0]).name) is None:
        project = Path(argv[0]).name
    elif Path(argv[0]).name == "dotnet" and rel not in ("", "."):
        # Projectless dotnet test/build in a project directory: same identity as the project's executable.
        project = Path(rel).name
    else:
        project = rel or "."
    shape = work_shape(argv)
    filtered = any(FILTER_ARGUMENT.match(arg) for arg in argv[1:])
    return WorkIdentity(repo_key, digest(kind, repo_key, project, shape, str(int(filtered))),
                        digest(kind, repo_key, project), project, shape, filtered)


HISTORY_WINDOW = 20


class PhaseHistory:
    """One ledger read per phase start; admission scans never touch the ledger."""

    def __init__(self, records=(), now=None):
        self.now = now or datetime.now(timezone.utc)
        self.exact, self.work, self.family, self.repo, self.shape_overruns = {}, {}, {}, {}, {}
        since = self.now - timedelta(days=7)
        for record in records:
            try:
                if self.relevant(record, since):
                    self.add(record)
            except (ValueError, TypeError, KeyError, AttributeError):
                continue

    @staticmethod
    def relevant(record, since):
        return (record["startedAt"] is not None and record["outcome"] in ("passed", "failed", "timeout")
                and datetime.fromisoformat(record["ts"].replace("Z", "+00:00")) >= since)

    def add(self, record):
        for index, key in ((self.exact, record.get("fingerprint")), (self.work, record.get("workKey")),
                           (self.family, record.get("familyKey")),
                           (self.repo, (record["kind"], record["repoKey"]) if record.get("repoKey") else None)):
            if key is not None:
                index.setdefault(key, []).append(record)
        if record.get("fastBudgetExceeded") is True and record.get("source") == "shape" and record.get("repoKey"):
            self.shape_overruns.setdefault(record["repoKey"], []).append(record["ts"])

    def exact_runs(self, fingerprint):
        return self.exact.get(fingerprint, [])

    def scoped(self, fingerprint, identity):
        """Most specific non-empty history: exact command, then work, then family."""
        candidates = [self.exact_runs(fingerprint)]
        if identity is not None:
            candidates += [self.work.get(identity.work_key, []), self.family.get(identity.family_key, [])]
        return next((c for c in candidates if c), [])

    def family_overran(self, identity):
        return identity is not None and any(r.get("fastBudgetExceeded") is True
                                            for r in self.family.get(identity.family_key, []))

    def shape_breaker(self, identity):
        since = (self.now - timedelta(hours=24)).isoformat().replace("+00:00", "Z")
        stamps = self.shape_overruns.get(identity.repo_key, [])
        return sum(1 for ts in stamps if self.parsed(ts) >= self.parsed(since)) >= 3

    @staticmethod
    def parsed(stamp):
        return datetime.fromisoformat(stamp.replace("Z", "+00:00"))

    def estimate(self, identity, fingerprint, kind, default):
        """(seconds, basis): exact (>=2 runs), work, family, repo (>=3 runs), else default."""
        tiers = [(self.exact.get(fingerprint), 2, "exact")]
        if identity is not None:
            tiers += [(self.work.get(identity.work_key), 1, "work"), (self.family.get(identity.family_key), 1, "family"),
                      (self.repo.get((kind, identity.repo_key)), 3, "repo")]
        for runs, needed, basis in tiers:
            if runs and len(runs) >= needed:
                return float(percentile([r["runS"] for r in runs[-HISTORY_WINDOW:]], 50)), basis
        return float(default), "default"


def load_history(state):
    try:
        records, _ = read_ledger(state, days=8)
    except (OSError, ValueError) as exc:
        note(f"fast history unavailable: {exc}")
        records = []
    return PhaseHistory(records)


def begin_test_attribution(state, token):
    """A generation change remembers even a peer that exits between Docker polls."""
    paths = [p for p in state.glob("*.lock")
             if p.name.startswith(("heavy-", "integration-", "ci-", "fast-"))]
    prior = {p: metadata(p.with_suffix(".json")) for p in paths}
    competitors = [entry for entry in prior.values() if entry.get("token") != token
                   and entry.get("kind") not in ("build", "ci")]
    live = live_groups(0.5) if any(lease_groups(entry) for entry in competitors) else set()
    solo = live is not None
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        for path in state.glob("*.lock"):
            if not path.name.startswith(("heavy-", "integration-", "ci-", "fast-")):
                continue
            entry = metadata(path.with_suffix(".json"))
            if entry.get("token") == token or entry.get("kind") in ("build", "ci"):
                continue
            fd = lock_file(path)
            busy = fd is None
            if fd is not None:
                unlock(fd)
            if (busy or entry.get("unreadable") or entry != prior.get(path, {})
                    or live is None or lease_groups(entry) & live):
                solo = False
        save(state / "test-generation.json", {"token": token})
    return token if solo else None


def record_container_test(state, fingerprint, attribution=None, family_key=None):
    # A later peer invalidates attribution even after its lease has disappeared.
    if attribution is None or metadata(state / "test-generation.json").get("token") != attribution:
        return
    # Separate from admission: a slow hint must never hold the coordinator.
    with open(state / "container-tests.guard", "a+b") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        known = metadata(state / "container-tests.json")
        known[fingerprint] = True
        if family_key:
            known[f"family:{family_key}"] = True
        save(state / "container-tests.json", known)


def container_test_poller(state, fingerprint, started, stopped, attribution=None, family_key=None):
    """Read-only Docker probe in a daemon; neither join nor delay the phase."""
    while not stopped.is_set():
        try:
            result = subprocess.run(
                ["docker", "ps", "--filter", "label=org.testcontainers=true",
                 "--format", "{{.ID}} {{.CreatedAt}}"],
                capture_output=True, text=True, timeout=5, check=True)
            for line in result.stdout.splitlines():
                fields = line.split()
                if len(fields) < 4:
                    continue
                created = datetime.strptime(" ".join(fields[1:4]),
                                            "%Y-%m-%d %H:%M:%S %z").timestamp()
                if created > started and not stopped.is_set():
                    note("hint: this test phase started Testcontainers containers; CI usually "
                         "runs these as integration — use --kind integration or CI's filter")
                    record_container_test(state, fingerprint, attribution, family_key)
                    return
        except (OSError, ValueError, subprocess.SubprocessError):
            pass  # Detection is best effort, including missing/unavailable Docker.
        if stopped.wait(15):
            return


def dump_warning(message):
    """Advisory output must never turn a producer's exit into a wrapper failure."""
    try:
        note(f"warning: {message}")
    except (OSError, ValueError):
        pass


def dump_command_segments(command, depth=0):
    """Inspect literal shell segments only; never expand or execute shell code."""
    command = unwrap_command(command, stop_at_shell=True) or command
    if depth >= 20 or len(command) < 3:
        yield command
        return
    if Path(command[0]).name not in ("sh", "bash") or command[1] != "-c":
        yield command
        return
    for segment in dump_shell_segments(command[2]):
        yield from dump_command_segments(segment, depth + 1)


def dump_shell_escape(characters):
    following = next(characters, "")
    return "" if following == "\n" else "\\" + following


def dump_shell_quoted(characters, quote):
    literal = [quote]
    for character in characters:
        if character == "\\" and quote == '"':
            literal.append(dump_shell_escape(characters))
            continue
        literal.append(character)
        if character == quote:
            break
    return "".join(literal)


def dump_shell_fragments(script):
    """Keep quoted/escaped literals atomic; remove only shell continuations."""
    characters = iter(script)
    word_start = True
    for character in characters:
        if character == "#" and word_start:
            yield next((item for item in characters if item == "\n"), "")
            word_start = True
            continue
        if character in ("'", '"'):
            fragment = dump_shell_quoted(characters, character)
        elif character == "\\":
            fragment = dump_shell_escape(characters)
        else:
            fragment = character
        if fragment:
            yield fragment
            word_start = fragment.isspace() or fragment in ";&|()"


def dump_shell_segments(script):
    # Inspect literal words only: no expansion, substitution or execution.
    segment = []
    for fragment in chain(dump_shell_fragments(script), ("\n",)):
        if fragment not in (";", "&", "|", "(", ")", "\n"):
            segment.append(fragment)
            continue
        try:
            yield shlex.split("".join(segment))
        except ValueError:
            pass  # Malformed shell text is best effort, like unwrap_command.
        segment = []


def dump_command_options(command):
    options = {}
    for argument, following in zip(command, command[1:] + [""]):
        name, separator, value = argument.partition("=")
        if not separator:
            name, separator, value = argument.partition(":")
        options[name] = value if separator else following
    return options


def dump_option_end(command):
    """Find the inner argv's runsettings boundary, not an env/nice separator."""
    inner = unwrap_command(command, stop_at_shell=True)
    if inner is None or "--" not in inner:
        return len(command)
    return len(command) - len(inner) + inner.index("--")


def hang_dump_defaults(command, diagnose_hang=False):
    """Only append options to direct argv; shell strings remain warning-only."""
    if diagnose_hang:
        return {}
    inner = unwrap_command(command, stop_at_shell=True)
    if not inner:
        return {}
    if Path(inner[0]).name in ("sh", "bash", "zsh", "dash", "ksh", "fish"):
        return {}
    options = dump_command_options(inner[:dump_option_end(inner)])
    defaults = {}
    for flags, dump_type, value in (
            (("--blame-hang", "--blame-hang-timeout"), "--blame-hang-dump-type", "none"),
            (("--hangdump",), "--hangdump-type", "Mini")):
        if any(flag in options for flag in flags) and dump_type not in options:
            defaults[dump_type] = value
    return defaults


HANG_TIMEOUT_DEFAULTS = dict(seconds=150, kinds=["test"], paths=[])
HANG_TIMEOUT_MARGIN_S = 30


def hang_timeout_config(value, warn=None):
    """{"mode": "off"|"on", "seconds", "kinds", "paths"}; anything invalid means off."""
    warn = warn or note
    off = dict(mode="off")
    if not isinstance(value, dict):
        warn(f"invalid hang_timeout; using default {off!r}")
        return off
    for key in value.keys() - HANG_TIMEOUT_DEFAULTS.keys() - {"mode"}:
        warn(f"unknown hang_timeout key {key}; ignored")
    settings = {key: value.get(key, default) for key, default in HANG_TIMEOUT_DEFAULTS.items()}
    valid = (type(settings["seconds"]) is int and 1 <= settings["seconds"] <= 3600
             and isinstance(settings["kinds"], list) and set(settings["kinds"]) <= {"build", "test"}
             and isinstance(settings["paths"], list) and all(type(item) is str for item in settings["paths"]))
    if value.get("mode", "off") not in ("off", "on") or not valid:
        warn(f"invalid hang_timeout; using default {off!r}")
        return off
    return off if value.get("mode", "off") == "off" else dict(settings, mode="on")


def test_runner_is_mtp(cwd):
    """True (or unknown) when the nearest global.json up to the git top selects Microsoft.Testing.Platform."""
    directory = Path(os.path.realpath(cwd))
    for candidate in (directory, *directory.parents):
        file = candidate / "global.json"
        if file.is_file():
            try:
                data = json.loads(file.read_text())
                runner = data.get("test", {}).get("runner")
            except (OSError, ValueError, AttributeError):
                return True  # Unreadable runner choice: do not risk an unsupported option.
            return runner == "Microsoft.Testing.Platform"
        if (candidate / ".git").exists():
            break
    return False


def hang_timeout_skip_reason(command, args, settings, cwd):
    """None when the hang timeout applies, else why not (empty string for silent skips)."""
    if settings["mode"] != "on" or args.kind not in settings["kinds"] or args.kind in ("integration", "ci"):
        return ""
    if (getattr(args, "no_hang_timeout", False) or args.diagnose_hang
            or args.vstest_hang_minutes is not None):
        return ""
    inner = unwrap_command(command, stop_at_shell=True)
    if not inner or Path(inner[0]).name != "dotnet" or inner[1:2] != ["test"]:
        return ""  # Shell strings and scripts (Tier 1 gates) keep CI's timeouts.
    if any(re.match(r"--(blame|hangdump|testing-platform)", argument) for argument in inner):
        return ""
    real = os.path.realpath(cwd)
    inherited = main_worktree(real) if settings["paths"] else None
    candidates = (real, inherited) if inherited is not None else (real,)
    if settings["paths"] and not any(fnmatch.fnmatchcase(path, os.path.expanduser(pattern))
                                     for path in candidates for pattern in settings["paths"]):
        return ""
    if settings["seconds"] > args.timeout - HANG_TIMEOUT_MARGIN_S:
        return ""
    if test_runner_is_mtp(real):
        return "hang timeout skipped: global.json selects Microsoft.Testing.Platform"
    return None


def apply_hang_timeout(command, args, settings, cwd):
    """Append --blame-hang-timeout (no dump) to a direct VSTest dotnet test at the dump-injection boundary."""
    reason = hang_timeout_skip_reason(command, args, settings, cwd)
    if reason is not None:
        if reason:
            note(reason)
        return command
    seconds = settings["seconds"]
    injected = ["--blame-hang-timeout", f"{seconds}s", "--blame-hang-dump-type", "none"]
    if getattr(args, "ledger", None) is not None:
        args.ledger.record["hangTimeoutS"] = seconds
    note(f"hang timeout {seconds}s injected (hang_timeout; pass --no-hang-timeout to opt out)")
    boundary = dump_option_end(command)
    return [*command[:boundary], *injected, *command[boundary:]]


PROFILES = ("iterate", "full")
ITERATE_PROPERTIES = ("RunAnalyzers=false", "EnforceCodeStyleInBuild=false")


def apply_profile(command, profile, kind):
    """The opt-in iterate profile: no analyzers or style enforcement for a direct `dotnet build|test` argv.

    Shell strings, scripts and other tools are left alone (and a note says so); a property the caller already
    sets is respected. Iterate runs are recorded as such and are never ship evidence."""
    if profile != "iterate" or kind not in ("build", "test", "integration"):
        return command
    inner = unwrap_command(command, stop_at_shell=True)
    if not inner or Path(inner[0]).name != "dotnet" or inner[1:2] not in (["build"], ["test"]):
        note("profile iterate: no dotnet build/test argv to adjust; running unchanged")
        return command
    added = [f"-p:{item}" for item in ITERATE_PROPERTIES
             if not any(re.match(rf"^[-/]p(roperty)?[:=]{item.split('=')[0]}=", argument, re.I) for argument in inner)]
    note("profile iterate: " + (" ".join(added) or "caller already sets the properties")
         + " (analyzers/style off; not ship evidence)")
    boundary = dump_option_end(command)
    return [*command[:boundary], *added, *command[boundary:]]


def prepare_dump_command(command, diagnose_hang=False):
    defaults = hang_dump_defaults(command, diagnose_hang)
    warn_full_dumps(command, diagnose_hang, ignored_types=defaults)
    if not defaults:
        return command
    injected = [argument for option in defaults.items() for argument in option]
    boundary = dump_option_end(command)
    print(f"pi-phase: injected {' '.join(injected)} "
          "(no dump type given; pass --diagnose-hang or an explicit type to keep a dump)",
          file=sys.stderr, flush=True)
    return [*command[:boundary], *injected, *command[boundary:]]


def warn_full_dumps(command, diagnose_hang=False, ignored_types=()):
    """Inspect argv before the no-dump preset, ignoring types fixed by injection."""
    for segment in dump_command_segments(command):
        warn_full_dump_options(dump_command_options(segment), diagnose_hang, ignored_types)


def dump_option_advice(dump_type):
    default = "omit dump options"
    if dump_type == "--blame-hang-dump-type":
        default = f"add {dump_type} none"
    return f"{default}; use pi-phase run --diagnose-hang with mini only when diagnosing a hang"


def warn_explicit_dump_type(value, dump_type, advice, diagnose_hang):
    if value == "full":
        dump_warning(f"{dump_type} full writes full dumps (GBs); {advice}")
    elif value == "mini" and not diagnose_hang:
        dump_warning(f"{dump_type} mini writes dumps without --diagnose-hang; {advice}")


def warn_full_dump_options(options, diagnose_hang=False, ignored_types=()):
    reported = set()
    for flag, dump_type in (
            ("--blame-hang", "--blame-hang-dump-type"),
            ("--blame-crash", "--blame-crash-dump-type"),
            ("--blame", "--blame-crash-dump-type"),
            ("--hangdump", "--hangdump-type"),
            ("--crashdump", "--crashdump-type")):
        if dump_type in ignored_types:
            continue
        advice = dump_option_advice(dump_type)
        if flag in options and dump_type not in options:
            dump_warning(f"{flag} without {dump_type} writes full dumps (GBs); {advice}")
        elif dump_type not in reported:
            # --blame and --blame-crash share a dump type; report it only once.
            warn_explicit_dump_type(options.get(dump_type, "").lower(), dump_type, advice, diagnose_hang)
            reported.add(dump_type)


def dump_scan_active(remaining, deadline):
    return remaining[0] > 0 and time.monotonic() < deadline


def dump_directory_entries(directory, deadline, remaining):
    """Share one entry budget across directories, including skipped entries."""
    try:
        with os.scandir(directory) as entries:
            while dump_scan_active(remaining, deadline):
                entry = next(entries, None)
                if entry is None:
                    return
                remaining[0] -= 1
                if entry.name not in ("node_modules", ".git", "obj", "bin"):
                    yield entry
    except OSError:
        pass


def dump_scan_entries(cwd, deadline):
    """Traverse to depth six without symlinks, for at most 20,000 entries / 2 s."""
    pending = [(Path(cwd), 0)]
    remaining = [20000]
    while pending and dump_scan_active(remaining, deadline):
        directory, depth = pending.pop()
        for entry in dump_directory_entries(directory, deadline, remaining):
            yield entry
            try:
                if depth < 5 and entry.is_dir(follow_symlinks=False):
                    pending.append((Path(entry.path), depth + 1))
            except OSError:
                pass


def large_dump_files(cwd, deadline):
    """Yield at most five regular dumps of at least 1 GiB within the scan budget."""
    found = 0
    for entry in dump_scan_entries(cwd, deadline):
        try:
            if not entry.name.endswith(".dmp") or not entry.is_file(follow_symlinks=False):
                continue
            size = entry.stat(follow_symlinks=False).st_size
            if time.monotonic() >= deadline:
                return
            if size < 1 << 30:
                continue
            yield f"{os.path.relpath(entry.path, cwd)} ({size / (1 << 30):.2f} GiB)"
            found += 1
            if found == 5:
                return
        except OSError:
            pass


def warn_large_dumps(cwd):
    # A stalled filesystem call must not hold up phase completion beyond the scan budget.
    found = []
    deadline = time.monotonic() + 2

    def scan():
        try:
            found.extend(large_dump_files(cwd, deadline))
        except (OSError, ValueError):
            pass

    try:
        worker = threading.Thread(target=scan, daemon=True)
        worker.start()
        worker.join(max(0, deadline - time.monotonic()))
        if found:
            dump_warning("dump file(s) over 1 GiB left behind: " + " ... ".join(found[:5]))
            try:
                note("hint: delete them once you have the stack (dotnet-dump analyze → clrstack -all)")
            except (OSError, ValueError):
                pass
    except (OSError, RuntimeError, ValueError):
        pass  # Best effort, including unavailable threads or a closed output stream.


def cold_worktree(cwd):
    """At most 1000 entries, three levels, no symlink traversal or git subprocess."""
    cwd = Path(cwd).resolve()
    for top in (cwd, *cwd.parents):
        if (top / ".git").is_file():
            break
        if (top / ".git").is_dir():
            return False
    else:
        return False
    pending = [(top, 0)]
    budget = 1000
    try:
        while pending:
            directory, depth = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    budget -= 1
                    if budget < 0:
                        return False  # Inconclusive, not necessarily cold.
                    if entry.name in ("node_modules", ".git") or not entry.is_dir(follow_symlinks=False):
                        continue
                    if entry.name == "obj":
                        return False
                    if depth < 2:
                        pending.append((Path(entry.path), depth + 1))
    except OSError:
        return False
    return True


def lock_file(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_CLOEXEC", 0), 0o600)
    os.set_inheritable(fd, False)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


WORKTREE_ENV = "PI_PHASE_WORKTREE_LOCK"
HOLDER_ENV = "PI_PHASE_HOLDER"
HOLDER_ROOT_ENV = "PI_PHASE_HOLDER_ROOT"
HOLDER_SLOTS_ENV = "PI_PHASE_HOLDER_SLOTS"
HOLDER_STATE_ENV = "PI_PHASE_HOLDER_STATE"


def worktree_root(cwd):
    for _ in range(2):
        try:
            result = subprocess.run(["git", "--no-optional-locks", "rev-parse", "--show-toplevel"],
                                    cwd=cwd, env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"),
                                    capture_output=True, text=True, timeout=3)
            return os.path.realpath(result.stdout.strip() if result.returncode == 0 else cwd)
        except (OSError, subprocess.TimeoutExpired):
            pass
    note("worktree root unknown (git probe failed); locking cwd")
    return os.path.realpath(cwd)


def worktree_paths(state, root):
    directory = state / "worktrees"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = hashlib.sha256(os.fsencode(root)).hexdigest()[:32]
    return directory / f"{key}.lock", directory / f"{key}.json", key


def worktree_group_paths(path):
    return path.with_suffix(".groups").glob("*.json")


def worktree_groups_alive(path, info):
    groups = [info, *(metadata(group) for group in worktree_group_paths(path))]
    return any(group_alive(group) is not False for group in groups)


class WorktreeLease:
    """Close-only lock reference with an independent guard for this producer group."""
    def __init__(self, path, fd, info, inherited=False):
        self.path, self.fd, self.info, self.inherited = path, fd, info, inherited
        self.group_path = path.with_suffix(".groups") / f"{uuid.uuid4().hex}.json"

    def publish(self, pgid):
        self.group_path.parent.mkdir(mode=0o700, exist_ok=True)
        # Each invocation has its own record: nested publishers cannot overwrite peers.
        save(self.group_path, dict(token=self.info["token"], pgid=pgid))
        if not self.inherited:
            self.info["pgid"] = pgid
            save(self.path.with_suffix(".json"), self.info)

    def retire_group(self):
        if not self.inherited:
            # The caller verified this producer group empty: its numeric id can be reused.
            self.info.pop("pgid", None)
            self.info["retired"] = True
            save(self.path.with_suffix(".json"), self.info)
        self.group_path.unlink(missing_ok=True)

    def close(self, safe):
        try:
            if safe:
                self.retire_group()
        finally:
            # Nested leases have a group guard but never a lock descriptor.
            if self.fd is not None:
                os.close(self.fd)


def process_snapshot():
    listing = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="],
                             capture_output=True, text=True, timeout=2, check=True).stdout
    return {int(p[0]): (int(p[1]), int(p[2]), p[3])
            for line in listing.splitlines() if len(p := line.split()) == 4}


def holder_ancestry(info):
    """A token alone is not authority: require a live holder and producer ancestry."""
    try:
        rows = process_snapshot()
        producer, holder = info["pid"], info["holderPid"]
        if any(pid not in rows or rows[pid][2].startswith("Z") for pid in (producer, holder)):
            return False
        if rows[producer][1] != info["pgid"] or rows[producer][0] != holder:
            return False
        current, seen = os.getpid(), set()
        if rows.get(current, (None, None, ""))[1] == info["pgid"]:
            return True
        while current in rows and current not in seen:
            if current == producer:
                return True
            seen.add(current)
            current = rows[current][0]
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        pass
    return False


def nested_holder(state, root):
    """Validate live slot ownership under the coordinator; never inherit lock FDs."""
    token = os.environ.get(HOLDER_ENV, "")
    if (not re.fullmatch(r"[a-f0-9]{32}", token)
            or os.environ.get(HOLDER_STATE_ENV) != os.path.realpath(state)
            or os.environ.get(HOLDER_ROOT_ENV) != root):
        return None
    try:
        slots = json.loads(os.environ.get(HOLDER_SLOTS_ENV, "null"))
        if (not isinstance(slots, list) or not slots or len(slots) > 3
                or any(not isinstance(name, str) or not re.fullmatch(
                    r"(?:heavy|integration|fast)-[0-9]+\.lock|direct-[a-f0-9]{32}\.lock", name) for name in slots)):
            return None
        with open(state / "coordinator.lock", "a+b") as coordinator:
            fcntl.flock(coordinator, fcntl.LOCK_EX)
            records = [metadata((state / name).with_suffix(".json")) for name in slots]
            info = records[0]
            if (any(record != info for record in records) or info.get("token") != token
                    or info.get("root") != root or not all(readonly_busy(state / name) for name in slots)):
                return None
        if holder_ancestry(info):
            return dict(info, slots=slots)
    except (OSError, ValueError, TypeError):
        pass
    return None


def holder_environment(state, root, held, token, environment, holder=None):
    environment = dict(os.environ if environment is None else environment)
    for name in (HOLDER_ENV, HOLDER_ROOT_ENV, HOLDER_SLOTS_ENV, HOLDER_STATE_ENV, "PI_PHASE_WORKTREE_HELD"):
        environment.pop(name, None)
    if holder or held:
        environment.update({HOLDER_ENV: holder["token"] if holder else token,
                            HOLDER_ROOT_ENV: root, HOLDER_STATE_ENV: os.path.realpath(state),
                            HOLDER_SLOTS_ENV: json.dumps(holder["slots"] if holder else [p.name for p, _ in held])})
    return environment


def nested_group(state, holder, pgid, safe=None):
    """Preserve slot orphan guards even if the outer supervisor exits first."""
    if not holder:
        return True
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        if safe is None and any(
                (info := metadata((state / name).with_suffix(".json"))).get("token") != holder["token"]
                or info.get("retired") for name in holder["slots"]):
            return False  # Registration succeeds only while the parent still owns every slot.
        for name in holder["slots"]:
            path = (state / name).with_suffix(".json")
            info = metadata(path)
            if info.get("token") != holder["token"]:
                continue
            groups = set(info.get("nestedGroups", []))
            if safe is None:
                groups.add(pgid)
            elif safe:
                groups.discard(pgid)
            info["nestedGroups"] = sorted(groups)
            save(path, info)
    return True


def worktree_waiters(state, readonly=False):
    waiters = []
    for path in (state / "worktrees" / "waiting").glob("*.json"):
        try:
            fd = os.open(path, os.O_RDONLY)
        except FileNotFoundError:
            continue
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                with os.fdopen(fd, "r", closefd=False) as stream:
                    waiters.append(json.load(stream))
            else:
                if not readonly:
                    path.unlink(missing_ok=True)
        finally:
            os.close(fd)
    return sorted(waiters, key=lambda w: (w["enqueued"], w["token"]))


class WorktreeAdmission:
    def __init__(self, state, args, token):
        self.opt_out = getattr(args, "no_worktree_lock", False)
        if args.kind == "build" and self.opt_out:
            raise ValueError("--no-worktree-lock is not allowed: build writes the worktree")
        self.state, self.args, self.token = state, args, token
        self.root = None
        self.lease = None
        self.holder = None
        self.result = "error"

    def register(self):
        directory = self.state / "worktrees" / "waiting"
        directory.mkdir(mode=0o700, exist_ok=True)
        path = directory / f"{self.token}.json"
        temporary = path.with_suffix(".tmp")
        fd = lock_file(temporary)
        try:
            data = dict(token=self.token, key=self.key, root=self.root, label=self.args.label,
                        kind=self.args.kind, pid=os.getpid(), enqueued=time.time(), policy=self.args.policy)
            os.write(fd, json.dumps(data).encode())
            os.replace(temporary, path)
            return path, fd
        except BaseException:
            os.close(fd)
            temporary.unlink(missing_ok=True)
            raise

    def claim(self):
        waiters = [w for w in worktree_waiters(self.state) if w["key"] == self.key]
        if waiters and waiters[0]["token"] != self.token:
            return None
        fd = lock_file(self.path)
        if fd is None:
            return None
        try:
            info = metadata(self.info_path)
            if worktree_groups_alive(self.path, info):
                return None
            self.publish_holder(fd, info)
            fd = None
            return self.lease
        finally:
            if fd is not None:
                os.close(fd)

    def publish_holder(self, fd, previous):
        residual = list(worktree_group_paths(self.path))
        for group in residual:
            group.unlink(missing_ok=True)
        if previous and (residual or not previous.get("retired")):
            note(f"recovered stale worktree lock (was {previous.get('label', '?')} pid {previous.get('pid', '?')})")
        info = dict(token=self.token, pid=os.getpid(), label=self.args.label, kind=self.args.kind,
                    root=self.root, policy=self.args.policy, acquired=time.time())
        save(self.info_path, info)
        self.lease = WorktreeLease(self.path, fd, info)

    def wait(self, deadline, cancelled):
        waiting, waiter_fd = self.register()
        previous = None
        heartbeat = time.monotonic() + HEARTBEAT
        try:
            while True:
                if cancelled():
                    return "cancelled", None
                info = metadata(self.info_path)
                if time.monotonic() >= deadline:
                    return "timeout", info
                if self.claim():
                    return "held", self.lease
                holder = info.get("token", "unknown")
                if holder != previous:
                    note(f"waiting for worktree lock (held by {info.get('label', '?')} pid {info.get('pid', '?')})")
                    previous = holder
                if time.monotonic() >= heartbeat:
                    note(f"queued kind={self.args.kind} label={self.args.label} worktree root={self.root} id={self.token[:12]}")
                    heartbeat = time.monotonic() + HEARTBEAT
                time.sleep(min(.5, max(0, deadline - time.monotonic())))
        finally:
            waiting.unlink(missing_ok=True)
            os.close(waiter_fd)

    def acquire(self, deadline, cancelled, ledger):
        if os.environ.get(WORKTREE_ENV) == "0":
            self.root = worktree_root(os.getcwd())
            if self.args.kind != "ci":
                self.holder = nested_holder(self.state, self.root)
            self.result = "disabled"
            return None
        started = time.monotonic()
        try:
            self.result, value = self.admit(deadline, cancelled)
            return self.exit_code(value, cancelled, ledger)
        finally:
            if ledger:
                ledger.record.update(worktreeLock=self.result, worktreeWaitS=round(time.monotonic() - started, 1),
                                     worktreeRoot=self.root)
                # waitS and its telemetry continue to describe global admission only.
                ledger.queued = time.monotonic()

    def admit(self, deadline, cancelled):
        if self.args.kind == "ci":
            return "skipped", None
        self.root = worktree_root(os.getcwd())
        self.holder = nested_holder(self.state, self.root)
        if self.opt_out:
            return "skipped", None
        self.path, self.info_path, self.key = worktree_paths(self.state, self.root)
        info = metadata(self.info_path)
        if (self.holder and info.get("token") == self.holder["token"] and readonly_busy(self.path)):
            self.lease = WorktreeLease(self.path, None, info, inherited=True)
            note(f"nested admission under parent phase {self.holder.get('label', '?')}")
            return "nested", self.lease
        self.holder = None
        return self.wait(deadline, cancelled)

    def exit_code(self, value, cancelled, ledger):
        if self.result not in ("timeout", "cancelled"):
            return None
        if ledger:
            ledger.outcome("queue-timeout" if self.result == "timeout" else "cancelled")
        if self.result == "timeout":
            queue_timeout_note(self.args.queue_timeout)
            note(f"worktree lock still held by {value.get('label', '?')} pid {value.get('pid', '?')}")
            return 75
        note("cancelled while waiting for worktree lock")
        return 128 + cancelled()

    def publish(self, pgid):
        if self.lease:
            self.lease.publish(pgid)

    def close(self, safe):
        if self.lease:
            self.lease.close(safe)


def worktree_status(state):
    owners = []
    for path in sorted((state / "worktrees").glob("*.lock")):
        info = metadata(path.with_suffix(".json"))
        busy = readonly_busy(path)
        if busy or worktree_groups_alive(path, info):
            owners.append((info, not busy))
    now = time.time()
    lines = []
    for info, orphan in owners:
        age = max(0, int(now - info.get("acquired", now)))
        lines.append(f"worktree-lock root={info.get('root', '?')} holder={info.get('label', '?')} "
                     f"pid={info.get('pid', '?')} kind={info.get('kind', '?')} held={age}s"
                     f"{' orphan-group' if orphan else ''}")
    for waiter in worktree_waiters(state, readonly=True):
        age = max(0, int(now - waiter["enqueued"]))
        lines.append(f"worktree-wait root={waiter['root']} label={waiter['label']} "
                     f"pid={waiter['pid']} kind={waiter['kind']} waited={age}s")
    for line in lines:
        note(line)


def group_liveness(pgid, timeouts=(2,)):
    """Return live/empty/unknown without treating failed probes as empty."""
    for timeout in timeouts:
        try:
            listing = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="],
                                     capture_output=True, text=True, timeout=timeout, check=True).stdout
            return any(int(parts[1]) == pgid and not parts[2].startswith("Z")
                       for line in listing.splitlines() if len(parts := line.split()) >= 3)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    if len(timeouts) > 1:
        failure_note(f"group probe pgid={pgid} liveness=unknown probe_attempts_failed={len(timeouts)}")
    return None


def live_group_members(pgid, timeouts=(2,)):
    """macOS can return EPERM for a group containing only an unreaped zombie."""
    return group_liveness(pgid, timeouts) is not False  # Unknown is never safe to release.


def live_groups(timeout):
    """One bounded process-list snapshot for orphan guards, outside the coordinator."""
    if timeout <= 0:
        return None
    try:
        listing = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="],
                                 capture_output=True, text=True, timeout=timeout, check=True).stdout
        return {int(parts[1]) for line in listing.splitlines()
                if len(parts := line.split()) >= 3 and not parts[2].startswith("Z")}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None  # Unknown: never admit an orphaned slot on a failed probe.


def lease_groups(info):
    return {pgid for pgid in [info.get("pgid"), *info.get("nestedGroups", [])]
            if type(pgid) is int and pgid > 1}


def group_alive(info, timeouts=(2,)):
    for pgid in lease_groups(info):
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            pass
        if live_group_members(pgid, timeouts):
            return True
    return False


def metadata(path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (ValueError, OSError):
        return {"label": "unreadable metadata", "unreadable": True}


def save(path, data):
    temp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with open(temp, "x") as stream:
            json.dump(data, stream)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def slot_paths(state, kind, heavy, integration, ci_key):
    if kind == "ci":
        key = hashlib.sha256("\0".join(ci_key).encode()).hexdigest()
        return [[state / f"ci-{key}.lock"]]
    heavy_paths = [state / f"heavy-{n}.lock" for n in range(heavy)]
    if kind == "integration":
        return [[h, state / f"integration-{n}.lock"] for h in heavy_paths for n in range(integration)]
    return [[h] for h in heavy_paths]


PRIORITIES = {"low": 0, "normal": 1, "high": 2}
APPROVAL_REQUIRED = ("high priority needs user approval (grant with: pi-phase grant-priority, "
                     "or /phase-priority allow in pi)")


def priority_grant(state):
    """Validate and discard unusable grants; caller holds the coordinator."""
    path = state / "priority-grant.json"
    data = metadata(path)
    uses = data.get("uses")
    valid = (set(data) == {"expires", "uses", "granted_by", "created"}
             and all(type(data.get(key)) in (int, float) and math.isfinite(data[key])
                     for key in ("expires", "created"))
             and data["expires"] > time.time() and data["expires"] > data["created"]
             and isinstance(data.get("granted_by"), str) and bool(data["granted_by"])
             and (uses is None or type(uses) is int and 1 <= uses <= 20))
    if not valid:
        path.unlink(missing_ok=True)
        return None
    return data


def consume_priority(state):
    grant = priority_grant(state)
    if grant is None:
        raise ValueError(APPROVAL_REQUIRED)
    if grant["uses"] is not None:
        grant["uses"] -= 1
        if grant["uses"]:
            save(state / "priority-grant.json", grant)
        else:
            (state / "priority-grant.json").unlink(missing_ok=True)


def grant_priority(state, uses, minutes):
    if uses is not None and not 1 <= uses <= 20:
        raise ValueError("uses must be 1-20")
    if minutes is not None and not 1 <= minutes <= 480:
        raise ValueError("minutes must be 1-480")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        now = time.time()
        save(state / "priority-grant.json", dict(expires=now + (minutes or 60) * 60,
             uses=None if minutes is not None else (uses or 1), granted_by="user", created=now))
    duration = (f"unlimited for {minutes} minutes" if minutes is not None
                else f"{uses or 1} use(s), expires in 60 minutes")
    note(f"high priority granted ({duration})")
    return 0


def revoke_priority(state):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        (state / "priority-grant.json").unlink(missing_ok=True)
    note("high priority revoked")
    return 0


def high_slot_paths(state):
    return list(state.glob("heavy-*.lock")) + list(state.glob("fast-*.lock")) + list(state.glob("direct-*.lock"))


def observe_high(state):
    """Probe orphan-guarded HIGH leases; call outside the coordinator and pass to high_count."""
    observed = {}
    for path in high_slot_paths(state):
        data = metadata(path.with_suffix(".json"))
        if data.get("priority") == "high" and lease_groups(data) and not readonly_busy(path):
            observed[path] = (data, group_alive(data))
    return observed


def high_count(state, observed=None):
    """Caller holds the coordinator; count queued and leased HIGH tokens only once.

    Orphan-group probes come from observe_high() made before the coordinator was taken. An
    observation is used only if the metadata is unchanged; anything else counts as occupied.
    Without an observation (direct callers) probes run inline.
    """
    tokens = {w["token"] for w in all_waiters(state) if w["priority"] == "high"}
    for path in high_slot_paths(state):
        data = metadata(path.with_suffix(".json"))
        if data.get("priority") != "high":
            continue
        busy = readonly_busy(path)
        if not busy and lease_groups(data):
            if observed is None:
                busy = group_alive(data)
            else:
                seen = observed.get(path)
                busy = seen is None or seen[0] != data or seen[1] is not False
        if busy:
            tokens.add(data.get("token", path.name))
    return len(tokens)


def slotless_policy(args):
    return args.kind == "ci" or getattr(args, "policy", None) == "direct"


def caller_identity():
    session = os.environ.get("PI_SESSION_ID") or None
    lane = os.environ.get("PI_ORCH_ID") or os.environ.get("PI_LANE_ID") or None
    return (session[:200] if session else None, lane[:200] if lane else None)


def approved_priority(state, priority, cap, observed=None):
    """Caller holds the coordinator; share approval and cap semantics with run."""
    if priority != "high":
        return priority, None
    if high_count(state, observed) >= cap:
        if priority_grant(state) is None:
            raise ValueError(APPROVAL_REQUIRED)
        return "normal", f"high-priority cap ({cap}) reached; queued as normal"
    consume_priority(state)
    return "high", None


def register_waiter(state, args, token):
    """Nonblocking registration, including atomic grant consumption and FIFO sequence."""
    observed = observe_high(state) if args.priority == "high" else None
    coordinator = lock_file(state / "coordinator.lock")
    if coordinator is None:
        return False, None
    path = state / ("fast-waiters" if getattr(args, "fast", False) else "waiters") / f"{token}.json"
    fd = None
    downgrade_note = None
    try:
        args.priority, downgrade_note = approved_priority(state, args.priority, getattr(args, "max_high", 3), observed)
        if slotless_policy(args):
            return True, None
        path.parent.mkdir(mode=0o700, exist_ok=True)
        counter = state / "waiter-seq.json"
        seq = metadata(counter).get("seq", 0) + 1
        save(counter, {"seq": seq})
        fd = lock_file(path)
        if fd is None:
            raise ValueError("cannot lock new waiter")
        session, lane = caller_identity()
        data = dict(token=token, pid=os.getpid(), priority=args.priority, kind=args.kind,
                    session=session, lane=lane, withdraw=1,
                    label=args.label, cwd=os.getcwd(), enqueued=time.time(), seq=seq,
                    policy=getattr(args, "policy", "queued"), source=getattr(args, "source", "default"))
        if getattr(args, "fast", False):
            data["fast"] = True
        if getattr(args, "expected", None) is not None:
            # Rank fields are written once, here, so every scan computes one total order.
            data.update(expected=float(args.expected), basis=getattr(args, "basis", "default"),
                        ageAt=data["enqueued"] + (getattr(args, "age_after", None) or 0))
            if args.priority == "low" and getattr(args, "promote_after", None) is not None:
                data["promoteAt"] = data["enqueued"] + args.promote_after
        os.write(fd, json.dumps(data).encode())
        return True, fd
    except BaseException:
        downgrade_note = None
        path.unlink(missing_ok=True)
        if fd is not None:
            unlock(fd)
        raise
    finally:
        unlock(coordinator)
        if downgrade_note:
            try:
                note(downgrade_note)
            except BaseException:
                if fd is not None:
                    deregister_waiter(state, token, fd)
                raise


def deregister_waiter(state, token, fd):
    """Keep unlink and lock release atomic with respect to queue scans."""
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        try:
            waiter_path(state, token).unlink(missing_ok=True)
        finally:
            unlock(fd)


def waiter_path(state, token):
    fast = state / "fast-waiters" / f"{token}.json"
    return fast if fast.exists() else state / "waiters" / f"{token}.json"


def withdrawal_path(state, token):
    return state / "withdrawn" / f"{token}.json"


def withdrawal(state, token):
    path = withdrawal_path(state, token)
    return metadata(path) if path.exists() else None


LEGACY_AGE_S = 600
LEGACY_EXPECTED_S = QUEUE_ORDER_DEFAULTS["default_expected_s"]


def waiter_age_at(waiter):
    return waiter.get("ageAt", waiter["enqueued"] + LEGACY_AGE_S)


def low_promoted(waiter, now):
    return waiter["priority"] == "low" and now >= waiter.get("promoteAt", math.inf)


def is_legacy_waiter(waiter):
    return "ageAt" not in waiter


def legacy_key(waiter):
    """Ranking of old-code processes: strict priority, then FIFO."""
    return (-PRIORITIES[waiter["priority"]], waiter["enqueued"], waiter["seq"])


def ranked_waiters(waiters, now):
    """With any legacy waiter present every process must agree with the old FIFO ranking, otherwise
    old and new reserve the free slot for each other and it idles."""
    if any(is_legacy_waiter(w) for w in waiters):
        return sorted(waiters, key=legacy_key)
    return sorted(waiters, key=lambda w: queue_key(w, now))


def queue_key(waiter, now):
    """Total order from waiter-file fields and the clock only, never the scanner's config.

    Priority first; then aged waiters FIFO; then the rest shortest-expected first."""
    rank = -PRIORITIES[waiter["priority"]]
    if low_promoted(waiter, now):
        # Bounded cross-class aging: a long-waiting low waiter competes as aged normal, FIFO by enqueue time.
        return (-PRIORITIES["normal"], 0, waiter["enqueued"], waiter["seq"])
    if now >= waiter_age_at(waiter):
        return (rank, 0, waiter["enqueued"], waiter["seq"])
    return (rank, 1, waiter.get("expected", LEGACY_EXPECTED_S), waiter["enqueued"], waiter["seq"])


def waiter_order(waiter, now):
    if "ageAt" in waiter and waiter["ageAt"] <= waiter["enqueued"]:
        return "fifo"
    if waiter["priority"] == "low" and now >= waiter.get("promoteAt", math.inf):
        return "aged"
    return "aged" if now >= waiter_age_at(waiter) else "short"


def all_waiters(state, cancelled=lambda: False, *, readonly=False, now=None):
    now = time.time() if now is None else now
    waiters = live_waiters(state, cancelled, readonly=readonly, now=now)
    waiters += live_waiters(state, cancelled, readonly=readonly, directory="fast-waiters", now=now)
    return ranked_waiters(waiters, now)


def live_waiters(state, cancelled=lambda: False, *, readonly=False, directory="waiters", now=None):
    """Kernel locks, not PIDs, define liveness. Caller holds the coordinator."""
    waiters = []
    for path in (state / directory).glob("*.json"):
        if cancelled():
            return []
        try:
            fd = os.open(path, os.O_RDONLY if readonly else os.O_RDWR)
        except FileNotFoundError:
            continue
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # Read the inode we probed, even if an older waiter unlinks its path.
                with os.fdopen(fd, "r", closefd=False) as stream:
                    data = json.load(stream)
                if (not isinstance(data, dict) or data.get("priority") not in PRIORITIES
                        or data.get("kind") not in ("build", "test", "integration")
                        or type(data.get("seq")) is not int
                        or type(data.get("enqueued")) not in (int, float)
                        or not math.isfinite(data["enqueued"])
                        or any(key in data and (type(data[key]) not in (int, float)
                                                or not math.isfinite(data[key]) or data[key] < 0)
                               for key in ("expected", "ageAt", "promoteAt"))):
                    raise ValueError("unreadable live waiter")
                waiters.append(data)
            else:
                if not readonly:
                    path.unlink(missing_ok=True)
        finally:
            os.close(fd)
    now = time.time() if now is None else now
    return ranked_waiters(waiters, now)


def waiter_resources(waiter, pools):
    lane = "fast" if waiter.get("fast") and pools["fast"] else "heavy"
    needed = [lane] + (["integration"] if waiter["kind"] == "integration" else [])
    if any(not pools[key] for key in needed):
        return []
    return [pools[key][0] for key in needed]


def record_order(scan, waiter, free):
    if scan is not None:
        scan["reason"] = "order" if waiter_resources(waiter, free) else "slots"


def record_candidate(scan, waiter, free, candidate):
    if scan is not None:
        scan["waiter"] = waiter
    if not candidate:
        record_order(scan, waiter, free)


def ordered_candidate(state, available, token, cancelled, scan=None):
    """Reserve satisfiable earlier waiters virtually; blocked ones take nothing."""
    pools = {key: sorted(p for p in available if p.name.startswith(key + "-"))
             for key in ("heavy", "integration", "fast")}
    free = {key: list(paths) for key, paths in pools.items()}
    for waiter in all_waiters(state, cancelled):
        candidate = waiter_resources(waiter, pools)
        if waiter.get("token") == token:
            record_candidate(scan, waiter, free, candidate)
            return candidate
        for path in candidate:
            pools[path.name.split("-", 1)[0]].pop(0)
    return []


def claim_paths(state, candidates, waiter, limits):
    paths = {path for candidate in candidates for path in candidate}
    if waiter is not None:
        paths.update(state / f"integration-{n}.lock" for n in range(limits[1]))
        fast = getattr(limits, "options", {}).get("fast_lane")
        if fast:
            paths.update(state / f"fast-{n}.lock" for n in range(fast["slots"]))
    return paths


def record_admission(scan, paths, available, admission):
    if scan is None:
        return
    totals = {pool: sum(path.name.startswith(pool + "-") for path in paths)
              for pool in ("heavy", "fast", "integration")}
    scan["busy"] = {pool: (total - sum(path.name.startswith(pool + "-") for path in available), total)
                    for pool, total in totals.items() if total > 0}
    if admission and admission.sample:
        scan["memFree"] = admission.sample[0]


def claim(state, candidates, deadline, cancelled, waiter=None, limits=None, admission=None,
          integration_ceiling=None, *, scan=None, pressure=None, cpu=None):
    """One bounded admission scan; kernel locks and metadata identity are checked atomically.

    Every probe (memory, host pressure, load average) runs here, before the coordinator lock is taken."""
    paths = claim_paths(state, candidates, waiter, limits)
    gated = any(path.name.startswith(("heavy-", "fast-", "direct-")) for path in paths)
    reason = admission.reason(deadline) if admission and gated else None
    host = pressure.reason(deadline) if pressure and gated else None
    holder = admission
    if host and pressure.mode == "enforce" and not reason:
        reason, holder = host, pressure
    elif host and pressure.mode == "enforce":
        host = None
    load = cpu.load_per_core() if cpu else None
    snapshot_paths = paths.copy()
    if reason or host or cpu:
        snapshot_paths.update(path for path in state.glob("*.lock")
                              if path.name.startswith(("heavy-", "integration-", "ci-", "fast-", "direct-")))
    if integration_ceiling is not None:
        snapshot_paths.update(state.glob("integration-*.lock"))
    prior = {}
    for path in snapshot_paths:
        if cancelled() or time.monotonic() >= deadline:
            return None
        prior[path] = metadata(path.with_suffix(".json"))
    needs_probe = any(lease_groups(entry) for entry in prior.values())
    live = live_groups(min(0.5, deadline - time.monotonic())) if needs_probe else set()
    if live is None or cancelled() or time.monotonic() >= deadline:
        return None
    coordinator = lock_file(state / "coordinator.lock")
    if coordinator is None:
        return None  # A busy coordinator is retried by the outer queue loop.
    available = {}
    memory_held = False
    try:
        for path in sorted(paths):
            if cancelled() or time.monotonic() >= deadline:
                return None
            fd = lock_file(path)
            if fd is None:
                continue
            # A new owner may have changed metadata since our snapshot.
            # Never trust a stale negative process-list result for that owner.
            entry = metadata(path.with_suffix(".json"))
            if entry != prior[path] or entry.get("unreadable") or lease_groups(entry) & live:
                unlock(fd)
                continue
            available[path] = fd
        record_admission(scan, paths, available, admission)
        if (reason or host) and phases_running(state, available, prior, live):
            if reason:
                memory_held = True
                if scan is not None:
                    scan["reason"] = "memory"
                return None
            if scan is not None:
                scan["wouldHold"] = f"host:{host}"  # observe mode: report, never hold
        eligible = (burst_available(state, available, prior, live, integration_ceiling)
                    if integration_ceiling is not None else available)
        if waiter is not None:
            candidate = ordered_candidate(state, eligible, waiter,
                                          lambda: cancelled() or time.monotonic() >= deadline, scan)
        else:
            candidate = next((c for c in candidates if all(p in eligible for p in c)), [])
            if scan is not None and not candidate:
                scan["reason"] = "slots"
        if candidate and cpu and phases_running(state, available, prior, live):
            budget = cpu.reason(cpu.running_units(state, available, prior, live), candidate, load)
            if budget and cpu.mode == "enforce":
                if scan is not None:
                    scan["reason"] = "cpu"
                candidate = []
            elif budget and scan is not None and "wouldHold" not in scan:
                scan["wouldHold"] = budget
        if candidate and not cancelled() and time.monotonic() < deadline:
            for path in candidate:
                # Reserve the slot generation: a late nested registration against the previous
                # owner is refused from now on, before the claimant publishes its own record.
                previous = metadata(path.with_suffix(".json"))
                if previous.get("token") and not previous.get("retired"):
                    save(path.with_suffix(".json"), dict(previous, retired=True))
            if waiter is not None:
                queued_path = waiter_path(state, waiter)
                info = metadata(queued_path)
                if info.get("priority") == "high":
                    # Reserve the HIGH count before unlinking; launcher publication happens later.
                    publish([(path, available[path]) for path in candidate], info)
                queued_path.unlink(missing_ok=True)
            return [(path, available.pop(path)) for path in candidate]
    finally:
        for fd in available.values():
            unlock(fd)
        unlock(coordinator)
        if memory_held:
            holder.waiting(reason)
    return None


def publish(held, info):
    for path, _ in held:
        save(path.with_suffix(".json"), info)


def release(state, held, token, safe):
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        if safe:
            for path, _ in held:
                entry = metadata(path.with_suffix(".json"))
                if entry.get("token") == token:
                    if entry.get("nestedGroups"):
                        entry.pop("pgid", None)
                        entry["retired"] = True  # Ownership ended: late nested registrations are refused.
                        save(path.with_suffix(".json"), entry)
                    else:
                        remove_lease(path)
        for _, fd in held:
            # Supervisor-only references: orphan group metadata guards crashes.
            os.close(fd)


def remove_lease(path):
    path.with_suffix(".json").unlink(missing_ok=True)
    if path.name.startswith("direct-"):
        path.unlink(missing_ok=True)


def waiter_is_mine(waiter, session, lane):
    return bool((session and session == waiter.get("session")) or (lane and lane == waiter.get("lane")))


def prune_withdrawals(state):
    for path in (state / "withdrawn").glob("*.json"):
        try:
            if path.stat().st_mtime < time.time() - 24 * 60 * 60:
                path.unlink(missing_ok=True)
        except OSError:
            pass


def withdraw_matches(waiter, args, identity):
    if args.id and not waiter.get("token", "").startswith(args.id):
        return False
    if args.label is not None and waiter.get("label") != args.label:
        return False
    return not args.mine or waiter_is_mine(waiter, *identity)


def withdraw_missing(state, token):
    admitted = token and any(metadata(path).get("token", "").startswith(token)
                             for path in state.glob("*.json"))
    if admitted:
        note(f"id={token} already admitted; withdraw never touches running phases (use cancellation)")
    else:
        note("no queued phase matches")
    return 1


def withdraw_refused(waiter, args, identity):
    if waiter.get("withdraw") != 1:
        note(f"id={waiter['token'][:12]} uses older pi-phase; cancel its process instead")
        return True
    if not waiter_is_mine(waiter, *identity) and not args.force:
        note(f"id={waiter['token'][:12]} belongs to another session/lane; use --force --reason TEXT")
        return True
    return False


def withdraw(state, args):
    if not state.exists():
        note("no queued phase matches")
        return 1
    session, lane = caller_identity()
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        waiters = all_waiters(state, readonly=True)
        matches = [waiter for waiter in waiters if withdraw_matches(waiter, args, (session, lane))]
        if not matches:
            return withdraw_missing(state, args.id)
        if len(matches) > 1 and not args.all:
            note(f"{len(matches)} queued phases match; use --all to withdraw all matches")
            return 2
        # Evaluate every refusal before any mutation, without short-circuiting diagnostics.
        refusals = [withdraw_refused(waiter, args, (session, lane)) for waiter in matches]
        if any(refusals):
            return 3
        (state / "withdrawn").mkdir(mode=0o700, exist_ok=True)
        for waiter in matches:
            token = waiter["token"]
            save(withdrawal_path(state, token), dict(token=token, at=time.time(), session=session, lane=lane,
                                                   forced=bool(args.force), reason=args.reason))
            waiter_path(state, token).unlink(missing_ok=True)
        prune_withdrawals(state)
    for waiter in matches:
        age = max(0, int(time.time() - waiter["enqueued"]))
        note(f"withdrawn id={waiter['token'][:12]} kind={waiter['kind']} label={waiter.get('label', '?')} "
             f"pid={waiter.get('pid', '?')} waited={age}s; waiter exits with 77 within ~3s")
    return 0


def reprioritize_matches(state, target):
    """Caller holds the coordinator; ownership comes from the locked file, not JSON."""
    waiters = all_waiters(state, readonly=True)
    matches = [w for w in waiters if str(w.get("pid")) == target] if target.isdecimal() else [
        w for w in waiters if w.get("label") == target]
    owned = [w for w in matches if waiter_path(state, w["token"]).stat().st_uid == os.getuid()]
    return matches, owned


def reprioritize(state, configuration, args):
    if not state.exists():
        note("no queued phase matches (already admitted/running phases cannot be reprioritized)")
        return 1
    options = config(configuration).options
    cap = options["max_high"]
    order = options["queue_order"]
    observed = observe_high(state) if args.priority == "high" else None
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        matches, owned = reprioritize_matches(state, args.target)
        if not matches:
            note("no queued phase matches (already admitted/running phases cannot be reprioritized)")
            return 1
        if not owned:
            note("queued phase belongs to another uid; only its owner can reprioritize it")
            return 3
        if len(owned) != 1:
            note("ambiguous queued phase; candidate pids: " + ", ".join(str(w.get("pid")) for w in owned))
            return 2
        waiter = owned[0]
        previous = waiter["priority"]
        if previous == args.priority:
            return 0
        priority, message = approved_priority(state, args.priority, cap, observed)
        waiter["priority"] = priority
        # A waiter lowered to low gets the same promotion deadline a low run would have had,
        # measured from its original enqueue time, so it cannot starve behind normal work.
        if (priority == "low" and "promoteAt" not in waiter and "expected" in waiter
                and order["mode"] == "shortest-first"):
            waiter["promoteAt"] = waiter["enqueued"] + order["low_promote_after_s"]
        waiter["reprioritization"] = dict(previous=previous, priority=priority, at=time.time(), uid=os.getuid())
        # The waiter holds this inode's flock for its lifetime. Replacing the path
        # would make it look dead. All queue readers hold the coordinator too.
        with open(waiter_path(state, waiter["token"]), "r+") as stream:
            stream.write(json.dumps(waiter))
            stream.truncate()
    if message:
        note(message)
    note(f"reprioritized pid={waiter.get('pid', '?')} label={waiter.get('label', '?')} priority={priority}")
    return 0


def observe_waiter(args, ledger, scan):
    waiter = scan.get("waiter", {})
    if "priority" not in waiter:
        return
    args.priority = waiter["priority"]
    if ledger:
        ledger.record["priority"] = args.priority
        if "reprioritization" in waiter:
            ledger.record["reprioritization"] = waiter["reprioritization"]


def withdrawal_text(value):
    return value[:200] if isinstance(value, str) else None


def record_withdrawal(ledger, marker):
    if ledger:
        ledger.outcome("withdrawn")
        ledger.record["withdrawal"] = dict(session=withdrawal_text(marker.get("session")),
                                          lane=withdrawal_text(marker.get("lane")),
                                          forced=bool(marker.get("forced")),
                                          reason=withdrawal_text(marker.get("reason")))


def critical_path_guidance(waiters):
    """One advisory for repeated chains or heavy work deep in the queue; no admission changes."""
    groups = {}
    for rank, waiter in enumerate(waiters, 1):
        if waiter.get("kind") not in ("build", "test", "integration"):
            continue
        label = waiter.get("label", "?")
        groups.setdefault(label, []).append(rank)
    candidates = [(label, ranks) for label, ranks in groups.items() if len(ranks) >= 2 or max(ranks) >= 4]
    if not candidates:
        return
    label, ranks = max(candidates, key=lambda item: (len(item[1]), max(item[1])))
    note(f"critical path: label={label} queued={len(ranks)} deepest_rank={max(ranks)}; "
         "with user approval, the orchestrator may time-box high priority for this one critical-path chain "
         "(pi-phase grant-priority --minutes 5); do not promote the whole queue")


def admission_status(state, fast_running, fast_slots, waiters):
    worktree_status(state)
    note(f"fast={fast_running}/{fast_slots} queued={sum(bool(w.get('fast')) for w in waiters)}")


def status(state, configuration=CONFIG):
    settings = config(configuration)
    options = settings.options
    cap = options["max_high"]
    fast_slots = options["fast_lane"]["slots"] if options["fast_lane"] else 0
    if not state.exists():
        note("no active phases")
        note(f"fast=0/{fast_slots} queued=0")
        note(f"high=0/{cap}")
        return 0
    observed = observe_high(state)
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        owners = []
        for path in sorted(state.glob("*.lock")):
            if path.name == "coordinator.lock":
                continue
            data = metadata(path.with_suffix(".json"))
            fd = lock_file(path)
            busy = fd is None
            if fd is not None:
                unlock(fd)
            owners.append((path, data, busy))
        waiters = all_waiters(state, now=time.time())
        grant = priority_grant(state)
        high = high_count(state, observed)
    # No slow ps probe or terminal write while holding the shared coordinator.
    live = live_groups(2) if any(not busy and lease_groups(data) for _, data, busy in owners) else set()
    try:
        processes = process_snapshot() if owners else {}
    except (OSError, ValueError, subprocess.SubprocessError):
        processes = None
    seen = set()
    fast_running = 0
    used = dict(heavy=0, integration=0)
    for path, data, busy in owners:
        orphan = (data.get("unreadable") or live is None or bool(lease_groups(data) & live)) if not busy else False
        if not busy and not orphan:
            continue
        for pool in used:
            used[pool] += path.name.startswith(pool + "-")
        token = data.get("token", path.name)
        if token in seen:
            continue
        seen.add(token)
        fast_running += path.name.startswith("fast-")
        age = max(0, int(time.time() - data.get("started", time.time())))
        phase_state = "orphan-group" if orphan else "running"
        if processes is not None and type(data.get("pid")) is int:
            producer = processes.get(data["pid"])
            if producer is None or producer[2].startswith("Z"):
                lingering = sorted(pid for pid, (_, pgid, state) in processes.items()
                                   if pgid in lease_groups(data) and not state.startswith("Z"))
                phase_state = f"draining pids={','.join(map(str, lingering)) or 'none'}" + (
                    " orphan-group" if orphan else "")
        note(f"{data.get('kind', 'unknown')} {data.get('label', 'unknown')} "
             f"pid={data.get('pid', '?')} cwd={data.get('cwd', '?')} "
             f"elapsed={age}s {phase_state}"
             f"{' fast' if data.get('fast') or path.name.startswith('fast-') else ''}"
             f" policy={data.get('policy', 'queued')} source={data.get('source', 'default')}")
    if not seen:
        note("no active phases")
    now = time.time()
    for rank, waiter in enumerate(waiters, 1):
        age = max(0, int(now - waiter["enqueued"]))
        note(f"queued priority={waiter['priority']} kind={waiter['kind']} "
             f"label={waiter.get('label', '?')} waited={age}s rank={rank} "
             f"expected={int(waiter.get('expected', LEGACY_EXPECTED_S))}s basis={waiter.get('basis', 'legacy')} "
             f"order={waiter_order(waiter, now)}"
             f"{' fast' if waiter.get('fast') else ''}"
             f" policy={waiter.get('policy', 'queued')} source={waiter.get('source', 'default')}"
             f" id={waiter.get('token', '?')[:12]}")
    admission_status(state, fast_running, fast_slots, waiters)
    note(f"high={high}/{cap}")
    if grant:
        remaining = "unlimited uses" if grant["uses"] is None else f"{grant['uses']} use(s) remaining"
        seconds = max(0, math.ceil(grant["expires"] - time.time()))
        expiry = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(grant["expires"]))
        note(f"high priority grant: {remaining}; expires in {seconds}s at {expiry}")
    critical_path_guidance(waiters)
    if waiters:
        note(f"slots heavy={used['heavy']}/{settings[0]} integration={used['integration']}/{settings[1]}")
    return 0


NICE_ENV = "PI_PHASE_NICE"


def apply_nice(value):
    """Lower the producer's CPU priority to at least `value` (never raises it); failures are noted, not fatal."""
    try:
        wanted = int(value) if value else 0
        current = os.getpriority(os.PRIO_PROCESS, 0)
        if wanted > current:
            os.setpriority(os.PRIO_PROCESS, 0, wanted)
    except (ValueError, OSError) as exc:
        print(f"pi-phase: nice {value!r} not applied ({exc})", file=sys.stderr, flush=True)


def launch(gate, command):
    """Internal gate: never execute a producer before its supervisor publishes metadata."""
    try:
        ready = os.read(gate, 1)
    finally:
        os.close(gate)
    if ready != b"1":
        return 125
    apply_nice(os.environ.pop(NICE_ENV, None))
    try:
        os.execvp(command[0], command)
    except OSError as exc:
        print(f"pi-phase: cannot execute {command[0]}: {exc.strerror}", file=sys.stderr, flush=True)
        return 127 if exc.errno == errno.ENOENT else 126


def zombie_unreaped(pid):
    """Inspect without reaping on Python builds lacking waitid (macOS < 3.13)."""
    try:
        status = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                                capture_output=True, text=True, timeout=0.5)
    except (OSError, subprocess.TimeoutExpired):
        return False  # Unknown: keep the PGID reserved and retry next tick.
    return status.returncode == 0 and status.stdout.lstrip().startswith("Z")


def exited_unreaped(pid, producer_exit=None):
    if not hasattr(os, "waitid"):
        # ps cannot observe the exit code; leave it unknown until the real wait.
        return zombie_unreaped(pid)
    # WNOWAIT reserves the leader PID/PGID until cleanup signals have been sent,
    # avoiding signalling a recycled, unrelated process group.
    status = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if status is not None and producer_exit is not None:
        if status.si_code == os.CLD_EXITED:
            producer_exit[0] = status.si_status
        elif status.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
            producer_exit[0] = 128 + status.si_status
    return status is not None


def cleanup_snapshot_row(line):
    """Validate a single value-free ps row before accepting any field."""
    parts = line.split()
    if len(parts) != 5:
        return None
    if not all(re.fullmatch(r"[0-9]{1,10}", value) for value in parts[:4]):
        return None
    identities = tuple(map(int, parts[:4]))
    if max(identities) > 4294967295:
        return None
    if not re.fullmatch(r"[RSDTtXZWIUKP][<NLsl+EXV-]{0,7}", parts[4]):
        return None
    return (*identities, parts[4])


def cleanup_snapshot_rows(listing, pgid, member_limit=32):
    """Accept only bounded numeric identities and ps state tokens, never raw text."""
    if len(listing) > 262144 or len(listing.encode("utf-8")) > 262144:
        return [], 0, 0, "oversized"
    parsed = [cleanup_snapshot_row(line) for line in listing.splitlines()]
    malformed = parsed.count(None)
    rows = [row for row in parsed if row is not None and row[2] == pgid]
    status = "incomplete" if malformed or len(rows) > 32 else "complete"
    return rows[:member_limit], len(rows), malformed, status


def cleanup_snapshot_observation(pgid, member_limit=32):
    """One bounded non-atomic observation; not proof of exit or signal authority."""
    try:
        result = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,pgid=,uid=,stat="],
                                capture_output=True, text=True, timeout=1, check=False)
        if result.returncode != 0:
            return [], f"completeness=unknown failure=nonzero returncode={int(result.returncode)}", "unknown"
        rows, matched, malformed, status = cleanup_snapshot_rows(result.stdout, pgid, member_limit)
        presence = "present" if any(row[0] == pgid for row in rows) else "absent_at_snapshot"
        if status != "complete" and presence != "present":
            presence = "unknown"
        return rows, (f"completeness={status} matched={matched} omitted={max(0, matched - 32)} "
                      f"malformed={malformed}"), presence
    except subprocess.TimeoutExpired:
        return [], "completeness=unknown failure=timeout", "unknown"
    except OSError as exc:
        number = exc.errno if type(exc.errno) is int else "unknown"
        return [], f"completeness=unknown failure=oserror errno={number}", "unknown"


def cleanup_snapshot(pgid, sig, leader_observation=None, snapshot=None):
    """Best effort, at most 32 rows / 8 KiB emitted; failures never escape."""
    try:
        rows, status, presence = snapshot if snapshot is not None else cleanup_snapshot_observation(pgid)
        source, observed_exit = leader_observation or ("unknown", None)
        if source not in ("waitid_wnowait", "ps_zombie"):
            source = "unknown"
        exit_value = observed_exit if type(observed_exit) is int else "unknown"
        failure_note(f"cleanup_snapshot pgid={pgid} signal={sig.name} observer=ps non_atomic=1 "
                     f"{status} leader_presence={presence} leader_observation={source} producer_exit={exit_value}")
        for pid, ppid, group, uid, state in rows[:32]:
            failure_note(f"cleanup_snapshot pid={pid} ppid={ppid} pgid={group} uid={uid} state={state}")
    except Exception:
        failure_note("cleanup_snapshot completeness=unknown failure=observer_error")


def eligible_member(pgid, row):
    """Same-user, non-zombie, non-leader member observed in this group."""
    pid, _, group, uid, state = row
    return pid != pgid and group == pgid and uid == os.getuid() and not state.startswith("Z")


def signal_group_members(pgid, sig, rows):
    """macOS may deny killpg when the reserved leader is a reparented zombie.

    Fall back only to observed, same-user live members, rechecking PGID immediately
    before each signal. Never signal the leader or anything outside this group.
    """
    signalled = []
    for row in rows:
        pid = row[0]
        if not eligible_member(pgid, row):
            continue
        try:
            if os.getpgid(pid) != pgid:
                continue
            os.kill(pid, sig)
            signalled.append(pid)
        except OSError:
            continue
    return signalled


def stop_group(pgid, leader_observation=None):
    snapshot = None  # At most one bounded observation per invocation, taken on the first EPERM.
    signalled = set()
    for sig, delay in ((signal.SIGTERM, 0.6), (signal.SIGKILL, 0.2)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            if snapshot is None:
                snapshot = cleanup_snapshot_observation(pgid, member_limit=None)
                cleanup_snapshot(pgid, sig, leader_observation, snapshot)
            rows = snapshot[0]
            targets = []
            if any(eligible_member(pgid, row) for row in rows):
                # Opportunistic only: a failed fallback preserves the original denial.
                if group_liveness(pgid, (0.5,)) is not False:
                    targets = signal_group_members(pgid, sig, rows)
            if targets:
                signalled.update(targets)
                failure_note(f"cleanup pgid={pgid} signal={sig.name} pids={','.join(map(str, targets))}")
            else:
                live = group_liveness(pgid, CLEANUP_PROBE_TIMEOUTS)
                if live is not False:
                    failure_note(f"killpg signal={sig.name} pgid={pgid} liveness={'live' if live else 'unknown'}")
                    raise
        time.sleep(delay)
    return sorted(signalled)


def failure_note(message):
    """Best-effort diagnostics must not replace failures or interrupt cleanup."""
    try:
        note(message)
    except Exception:
        pass


def supervisor_error(role, operation, proc, exc):
    # Exception strings can contain paths/arguments; report only type and errno.
    identity = "" if proc is None else f" pid={proc.pid} pgid={proc.pid}"
    failure_note(f"{role} operation={operation}{identity} error={type(exc).__name__} errno={getattr(exc, 'errno', None)}")


def cleanup_step(errors, operation, proc, action):
    try:
        return action()
    except Exception as exc:
        errors.append(exc)
        supervisor_error("cleanup", operation, proc, exc)
        return None


def producer_outcome(proc, producer_exit):
    if proc is not None and proc.returncode is not None:
        producer_exit[0] = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
    value = "unknown" if producer_exit[0] is None else producer_exit[0]
    identity = "" if proc is None else f" pid={proc.pid} pgid={proc.pid}"
    failure_note(f"producer_exit={value}{identity}; wrapper exit=125")


def bounded(value, name, approved):
    if name == "queue-timeout":
        if not math.isfinite(value) or value <= 0 or (value > 7200 and not approved):
            raise ValueError("queue-timeout must be positive and at most 7200s without --approved-long-timeout")
        return value
    if not math.isfinite(value) or value <= 0 or (value > 600 and not approved):
        raise ValueError(f"{name} must be positive and at most 600s without --approved-long-timeout")
    return value


def queue_timeout_note(timeout):
    note(f"queue timeout ({timeout:g}s); command not started")
    note("not a failed command/test attempt. Do not loop short requeues; check pi-phase status once.")
    note("If a retry is appropriate, retry once in the background (job_start if available, otherwise a background agent) "
         "with an explicit queue-sized budget (e.g. --queue-timeout 2400; keep a larger budget if appropriate).")
    note("The outer deadline must cover queue + execution + cleanup. Admission is not guaranteed; "
         "if that background retry also times out, report: gate not run: queue saturated.")


def report_log(path, tail, return_code):
    lines = 0
    recent = deque(maxlen=tail)
    with open(path, "rb") as stream:
        for line in stream:
            lines += 1
            recent.append(line)
    if recent:
        sys.stdout.flush()
        for line in recent:
            sys.stdout.buffer.write(line)
        if not recent[-1].endswith(b"\n"):
            sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
    note(f"log={path} exit={return_code} lines={lines}")


def prepare_policy(state, args, options, fingerprint, history=None, identity=None):
    args.policy, args.source = select_policy(state, args, options, fingerprint, history=history, identity=identity)
    args.fast = args.policy == "fast"
    note(f"policy={args.policy} source={args.source}")
    order = options["queue_order"]
    if history is not None:
        args.expected, args.basis = history.estimate(identity, fingerprint, args.kind, order["default_expected_s"])
        # A long job with a short queue timeout must age before it can time out.
        shortest = order["mode"] == "shortest-first"
        args.age_after = min(order["aging_s"], 0.5 * args.queue_timeout) if shortest else None
        # fifo mode: no promotion, i.e. the old strict priority classes.
        args.promote_after = (min(order["low_promote_after_s"], 0.5 * args.queue_timeout)
                              if shortest else None)
    if getattr(args, "ledger", None):
        args.ledger.record.update(fingerprint=fingerprint, fast=args.fast, policy=args.policy, source=args.source)
        if identity is not None:
            args.ledger.record.update(workKey=identity.work_key, familyKey=identity.family_key,
                                      repoKey=identity.repo_key)
        if history is not None:
            args.ledger.record.update(expectedS=round(args.expected, 1), expectedBasis=args.basis)


def phase_candidates(state, args, context):
    heavy, integration, identity, token = context
    if args.policy == "direct" and args.kind != "ci":
        # A per-run lease tracks ownership, not capacity. CI keeps its singleton watcher lock.
        return [[state / f"direct-{token}.lock"]]
    return slot_paths(state, args.kind, heavy, integration, identity)


def apply_fast_budget(args, settings, held, policy_args=None):
    limit = getattr(policy_args, "config_direct_limit", None)
    if limit is not None and any(path.name.startswith("direct-") for path, _ in held):
        budget = fast_budget(dict(max_expected_s=limit))
        args.config_direct_budget = True
        lane = "config-direct"
    elif any(path.name.startswith("fast-") for path, _ in held):
        budget = fast_budget(settings)
        lane = "fast lane"
    else:
        return None
    args.timeout = min(args.timeout, budget)
    note(f"{lane} (budget {budget:g}s)")
    return budget


def fast_timeout(args, budget):
    if budget is None or args.timeout < budget:
        return
    if getattr(args, "config_direct_budget", False):
        note("config-direct phase exceeded its budget; history will be re-evaluated on the next run")
    else:
        note("fast-lane phase exceeded its budget; rerun normally; this command family now queues")
    if getattr(args, "ledger", None):
        args.ledger.record["fastBudgetExceeded"] = True


def run(args, state, configuration, output=None):
    safe_label(args.label)
    bounded(args.timeout, "timeout", args.approved_long_timeout)
    bounded(args.queue_timeout, "queue-timeout", args.approved_long_timeout)
    if args.kind == "ci":
        if args.priority != "normal":
            raise ValueError("ci does not queue; --priority must be normal")
        if not all((args.repo, args.pr, args.commit)):
            raise ValueError("ci requires --repo, --pr, and --commit (explicit watcher identity)")
    elif any((args.repo, args.pr, args.commit)):
        raise ValueError("--repo/--pr/--commit only apply to ci")
    phase_cwd = os.getcwd()
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise ValueError("missing command after --")
    # Fingerprints/identity and PhaseLedger's argvHash retain the original argv
    # for stable history (#32), excluding injection and random preset paths.
    original_command = command[:]
    if args.kind in ("test", "integration"):
        command = prepare_dump_command(command, args.diagnose_hang)
    if args.vstest_hang_minutes is not None:
        if not args.vstest_confirmed or args.kind not in ("test", "integration"):
            raise ValueError("VSTest preset requires --vstest-confirmed and kind test/integration")
        if len(command) < 2 or Path(command[0]).name != "dotnet" or command[1] != "test" or "--testing-platform" in command:
            raise ValueError("VSTest preset requires a confirmed 'dotnet test' VSTest runner (not MTP)")
        if not 1 <= args.vstest_hang_minutes <= 60:
            raise ValueError("vstest-hang-minutes must be 1-60")
        root = subprocess.run(["git", "--no-optional-locks", "rev-parse", "--show-toplevel"], capture_output=True,
                              env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"), text=True, check=True).stdout.strip()
        results = Path(root) / ".ai-work" / "pi-phase" / uuid.uuid4().hex
        results.mkdir(parents=True)
        command += ["--blame-hang", "--blame-hang-timeout", f"{args.vstest_hang_minutes}m",
                    "--blame-hang-dump-type", "none", "--results-directory", str(results)]
        note(f"VSTest hang diagnostics (no dumps); results={results}")
    elif args.vstest_confirmed:
        raise ValueError("--vstest-confirmed requires --vstest-hang-minutes")

    ledger = getattr(args, "ledger", None)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    ci_key = (args.repo, args.pr, args.commit)
    long_queue_hint = False
    next_heartbeat = 0
    token = uuid.uuid4().hex
    worktree = WorktreeAdmission(state, args, token)
    cancelled = [None]

    def interrupt(sig, _frame):
        cancelled[0] = sig

    old_int = signal.signal(signal.SIGINT, interrupt)
    old_term = signal.signal(signal.SIGTERM, interrupt)
    held = None
    proc = None
    started = None
    return_code = 125
    safe = False
    registered = False
    waiter_fd = None
    shim_dir = None
    compiler_id = None
    detector_stopped = threading.Event()
    producer_exit = [None]
    leader_observation = None
    operation = "prepare"
    primary = None
    fingerprint = test_fingerprint(os.getcwd(), original_command)
    admission_args = argparse.Namespace(**vars(args))
    try:
        config_notes = set()
        settings = config(configuration, notes=config_notes)
        options = settings.options
        command = apply_profile(command, getattr(args, "profile", "full"), args.kind)
        command = apply_hang_timeout(command, admission_args, options["hang_timeout"], phase_cwd)
        identity = work_identity(os.getcwd(), original_command, args.kind)
        prepare_policy(state, admission_args, options, fingerprint, load_history(state), identity)
        if ledger:
            ledger.failure_categories = options["failure_categories"]
            ledger.prepare_snapshot()
            passed, failed = ledger.passed_state(state)
            warn_repeat_failure(failed)
            if (not args.rerun and os.environ.get("PI_PHASE_NO_SKIP") != "1" and args.kind != "ci"
                    and (args.kind != "integration" or options["skip_passed_integration"])):
                if passed:
                    note(f"skipped: this exact state already passed at {passed['ts']} "
                         f"(kind={args.kind} label={args.label} head={passed['head'][:7]} "
                         f"run={passed['runS']:g}s); pass --rerun to run again")
                    ledger.outcome("skipped")
                    return 0
            if (options["skip_cross_worktree"] and not args.rerun and os.environ.get("PI_PHASE_NO_SKIP") != "1"
                    and args.kind in ("build", "test")):
                if ledger.record["dirty"] is None and ledger.record["head"] is not None:
                    note("tree state too large to hash; not deduplicating")
                other = ledger.cross_worktree_passed()
                if other:
                    note(f"skipped: an identical gate already passed in {other.get('cwd')} at {other['ts']} "
                         f"(kind={args.kind} head={other['head'][:7]} run={other['runS']:g}s); "
                         "pass --rerun to run again")
                    ledger.record["dedupedFrom"] = other["ts"]
                    ledger.outcome("skipped")
                    return 0
        queued = time.monotonic()
        deadline = queued + args.queue_timeout
        worktree_code = worktree.acquire(deadline, lambda: cancelled[0], ledger)
        if worktree_code is not None:
            return worktree_code
        admission_args.max_high = options["max_high"]
        admission = MemoryAdmission(options["memory_admission"]) if options["memory_admission"] else None
        burst_settings = options["memory_admission"].get("integration_burst") if admission else None
        burst = IntegrationBurst(admission, burst_settings) if burst_settings else None
        pressure = (HostPressure(options["host_pressure"], state)
                    if options["host_pressure"]["mode"] != "off" else None)
        cpu = (CpuBudget(options["cpu_budget"], options["msbuild_max_cpu"])
               if options["cpu_budget"]["mode"] != "off" else None)
        if ledger:
            ledger.host_pressure = pressure
        if (args.kind == "test" and options["container_test_detection"] == "promote"
                and container_test_known(state, fingerprint, identity)):
            admission_args.kind = "integration"
            note("recorded container test: also claiming an integration permit (container_test_detection)")
        heavy, integration = settings
        if worktree.holder:
            held = []
        while worktree.holder is None:
            if cancelled[0]:
                note("cancelled while queued")
                if ledger:
                    ledger.outcome("cancelled")
                return 128 + cancelled[0]
            if waiter_fd is not None:
                marker = withdrawal(state, token)
                if marker is not None:
                    note("withdrawn while queued; command not started")
                    record_withdrawal(ledger, marker)
                    return EXIT_WITHDRAWN
            if not long_queue_hint and time.monotonic() - queued > 600:
                note(f"long queue ({int(time.monotonic() - queued)}s): run dev-doctor to look for contention")
                long_queue_hint = True
            if time.monotonic() >= deadline:
                queue_timeout_note(args.queue_timeout)
                if ledger:
                    ledger.outcome("queue-timeout")
                return 75
            if not registered:
                registered, waiter_fd = register_waiter(state, admission_args, token)
                if registered and ledger:
                    ledger.record["priority"] = admission_args.priority
                    ledger.enqueue()
                if not registered:
                    time.sleep(min(TICK, max(0, deadline - time.monotonic())))
                    continue
            heavy, integration = settings
            if burst and admission_args.kind == "integration":
                integration = burst.effective(integration, deadline)
            scan = {}
            held = claim(state, phase_candidates(state, admission_args, (heavy, integration, ci_key, token)),
                         deadline, lambda: bool(cancelled[0]),
                         token if waiter_fd is not None else None, PhaseConfig(heavy, integration, settings.options), admission,
                         integration if burst and admission_args.kind == "integration" else None, scan=scan,
                         pressure=pressure, cpu=cpu)
            observe_waiter(admission_args, ledger, scan)
            if cancelled[0]:
                note("cancelled during admission; command not started")
                if ledger:
                    ledger.outcome("cancelled")
                return 128 + cancelled[0]
            if held:
                if ledger:
                    ledger.admitted_with_would_hold(scan)
                if time.monotonic() >= deadline:
                    release(state, held, token, True)
                    held = None
                    queue_timeout_note(args.queue_timeout)
                    if ledger:
                        ledger.outcome("queue-timeout")
                    return 75
                break
            if ledger:
                ledger.waited(scan)
            if args.kind == "ci":
                if ledger:
                    ledger.outcome("rejected")
                note("already watching this repo/PR/commit; no second watcher started")
                return 75
            now = time.monotonic()
            if now >= deadline:
                queue_timeout_note(args.queue_timeout)
                if ledger:
                    ledger.outcome("queue-timeout")
                return 75
            if now >= next_heartbeat:
                note(f"queued kind={args.kind} label={args.label} remaining={max(0, int(deadline-now))}s id={token[:12]}")
                next_heartbeat = now + HEARTBEAT
            time.sleep(min(QUEUE_TICK + random.uniform(0, 0.5), max(0, deadline-now)))
            settings = config(configuration, notes=config_notes)
        if cancelled[0]:
            note("cancelled after admission; command not started")
            if ledger:
                ledger.outcome("cancelled")
            return 128 + cancelled[0]
        budget = apply_fast_budget(args, options["fast_lane"], held, admission_args)
        child_env = None
        cap = msbuild_cap(options["msbuild_max_cpu"], heavy)
        if cap and args.kind in ("build", "test", "integration"):
            try:
                shim_dir = tempfile.TemporaryDirectory(prefix="dotnet-shim-", dir=state)
                child_env = shim_environment(Path(shim_dir.name), cap)
            except OSError as exc:
                note(f"msbuild shim unavailable ({exc}); running uncapped")
            else:
                note(f"msbuild cap -m:{cap} (msbuild_max_cpu)")
        if options["phase_nice"] and args.kind in ("build", "test", "integration"):
            child_env = dict(os.environ if child_env is None else child_env, **{NICE_ENV: str(options["phase_nice"])})
            note(f"nice {options['phase_nice']} (phase_nice)")
        if options["cold_worktree_hint"] and args.kind in ("build", "test") and cold_worktree(os.getcwd()):
            note("cold worktree (no obj within depth 3); consider reusing a warm lane worktree")
        if args.kind in ("build", "test", "integration"):
            child_env = dict(os.environ if child_env is None else child_env)
            child_env.setdefault("DOTNET_CLI_USE_MSBUILD_SERVER", "0")
            child_env.setdefault("MSBUILDDISABLENODEREUSE", "1")
            compiler_id = shared_compilation_id(child_env, token)
            if compiler_id:
                child_env["SharedCompilationId"] = compiler_id  # MSBuild reads env vars as properties
                note(f"compiler server isolated: SharedCompilationId={compiler_id}")
        child_env = holder_environment(state, worktree.root or worktree_root(phase_cwd), held, token,
                                       child_env, worktree.holder) if args.kind != "ci" else child_env
        read_gate, write_gate = os.pipe()
        try:
            launcher = [sys.executable, str(Path(__file__).resolve()), "_launch", str(read_gate), "--", *command]
            output_options = {} if output is None else {"stdout": output, "stderr": subprocess.STDOUT}
            operation = "Popen"
            proc = subprocess.Popen(launcher, pass_fds=[read_gate], close_fds=True,
                                    start_new_session=True, env=child_env, **output_options)
            os.close(read_gate)
            read_gate = -1
            operation = "publish"
            publish(held, dict(token=token, pid=proc.pid, pgid=proc.pid, holderPid=os.getpid(),
                               root=worktree.root, cwd=os.getcwd(),
                               label=args.label, kind=args.kind, priority=admission_args.priority, started=time.time(),
                               fast=admission_args.fast, policy=admission_args.policy, source=admission_args.source))
            worktree.publish(proc.pid)
            if not nested_group(state, worktree.holder, proc.pid):
                note("parent phase released its slots during nested registration; command not started")
                return 125
            if cancelled[0]:
                note("cancelled before execution; command not started")
                if ledger:
                    ledger.outcome("cancelled")
                return 128 + cancelled[0]
            attribution = begin_test_attribution(state, token) if args.kind in ("test", "integration") else None
            detection_started = time.time()
            os.write(write_gate, b"1")
            started = time.monotonic()  # No execution budget consumed waiting for a permit.
            if ledger:
                ledger.start()
        finally:
            if read_gate != -1:
                os.close(read_gate)
            os.close(write_gate)
        note(f"running kind={args.kind} label={args.label} pid={proc.pid} timeout={args.timeout:g}s")
        if args.kind == "test" and options["container_test_detection"] != "off":
            threading.Thread(target=container_test_poller,
                             args=(state, fingerprint, detection_started, detector_stopped, attribution, identity.family_key),
                             daemon=True).start()
        next_heartbeat = started + HEARTBEAT
        running_memory = phase_memory(options, args.kind, ledger)
        next_memory = started + MEMORY_SAMPLE_INTERVAL
        while True:
            if cancelled[0]:
                note("cancelled; stopping owned process group")
                return_code = 128 + cancelled[0]
                if ledger:
                    ledger.outcome("cancelled")
                break
            operation = "waitid"
            if exited_unreaped(proc.pid, producer_exit):
                leader_observation = ("waitid_wnowait" if hasattr(os, "waitid") else "ps_zombie", producer_exit[0])
                break
            operation = "supervise"
            now = time.monotonic()
            if now - started >= args.timeout:
                note(f"phase timed out ({args.timeout:g}s); stopping owned process group")
                fast_timeout(args, budget)
                return_code = 124
                if ledger:
                    ledger.outcome("timeout")
                break
            if now >= next_memory:
                next_memory = now + MEMORY_SAMPLE_INTERVAL
                offender = running_memory.offender(proc.pid)
                if offender:
                    note(f"rss cap exceeded: pid={offender[0]} rss={offender[1]:.0f}MB > rss_cap_mb={running_memory.cap}MB "
                         f"command={offender[2][:200]}; stopping owned process group (exit {EXIT_RSS_CAP})")
                    return_code = EXIT_RSS_CAP
                    break
            if now >= next_heartbeat:
                note(f"running kind={args.kind} label={args.label} elapsed={int(now-started)}s")
                next_heartbeat = now + HEARTBEAT
            time.sleep(min(TICK, max(0, args.timeout - (now-started))))
        # Keep the group leader unreaped through both signals so its PGID cannot
        # be reused by an unrelated process, even when it exited first.
        operation = "stop_group"
        cleanup_pids = stop_group(proc.pid, leader_observation)
        try:
            operation = "wait"
            proc.wait(timeout=2)
            if return_code == 125:
                return_code = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
                if ledger and proc.returncode < 0:
                    ledger.outcome("cancelled")
        except subprocess.TimeoutExpired:
            failure_note("cleanup incomplete; lease retained while group exists")
            return_code = 125
        operation = "group_alive"
        safe = not group_alive({"pgid": proc.pid}, timeouts=CLEANUP_PROBE_TIMEOUTS)
        if not safe:
            failure_note("process group still exists; retaining orphan guard")
            return_code = 125
        if return_code == 125:
            producer_outcome(proc, producer_exit)
        note(f"finished kind={args.kind} label={args.label} exit={return_code}"
             + (f" cleanup_pids={','.join(map(str, cleanup_pids))}" if cleanup_pids else ""))
        if args.kind in ("test", "integration"):
            warn_large_dumps(phase_cwd)
        return return_code
    except BaseException as exc:
        primary = exc
        supervisor_error("primary", operation, proc, exc)
        raise
    finally:
        errors = []
        detector_stopped.set()
        if waiter_fd is not None:
            cleanup_step(errors, "deregister_waiter", proc,
                         lambda: deregister_waiter(state, token, waiter_fd))
            try:
                withdrawal_path(state, token).unlink(missing_ok=True)
            except OSError:
                pass
        # Do not reap if signals fail: the leader still reserves its PGID.
        if proc is not None and proc.returncode is None:
            before_stop = len(errors)
            cleanup_step(errors, "stop_group", proc, lambda: stop_group(proc.pid, leader_observation))
            if len(errors) == before_stop:
                cleanup_step(errors, "wait", proc, lambda: proc.wait(timeout=2))
            alive = cleanup_step(errors, "group_alive", proc,
                                 lambda: group_alive({"pgid": proc.pid}, timeouts=CLEANUP_PROBE_TIMEOUTS))
            safe = alive is False
        if proc is not None:
            cleanup_step(errors, "nested_release", proc,
                         lambda: nested_group(state, worktree.holder, proc.pid, safe))
        if held:
            cleanup_step(errors, "release", proc, lambda: release(state, held, token, safe or proc is None))
        cleanup_step(errors, "worktree_release", proc, lambda: worktree.close(safe or proc is None))
        if compiler_id and (proc is None or safe):
            # After the phase's own process group is gone; probes run here, outside the coordinator lock.
            cleanup_step(errors, "compiler_server_cleanup", proc, lambda: stop_phase_compiler_server(compiler_id))
        if shim_dir is not None:
            cleanup_step(errors, "shim_cleanup", proc, shim_dir.cleanup)
        cleanup_step(errors, "restore_sigint", proc, lambda: signal.signal(signal.SIGINT, old_int))
        cleanup_step(errors, "restore_sigterm", proc, lambda: signal.signal(signal.SIGTERM, old_term))
        if primary is not None or errors:
            producer_outcome(proc, producer_exit)
        if errors and primary is None:
            raise errors[0]


def add_policy_arguments(runner):
    runner.add_argument("--expect-fast", action="store_true", help="alias for --policy fast")
    runner.add_argument("--policy", choices=POLICIES, help="override admission policy (default: PI_PHASE_POLICY or automatic)")


def withdrawal_id(value):
    if not re.fullmatch(r"[0-9a-fA-F]{6,}", value):
        raise argparse.ArgumentTypeError("ID must be a hex token prefix of at least 6 characters")
    return value.lower()


def withdrawal_reason(value):
    try:
        return safe_label(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def validate_withdraw(parser, args):
    if not any((args.id, args.label is not None, args.mine)):
        parser.error("withdraw requires ID, --label or --mine")
    if args.force and args.reason is None:
        parser.error("--force requires --reason")
    if args.mine and caller_identity() == (None, None):
        parser.error("--mine requires a session or lane identity")


def add_worktree_arguments(runner):
    add_policy_arguments(runner)
    runner.add_argument("--no-worktree-lock", action="store_true", help="opt out of worktree admission (not build)")


HELP_EPILOG = """Examples:
  pi-phase status                                      # read-only: leases and queue
  pi-phase run --kind test --label unit -- npm test    # state-changing: runs the command as a bounded phase
Exit codes:
  run: the command's own exit code, or 75 queue timeout, 76 RSS cap, 77 withdrawn, 124 timeout, 125 wrapper failure
  other commands: 0 ok, 1 no match, 2 usage error, 3 refused (see README.md)
See also: docs/reference.md, agent/pi-phase/README.md, cratis-local-run --help
"""


def main(argv=None, *, state=None, configuration=None):
    parser = argparse.ArgumentParser(description="Bounded, cooperative local phase runner",
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=HELP_EPILOG)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("status", help="show leases, queue and priority grant (never command arguments)")
    reprioritizing = commands.add_parser("reprioritize", help="change an owned queued waiter's priority in place")
    reprioritizing.add_argument("target", metavar="pid|label", help="exact pid or unique label owned by your uid")
    reprioritizing.add_argument("--priority", choices=tuple(PRIORITIES), required=True)
    withdrawing = commands.add_parser("withdraw", help="withdraw a queued phase without touching running phases")
    withdrawing.add_argument("id", nargs="?", type=withdrawal_id, help="hex token prefix (at least 6 characters)")
    withdrawing.add_argument("--label")
    withdrawing.add_argument("--mine", action="store_true")
    withdrawing.add_argument("--all", action="store_true")
    withdrawing.add_argument("--force", action="store_true")
    withdrawing.add_argument("--reason", type=withdrawal_reason)
    summary = commands.add_parser("stats", help="summarize phase history by UTC day and kind")
    summary.add_argument("--days", type=int, default=7)
    summary.add_argument("--kind", choices=KINDS)
    summary.add_argument("--json", action="store_true")
    summary.add_argument("--stack", type=stack_name)
    summary.add_argument("--failures", action="store_true", help="group failures by kind and category")
    waiting = commands.add_parser("wait", help="estimate the wait for a new normal-priority phase")
    waiting.add_argument("--eta", action="store_true", required=True)
    waiting.add_argument("--kind", choices=KINDS, default="build")
    waiting.add_argument("--expect-fast", action="store_true", help="request fast estimate for a short build/test")
    waiting.add_argument("command", nargs=argparse.REMAINDER)
    grant = commands.add_parser("grant-priority", help="grant user-approved high priority")
    duration = grant.add_mutually_exclusive_group()
    duration.add_argument("--uses", type=int, help="1-20 uses, expires after 60 minutes (default 1)")
    duration.add_argument("--minutes", type=int, help="unlimited uses for 1-480 minutes")
    commands.add_parser("revoke-priority", help="revoke high priority approval")
    runner = commands.add_parser("run", help="run a single explicit command in one phase")
    runner.add_argument("--kind", choices=("build", "test", "integration", "ci"), required=True)
    runner.add_argument("--label", required=True)
    runner.add_argument("--stack", type=stack_name, help="override inferred ledger stack")
    runner.add_argument("--priority", choices=tuple(PRIORITIES), default="normal")
    runner.add_argument("--timeout", type=float, default=None, help="execution seconds (default 300 build/test/integration, 120 ci)")
    runner.add_argument("--queue-timeout", type=float, default=120, help="separate permit wait in seconds")
    runner.add_argument("--approved-long-timeout", action="store_true", help="declare explicit user approval for execution >600 seconds")
    runner.add_argument("--profile", choices=PROFILES, default="full",
                        help="iterate: no analyzers/style enforcement for dotnet build/test (never ship evidence); default full")
    runner.add_argument("--rerun", action="store_true", help="run even if this exact state already passed")
    runner.add_argument("--expect-red", action="store_true", help="tag an intentional TDD failure; exit code is unchanged")
    add_worktree_arguments(runner)
    runner.add_argument("--repo", help="ci watcher repo identity")
    runner.add_argument("--pr", help="ci watcher PR identity")
    runner.add_argument("--commit", help="ci watcher commit identity")
    runner.add_argument("--vstest-hang-minutes", type=int, help="opt-in VSTest-only hang diagnostics without dumps")
    runner.add_argument("--no-hang-timeout", action="store_true", help="skip the configured hang_timeout injection")
    runner.add_argument("--vstest-confirmed", action="store_true", help="attest project uses VSTest, not MTP")
    runner.add_argument("--diagnose-hang", action="store_true", help="declare active hang diagnosis; suppress mini-dump warnings only")
    runner.add_argument("--log", help="write producer stdout/stderr to FILE instead of streaming", metavar="FILE")
    runner.add_argument("--tail", type=int, help="print last N log lines on completion (default 60; requires --log)", metavar="N")
    runner.add_argument("command", nargs=argparse.REMAINDER)
    internal = commands.add_parser("_launch", help=argparse.SUPPRESS)
    internal.add_argument("gate", type=int)
    internal.add_argument("command", nargs=argparse.REMAINDER)
    argv = list(sys.argv[1:] if argv is None else argv)
    state = Path(state) if state is not None else STATE
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code:
            ledger = rejected_ledger(argv)
            if ledger:
                ledger.finish(state, exc.code)
        raise
    if args.action == "_launch":
        command = args.command[1:] if args.command and args.command[0] == "--" else args.command
        return launch(args.gate, command)
    os.umask(0o077)
    configuration = Path(configuration) if configuration is not None else CONFIG
    output = None
    return_code = 125
    ledger = PhaseLedger(args) if args.action == "run" else None
    if ledger:
        args.ledger = ledger
    try:
        if args.action == "run" and args.tail is not None:
            if args.log is None:
                parser.error("--tail requires --log")
            if args.tail < 0:
                parser.error("--tail must be nonnegative")
        if args.action == "reprioritize":
            return reprioritize(state, configuration, args)
        if args.action == "withdraw":
            validate_withdraw(parser, args)
            return withdraw(state, args)
        if args.action == "stats":
            if args.days < 1:
                parser.error("--days must be positive")
            return summary_stats(state, args)
        if args.action == "wait":
            return wait_eta(state, configuration, args.kind, args)
        if args.action == "status":
            return status(state, configuration)
        if args.action == "grant-priority":
            return grant_priority(state, args.uses, args.minutes)
        if args.action == "revoke-priority":
            return revoke_priority(state)
        if args.timeout is None:
            args.timeout = 120 if args.kind == "ci" else 300
        if args.log is not None:
            log_path = Path(args.log).resolve()
            log_path.parent.mkdir(parents=True, exist_ok=True)
            output = open(log_path, "wb")
        return_code = run(args, state, configuration, output=output)
    except SystemExit as exc:
        return_code = exc.code
        raise
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        if ledger and ledger.enqueued and ledger.started is None:
            ledger.outcome("error")
        print(f"pi-phase: {exc}", file=sys.stderr, flush=True)
    finally:
        if output is not None:
            output.close()
            try:
                report_log(log_path, 60 if args.tail is None else args.tail, return_code)
            except OSError as exc:
                print(f"pi-phase: {exc}", file=sys.stderr, flush=True)
                return_code = 125
        if ledger:
            ledger.record_failure(args.log, return_code, args.expect_red)
            ledger.finish(state, return_code)
    return return_code


if __name__ == "__main__":
    sys.exit(main())
