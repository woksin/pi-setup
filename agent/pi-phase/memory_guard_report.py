"""memory_guard human-readable output: the `memory:` block of `pi-phase status` and `memory-guard --once`."""
from memory_guard_config import LEVEL_NAMES
from memory_guard_signals import Capacity, effective_slots

POOLS = ("heavy", "fast", "integration")


def fmt(state, key, unit=""):
    value = state.get(key)
    return "n/a" if value is None else f"{value:g}{unit}"


def headroom_line(state, settings, effective, used):
    """"headroom: can admit N more lanes / M more heavy phases" from the guard cap and the effective heavy slots."""
    cap = state.get("cap", settings["max_live_sessions"])
    lanes = max(0, int(cap - (state.get("sessions") or 0)))
    text = f"memory: headroom can admit {lanes} more lane(s) (cap {cap:g}"
    if effective:
        text += f") / {max(0, effective['heavy'] - (used or {}).get('heavy', 0))} more heavy phase(s)"
    else:
        text += ")"
    return text + ("; headroom confirmed" if state.get("headroom") else "; no confirmed headroom: cap and heavy at base")


def category_line(state):
    mem, procs = state.get("mem"), state.get("procs") or {}
    if not mem:
        return None
    parts = ", ".join(f"{name} {mb} MB x{procs.get(name, 0)}" for name, mb in mem.items() if mb)
    return f"memory: rss by category {parts} (RSS undercounts compressed pages)"


def slots_line(configured, effective, rules):
    parts = [f"{pool} {configured[pool]}->{effective[pool]}" + (f" ({rules[pool]})" if pool in rules else "")
             for pool in POOLS if pool in configured]
    return "memory: slots configured->effective " + ", ".join(parts)


def signal_lines(state, settings):
    level = state.get("level", 1)
    stale = " [guard not running: state missing or stale]" if state.get("stale") else ""
    return [f"memory: guard level {level} ({LEVEL_NAMES[min(level, 4)]}) mode={settings['mode']}{stale}",
            f"memory: pressure level {fmt(state, 'pl')} compressor {fmt(state, 'cmpPct', '%')}"
            f" swap used {fmt(state, 'swapMb', ' MB')} growth {fmt(state, 'swapGrowth', ' MB/min')}"
            f" swap-in {fmt(state, 'swapInRate', ' pages/s')}",
            f"memory: live pi {fmt(state, 'sessions')} (soft cap {settings['max_live_sessions']:g},"
            f" hard {settings['hard_live_sessions']:g})"]


def describe(state, settings, configured=None, used=None):
    """Lines for the `memory:` block of `pi-phase status` and for `memory-guard --once`."""
    lines = signal_lines(state, settings)
    if state.get("reasons"):
        lines.append("memory: reasons " + "; ".join(state["reasons"]))
    if category_line(state):
        lines.append(category_line(state))
    effective = None
    if configured:
        capacity = Capacity(state.get("level", 1), state.get("sessions") or 0, bool(state.get("headroom")))
        effective, rules = effective_slots(capacity, configured, settings)
        lines.append(slots_line(configured, effective, rules))
    lines.append(headroom_line(state, settings, effective, used))
    return lines
