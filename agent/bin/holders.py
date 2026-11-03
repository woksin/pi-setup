"""Who holds a path: lsof parsing and the shared-inode (hard link) rule used by pi-cleanup and pi-holders.

A process holds PATH when its cwd is PATH or below it, or when it has an open name below PATH. lsof reports an
open inode under whichever link name is in the vnode cache, so a regular file with st_nlink > 1 is ambiguous:
the process may hold another link, and unlinking this name never affects it. Unstat-able names hold (fail closed).
"""
import os
import stat as statmod
import subprocess
from concurrent.futures import ThreadPoolExecutor

HOLD, SHARED = "hold", "shared"


class SnapshotError(Exception):
    pass


def parse_names(out, me, into):
    """Add every absolute name lsof -F reports to `into`, skipping this process and its children."""
    skip = False
    for line in out.splitlines():
        c, v = line[:1], line[1:]
        if c == "p":
            skip = v == str(me)
        elif c == "R":
            if v == str(me):
                skip = True
        elif c == "n" and not skip and v.startswith("/"):
            into.add(v)


def parse_records(out, me):
    """lsof -FpRcn output -> {pid: {"pid", "command", "names": [..]}}, skipping this process and its children."""
    records, current, skip = {}, None, False
    for line in out.splitlines():
        c, v = line[:1], line[1:]
        if c == "p":
            skip = v == str(me)
            current = None if skip else records.setdefault(v, {"pid": v, "command": "", "names": []})
        elif c == "R":
            if v == str(me) and current is not None:
                records.pop(current["pid"], None)
                skip, current = True, None
        elif c == "c" and current is not None:
            current["command"] = v
        elif c == "n" and current is not None and v.startswith("/"):
            current["names"].append(v)
    return records


def classify(name, base, forgive_shared, is_build_dir=False, build_dirs=frozenset()):
    """HOLD or SHARED for an open name at or below `base`.

    forgive_shared=True: any regular file with st_nlink > 1 is SHARED.
    forgive_shared=False: only below a build dir (is_build_dir, or a path part in build_dirs), as pi-cleanup
    deletes build output only there; everything else, and any stat failure, is HOLD.
    """
    base = base.rstrip("/")
    if not forgive_shared:
        rel = name[len(base):].lower().split("/")[1:-1] if name.lower() != base.lower() else []
        if not (is_build_dir or any(part in build_dirs for part in rel)):
            return HOLD
    try:
        st = os.lstat(name)
    except OSError:
        return HOLD
    return SHARED if statmod.S_ISREG(st.st_mode) and st.st_nlink > 1 else HOLD


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


def snapshot(timeout=60, runner=None):
    """One lsof snapshot of every process: [{"pid", "command", "cwds": [...], "names": [...]}].
    Excludes this process and its children. Raises SnapshotError when lsof fails, times out or prints nothing."""
    me = os.getpid()
    runner = runner or run
    with ThreadPoolExecutor(2) as ex:
        f_all = ex.submit(runner, ["lsof", "-nP", "-FpRcn"], timeout)
        f_cwd = ex.submit(runner, ["lsof", "-nP", "-d", "cwd", "-FpRcn"], timeout)
        results = [f_all.result(), f_cwd.result()]
    for rc, out, err in results:
        if rc in (124, 126, 127) or not out:
            raise SnapshotError(f"lsof failed (rc={rc}): {err.strip()[:200]}")
    everything, cwds = parse_records(results[0][1], me), parse_records(results[1][1], me)
    processes = []
    for pid, record in everything.items():
        own = cwds.get(pid, {"names": []})["names"]
        processes.append({"pid": pid, "command": record["command"] or cwds.get(pid, {}).get("command", ""),
                          "cwds": own, "names": [n for n in record["names"] if n not in own]})
    for pid, record in cwds.items():
        if pid not in everything:
            processes.append({"pid": pid, "command": record["command"], "cwds": record["names"], "names": []})
    return processes


def holders_of(processes, base, forgive_shared=True):
    """(holders, ambiguous): holders are {"pid", "command", "kind": "cwd"|"open", "name"} (one per process);
    ambiguous are the shared-inode names below `base` that were not counted as holding."""
    held, ambiguous = [], []
    for process in processes:
        hit = next((("cwd", n) for n in process["cwds"] if inside(n, base)), None)
        for name in process["names"]:
            if hit or not inside(name, base):
                continue
            if classify(name, base, forgive_shared) == HOLD:
                hit = ("open", name)
            else:
                ambiguous.append({"pid": process["pid"], "command": process["command"], "name": name})
        if hit:
            held.append({"pid": process["pid"], "command": process["command"], "kind": hit[0], "name": hit[1]})
    return held, ambiguous
