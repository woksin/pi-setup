"""Who holds a path: lsof parsing and the shared-inode (hard link) rule used by pi-cleanup and pi-holders.

A process holds PATH when its cwd is PATH or below it, or when it has an open name below PATH. lsof reports an
open inode under whichever link name is in the vnode cache, so a regular file with st_nlink > 1 is ambiguous:
the process may hold another link, and unlinking this name never affects it. Unstat-able names hold (fail closed).
"""
import os
import stat as statmod
import subprocess
from typing import NamedTuple
from concurrent.futures import ThreadPoolExecutor

HOLD, SHARED = "hold", "shared"


class SnapshotError(Exception):
    pass


def parse_names(out, me, into):
    """Add every absolute name lsof -F reports to `into`, skipping this process and its children."""
    for record in parse_records(out, me).values():
        into.update(record["names"])


class _Records:
    """Accumulates lsof -FpRcn lines; the current process is None while skipping this process or its children."""

    def __init__(self, me):
        self.me, self.records, self.current = str(me), {}, None

    def p(self, value):
        self.current = None if value == self.me else self.records.setdefault(value, {"pid": value, "command": "", "names": []})

    def R(self, value):
        if value == self.me and self.current is not None:
            self.records.pop(self.current["pid"], None)
            self.current = None

    def c(self, value):
        if self.current is not None:
            self.current["command"] = value

    def n(self, value):
        if self.current is not None and value.startswith("/"):
            self.current["names"].append(value)


def parse_records(out, me):
    """lsof -FpRcn output -> {pid: {"pid", "command", "names": [..]}}, skipping this process and its children."""
    parser = _Records(me)
    for line in out.splitlines():
        handler = getattr(parser, line[:1], None) if line[:1] in "pRcn" else None
        if handler:
            handler(line[1:])
    return parser.records


class Policy(NamedTuple):
    """How to judge an open name: forgive_shared forgives any shared inode; otherwise only below a build dir."""
    forgive_shared: bool
    is_build_dir: bool = False
    build_dirs: frozenset = frozenset()


def _below_build_dir(name, base, policy):
    rel = name[len(base):].lower().split("/")[1:-1] if name.lower() != base.lower() else []
    return policy.is_build_dir or any(part in policy.build_dirs for part in rel)


def _is_shared_inode(name):
    try:
        st = os.lstat(name)
    except OSError:
        return False
    return statmod.S_ISREG(st.st_mode) and st.st_nlink > 1


def classify(name, base, policy):
    """HOLD or SHARED for an open name at or below `base` (see Policy). Stat failures are HOLD (fail closed)."""
    if not policy.forgive_shared and not _below_build_dir(name, base.rstrip("/"), policy):
        return HOLD
    return SHARED if _is_shared_inode(name) else HOLD


def inside(name, base):
    n, b = name.lower(), base.lower().rstrip("/")
    return n == b or n.startswith(b + "/")


def run(args, timeout):
    """(rc, stdout, stderr); 124 timeout, 126 OS error, 127 missing."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, errors="replace", timeout=timeout,
                           stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not found"
    except OSError as e:
        return 126, "", str(e)


def _lsof_outputs(timeout, runner):
    """(everything, cwd-only) lsof outputs; raises SnapshotError on failure, timeout or empty output."""
    with ThreadPoolExecutor(2) as ex:
        f_all = ex.submit(runner, ["lsof", "-nP", "-FpRcn"], timeout)
        f_cwd = ex.submit(runner, ["lsof", "-nP", "-d", "cwd", "-FpRcn"], timeout)
        results = [f_all.result(), f_cwd.result()]
    for rc, out, err in results:
        if rc != 0 or not out:  # non-zero with output is partial (unreadable pids, timeouts): unknown, never free
            raise SnapshotError(f"lsof failed (rc={rc}): {err.strip()[:200]}")
    return results[0][1], results[1][1]


def snapshot(timeout=60, runner=None):
    """One lsof snapshot of every process: [{"pid", "command", "cwds": [...], "names": [...]}].
    Excludes this process and its children. Raises SnapshotError when lsof fails, times out or prints nothing."""
    me = os.getpid()
    out_all, out_cwd = _lsof_outputs(timeout, runner or run)
    everything, cwds = parse_records(out_all, me), parse_records(out_cwd, me)
    processes = []
    for pid, record in everything.items():
        own = cwds.get(pid, {"names": []})["names"]
        processes.append({"pid": pid, "command": record["command"] or cwds.get(pid, {}).get("command", ""),
                          "cwds": own, "names": [n for n in record["names"] if n not in own]})
    processes += [{"pid": pid, "command": r["command"], "cwds": r["names"], "names": []}
                  for pid, r in cwds.items() if pid not in everything]
    return processes


def _first_hold(process, base, forgive_shared, ambiguous):
    """("cwd"|"open", name) for the first holding name of `process`, else None; shared names go to `ambiguous`."""
    cwd = next((n for n in process["cwds"] if inside(n, base)), None)
    if cwd:
        return "cwd", cwd
    for name in (n for n in process["names"] if inside(n, base)):
        if classify(name, base, Policy(forgive_shared)) == HOLD:
            return "open", name
        ambiguous.append({"pid": process["pid"], "command": process["command"], "name": name})
    return None


def holders_of(processes, base, forgive_shared=True):
    """(holders, ambiguous): holders are {"pid", "command", "kind": "cwd"|"open", "name"} (one per process);
    ambiguous are the shared-inode names below `base` that were not counted as holding."""
    held, ambiguous = [], []
    for process in processes:
        hit = _first_hold(process, base, forgive_shared, ambiguous)
        if hit:
            held.append({"pid": process["pid"], "command": process["command"], "kind": hit[0], "name": hit[1]})
    return held, ambiguous
