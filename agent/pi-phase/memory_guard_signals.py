"""memory_guard decision logic: swap signals, level classification, hysteresis, headroom and effective slots."""
from dataclasses import dataclass

from memory_guard_config import DEFAULTS, HEAVY_HARD_CEILING, number

GROWTH_WINDOW_S = 300
MIN_SPAN_S = 60
NORMAL_HEAVY_CEILING = 3
POOLS_BY_LEVEL = {0: {}, 1: {}, 2: dict(heavy=1, fast=1, integration=0), 3: dict(heavy=0, fast=1, integration=0),
                  4: dict(heavy=0, fast=0, integration=0)}


def has_swap_ins(sample):
    return bool(sample) and "swapIns" in sample


def swap_in_rate(previous, current):
    """Pages/s between two samples (Swapins counter delta); None without a usable pair."""
    if not (has_swap_ins(previous) and has_swap_ins(current)):
        return None
    span = current["t"] - previous["t"]
    delta = current["swapIns"] - previous["swapIns"]
    return round(delta / span, 1) if span > 0 and delta >= 0 else None


def swap_growth(history, current):
    """MB/min of swap used against the oldest sample within GROWTH_WINDOW_S that is at least MIN_SPAN_S old."""
    for old in history:
        span = current["t"] - old["t"]
        if MIN_SPAN_S <= span <= GROWTH_WINDOW_S and number(old.get("swapMb")):
            return round((current["swapMb"] - old["swapMb"]) / (span / 60), 1)
    return None


def enrich(sample, history):
    """Add swapInRate and swapGrowth derived from the history (oldest first, failed ticks skipped)."""
    good = [item for item in history if item and "swapMb" in item]
    sample = dict(sample)
    sample["swapInRate"] = swap_in_rate(good[-1] if good else None, sample)
    sample["swapGrowth"] = swap_growth(good, sample)
    return sample


def at_least(value, limit):
    return value is not None and value >= limit


def sustained(sample, history, key, limit):
    previous = history[-1] if history else None
    return at_least(sample.get(key), limit) and bool(previous) and at_least(previous.get(key), limit)


def compressor_reason(sample, limit):
    return [f"compressor {sample['cmpPct']:g}% >= {limit:g}%"] if sample["cmpPct"] >= limit else []


def latency_reason(sample, limit):
    return [f"ps latency {sample['psLatency']:g}s"] if at_least(sample.get("psLatency"), limit) else []


def swap_in_reason(sample, history, limit):
    return [f"swap-in {sample['swapInRate']:g} pages/s sustained"] if sustained(sample, history, "swapInRate", limit) else []


def pressure_held(sample, history, limit):
    previous = history[-1] if history else None
    return sample["pl"] >= limit and bool(previous) and previous.get("pl", 0) >= limit


def emergency_reasons(sample, history, limits):
    pressure = sample["pl"] >= limits["emergency_pressure_level"]
    return ([f"memory pressure level {sample['pl']} (critical)"] if pressure else []) \
        + compressor_reason(sample, limits["emergency_compressor_percent"]) \
        + latency_reason(sample, limits["emergency_ps_latency_s"])


def shed_reasons(sample, history, limits):
    held = [f"memory pressure level {sample['pl']} held"] if pressure_held(sample, history, limits["shed_pressure_level"]) else []
    return compressor_reason(sample, limits["shed_compressor_percent"]) \
        + swap_in_reason(sample, history, limits["shed_swap_in_pages_per_s"]) + held


def stop_reasons(sample, history, limits):
    growth = at_least(sample.get("swapGrowth"), limits["stop_swap_growth_mb_per_min"])
    over_hard = sample.get("sessions", 0) > limits["hard_live_sessions"]
    return compressor_reason(sample, limits["stop_compressor_percent"]) \
        + ([f"swap growth {sample['swapGrowth']:g} MB/min"] if growth else []) \
        + swap_in_reason(sample, history, limits["stop_swap_in_pages_per_s"]) \
        + ([f"{sample['sessions']} live pi > hard cap {limits['hard_live_sessions']:g}"] if over_hard else []) \
        + latency_reason(sample, limits["stop_ps_latency_s"])


def warn_reasons(sample, history, limits):
    pressure = sample["pl"] >= limits["warn_pressure_level"]
    over_soft = sample.get("sessions", 0) > limits["max_live_sessions"]
    return ([f"memory pressure level {sample['pl']}"] if pressure else []) \
        + compressor_reason(sample, limits["warn_compressor_percent"]) \
        + ([f"{sample['sessions']} live pi > soft cap {limits['max_live_sessions']:g}"] if over_soft else []) \
        + latency_reason(sample, limits["warn_ps_latency_s"])


