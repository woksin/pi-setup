"""Per-user host-wide, cooperative phase leases. POSIX flock and process groups required.

Only the child's own process group is signalled. The producer inherits the lease FD;
metadata guards against a dead supervisor whose descendant closed inherited FDs.
"""
import argparse
from collections import deque, namedtuple
from datetime import datetime, timezone, timedelta
import errno
import fcntl
import fnmatch
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import shlex
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
# Consecutive over-cap samples (same pid + start time) before the kill: ~45 s at the 15 s interval, so a
# transient spike never kills a phase.
OVER_CAP_SAMPLES = 3


def note(message):
    print(f"pi-phase: {message}", flush=True)


KINDS = ("build", "test", "integration", "ci")
POLICIES = ("direct", "fast", "queued")
OUTCOMES = ("passed", "failed", "queue-timeout", "timeout", "cancelled", "rejected", "error", "skipped")


def stack_name(value):
    if not re.fullmatch(r"[a-z0-9-]{1,20}", value):
        raise argparse.ArgumentTypeError("stack must match ^[a-z0-9-]{1,20}$")
    return value


def unwrap_command(command):
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
                           argvHash=hashlib.sha256(os.fsencode("\0".join(command))).hexdigest(),
                           fingerprint=test_fingerprint(cwd, command) if cwd is not None else None)
        self.queued = time.monotonic()
        self.started = None
        self.enqueued = False
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

    def passed_state(self, state):
        if not self.snapshot_ready or self.record["dirty"] is None:
            return None
        try:
            records, _ = read_ledger(state, days=14)
        except (OSError, ValueError):
            return None  # Unreadable history must not prevent execution.
        keys = ("cwd", "kind", "label", "argvHash", "head", "dirty", "stack", "envHash")
        return next((r for r in reversed(records) if r["outcome"] == "passed" and r.get("verified") is True
                     and all(r.get(k) == self.record[k] for k in keys)), None)

    def enqueue(self):
        self.record["queuedAt"] = utc_stamp()
        self.queued = time.monotonic()
        self.enqueued = True
        if self.snapshot_ready:
            return
        self.snapshot_thread = threading.Thread(target=self.snapshot, daemon=True)
        try:
            self.snapshot_thread.start()
        except RuntimeError:
            self.snapshot_thread = None  # Thread exhaustion is only missing optional metadata.

    def snapshot(self):
        try:
            self.git_result = git_state(self.record["cwd"])
        except Exception:
            pass  # Optional metadata must not interrupt the phase or print a traceback.

    def start(self):
        self.record["outcome"] = "failed"
        self.record["startedAt"] = utc_stamp()
        self.started = time.monotonic()
        self.record["waitS"] = max(0, self.started - self.queued)

    def outcome(self, value):
        self.record["outcome"] = value

    def finish(self, state, code):
        self.record["ts"] = self.record["endedAt"] = utc_stamp()
        self.record["exit"] = code
        if self.record["outcome"] == "skipped":
            self.record["waitS"] = self.record["runS"] = 0
        elif self.started is None:
            self.record["waitS"] = max(0, time.monotonic() - self.queued)
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
        append_ledger(state, self.record)


def rejected_ledger(argv):
    """Argparse may reject before producing a Namespace; retain only known metadata."""
    if not argv or argv[0] != "run":
        return None
    options, command = [], []
    valued = {"--kind", "--label", "--priority", "--timeout", "--queue-timeout", "--repo", "--pr",
              "--commit", "--log", "--tail", "--vstest-hang-minutes", "--stack", "--policy"}
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
                         skipped=sum(r["outcome"] == "skipped" for r in entries),
                         queueTimeouts=sum(r["outcome"] == "queue-timeout" for r in entries),
                         failures=sum(r["outcome"] in ("failed", "timeout", "error") for r in entries)))
    if as_json:
        print(json.dumps(dict(days=days, skipped=skipped, rows=rows)))
    else:
        print("day kind stack count started waitS.p50 waitS.p90 runS.p50 runS.p90 queue-timeouts failures skipped")
        for row in rows:
            print(row["day"], row["kind"], row["stack"], row["count"], row["started"],
                  *("-" if v is None else f"{v:g}" for v in (*row["waitS"].values(), *row["runS"].values())),
                  row["queueTimeouts"], row["failures"], row["skipped"])
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
                if not (readonly_busy(path) or data.get("unreadable") or live is None or data.get("pgid") in live):
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


