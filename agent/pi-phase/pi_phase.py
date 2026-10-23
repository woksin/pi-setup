"""Per-user host-wide, cooperative phase leases. POSIX flock and process groups required.

Only the child's own process group is signalled. The producer inherits the lease FD;
metadata guards against a dead supervisor whose descendant closed inherited FDs.
"""
import argparse
from collections import deque
from datetime import datetime, timezone, timedelta
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import shlex
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
OUTCOMES = ("passed", "failed", "queue-timeout", "timeout", "cancelled", "rejected")


def stack_name(value):
    if not re.fullmatch(r"[a-z0-9-]{1,20}", value):
        raise argparse.ArgumentTypeError("stack must match ^[a-z0-9-]{1,20}$")
    return value


def command_stack(command):
    """Best effort only: unwrap simple invocations, never evaluate shell code."""
    command = list(command)
    for _ in range(20):
        if not command:
            return "other"
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
                    return "other"
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
                return "other"
            if any(arg and all(c in ";&|<>()" for c in arg) for arg in command):
                return "other"
        else:
            if name == "dotnet":
                return "dotnet"
            if name in ("node", "npm", "npx", "yarn", "pnpm", "corepack", "tsc", "tsgo", "vite",
                        "vitest", "jest", "playwright", "eslint", "prettier", "turbo", "nx"):
                return "node"
            if name in ("python", "python3", "pytest"):
                return "python"
            if name in ("docker", "docker-compose"):
                return "docker"
            return {"cargo": "rust", "go": "go"}.get(name, "other")
    return "other"


def utc_stamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def git_state(cwd):
    """Capture the code being admitted, without recording filenames or diffs."""
    head = dirty = None
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=cwd, capture_output=True,
                              text=True, check=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    deadline = time.monotonic() + 5
    try:
        status = subprocess.run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
                                cwd=cwd, capture_output=True, check=True, timeout=5).stdout
        if not status:
            dirty = "clean"
        else:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return head, None
            diff = subprocess.run(["git", "diff", "HEAD", "--binary"], cwd=cwd,
                                  capture_output=True, check=True, timeout=remaining).stdout
            dirty = hashlib.sha256(status + diff).hexdigest()
    except (OSError, subprocess.SubprocessError):
        pass
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
        self.record = dict(v=1, ts=None, session=os.environ.get("PI_SESSION_ID") or None,
                           lane=os.environ.get("PI_ORCH_ID") or os.environ.get("PI_LANE_ID") or None,
                           cwd=os.getcwd(), kind=args.kind, label=args.label, priority=args.priority,
                           stack=getattr(args, "stack", None) or command_stack(command),
                           queuedAt=utc_stamp(), startedAt=None, endedAt=None, waitS=0, runS=0,
                           exit=None, outcome="rejected", head=None, dirty=None,
                           argvHash=hashlib.sha256(os.fsencode("\0".join(command))).hexdigest())
        self.queued = time.monotonic()
        self.started = None

    def enqueue(self):
        self.record["queuedAt"] = utc_stamp()
        self.queued = time.monotonic()
        self.snapshot()

    def snapshot(self):
        self.record["head"], self.record["dirty"] = git_state(self.record["cwd"])

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
        if self.started is None:
            self.record["waitS"] = max(0, time.monotonic() - self.queued)
        else:
            self.record["runS"] = max(0, time.monotonic() - self.started)
            if self.record["outcome"] == "failed" and code == 0:
                self.record["outcome"] = "passed"
        append_ledger(state, self.record)


def rejected_ledger(argv):
    """Argparse may reject before producing a Namespace; retain only known metadata."""
    if not argv or argv[0] != "run":
        return None
    options, command = [], []
    valued = {"--kind", "--label", "--priority", "--timeout", "--queue-timeout", "--repo", "--pr",
              "--commit", "--log", "--tail", "--vstest-hang-minutes", "--stack"}
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
                         queueTimeouts=sum(r["outcome"] == "queue-timeout" for r in entries),
                         failures=sum(r["outcome"] in ("failed", "timeout") for r in entries)))
    if as_json:
        print(json.dumps(dict(days=days, skipped=skipped, rows=rows)))
    else:
        print("day kind stack count started waitS.p50 waitS.p90 runS.p50 runS.p90 queue-timeouts failures")
        for row in rows:
            print(row["day"], row["kind"], row["stack"], row["count"], row["started"],
                  *("-" if v is None else f"{v:g}" for v in (*row["waitS"].values(), *row["runS"].values())),
                  row["queueTimeouts"], row["failures"])
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
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
    finally:
        os.close(fd)


