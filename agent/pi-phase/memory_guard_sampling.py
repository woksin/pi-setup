"""memory_guard host sampling: sysctl, vm_stat, pgrep and a per-category `ps` table. No `ps -o lstart`."""
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import time

PS_TIMEOUT_S = 22
PS_COLUMNS = "pid=,ppid=,uid=,rss=,comm="
SYSCTL_NAMES = ["vm.swapusage", "vm.compressor_bytes_used", "hw.memsize", "kern.memorystatus_vm_pressure_level"]
# (category, comm names or fnmatch patterns). First match wins; order matters (mcp before node).
CATEGORIES = (("pi", ("pi",)), ("mcp", ("*-mcp", "*-mcp-*", "chrome-devtools-mcp", "cs-mcp")),
              ("build-server", ("VBCSCompiler", "csc")), ("testhost", ("testhost*", "vstest*")),
              ("dotnet", ("dotnet",)), ("node", ("node", "tsserver")),
              ("python", ("python", "python3", "Python", "Python3")),
              ("docker", ("docker", "com.docker.*", "com.apple.Virtualization.VirtualMachine", "vpnkit*")))


def run_text(command, timeout):
    return subprocess.run(command, capture_output=True, text=True, check=True, timeout=timeout).stdout


def count_lines(text):
    return len([line for line in text.splitlines() if line.strip()])


def parse_vm_stat(text):
    """`vm_stat` -> pageSize and the monotonically increasing Swapins/Swapouts page counters."""
    found = [re.search(pattern, text, re.M) for pattern in
             (r"page size of (\d+) bytes", r"^Swapins:\s+(\d+)\.?", r"^Swapouts:\s+(\d+)\.?")]
    if not all(found):
        raise ValueError("unrecognized vm_stat output")
    size, ins, outs = (int(match.group(1)) for match in found)
    return dict(pageSize=size, swapIns=ins, swapOuts=outs)


def parse_sysctl(text):
    """Output of `sysctl -n` for SYSCTL_NAMES -> swapMb (used), cmpPct, pl."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != len(SYSCTL_NAMES):
        raise ValueError("unrecognized sysctl output")
    used = re.search(r"\bused\s*=\s*([0-9.]+)M", lines[0])
    compressor, memsize, level = (int(line) for line in lines[1:])
    if not used or min(compressor, level) < 0 or memsize <= 0:
        raise ValueError("invalid sysctl values")
    return dict(swapMb=float(used.group(1)), cmpPct=round(compressor * 100 / memsize, 2), pl=level)


def category_of(comm):
    base = comm.strip().rsplit("/", 1)[-1]
    for name, patterns in CATEGORIES:
        if any(fnmatch.fnmatchcase(base, pattern) for pattern in patterns):
            return name
    return "other"


def parse_ps_line(line):
    parts = line.split(None, 4)
    if len(parts) != 5 or not all(part.isdigit() for part in parts[:4]):
        return None
    pid, ppid, uid, rss = (int(part) for part in parts[:4])
    return pid, dict(ppid=ppid, uid=uid, rssKb=rss, comm=parts[4].strip(), category=category_of(parts[4]))


def parse_ps_table(text, uid=None):
    """`ps -axo pid=,ppid=,uid=,rss=,comm=` -> {pid: dict(ppid, uid, rssKb, comm, category)}; uid filters when given."""
    parsed = (parse_ps_line(line) for line in text.splitlines())
    return {pid: entry for pid, entry in filter(None, parsed) if uid is None or entry["uid"] == uid}


def category_mb(table):
    """MB resident per category (RSS undercounts compressed pages: accounting only, never a decision signal)."""
    totals = {}
    for entry in table.values():
        totals[entry["category"]] = totals.get(entry["category"], 0) + entry["rssKb"]
    return {name: round(kib / 1024) for name, kib in sorted(totals.items(), key=lambda item: -item[1])}


def counts_by_category(table):
    counts = {}
    for entry in table.values():
        counts[entry["category"]] = counts.get(entry["category"], 0) + 1
    return counts


def read_ps(runner, monotonic):
    """(mem, procs, latency) from one `ps`; a failing ps never fails the sample (latency = the timeout)."""
    began = monotonic()
    try:
        table = parse_ps_table(runner(["ps", "-axo", PS_COLUMNS], PS_TIMEOUT_S), os.getuid())
    except (OSError, subprocess.SubprocessError):
        return {}, {}, float(PS_TIMEOUT_S)
    return category_mb(table), counts_by_category(table), round(monotonic() - began, 2)


def read_sample(runner=run_text, clock=time.time, monotonic=time.monotonic):
    """One host sample, or raises."""
    sample = parse_sysctl(runner(["sysctl", "-n", *SYSCTL_NAMES], 5))
    sample.update(parse_vm_stat(runner(["vm_stat"], 5)))
    sample["sessions"] = count_lines(runner(["pgrep", "-x", "pi"], 5))
    sample["mem"], sample["procs"], sample["psLatency"] = read_ps(runner, monotonic)
    sample["t"] = clock()
    return sample


def pgrep_count(runner=run_text):
    try:
        return count_lines(runner(["pgrep", "-x", "pi"], 5))
    except subprocess.CalledProcessError:
        return 0  # pgrep exits 1 on no match
    except (OSError, subprocess.SubprocessError):
        return None


def pgrep_tolerant(runner):
    def run(command, timeout):
        if command[:2] == ["pgrep", "-x"]:
            return "\n".join(["x"] * (pgrep_count(runner) or 0))
        return runner(command, timeout)
    return run


def injected_sample():
    """PI_MEM_GUARD_SAMPLE=<json file>: a fixed sample for tests and dry runs of the consumers."""
    path = os.environ.get("PI_MEM_GUARD_SAMPLE")
    if not path:
        return None
    sample = json.loads(Path(path).read_text())
    sample.setdefault("t", time.time())
    return sample