def config(path, *, notes=None):
    def warn(message):
        if notes is None or message not in notes:
            note(message)
            if notes is not None:
                notes.add(message)

    defaults = dict(heavy_slots=2, integration_slots=1, msbuild_max_cpu=0,
                    container_test_detection="hint", cold_worktree_hint=True, memory_admission=False,
                    phase_nice=0, rss_cap_mb=12288, skip_passed_integration=False, max_high=3,
                    fast_lane=dict(slots=2, max_expected_s=90, kinds=["build", "test"], shape=True),
                    queue_order=dict(QUEUE_ORDER_DEFAULTS), policy=[])
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
        if not isinstance(data, dict):
            raise ValueError("expected an object")
    except (ValueError, OSError) as exc:
        warn(f"invalid config.json ({exc}); using defaults")
        data = {}
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


def configured_policy(state, args, options, fingerprint, *, history=None, identity=None):
    cwd = os.path.realpath(os.getcwd())
    for rule in options["policy"]:
        if args.kind not in rule["kinds"] or not fnmatch.fnmatchcase(cwd, os.path.expanduser(rule["path"])):
            continue
        return rule_policy(state, rule, fingerprint, history=history, identity=identity), "config"
    fast, source = fast_decision(state, args, options["fast_lane"], fingerprint, history=history, identity=identity)
    return ("fast", source) if fast else ("queued", "default")


def rule_policy(state, rule, fingerprint, *, history=None, identity=None):
    if rule["policy"] != "direct":
        return rule["policy"]
    limit = rule.get("max_expected_s", 90)
    if history is not None:
        # Work/family history, so a new filter or executable path cannot bypass a slow record.
        records = history.scoped(fingerprint, identity)
        if not records or slow_fast_history(records, limit) or history.family_overran(identity):
            return "fast"
        return "direct"
    records = policy_history(state, fingerprint)
    if not records or slow_fast_history(records, limit):
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


def lease_running(path, prior, live):
    """Caller holds the coordinator; account for both locked and orphan leases."""
    fd = lock_file(path)
    if fd is None:
        return True
    try:
        entry = metadata(path.with_suffix(".json"))
        return entry != prior.get(path) or entry.get("unreadable") or entry.get("pgid") in live
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
        self.cap = rss_cap_mb
        self.floor = swap_floor_mb
        self.warn = warn
        self.last_warning = None
        self.streaks = {}  # (pid, start time) -> consecutive over-cap samples

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
        if not self.cap:
            return None
        try:
            samples = sample_tree(root_pid)
        except (OSError, ValueError, subprocess.SubprocessError):
            self.streaks = {}  # a failed measurement breaks every streak: "consecutive" means consecutive samples
            return None  # fail-open: never kill on a failed measurement
        over = {(item[0], item[3] if len(item) > 3 else None): item for item in samples if item[1] > self.cap}
        self.streaks = {identity: self.streaks.get(identity, 0) + 1 for identity in over}
        sustained = [over[identity] for identity, count in self.streaks.items() if count >= OVER_CAP_SAMPLES]
        return max(sustained, key=lambda item: item[1]) if sustained else None


