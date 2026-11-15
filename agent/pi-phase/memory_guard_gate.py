"""memory_guard spawn gate: refuse new lanes at the adaptive cap or at guard level >= 2."""
from dataclasses import dataclass
import os
import subprocess

from memory_guard_sampling import injected_sample, pgrep_count, run_text
from memory_guard_signals import classify, enrich, session_cap
from memory_guard_state import read_level


@dataclass(frozen=True)
class Probe:
    """How the gate reads the host: a command runner and an optional fixed clock."""
    runner: object = run_text
    now: object = None


def pressure_level(runner):
    try:
        return int(runner(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], 3).strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def gate_view(settings, directory, probe):
    """(level, reasons, stale, cap, from_sample) from an injected sample or the guard state file."""
    sample = injected_sample()
    if sample is not None:
        level, reasons = classify(enrich(sample, []), [], settings)
        return level, reasons, False, session_cap(level, False, settings), True
    info = read_level(directory, settings["stale_s"], probe.now)
    cap = settings["max_live_sessions"] if info["stale"] else info.get("cap", settings["max_live_sessions"])
    return info["level"], info.get("reasons", []), info["stale"], cap, False


def gate_decision(settings, directory, sessions, probe=None):
    """(allowed, message). Refuses at guard level >= 2, at the adaptive cap, or with stale state under pressure."""
    probe = probe or Probe()
    level, reasons, stale, cap, injected = gate_view(settings, directory, probe)
    if level >= 2:
        return False, f"memory guard level {level}: {'; '.join(reasons)}"
    if sessions is not None and sessions >= cap:
        return False, f"{sessions} live pi >= cap {cap:g} (adaptive: memory_guard max_live_sessions/hard_live_sessions)"
    if stale and not injected and pressure_level(probe.runner) >= 2:
        return False, "memory guard not running and memory pressure level >= 2"
    return True, f"ok (level {level}, {sessions} live pi)"


def run_gate(settings, directory, log, runner=run_text):
    if settings["mode"] == "off":
        print("memory guard off; not checking")
        return 0
    allowed, message = gate_decision(settings, directory, pgrep_count(runner), Probe(runner))
    override = os.environ.get("LANE_CAP_OVERRIDE", "").strip()
    if allowed:
        print(message)
        return 0
    if override:
        log(f"OVERRIDE LANE_CAP_OVERRIDE={override!r}: allowed despite: {message}")
        print(f"memory guard: {message}; allowed by LANE_CAP_OVERRIDE ({override})")
        return 0
    print(f"memory guard REFUSED: {message}. Close idle lanes, or set LANE_CAP_OVERRIDE=<reason> (audited).")
    return 3