def wait_eta(state, configuration, kind):
    records, _ = read_ledger(state)
    durations = {k: [r["runS"] for r in records if r["kind"] == k and r["startedAt"] is not None]
                 for k in KINDS}
    basis = len(durations[kind])
    if not basis:
        print("eta unknown (no ledger data)")
        return 0
    median = percentile(durations[kind], 50)
    medians = {k: percentile(v, 50) if v else median for k, v in durations.items()}
    heavy, integration = config(configuration)
    free = dict(heavy=heavy, integration=integration)
    events, running = [], set()
    now = time.time()
    # Probe once for orphan metadata as well as live locks, as admission does.
    live = live_groups(2) if state.exists() else set()
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
    try:
        coordinator = os.open(state / "coordinator.lock", os.O_RDONLY)
    except FileNotFoundError:
        waiters = []
    else:
        try:
            fcntl.flock(coordinator, fcntl.LOCK_SH)
            waiters = live_waiters(state, readonly=True)
        finally:
            os.close(coordinator)
    waiters = [w for w in waiters if PRIORITIES[w["priority"]] >= PRIORITIES["normal"]]
    ahead = len(waiters)
    pending = [w["kind"] for w in waiters] + [kind]
    elapsed = 0
    if kind == "ci":
        pending, ahead = [kind], 0
    while pending:
        for entry in list(enumerate(pending)):
            index, candidate = entry
            needs = [] if candidate == "ci" else ["heavy"] + (["integration"] if candidate == "integration" else [])
            if not all(free[r] > 0 for r in needs):
                continue
            if index == len(pending) - 1:
                print(f"eta ~{math.ceil(elapsed / 60)}m (ahead={ahead} running={len(running)} "
                      f"p50run={median:g}s, basis={basis} runs)")
                return 0
            pending[index] = None
            for resource in needs:
                free[resource] -= 1
                events.append((elapsed + medians[candidate], resource))
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
                    phase_nice=0, rss_cap_mb=12288)
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
    for key, default in defaults.items():
        value = data.get(key, default)
        if key in ("heavy_slots", "integration_slots"):
            valid = type(value) is int and 1 <= value <= 32
        elif key == "msbuild_max_cpu":
            valid = value == "auto" or type(value) is int and value >= 0
        elif key == "rss_cap_mb":
            valid = type(value) is int and value >= 0  # 0 = off
        elif key == "phase_nice":
            valid = type(value) is int and 0 <= value <= 19
        elif key == "memory_admission":
            values[key] = memory_admission_config(value, warn)
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
               if path.name.startswith(("heavy-", "integration-", "ci-")) and path not in available)


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


def begin_test_attribution(state, token):
    """A generation change remembers even a peer that exits between Docker polls."""
    paths = [p for p in state.glob("*.lock")
             if p.name.startswith(("heavy-", "integration-", "ci-"))]
    prior = {p: metadata(p.with_suffix(".json")) for p in paths}
    competitors = [entry for entry in prior.values() if entry.get("token") != token
                   and entry.get("kind") not in ("build", "ci")]
    live = live_groups(0.5) if any(entry.get("pgid") for entry in competitors) else set()
    solo = live is not None
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        for path in state.glob("*.lock"):
            if not path.name.startswith(("heavy-", "integration-", "ci-")):
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


def record_container_test(state, fingerprint, attribution=None):
    # A later peer invalidates attribution even after its lease has disappeared.
    if attribution is None or metadata(state / "test-generation.json").get("token") != attribution:
        return
    # Separate from admission: a slow hint must never hold the coordinator.
    with open(state / "container-tests.guard", "a+b") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        known = metadata(state / "container-tests.json")
        known[fingerprint] = True
        save(state / "container-tests.json", known)


def container_test_poller(state, fingerprint, started, stopped, attribution=None):
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
                    record_container_test(state, fingerprint, attribution)
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


def live_group_members(pgid):
    """macOS can return EPERM for a group containing only an unreaped zombie."""
    try:
        listing = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="],
                                 capture_output=True, text=True, timeout=2, check=True).stdout
        return any(int(parts[1]) == pgid and not parts[2].startswith("Z")
                   for line in listing.splitlines() if len(parts := line.split()) >= 3)
    except (OSError, ValueError, subprocess.SubprocessError):
        return True  # Unknown is never treated as safe to release.


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