def msbuild_cap(value, heavy):
    return max(2, (os.cpu_count() or 1) // heavy) if value == "auto" else value


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


def test_fingerprint(cwd, command):
    return hashlib.sha1("\0".join([os.path.realpath(cwd), *command]).encode()).hexdigest()


WorkIdentity = namedtuple("WorkIdentity", "repo_key work_key family_key project shape filtered")
TARGET_SUFFIXES = (".dll", ".exe", ".csproj", ".fsproj", ".sln", ".slnx")
FILTER_ARGUMENT = re.compile(r"^--?(filter|treenode-filter|filter-[a-z-]+|class|method|namespace|trait|query)\b",
                             re.IGNORECASE)


def digest(*parts):
    return hashlib.sha1("\0".join(parts).encode()).hexdigest()


def repository_location(cwd):
    """(common git dir without .git, path of cwd relative to the checkout), one bounded git call."""
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
        return common, os.path.relpath(real, top)
    except (OSError, IndexError, subprocess.SubprocessError):
        return real, ""


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
    live = live_groups(0.5) if any(entry.get("pgid") for entry in competitors) else set()
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
                    or live is None or entry.get("pgid") in live):
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
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


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


def group_alive(info, timeouts=(2,)):
    pgid = info.get("pgid")
    if type(pgid) is not int or pgid <= 1:
        return False
    try:
        os.killpg(pgid, 0)
        return live_group_members(pgid, timeouts)
    except ProcessLookupError:
        return False
    except PermissionError:
        return live_group_members(pgid, timeouts)


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


def high_count(state):
    """Caller holds the coordinator; count queued and leased HIGH tokens only once."""
    tokens = {w["token"] for w in all_waiters(state) if w["priority"] == "high"}
    for path in list(state.glob("heavy-*.lock")) + list(state.glob("fast-*.lock")) + list(state.glob("direct-*.lock")):
        data = metadata(path.with_suffix(".json"))
        if data.get("priority") != "high":
            continue
        busy = readonly_busy(path)
        if not busy and data.get("pgid"):
            try:
                os.killpg(data["pgid"], 0)
                busy = True
            except ProcessLookupError:
                pass
            except PermissionError:
                busy = True
        if busy:
            tokens.add(data.get("token", path.name))
    return len(tokens)


def slotless_policy(args):
    return args.kind == "ci" or getattr(args, "policy", None) == "direct"


