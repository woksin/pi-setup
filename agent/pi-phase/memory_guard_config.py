"""memory_guard settings, constants and paths (woksin/pi-setup#222). Stdlib only."""
import json
import os
from pathlib import Path

DEFAULTS = dict(
    mode="off", max_live_sessions=36, hard_live_sessions=42, stale_s=180, max_shed_per_tick=3,
    warn_pressure_level=2, warn_compressor_percent=30, warn_ps_latency_s=3,
    stop_compressor_percent=35, stop_swap_growth_mb_per_min=256, stop_swap_in_pages_per_s=2000,
    stop_ps_latency_s=8, shed_compressor_percent=40, shed_swap_in_pages_per_s=6000, shed_pressure_level=3,
    emergency_pressure_level=4, emergency_compressor_percent=45, emergency_ps_latency_s=20,
    shed_idle_s=1800, emergency_idle_s=600, lane_cap_script="",
    headroom_compressor_percent=20, headroom_swap_in_pages_per_s=100, headroom_ticks=3, level1_cap_reduction=6,
    max_heavy_slots=4, max_fast_slots=4, reclaim_max_per_tick=40, max_sessions_for_heavy_growth=30)
HEAVY_HARD_CEILING = 4  # config cannot raise max_heavy_slots above this
NON_NUMERIC = ("mode", "lane_cap_script")
MODES = ("off", "observe", "enforce")
LEVEL_NAMES = ("ok", "warn", "stop admission", "shedding", "emergency")
STATE_NAME = "mem-guard.json"


def agent_dir():
    return Path(os.environ.get("PI_MEM_GUARD_AGENT_DIR") or Path.home() / ".pi" / "agent")


def state_dir():
    return Path(os.environ.get("PI_MEM_GUARD_STATE") or agent_dir() / "state")


def number(value):
    return type(value) in (int, float) and value == value and abs(value) != float("inf")


def numbers_valid(settings):
    return all(number(value) and value >= 0 for key, value in settings.items() if key not in NON_NUMERIC)


def settings_valid(settings):
    return settings["mode"] in MODES and isinstance(settings["lane_cap_script"], str) and numbers_valid(settings)


def clamp_heavy(settings, warn):
    if number(settings["max_heavy_slots"]) and settings["max_heavy_slots"] > HEAVY_HARD_CEILING:
        warn(f"memory_guard max_heavy_slots clamped to {HEAVY_HARD_CEILING}")
        settings["max_heavy_slots"] = HEAVY_HARD_CEILING


def guard_config(value, warn=print):
    """Validated `memory_guard` settings; anything wrong or absent means mode off (the library stays inert)."""
    if not isinstance(value, dict):
        return dict(DEFAULTS)
    for key in sorted(value.keys() - DEFAULTS.keys()):
        warn(f"unknown memory_guard key {key}; ignored")
    settings = {key: value.get(key, default) for key, default in DEFAULTS.items()}
    clamp_heavy(settings, warn)
    if not settings_valid(settings):
        warn("invalid memory_guard; using mode off")
        return dict(DEFAULTS)
    return settings


def read_guard_section(path):
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    section = data.get("memory_guard") if isinstance(data, dict) else None
    return section if isinstance(section, dict) else {}


def load_guard_settings(config_path):
    """memory_guard from config.json overlaid by config.local.json (key-wise), without importing pi_phase."""
    merged = {}
    for path in (Path(config_path), Path(config_path).with_name("config.local.json")):
        merged.update(read_guard_section(path))
    return guard_config(merged or None)