def group_alive(info):
    pgid = info.get("pgid")
    if type(pgid) is not int or pgid <= 1:
        return False
    try:
        os.killpg(pgid, 0)
        return live_group_members(pgid)
    except ProcessLookupError:
        return False
    except PermissionError:
        return live_group_members(pgid)


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


def register_waiter(state, args, token):
    """Nonblocking registration, including atomic grant consumption and FIFO sequence."""
    coordinator = lock_file(state / "coordinator.lock")
    if coordinator is None:
        return False, None
    path = state / "waiters" / f"{token}.json"
    fd = None
    try:
        if args.priority == "high":
            consume_priority(state)
        if args.kind == "ci":
            return True, None
        path.parent.mkdir(mode=0o700, exist_ok=True)
        counter = state / "waiter-seq.json"
        seq = metadata(counter).get("seq", 0) + 1
        save(counter, {"seq": seq})
        fd = lock_file(path)
        if fd is None:
            raise ValueError("cannot lock new waiter")
        data = dict(token=token, pid=os.getpid(), priority=args.priority, kind=args.kind,
                    label=args.label, cwd=os.getcwd(), enqueued=time.time(), seq=seq)
        os.write(fd, json.dumps(data).encode())
        return True, fd
    except BaseException:
        path.unlink(missing_ok=True)
        if fd is not None:
            unlock(fd)
        raise
    finally:
        unlock(coordinator)


def deregister_waiter(state, token, fd):
    """Keep unlink and lock release atomic with respect to queue scans."""
    with open(state / "coordinator.lock", "a+b") as coordinator:
        fcntl.flock(coordinator, fcntl.LOCK_EX)
        try:
            (state / "waiters" / f"{token}.json").unlink(missing_ok=True)
        finally:
            unlock(fd)


def live_waiters(state, cancelled=lambda: False, *, readonly=False):
    """Kernel locks, not PIDs, define liveness. Caller holds the coordinator."""
    waiters = []
    for path in (state / "waiters").glob("*.json"):
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
                        or not math.isfinite(data["enqueued"])):
                    raise ValueError("unreadable live waiter")
                waiters.append(data)
            else:
                if not readonly:
                    path.unlink(missing_ok=True)
        finally:
            os.close(fd)
    return sorted(waiters, key=lambda w: (-PRIORITIES[w["priority"]], w["enqueued"], w["seq"]))


def ordered_candidate(state, available, token, cancelled):
    """Reserve satisfiable earlier waiters virtually; blocked ones take nothing."""
    heavy = sorted(p for p in available if p.name.startswith("heavy-"))
    integration = sorted(p for p in available if p.name.startswith("integration-"))
    for waiter in live_waiters(state, cancelled):
        candidate = ([heavy[0]] if heavy else [])
        if waiter["kind"] == "integration":
            candidate = candidate + [integration[0]] if candidate and integration else []
        if waiter.get("token") == token:
            return candidate
        if candidate:
            heavy.pop(0)
            if waiter["kind"] == "integration":
                integration.pop(0)
    return []


def claim(state, candidates, deadline, cancelled, waiter=None, limits=None, admission=None,
          integration_ceiling=None):
    """One bounded admission scan; kernel locks and metadata identity are checked atomically."""
    paths = {path for candidate in candidates for path in candidate}
    if waiter is not None:
        paths.update(state / f"integration-{n}.lock" for n in range(limits[1]))
    reason = admission.reason(deadline) if admission and any(
        path.name.startswith("heavy-") for path in paths) else None
    snapshot_paths = paths.copy()
    if reason:
        snapshot_paths.update(path for path in state.glob("*.lock")
                              if path.name.startswith(("heavy-", "integration-", "ci-")))
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
                (state / "waiters" / f"{waiter}.json").unlink(missing_ok=True)
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
                    path.with_suffix(".json").unlink(missing_ok=True)
        for _, fd in held:
            # Never explicitly unlock a shared open-file description if the
            # producer may still hold its inherited FD after supervisor failure.
            os.close(fd)