def register_waiter(state, args, token):
    """Nonblocking registration, including atomic grant consumption and FIFO sequence."""
    coordinator = lock_file(state / "coordinator.lock")
    if coordinator is None:
        return False, None
    path = state / ("fast-waiters" if getattr(args, "fast", False) else "waiters") / f"{token}.json"
    fd = None
    downgrade_note = None
    try:
        if args.priority == "high":
            cap = getattr(args, "max_high", 3)
            if high_count(state) >= cap:
                if priority_grant(state) is None:
                    raise ValueError(APPROVAL_REQUIRED)
                args.priority = "normal"
                downgrade_note = f"high-priority cap ({cap}) reached; queued as normal"
            else:
                consume_priority(state)
        if slotless_policy(args):
            return True, None
        path.parent.mkdir(mode=0o700, exist_ok=True)
        counter = state / "waiter-seq.json"
        seq = metadata(counter).get("seq", 0) + 1
        save(counter, {"seq": seq})
        fd = lock_file(path)
        if fd is None:
            raise ValueError("cannot lock new waiter")
        data = dict(token=token, pid=os.getpid(), priority=args.priority, kind=args.kind,
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


def ordered_candidate(state, available, token, cancelled):
    """Reserve satisfiable earlier waiters virtually; blocked ones take nothing."""
    pools = {key: sorted(p for p in available if p.name.startswith(key + "-"))
             for key in ("heavy", "integration", "fast")}
    for waiter in all_waiters(state, cancelled):
        candidate = waiter_resources(waiter, pools)
        if waiter.get("token") == token:
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


def claim(state, candidates, deadline, cancelled, waiter=None, limits=None, admission=None,
          integration_ceiling=None):
    """One bounded admission scan; kernel locks and metadata identity are checked atomically."""
    paths = claim_paths(state, candidates, waiter, limits)
    reason = admission.reason(deadline) if admission and any(
        path.name.startswith(("heavy-", "fast-", "direct-")) for path in paths) else None
    snapshot_paths = paths.copy()
    if reason:
        snapshot_paths.update(path for path in state.glob("*.lock")
                              if path.name.startswith(("heavy-", "integration-", "ci-", "fast-", "direct-")))
    if integration_ceiling is not None:
        snapshot_paths.update(state.glob("integration-*.lock"))
    prior = {}
    for path in snapshot_paths:
        if cancelled() or time.monotonic() >= deadline:
            return None
        prior[path] = metadata(path.with_suffix(".json"))
    needs_probe = any(type(entry.get("pgid")) is int and entry["pgid"] > 1
                      for entry in prior.values())
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
            if entry != prior[path] or entry.get("unreadable") or entry.get("pgid") in live:
                unlock(fd)
                continue
            available[path] = fd
        if reason and phases_running(state, available, prior, live):
            memory_held = True
            return None
        eligible = (burst_available(state, available, prior, live, integration_ceiling)
                    if integration_ceiling is not None else available)
        if waiter is not None:
            candidate = ordered_candidate(state, eligible, waiter,
                                          lambda: cancelled() or time.monotonic() >= deadline)
        else:
            candidate = next((c for c in candidates if all(p in eligible for p in c)), [])
        if candidate and not cancelled() and time.monotonic() < deadline:
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
            admission.waiting(reason)
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
                    remove_lease(path)
        for _, fd in held:
            # Never explicitly unlock a shared open-file description if the
            # producer may still hold its inherited FD after supervisor failure.
            os.close(fd)


def remove_lease(path):
    path.with_suffix(".json").unlink(missing_ok=True)
    if path.name.startswith("direct-"):
        path.unlink(missing_ok=True)


def status(state, configuration=CONFIG):
    options = config(configuration).options
    cap = options["max_high"]
    fast_slots = options["fast_lane"]["slots"] if options["fast_lane"] else 0
    if not state.exists():
        note("no active phases")
        note(f"fast=0/{fast_slots} queued=0")
        note(f"high=0/{cap}")
        return 0
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
        high = high_count(state)
    # No slow ps probe or terminal write while holding the shared coordinator.
    live = live_groups(2) if any(not busy and data.get("pgid") for _, data, busy in owners) else set()
    seen = set()
    fast_running = 0
    for path, data, busy in owners:
        orphan = (data.get("unreadable") or live is None or data.get("pgid") in live) if not busy else False
        if not busy and not orphan:
            continue
        token = data.get("token", path.name)
        if token in seen:
            continue
        seen.add(token)
        fast_running += path.name.startswith("fast-")
        age = max(0, int(time.time() - data.get("started", time.time())))
        note(f"{data.get('kind', 'unknown')} {data.get('label', 'unknown')} "
             f"pid={data.get('pid', '?')} cwd={data.get('cwd', '?')} "
             f"elapsed={age}s {'orphan-group' if orphan else 'running'}"
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
             f" policy={waiter.get('policy', 'queued')} source={waiter.get('source', 'default')}")
    note(f"fast={fast_running}/{fast_slots} queued={sum(bool(w.get('fast')) for w in waiters)}")
    note(f"high={high}/{cap}")
    if grant:
        remaining = "unlimited uses" if grant["uses"] is None else f"{grant['uses']} use(s) remaining"
        seconds = max(0, math.ceil(grant["expires"] - time.time()))
        expiry = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(grant["expires"]))
        note(f"high priority grant: {remaining}; expires in {seconds}s at {expiry}")
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


def exited_unreaped(pid, producer_exit=None):
    # WNOWAIT reserves the leader PID/PGID until cleanup signals have been sent,
    # avoiding signalling a recycled, unrelated process group.
    status = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if status is not None and producer_exit is not None:
        if status.si_code == os.CLD_EXITED:
            producer_exit[0] = status.si_status
        elif status.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
            producer_exit[0] = 128 + status.si_status
    return status is not None


