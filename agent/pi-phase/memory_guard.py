#!/usr/bin/env python3
"""Automatic memory guard for a RAM-bound Mac (woksin/pi-setup#222). Stdlib only.

Out-of-band (launchd via `docker-guardian memory-guard`) it samples compressor share, swap growth, swap-in rate,
pressure level, `ps` latency and the number of live `pi` sessions, classifies a level 0..4 with hysteresis, writes
`mem-guard.json`, and acts. pi-phase and the lane scripts read that file: they never decide from swap-used or
free-% (swap files grow on demand and never shrink; free-% reads ~37 % while thrashing).

Levels: 0 ok, 1 warn, 2 stop admission, 3 shed idle lanes, 4 emergency.
Modes: off (library inert), observe (state + notifications; destructive actions only logged as "would"),
enforce (acts).

This module is the facade and CLI; the logic lives in the memory_guard_* modules it re-exports.
"""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

from memory_guard_actions import Action, Actuator, Transition, phase_running, plan_actions, pins  # noqa: F401
from memory_guard_config import DEFAULTS, LEVEL_NAMES, STATE_NAME, agent_dir, guard_config, load_guard_settings, number, state_dir  # noqa: F401,E501
from memory_guard_gate import Probe, gate_decision, run_gate  # noqa: F401
from memory_guard_reclaim import has_pi_ancestor, reclaim_candidates, reclaim_list  # noqa: F401
from memory_guard_report import category_line, describe, headroom_line  # noqa: F401
from memory_guard_sampling import (PS_TIMEOUT_S, category_mb, injected_sample, parse_ps_table, parse_vm_stat,  # noqa: F401
                                   pgrep_tolerant, read_sample, run_text)
from memory_guard_signals import (Capacity, Hysteresis, classify, effective_slots, enrich, has_headroom,  # noqa: F401
                                  session_cap, swap_in_rate)
from memory_guard_state import append_log, load_state, read_level, rotate_append, write_state  # noqa: F401
from memory_guard_tick import Guard, TickInput, tick  # noqa: F401


def default_config_path():
    return Path(os.environ.get("PI_MEM_GUARD_CONFIG") or Path(__file__).resolve().parent / "config.json")


def take_sample(runner, log_path, dry_run):
    try:
        return injected_sample() or read_sample(pgrep_tolerant(runner))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        if not dry_run:
            append_log(log_path, f"sample failed: {exc}")
        return None


def run_once(settings, directory, dry_run, runner=run_text):
    log_path = agent_dir() / "logs" / "mem-guard.log"
    log = (lambda line: None) if dry_run else (lambda line: append_log(log_path, line))
    previous = load_state(directory)
    sample = take_sample(runner, log_path, dry_run)
    guard = Guard(settings, directory, Actuator(settings, log, runner, execute=not dry_run), execute=not dry_run)
    state, done = tick(guard, TickInput(sample, previous, time.time()))
    if sample is not None and not dry_run:
        rotate_append(agent_dir() / "logs" / "mem-samples.jsonl", dict(sample, level=state["level"]))
    for line in describe(state, settings):
        print(line)
    if dry_run and state["level"] >= 1:
        for pid, comm, why in reclaim_list(runner, state["level"], os.getuid(), os.getpid()):
            print(f"reclaim candidate: {pid} {comm}: {why}")
    print("actions: " + (", ".join(done) if done else "none") + (" (dry run: nothing executed)" if dry_run else ""))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="memory-guard", description=__doc__.splitlines()[0])
    parser.add_argument("command", nargs="?", default="run", choices=("run", "gate", "status"))
    parser.add_argument("--once", action="store_true", help="one tick (the only mode; kept for launchd clarity)")
    parser.add_argument("--dry-run", action="store_true", help="print level and would-be actions; change nothing")
    args = parser.parse_args(argv)
    settings = load_guard_settings(default_config_path())
    directory = state_dir()
    log = lambda line: append_log(agent_dir() / "logs" / "mem-guard.log", line)
    if args.command == "gate":
        return run_gate(settings, directory, log)
    if args.command == "status":
        print("\n".join(describe(read_level(directory, settings["stale_s"]), settings)))
        return 0
    return run_once(settings, directory, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
