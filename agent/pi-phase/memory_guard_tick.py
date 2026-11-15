"""memory_guard tick: one decision from a sample and the previous state."""
from dataclasses import dataclass

from memory_guard_signals import Hysteresis, classify, enrich, has_headroom, session_cap
from memory_guard_actions import Transition, plan_actions
from memory_guard_state import write_state

HISTORY_KEEP = 8
STATE_SIGNALS = ("sessions", "pl", "cmpPct", "swapMb", "swapGrowth", "swapInRate", "psLatency")
COMPACT_KEYS = ("t", "pl", "cmpPct", "swapMb", "swapIns", "swapInRate", "swapGrowth", "sessions", "psLatency")


@dataclass(frozen=True)
class Guard:
    """What a tick works with: settings, state directory, the actuator and whether to execute/write."""
    settings: dict
    directory: object
    actuator: object
    execute: bool = True


@dataclass(frozen=True)
class TickInput:
    sample: object
    previous_state: dict
    now: float


def compact(sample):
    return None if sample is None else {key: sample.get(key) for key in COMPACT_KEYS}


def headroom_state(level, enriched, settings, previous_state):
    """(confirmed, ticks): capacity rises slowly (headroom must hold headroom_ticks ticks) and falls at once."""
    held = level == 0 and has_headroom(enriched, settings)
    ticks = previous_state.get("headroomTicks", 0) + 1 if held else 0
    return ticks >= settings["headroom_ticks"], ticks


def build_state(guard, inputs, enriched, outcome):
    settings, previous = guard.settings, inputs.previous_state
    level, raw, reasons, hysteresis, actions = outcome
    headroom, ticks = headroom_state(level, enriched, settings, previous)
    history = list(previous.get("hist", []))
    notified = any(action.name == "notify" for action in actions)
    return dict(level=level, raw=raw, reasons=reasons, t=inputs.now, clear=hysteresis.clear, mode=settings["mode"],
                headroom=headroom, headroomTicks=ticks, cap=session_cap(level, headroom, settings),
                mem=(inputs.sample or {}).get("mem"), procs=(inputs.sample or {}).get("procs"),
                hist=(history + [compact(enriched)])[-HISTORY_KEEP:],
                lastNotify=inputs.now if notified else previous.get("lastNotify", 0),
                **{key: (enriched or {}).get(key) for key in STATE_SIGNALS})


def tick(guard, inputs):
    """One guard decision. Returns the new state (written unless guard.execute is False) and the actions taken."""
    settings, previous = guard.settings, inputs.previous_state
    history = list(previous.get("hist", []))
    enriched = enrich(inputs.sample, history) if inputs.sample is not None else None
    raw, reasons = classify(enriched, history, settings)
    hysteresis = Hysteresis(previous.get("level", 0), previous.get("clear", 0))
    level = hysteresis.update(raw)
    if level > raw and not reasons:
        reasons = [f"holding level {level} until {hysteresis.clear_ticks - hysteresis.clear} more clear tick(s)"]
    move = Transition(level, previous.get("level", 0), inputs.now, previous.get("lastNotify", 0))
    actions = plan_actions(move, settings)
    state = build_state(guard, inputs, enriched, (level, raw, reasons, hysteresis, actions))
    if guard.execute:
        write_state(guard.directory, state)  # publish first: shedding and docker stops take minutes
    return state, guard.actuator.perform(level, actions, reasons)
