"""Private, agent-wide protective holds. Reading the register never runs checks."""
import fcntl
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

LANE = re.compile(r"(?:[A-Z][A-Z0-9]*[a-z]?|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+)")
NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}")
ID = re.compile(r"[0-9a-f]{32}")
DAY = 24 * 60 * 60
CHECK_TIMEOUT = 10
ROUTE_TIMEOUT = 4
SWEEP_BUDGET = 60
PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENABLE = "on macOS, run ./install.sh --with lanes --with holds (without --no-launchd)"
MAX_RECORD = 8192
RESULTS = {"unchecked", "ready", "not yet", "unknown"}
REASONS = {"ready": "condition ready", "age": "still active at 24 h", "escalation": "owner no longer reachable"}


class HoldError(Exception):
    pass


class Route(NamedTuple):
    root: Path
    inbox: Path
    coordinator: str


def agent_dir():
    path = Path(os.environ.get("PI_CODING_AGENT_DIR") or "~/.pi/agent").expanduser().absolute()
    return path.parent.resolve() / path.name


def private_dir(path, *, create=False, private=True):
    if create:
        path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & (0o077 if private else 0o022)):
        raise HoldError(f"unsafe directory: {path.name}")


def trusted_agent(path):
    private_dir(path, private=False)
    # Canonical ancestors must not let another account replace the trusted agent tree.
    # A system-owned sticky temp directory protects its existing user-owned children.
    parent = path.parent.resolve()
    for ancestor in (parent, *parent.parents):
        info = ancestor.stat()
        if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise HoldError("agent directory has an unsafe ancestor")


def validate_check(base, name):
    if not NAME.fullmatch(name):
        raise HoldError("--lift must name a single executable in holds/checks/")
    path = base / "checks" / name
    try:
        trusted_agent(base.parent)
        private_dir(base)
        private_dir(path.parent)
        info = path.lstat()
    except OSError as e:
        raise HoldError("check is missing or inaccessible in holds/checks/") from e
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o7077 or not info.st_mode & 0o100 or not os.access(path, os.X_OK)):
        raise HoldError("check must be a regular, owner-only executable (no symlinks)")
    return path


def local_env():
    return {"HOME": str(Path.home()), "PATH": PATH, "PYTHONDONTWRITEBYTECODE": "1"}


def run_bounded(args, *, cwd, timeout, capture=False, user_bin=False):
    env = local_env()
    if user_bin:
        env["PATH"] += f":{Path.home()}/.local/bin"
    with subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True,
                          stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL) as proc:
        try:
            output, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
        return proc.returncode, output


def check(base, name):
    try:
        path = validate_check(base, name)
        code, _ = run_bounded([path], cwd=path.parent, timeout=CHECK_TIMEOUT)
        return {0: "ready", 1: "not yet"}.get(code, "unknown")
    except (HoldError, OSError, subprocess.TimeoutExpired):
        return "unknown"


def scheduler_loaded(base):
    if sys.platform != "darwin":
        return False
    user = re.sub(r"[^A-Za-z0-9-]", "", os.environ.get("USER", "")) or "pi-setup"
    label = f"gui/{os.getuid()}/com.{user}.holds"
    program = base.parent / "bin" / "holds"
    try:
        code, output = run_bounded(["/bin/launchctl", "print", label], cwd="/", timeout=4, capture=True)
        job = output.decode(errors="replace")
        return (code == 0 and f"program = {program}" in map(str.strip, job.splitlines())
                and re.search(r"arguments = \{\s*" + re.escape(str(program)) + r"\s+sweep\s*\}", job) is not None)
    except (OSError, subprocess.TimeoutExpired):
        return False


def lane_id(value):
    return isinstance(value, str) and len(value) <= 32 and LANE.fullmatch(value) and value.lower() != "all"


def lane_root():
    if root := os.environ.get("LANES_DIR"):
        return Path(root).resolve()
    try:
        cwd = Path.cwd()
    except FileNotFoundError:
        return None
    return next((p for p in (cwd, *cwd.parents) if (p / "lanes.json").is_file()), None)


