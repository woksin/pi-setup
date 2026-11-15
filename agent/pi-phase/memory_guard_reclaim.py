"""memory_guard waste reclaim: which processes are orphaned or idle and safe to terminate."""
import subprocess

from memory_guard_sampling import PS_COLUMNS, PS_TIMEOUT_S, count_lines, parse_ps_table, run_text

ORPHAN_CATEGORIES = ("mcp", "testhost")  # reclaimed only when reparented to launchd (owner gone), never node/dotnet:
# those also run as launchd services, and comm cannot tell a service from an orphan
BUILD_SERVER_CATEGORY = "build-server"
BUILD_SERVER_MIN_LEVEL = 2


def is_live_ancestor(table, pid, seen):
    return pid in table and pid > 1 and pid not in seen


def has_pi_ancestor(table, pid):
    """True when a live pi session is an ancestor (the owning lane exists)."""
    seen = set()
    current = table.get(pid, {}).get("ppid")
    while is_live_ancestor(table, current, seen):
        if table[current]["category"] == "pi":
            return True
        seen.add(current)
        current = table[current]["ppid"]
    return False


def phase_running(runner=run_text):
    """True when a `pi-phase run` supervisor is alive (leases are flocks without pids, so look at processes).
    Any error counts as running (fail-safe)."""
    try:
        return count_lines(runner(["pgrep", "-f", "bin/pi-phase run"], 5)) > 0
    except subprocess.CalledProcessError:
        return False  # pgrep exits 1 on no match
    except (OSError, subprocess.SubprocessError):
        return True


def reclaim_reason(entry, level, phases_running):
    """Why an entry is waste, or None. Only a process whose parent is gone (ppid 1) qualifies: a live non-pi parent
    (editor, claude, a terminal build) owns it. A running phase protects everything but orphaned MCP servers."""
    category = entry["category"]
    if entry["ppid"] != 1:
        return None
    if category == "mcp":
        return "orphaned mcp (owner gone)"
    if phases_running:
        return None
    if category in ORPHAN_CATEGORIES:
        return f"orphaned {category} (owner gone)"
    if category == BUILD_SERVER_CATEGORY and level >= BUILD_SERVER_MIN_LEVEL:
        return "orphaned build server (owner gone, no phase running)"
    return None


def reclaim_candidates(table, level, phases_running, self_pid=None):
    """[(pid, comm, why)] wasted processes. Never anything with a live pi ancestor; see reclaim_reason."""
    found = []
    for pid, entry in sorted(table.items()):
        why = None if pid == self_pid or has_pi_ancestor(table, pid) else reclaim_reason(entry, level, phases_running)
        if why:
            found.append((pid, entry["comm"], why))
    return found


def reclaim_list(runner, level, uid, self_pid):
    try:
        table = parse_ps_table(runner(["ps", "-axo", PS_COLUMNS], PS_TIMEOUT_S), uid)
    except (OSError, subprocess.SubprocessError):
        return []
    return reclaim_candidates(table, level, phase_running(runner), self_pid)
