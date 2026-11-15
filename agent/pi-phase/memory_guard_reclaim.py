"""memory_guard waste reclaim: which processes are orphaned or idle and safe to terminate."""
import subprocess

from memory_guard_sampling import PS_COLUMNS, PS_TIMEOUT_S, count_lines, parse_ps_table, run_text

ORPHAN_CATEGORIES = ("mcp", "node", "testhost", "dotnet")  # reclaimed only when no live pi is an ancestor
BUILD_SERVER_CATEGORY = "build-server"
BUILD_SERVER_MIN_LEVEL = 2


def has_pi_ancestor(table, pid):
    """True when a live pi session is an ancestor (the owning lane exists)."""
    seen = set()
    current = table.get(pid, {}).get("ppid")
    while current in table and current > 1 and current not in seen:
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
    """Why an entry without a live pi ancestor is waste, or None. A running phase protects everything but MCP."""
    category = entry["category"]
    if category == "mcp":
        return "orphaned mcp (no live pi ancestor)"
    if category in ORPHAN_CATEGORIES and entry["ppid"] == 1 and not phases_running:
        return f"orphaned {category} (no live pi ancestor)"
    if category == BUILD_SERVER_CATEGORY and level >= BUILD_SERVER_MIN_LEVEL and not phases_running:
        return "idle build server (no phase running)"
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