def resolve_inbox(root, config):
    messages = config["messages"]["dir"]
    values = dict(config, root=str(root))
    for _ in range(8):
        messages = re.sub(r"\$\{(root|reposRoot|worktreesDir)\}", lambda m: values[m[1]], messages)
    inbox = (root / Path(os.path.expanduser(messages))).resolve(strict=True)
    if "${" in messages or not inbox.is_dir() or not os.access(inbox, os.W_OK | os.X_OK):
        raise ValueError
    if (expected := os.environ.get("INBOX_DIR")) and Path(expected).resolve() != inbox:
        raise ValueError
    return inbox


def route_recipients(config, owner):
    lanes = config["lanes"]
    coordinator = config["coordinator"]["id"]
    groups = {lane["group"].lower() for lane in lanes if lane.get("group")}
    groups.add(config["messages"]["broadcast"].lower())
    if not lane_id(coordinator) or coordinator.lower() in groups:
        raise ValueError
    individuals = {lane["id"] for lane in lanes if not (lane.get("retired") or lane.get("closed"))}
    if owner.lower() in groups or owner not in individuals | {coordinator}:
        raise HoldError("owner must be an individual configured lane, not retired, a group or broadcast")
    return coordinator


def capture_route(owner):
    root = lane_root()
    if root is None:
        raise HoldError("missing lane route: set LANES_DIR or run from a lanes workspace")
    try:
        config = json.loads((root / "lanes.json").read_text())
        return Route(root, resolve_inbox(root, config), route_recipients(config, owner))
    except (OSError, ValueError, KeyError, AttributeError, TypeError) as e:
        raise HoldError("missing or invalid lane route (lanes.json / inbox)") from e


def live_row(roster, owner):
    sources = roster["sources"]
    if sources["status-files"]["status"] == "error" or sources["processes"]["status"] != "ok":
        return None
    rows = [row for row in roster["rows"] if row["lane"] == owner]
    if len(rows) != 1:
        return None
    row = rows[0]
    if row["state"] not in ("working", "idle", "waiting", "blocked"):
        return None
    if row["identity"] not in ("registered", "orch", "launched"):
        return None
    pid = row["pid"]
    return row if type(pid) is int and pid > 0 else None


def identity_file(path):
    # These are workspace/orch inputs, not trusted private register files.
    # Do not follow a symlink or let a FIFO block the scheduler.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as src:
            if stat.S_ISREG(os.fstat(src.fileno()).st_mode):
                value = json.loads(src.read(MAX_RECORD + 1))
                return value if isinstance(value, dict) else {}
    except (OSError, ValueError, RecursionError):
        pass
    return {}


def identified_process(root, owner, row):
    # A roster row may be joined by cwd even with a positive registration or
    # heartbeat flag. Require an independent lane-to-PID link in that source.
    evidence, pid = row["evidence"], row["pid"]
    if "registration" in evidence:
        reg = identity_file(Path(root) / ".state/roster" / f"{owner}.json")
        if (reg.get("id"), reg.get("pid"), reg.get("retiredAt")) == (owner, pid, None):
            return True
    if "heartbeat(fresh)" in evidence and (session_id := row.get("sessionId")):
        hb = identity_file(Path.home() / ".pi/orch/heartbeats" / f"p{pid}.json")
        return (hb.get("id"), hb.get("pid"), hb.get("sessionId")) == (owner, pid, session_id)
    return False


def live_owner(root, owner):
    """A configured name or a wrapper PID by itself does not prove a live lane."""
    try:
        lanes = Path.home() / ".local/bin/lanes"
        code, output = run_bounded([lanes, "--dir", root, "who", "--json"], cwd="/",
                                   timeout=ROUTE_TIMEOUT, capture=True, user_bin=True)
        if code or (row := live_row(json.loads(output), owner)) is None:
            return False
        if not identified_process(root, owner, row):
            return False
        os.kill(row["pid"], 0)
        return True
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return False