def stop_group(pgid):
    for sig, delay in ((signal.SIGTERM, 0.6), (signal.SIGKILL, 0.2)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            live = group_liveness(pgid, CLEANUP_PROBE_TIMEOUTS)
            if live is not False:
                failure_note(f"killpg signal={sig.name} pgid={pgid} liveness={'live' if live else 'unknown'}")
                raise
        time.sleep(delay)


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


def apply_fast_budget(args, settings, held):
    if not any(path.name.startswith("fast-") for path, _ in held):
        return None
    budget = fast_budget(settings)
    args.timeout = min(args.timeout, budget)
    note(f"fast lane (budget {budget:g}s)")
    return budget


def fast_timeout(args, budget):
    if budget is None or args.timeout < budget:
        return
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
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise ValueError("missing command after --")
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
    cancelled = [None]

    def interrupt(sig, _frame):
        cancelled[0] = sig

    old_int = signal.signal(signal.SIGINT, interrupt)
    old_term = signal.signal(signal.SIGTERM, interrupt)
    held = None
    proc = None
    token = uuid.uuid4().hex
    started = None
    return_code = 125
    safe = False
    registered = False
    waiter_fd = None
    shim_dir = None
    detector_stopped = threading.Event()
    producer_exit = [None]
    operation = "prepare"
    primary = None
    fingerprint = test_fingerprint(os.getcwd(), command)
    admission_args = argparse.Namespace(**vars(args))
    try:
        config_notes = set()
        settings = config(configuration, notes=config_notes)
        options = settings.options
        identity = work_identity(os.getcwd(), command, args.kind)
        prepare_policy(state, admission_args, options, fingerprint, load_history(state), identity)
        if ledger:
            ledger.prepare_snapshot()
            if (not args.rerun and os.environ.get("PI_PHASE_NO_SKIP") != "1" and args.kind != "ci"
                    and (args.kind != "integration" or options["skip_passed_integration"])):
                passed = ledger.passed_state(state)
                if passed:
                    note(f"skipped: this exact state already passed at {passed['ts']} "
                         f"(kind={args.kind} label={args.label} head={passed['head'][:7]} "
                         f"run={passed['runS']:g}s); pass --rerun to run again")
                    ledger.outcome("skipped")
                    return 0
        queued = time.monotonic()
        deadline = queued + args.queue_timeout
        admission_args.max_high = options["max_high"]
        admission = MemoryAdmission(options["memory_admission"]) if options["memory_admission"] else None
        burst_settings = options["memory_admission"].get("integration_burst") if admission else None
        burst = IntegrationBurst(admission, burst_settings) if burst_settings else None
        if (args.kind == "test" and options["container_test_detection"] == "promote"
                and container_test_known(state, fingerprint, identity)):
            admission_args.kind = "integration"
            note("recorded container test: also claiming an integration permit (container_test_detection)")
        while True:
            if cancelled[0]:
                note("cancelled while queued")
                if ledger:
                    ledger.outcome("cancelled")
                return 128 + cancelled[0]
            if not long_queue_hint and time.monotonic() - queued > 600:
                note(f"long queue ({int(time.monotonic() - queued)}s): run dev-doctor to look for contention")
                long_queue_hint = True
            if time.monotonic() >= deadline:
                note(f"queue timeout ({args.queue_timeout:g}s); command not started")
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
            held = claim(state, phase_candidates(state, admission_args, (heavy, integration, ci_key, token)),
                         deadline, lambda: bool(cancelled[0]),
                         token if waiter_fd is not None else None, PhaseConfig(heavy, integration, settings.options), admission,
                         integration if burst and admission_args.kind == "integration" else None)
            if cancelled[0]:
                note("cancelled during admission; command not started")
                if ledger:
                    ledger.outcome("cancelled")
                return 128 + cancelled[0]
            if held:
                if time.monotonic() >= deadline:
                    release(state, held, token, True)
                    held = None
                    note(f"queue timeout ({args.queue_timeout:g}s); command not started")
                    if ledger:
                        ledger.outcome("queue-timeout")
                    return 75
                break
            if args.kind == "ci":
                if ledger:
                    ledger.outcome("rejected")
                note("already watching this repo/PR/commit; no second watcher started")
                return 75
            now = time.monotonic()
            if now >= deadline:
                note(f"queue timeout ({args.queue_timeout:g}s); command not started")
                if ledger:
                    ledger.outcome("queue-timeout")
                return 75
            if now >= next_heartbeat:
                note(f"queued kind={args.kind} label={args.label} remaining={max(0, int(deadline-now))}s")
                next_heartbeat = now + HEARTBEAT
            time.sleep(min(QUEUE_TICK + random.uniform(0, 0.5), max(0, deadline-now)))
            settings = config(configuration, notes=config_notes)
        if cancelled[0]:
            note("cancelled after admission; command not started")
            if ledger:
                ledger.outcome("cancelled")
            return 128 + cancelled[0]
        budget = apply_fast_budget(args, options["fast_lane"], held)
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
        read_gate, write_gate = os.pipe()
        try:
            launcher = [sys.executable, str(Path(__file__).resolve()), "_launch", str(read_gate), "--", *command]
            output_options = {} if output is None else {"stdout": output, "stderr": subprocess.STDOUT}
            operation = "Popen"
            proc = subprocess.Popen(launcher, pass_fds=[read_gate, *(fd for _, fd in held)],
                                    start_new_session=True, env=child_env, **output_options)
            os.close(read_gate)
            read_gate = -1
            operation = "publish"
            publish(held, dict(token=token, pid=proc.pid, pgid=proc.pid, cwd=os.getcwd(),
                               label=args.label, kind=args.kind, priority=admission_args.priority, started=time.time(),
                               fast=admission_args.fast, policy=admission_args.policy, source=admission_args.source))
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
        running_memory = RunningMemory(options["rss_cap_mb"] if args.kind in ("build", "test", "integration") else 0,
                                       (options["memory_admission"] or {}).get("min_swap_free_mb", DEFAULT_MIN_SWAP_FREE_MB),
                                       args.kind in ("build", "test", "integration"))
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
        stop_group(proc.pid)
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
        note(f"finished kind={args.kind} label={args.label} exit={return_code}")
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
        # Do not reap if signals fail: the leader still reserves its PGID.
        if proc is not None and proc.returncode is None:
            before_stop = len(errors)
            cleanup_step(errors, "stop_group", proc, lambda: stop_group(proc.pid))
            if len(errors) == before_stop:
                cleanup_step(errors, "wait", proc, lambda: proc.wait(timeout=2))
            alive = cleanup_step(errors, "group_alive", proc,
                                 lambda: group_alive({"pgid": proc.pid}, timeouts=CLEANUP_PROBE_TIMEOUTS))
            safe = alive is False
        if held:
            cleanup_step(errors, "release", proc, lambda: release(state, held, token, safe or proc is None))
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


def main(argv=None, *, state=None, configuration=None):
    parser = argparse.ArgumentParser(description="Bounded, cooperative local phase runner")
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("status", help="show leases, queue and priority grant (never command arguments)")
    summary = commands.add_parser("stats", help="summarize phase history by UTC day and kind")
    summary.add_argument("--days", type=int, default=7)
    summary.add_argument("--kind", choices=KINDS)
    summary.add_argument("--json", action="store_true")
    summary.add_argument("--stack", type=stack_name)
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
    runner.add_argument("--rerun", action="store_true", help="run even if this exact state already passed")
    add_policy_arguments(runner)
    runner.add_argument("--repo", help="ci watcher repo identity")
    runner.add_argument("--pr", help="ci watcher PR identity")
    runner.add_argument("--commit", help="ci watcher commit identity")
    runner.add_argument("--vstest-hang-minutes", type=int, help="opt-in VSTest-only hang diagnostics without dumps")
    runner.add_argument("--vstest-confirmed", action="store_true", help="attest project uses VSTest, not MTP")
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
        if args.action == "stats":
            if args.days < 1:
                parser.error("--days must be positive")
            return stats(state, args.days, args.kind, args.json, args.stack)
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
            ledger.finish(state, return_code)
    return return_code


if __name__ == "__main__":
    sys.exit(main())
