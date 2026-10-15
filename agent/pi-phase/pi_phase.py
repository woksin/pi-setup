"""Per-user host-wide, cooperative phase leases. POSIX flock and process groups required.

Only the child's own process group is signalled. The producer inherits the lease FD;
metadata guards against a dead supervisor whose descendant closed inherited FDs.
"""
import argparse
from collections import deque
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
CONFIG = ROOT / "config.json"
HEARTBEAT = 5.0
TICK = 0.2


def note(message):
    print(f"pi-phase: {message}", flush=True)


def safe_label(value):
    if not value or len(value) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("label must be 1-120 printable characters (no control characters)")
    return value


def config(path):
    if not path.exists():
        return 2, 1
    data = json.loads(path.read_text())
    if set(data) != {"heavy_slots", "integration_slots"}:
        raise ValueError("config.json needs exactly heavy_slots and integration_slots")
    heavy, integration = data["heavy_slots"], data["integration_slots"]
    if any(type(n) is not int or n < 1 or n > 32 for n in (heavy, integration)):
        raise ValueError("slot limits must be integers from 1 to 32")
    return heavy, integration


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


def claim(state, candidates, deadline, cancelled):
    """One bounded admission scan; kernel locks and metadata identity are checked atomically."""
    paths = {path for candidate in candidates for path in candidate}
    prior = {}
    for path in paths:
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
    try:
        for candidate in candidates:
            held = []
            for path in candidate:
                if cancelled() or time.monotonic() >= deadline:
                    break
                fd = lock_file(path)
                if fd is None:
                    break
                # A new owner may have changed metadata since our snapshot.
                # Never trust a stale negative process-list result for that owner.
                entry = metadata(path.with_suffix(".json"))
                if entry != prior[path] or entry.get("unreadable") or entry.get("pgid") in live:
                    unlock(fd)
                    break
                held.append((path, fd))
            if len(held) == len(candidate) and not cancelled() and time.monotonic() < deadline:
                return held
            for _, fd in held:
                unlock(fd)
            if cancelled() or time.monotonic() >= deadline:
                break
    finally:
        unlock(coordinator)
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
    return 0


def launch(gate, command):
    """Internal gate: never execute a producer before its supervisor publishes metadata."""
    try:
        ready = os.read(gate, 1)
    finally:
        os.close(gate)
    if ready != b"1":
        return 125
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

    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    ci_key = (args.repo, args.pr, args.commit)
    deadline = time.monotonic() + args.queue_timeout
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
    try:
        while True:
            if cancelled[0]:
                note("cancelled while queued")
                return 128 + cancelled[0]
            if time.monotonic() >= deadline:
                note(f"queue timeout ({args.queue_timeout:g}s); command not started")
                return 75
            heavy, integration = config(configuration)
            held = claim(state, slot_paths(state, args.kind, heavy, integration, ci_key),
                         deadline, lambda: bool(cancelled[0]))
            if cancelled[0]:
                note("cancelled during admission; command not started")
                return 128 + cancelled[0]
            if held:
                if time.monotonic() >= deadline:
                    release(state, held, token, True)
                    held = None
                    note(f"queue timeout ({args.queue_timeout:g}s); command not started")
                    return 75
                break
            if args.kind == "ci":
                note("already watching this repo/PR/commit; no second watcher started")
                return 75
            now = time.monotonic()
            if now >= deadline:
                note(f"queue timeout ({args.queue_timeout:g}s); command not started")
                return 75
            if now >= next_heartbeat:
                note(f"queued kind={args.kind} label={args.label} remaining={max(0, int(deadline-now))}s")
                next_heartbeat = now + HEARTBEAT
            time.sleep(min(TICK, max(0, deadline-now)))
        if cancelled[0]:
            note("cancelled after admission; command not started")
            return 128 + cancelled[0]
        read_gate, write_gate = os.pipe()
        try:
            launcher = [sys.executable, str(Path(__file__).resolve()), "_launch", str(read_gate), "--", *command]
            output_options = {} if output is None else {"stdout": output, "stderr": subprocess.STDOUT}
            proc = subprocess.Popen(launcher, pass_fds=[read_gate, *(fd for _, fd in held)],
                                    start_new_session=True, **output_options)
            os.close(read_gate)
            read_gate = -1
            publish(held, dict(token=token, pid=proc.pid, pgid=proc.pid, cwd=os.getcwd(),
                               label=args.label, kind=args.kind, started=time.time()))
            if cancelled[0]:
                note("cancelled before execution; command not started")
                return 128 + cancelled[0]
            os.write(write_gate, b"1")
            started = time.monotonic()  # No execution budget consumed waiting for a permit.
        finally:
            if read_gate != -1:
                os.close(read_gate)
            os.close(write_gate)
        note(f"running kind={args.kind} label={args.label} pid={proc.pid} timeout={args.timeout:g}s")
        next_heartbeat = started + HEARTBEAT
        while True:
            if cancelled[0]:
                note("cancelled; stopping owned process group")
                return_code = 128 + cancelled[0]
                break
            if exited_unreaped(proc.pid):
                break
            now = time.monotonic()
            if now - started >= args.timeout:
                note(f"phase timed out ({args.timeout:g}s); stopping owned process group")
                return_code = 124
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
        signal.signal(signal.SIGINT, old_int)
        signal.signal(signal.SIGTERM, old_term)


def main(argv=None, *, state=None, configuration=None):
    parser = argparse.ArgumentParser(description="Bounded, cooperative local phase runner")
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("status", help="show current lease owners (never command arguments)")
    runner = commands.add_parser("run", help="run a single explicit command in one phase")
    runner.add_argument("--kind", choices=("build", "test", "integration", "ci"), required=True)
    runner.add_argument("--label", required=True)
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
    args = parser.parse_args(argv)
    if args.action == "_launch":
        command = args.command[1:] if args.command and args.command[0] == "--" else args.command
        return launch(args.gate, command)
    if args.action == "run" and args.tail is not None:
        if args.log is None:
            parser.error("--tail requires --log")
        if args.tail < 0:
            parser.error("--tail must be nonnegative")
    os.umask(0o077)
    state = Path(state) if state is not None else STATE
    configuration = Path(configuration) if configuration is not None else CONFIG
    output = None
    return_code = 125
    try:
        if args.action == "status":
            return status(state)
        if args.timeout is None:
            args.timeout = 120 if args.kind == "ci" else 300
        if args.log is not None:
            log_path = Path(args.log).resolve()
            log_path.parent.mkdir(parents=True, exist_ok=True)
            output = open(log_path, "wb")
        return_code = run(args, state, configuration, output=output)
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
    return return_code


if __name__ == "__main__":
    sys.exit(main())