LADDER = ((4, emergency_reasons), (3, shed_reasons), (2, stop_reasons), (1, warn_reasons))


def classify(sample, history, limits):
    """(level 0..4, reasons) for one enriched sample. `sample` None is a failed probe: two in a row => emergency."""
    if sample is None:
        twice = bool(history) and history[-1] is None
        return (4, ["guard could not sample twice in a row"]) if twice else (1, ["sample failed once"])
    for level, rule in LADDER:
        reasons = rule(sample, history, limits)
        if reasons:
            return level, reasons
    return 0, []


class Hysteresis:
    """Rises immediately; falls one level only after `clear_ticks` consecutive ticks below the current level."""
    def __init__(self, level=0, clear=0, clear_ticks=3):
        self.level, self.clear, self.clear_ticks = level, clear, clear_ticks

    def update(self, raw):
        if raw >= self.level:
            self.level, self.clear = raw, 0
            return self.level
        self.clear += 1
        if self.clear >= self.clear_ticks:
            self.level, self.clear = max(raw, self.level - 1), 0
        return self.level


def has_headroom(sample, limits):
    """Room to grow: low compressor, no swap-in, normal pressure, fast ps. A single-sample test; callers debounce."""
    if sample is None:
        return False
    return all((sample["pl"] <= 1, sample["cmpPct"] < limits["headroom_compressor_percent"],
                (sample.get("swapInRate") or 0) < limits["headroom_swap_in_pages_per_s"],
                (sample.get("swapGrowth") or 0) <= 0, (sample.get("psLatency") or 0) < limits["warn_ps_latency_s"]))


def session_cap(level, headroom, limits):
    """Live-pi cap: hard cap with headroom at level 0, soft cap at level 0, reduced at level 1, none above."""
    if level >= 2:
        return 0
    if level == 1:
        return max(0, limits["max_live_sessions"] - limits["level1_cap_reduction"])
    return limits["hard_live_sessions"] if headroom else limits["max_live_sessions"]


@dataclass(frozen=True)
class Capacity:
    """Inputs that decide effective slots: guard level, live pi count, confirmed headroom."""
    level: int
    sessions: int = 0
    headroom: bool = False


def target_slots(pool, wanted, grows, limits):
    """The slot count a pool aims for before the level table caps it (headroom raises heavy/fast only)."""
    grow = grows.get(pool)
    if grow and pool == "heavy":
        return max(wanted, min(limits["max_heavy_slots"], HEAVY_HARD_CEILING))
    if grow and pool == "fast":
        return max(wanted, limits["max_fast_slots"])
    return wanted


def slot_rule(pool, counts, capacity, ceiling):
    wanted, effective = counts
    if effective < wanted:
        if pool in POOLS_BY_LEVEL[min(capacity.level, 4)]:
            return f"guard level {capacity.level}"
        return f"heavy ceiling {ceiling} (no headroom, {capacity.sessions} live pi)"
    return f"headroom (raised from {wanted})" if effective > wanted else None


def effective_slots(capacity, configured, limits=None):
    """({heavy, fast, integration}, {pool: reason}). Falls with the level; with headroom at level 0 heavy and fast
    rise to the configured ceilings (max_heavy_slots <= 4, max_fast_slots); heavy needs <= max_sessions_for_heavy_growth
    live pi sessions too, otherwise it never exceeds 3."""
    limits = limits or DEFAULTS
    grow = capacity.level == 0 and capacity.headroom
    grows = dict(fast=grow, heavy=grow and capacity.sessions <= limits["max_sessions_for_heavy_growth"])
    ceiling = min(limits["max_heavy_slots"], HEAVY_HARD_CEILING) if grows["heavy"] else NORMAL_HEAVY_CEILING
    table = POOLS_BY_LEVEL[min(capacity.level, 4)]
    effective, rules = {}, {}
    for pool, wanted in configured.items():
        target = target_slots(pool, wanted, grows, limits)
        cap = table.get(pool, ceiling if pool == "heavy" else target)
        effective[pool] = min(target, cap, ceiling) if pool == "heavy" else min(target, cap)
        rule = slot_rule(pool, (wanted, effective[pool]), capacity, ceiling)
        if rule:
            rules[pool] = rule
    return effective, rules