def status(state):
    if not state.exists():
        note("no active phases")
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
        waiters = live_waiters(state)
        grant = priority_grant(state)
    # No slow ps probe or terminal write while holding the shared coordinator.
    live = live_groups(2) if any(not busy and data.get("pgid") for _, data, busy in owners) else set()
    seen = set()
    for path, data, busy in owners:
        orphan = (data.get("unreadable") or live is None or data.get("pgid") in live) if not busy else False
        if not busy and not orphan:
            continue
        token = data.get("token", path.name)
        if token in seen:
            continue
        seen.add(token)
        age = max(0, int(time.time() - data.get("started", time.time())))
        note(f"{data.get('kind', 'unknown')} {data.get('label', 'unknown')} "
             f"pid={data.get('pid', '?')} cwd={data.get('cwd', '?')} "
             f"elapsed={age}s {'orphan-group' if orphan else 'running'}")
    if not seen:
        note("no active phases")
    for rank, waiter in enumerate(waiters, 1):
        age = max(0, int(time.time() - waiter["enqueued"]))
        note(f"queued priority={waiter['priority']} kind={waiter['kind']} "
             f"label={waiter.get('label', '?')} waited={age}s rank={rank}")
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


def exited_unreaped(pid):
    # WNOWAIT reserves the leader PID/PGID until cleanup signals have been sent,
    # avoiding signalling a recycled, unrelated process group.
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def stop_group(pgid):
    for sig, delay in ((signal.SIGTERM, 0.6), (signal.SIGKILL, 0.2)):
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            if live_group_members(pgid):
                raise
        time.sleep(delay)


def bounded(value, name, approved):
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
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                              text=True, check=True).stdout.strip()
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
    queued = time.monotonic()
    deadline = queued + args.queue_timeout
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
    fingerprint = test_fingerprint(os.getcwd(), command)
    admission_args = argparse.Namespace(**vars(args))
    try:
        if ledger:
            ledger.enqueue()
        config_notes = set()
        settings = config(configuration, notes=config_notes)
        options = settings.options
        admission = MemoryAdmission(options["memory_admission"]) if options["memory_admission"] else None
        burst_settings = options["memory_admission"].get("integration_burst") if admission else None
        burst = IntegrationBurst(admission, burst_settings) if burst_settings else None
        if (args.kind == "test" and options["container_test_detection"] == "promote"
                and metadata(state / "container-tests.json").get(fingerprint) is True):
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
                if not registered:
                    time.sleep(min(TICK, max(0, deadline - time.monotonic())))
                    continue
            heavy, integration = settings
            if burst and admission_args.kind == "integration":
                integration = burst.effective(integration, deadline)
            held = claim(state, slot_paths(state, admission_args.kind, heavy, integration, ci_key),
                         deadline, lambda: bool(cancelled[0]),
                         token if waiter_fd is not None else None, (heavy, integration), admission,
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
        if ledger:
            ledger.snapshot()
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
            proc = subprocess.Popen(launcher, pass_fds=[read_gate, *(fd for _, fd in held)],
                                    start_new_session=True, env=child_env, **output_options)
            os.close(read_gate)
            read_gate = -1
            publish(held, dict(token=token, pid=proc.pid, pgid=proc.pid, cwd=os.getcwd(),
                               label=args.label, kind=args.kind, started=time.time()))
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
                             args=(state, fingerprint, detection_started, detector_stopped, attribution),
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
            if exited_unreaped(proc.pid):
                break
            now = time.monotonic()
            if now - started >= args.timeout:
                note(f"phase timed out ({args.timeout:g}s); stopping owned process group")
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
        stop_group(proc.pid)
        try:
            proc.wait(timeout=2)
            if return_code == 125:
                return_code = proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
                if ledger and proc.returncode < 0:
                    ledger.outcome("cancelled")
        except subprocess.TimeoutExpired:
            note("cleanup incomplete; lease retained while group exists")
            return_code = 125
        safe = not group_alive({"pgid": proc.pid})
        if not safe:
            note("process group still exists; retaining orphan guard")
            return_code = 125
        note(f"finished kind={args.kind} label={args.label} exit={return_code}")
        return return_code
    finally:
        detector_stopped.set()
        if waiter_fd is not None:
            deregister_waiter(state, token, waiter_fd)
        # A failed launch sees EOF at its gate. An unexpected exception during
        # execution must also terminate the owned group before releasing a lease.
        if proc is not None and proc.returncode is None:
            try:
                stop_group(proc.pid)
                proc.wait(timeout=2)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                pass
            safe = not group_alive({"pgid": proc.pid})
        if held:
            release(state, held, token, safe or proc is None)
        if shim_dir is not None:
            shim_dir.cleanup()
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)


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
    runner.add_argument("--approved-long-timeout", action="store_true", help="declare explicit user approval for >600 seconds")
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
            return wait_eta(state, configuration, args.kind)
        if args.action == "status":
            return status(state)
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
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
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