def atomic_write(path, text, *, replace=True):
    fd, tmp = tempfile.mkstemp(prefix=".hold-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(text)
        if replace:
            os.replace(tmp, path)
        else:
            try:
                os.link(tmp, path)  # publish atomically without waking an already-notified lane again
            except FileExistsError:
                if not stat.S_ISREG(path.lstat().st_mode):
                    raise
    finally:
        Path(tmp).unlink(missing_ok=True)


class Register:
    def __init__(self, base=None):
        self.base = base if base is not None else agent_dir() / "holds"
        self.records = self.base / "records"

    def validate(self, create=False):
        trusted_agent(self.base.parent)
        private_dir(self.base, create=create)
        private_dir(self.records, create=create)

    @contextmanager
    def locked(self, *, create=False):
        self.validate(create)
        fd = os.open(self.base / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            deadline = time.monotonic() + 1
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise HoldError("hold register is busy; try again")
                    time.sleep(0.025)
            yield
        finally:
            os.close(fd)

    def save(self, record):
        atomic_write(self.records / f"{record['id']}.json", json.dumps(record) + "\n")

    def read(self, hold_id):
        fd = os.open(self.records / f"{hold_id}.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as src:
            info = os.fstat(src.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise HoldError("unsafe hold record")
            raw = src.read(MAX_RECORD + 1)
        try:
            if len(raw) > MAX_RECORD:
                raise ValueError
            record = json.loads(raw)
            if not valid_record(record, hold_id):
                raise ValueError
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as e:
            raise HoldError("invalid hold record") from e
        return record

    def active(self, deadline=None):
        records, unavailable = [], False
        try:
            os.lstat(self.base)  # no register at all is empty, whatever the agent dir looks like
        except FileNotFoundError:
            return records, False
        try:
            self.validate()
            with os.scandir(self.records) as entries:
                for entry in entries:
                    if deadline is not None and time.monotonic() >= deadline:
                        return records, True
                    if not (entry.name.endswith(".json") and ID.fullmatch(entry.name[:-5])):
                        continue
                    try:
                        record = self.read(entry.name[:-5])
                        if record["lifted_at"] is None:
                            records.append(record)
                    except (OSError, HoldError):
                        unavailable = True
        except FileNotFoundError:
            pass  # a register that has never been created is empty
        except (OSError, HoldError):
            unavailable = True
        return records, unavailable

    def add(self, owner, what, probe, now, scheduler=scheduler_loaded):
        if not lane_id(owner):
            raise HoldError("invalid owner lane id")
        what = clean_text(what)
        if not what:
            raise HoldError("--what must describe the protective change")
        if not scheduler(self.base):
            raise HoldError(f"holds sweep is not loaded; {ENABLE} before placing a hold")
        root, inbox, coordinator = capture_route(owner)
        validate_check(self.base, probe)
        record = {"id": uuid.uuid4().hex, "root": str(root), "inbox": str(inbox), "coordinator": coordinator,
                  "owner": owner, "what": what, "probe": probe, "created_at": now, "checked_at": None,
                  "result": "unchecked", "ready": False, "delivered": {}, "pending": None,
                  "lifted_at": None, "lifted_by": None}
        with self.locked(create=True):
            self.save(record)
        return record["id"]

    def lift(self, hold_id, now):
        if not ID.fullmatch(hold_id):
            raise HoldError("invalid hold id")
        try:
            with self.locked():
                record = self.read(hold_id)
                if record["lifted_at"] is None:
                    lane = os.environ.get("PI_ORCH_ID")
                    record.update(lifted_at=now, lifted_by=lane if lane_id(lane) else pwd.getpwuid(os.getuid()).pw_name)
                    self.save(record)
                    return True
                return False
        except FileNotFoundError as e:
            raise HoldError("unknown hold id") from e


def clean_text(value):
    return " ".join("".join(c if c.isprintable() else " " for c in value).split())[:240].rstrip()


def valid_time(value):
    return value is None or type(value) in (float, int) and 0 <= value < 253402300799


def valid_delivery(record, recipients):
    if not all(key in REASONS and lane in recipients for key, lane in record["delivered"].items()):
        return False
    alert = record["pending"]
    if alert is None:
        return True
    events = alert["events"]
    return (alert["to"] in recipients and isinstance(events, list)
            and 0 < len(events) <= len(REASONS) and all(e in REASONS for e in events))


def valid_record(r, hold_id):
    if not isinstance(r, dict) or r["id"] != hold_id:
        return False
    recipients = (r["owner"], r["coordinator"])
    if not all(lane_id(lane) for lane in recipients) or not valid_delivery(r, recipients):
        return False
    if not all(os.path.isabs(r[key]) for key in ("root", "inbox")):
        return False
    if r["created_at"] is None or not all(valid_time(r[k]) for k in ("created_at", "checked_at", "lifted_at")):
        return False
    return (r["result"] in RESULTS and type(r["ready"]) is bool and NAME.fullmatch(r["probe"])
            and bool(r["what"]) and r["what"] == clean_text(r["what"]))


def summary_time(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if t is not None else None


def summaries(*, root=None, now):
    try:
        active, unavailable = Register().active()
    except (OSError, RuntimeError):
        return [], True
    return [dict(id=r["id"], owner=r["owner"], what=r["what"], root=r["root"],
                 age_seconds=max(0, int(now - r["created_at"])), result=r["result"],
                 checked_at=summary_time(r["checked_at"]))
            for r in sorted(active, key=lambda r: (r["created_at"], r["id"]))
            if root is None or r["root"] == str(root)], unavailable


def summary_line(h):
    hours, remainder = divmod(h["age_seconds"], 3600)
    checked = f" at {h['checked_at']}" if h["checked_at"] else ""
    return f"{h['id']} {h['owner']}: {h['what']} ({hours}h{remainder // 60:02d}m; {h['result']}{checked})"


def pending_reasons(record, now):
    delivered = record["delivered"]
    return [key for key, due in (("ready", record["ready"]), ("age", now - record["created_at"] >= DAY))
            if due and key not in delivered]


def can_escalate(record):
    sent = record["delivered"]
    return record["owner"] != record["coordinator"] and record["owner"] in sent.values() and "escalation" not in sent


def alert_path(record, alert):
    events = "-".join(alert["events"])
    return Path(record["inbox"]) / f"HOLD-to-{alert['to']}-hold-{record['id']}-{events}.md"


def finish_alert(register, record):
    alert = record["pending"]
    record["delivered"].update(dict.fromkeys(alert["events"], alert["to"]))
    record["pending"] = None
    register.save(record)


def recover_delivery(register, record):
    if record["pending"] is not None:
        try:
            info = alert_path(record, record["pending"]).lstat()
        except FileNotFoundError:
            return
        if stat.S_ISREG(info.st_mode):
            finish_alert(register, record)


def deliver(register, record, recipient, events):
    alert = {"to": recipient, "events": events}
    record["pending"] = alert  # recover if we exit between publishing and recording delivery
    register.save(record)
    reasons = "; ".join(REASONS[key] for key in events)
    atomic_write(alert_path(record, alert),
                 f"Protective hold {record['id']} (owner {record['owner']}): {reasons}.\n\n{record['what']}\n\n"
                 f"Inspect the actual state and leave the hold in place unless removal is authorized. "
                 f"After authorized removal, run `holds lift {record['id']}`.\n", replace=False)
    finish_alert(register, record)


def sweep_one(register, snapshot, *, clock):
    hold_id = snapshot["id"]
    result = check(register.base, snapshot["probe"])
    now = clock()
    with register.locked():
        record = register.read(hold_id)
        if record["lifted_at"] is not None:
            return
        record.update(checked_at=now, result=result, ready=record["ready"] or result == "ready")
        register.save(record)
        recover_delivery(register, record)
        if not (pending_reasons(record, now) or can_escalate(record)):
            return
    owner, coordinator = record["owner"], record["coordinator"]
    recipient = owner if owner != coordinator and live_owner(record["root"], owner) else coordinator
    with register.locked():
        record = register.read(hold_id)
        if record["lifted_at"] is not None:
            return
        recover_delivery(register, record)
        events = pending_reasons(record, now)
        if recipient != owner and can_escalate(record):
            events.append("escalation")
        if events:
            deliver(register, record, recipient, events)


def sweep(register, *, clock=time.time):
    deadline = time.monotonic() + SWEEP_BUDGET
    records, failed = register.active(deadline)
    if failed:
        print("holds: register unavailable or incomplete", file=sys.stderr)
    for record in sorted(records, key=lambda r: (r["checked_at"] or 0, r["created_at"], r["id"])):
        if time.monotonic() + CHECK_TIMEOUT + ROUTE_TIMEOUT + 2 >= deadline:
            break
        try:
            sweep_one(register, record, clock=clock)
        except (HoldError, OSError):
            print(f"holds: could not update or notify for {record['id']}; will retry", file=sys.stderr)
            failed = True
    return 2 if failed else 0
