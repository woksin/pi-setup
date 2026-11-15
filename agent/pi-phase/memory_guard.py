#!/usr/bin/env python3
"""Automatic memory guard for a RAM-bound Mac (woksin/pi-setup#222). Stdlib only.

Out-of-band (launchd via `docker-guardian memory-guard`) it samples compressor share, swap growth, swap-in rate,
pressure level, `ps` latency and the number of live `pi` sessions, classifies a level 0..4 with hysteresis, writes
`mem-guard.json`, and acts. pi-phase and the lane scripts read that file: they never decide from swap-used or
free-% (swap files grow on demand and never shrink; free-% reads ~37 % while thrashing).

Levels: 0 ok, 1 warn, 2 stop admission, 3 shed idle lanes, 4 emergency.
Modes: off (library inert), observe (state + notifications; destructive actions only logged as "would"),
enforce (acts).
"""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

DEFAULTS = dict(
    mode="off", max_live_sessions=36, hard_live_sessions=42, stale_s=180, max_shed_per_tick=3,
    warn_pressure_level=2, warn_compressor_percent=30, warn_ps_latency_s=3,
    stop_compressor_percent=35, stop_swap_growth_mb_per_min=256, stop_swap_in_pages_per_s=2000,
    stop_ps_latency_s=8, shed_compressor_percent=40, shed_swap_in_pages_per_s=6000, shed_pressure_level=3,
    emergency_pressure_level=4, emergency_compressor_percent=45, emergency_ps_latency_s=20,
    shed_idle_s=1800, emergency_idle_s=600, lane_cap_script="",
    headroom_compressor_percent=20, headroom_swap_in_pages_per_s=100, headroom_ticks=3, level1_cap_reduction=6,
    max_heavy_slots=4, max_fast_slots=4, reclaim_max_per_tick=40)
HEAVY_HARD_CEILING = 4  # config cannot raise max_heavy_slots above this
MODES = ("off", "observe", "enforce")
LEVEL_NAMES = ("ok", "warn", "stop admission", "shedding", "emergency")
HISTORY_KEEP = 8
GROWTH_WINDOW_S = 300
MIN_SPAN_S = 60
PS_TIMEOUT_S = 22
SAMPLE_LOG_MAX = 5 * 1024 * 1024
NOTIFY_EVERY_S = 1800
NORMAL_HEAVY_CEILING = 3
SYSCTL_NAMES = ["vm.swapusage", "vm.compressor_bytes_used", "hw.memsize", "kern.memorystatus_vm_pressure_level"]
# (category, comm names or fnmatch patterns). First match wins; order matters (mcp before node).
CATEGORIES = (("pi", ("pi",)), ("mcp", ("*-mcp", "*-mcp-*", "chrome-devtools-mcp", "cs-mcp")),
              ("build-server", ("VBCSCompiler", "csc")), ("testhost", ("testhost*", "vstest*")),
              ("dotnet", ("dotnet",)), ("node", ("node", "tsserver")),
              ("python", ("python", "python3", "Python", "Python3")),
              ("docker", ("docker", "com.docker.*", "com.apple.Virtualization.VirtualMachine", "vpnkit*")))
ORPHAN_CATEGORIES = ("mcp", "node", "testhost", "dotnet")  # reclaimed only when no live pi is an ancestor
BUILD_SERVER_CATEGORY = "build-server"
STATE_NAME = "mem-guard.json"


def agent_dir():
    return Path(os.environ.get("PI_MEM_GUARD_AGENT_DIR") or Path.home() / ".pi" / "agent")


def state_dir():
    return Path(os.environ.get("PI_MEM_GUARD_STATE") or agent_dir() / "state")


def number(value):
    return type(value) in (int, float) and value == value and abs(value) != float("inf")


def guard_config(value, warn=print):
    """Validated `memory_guard` settings; anything wrong or absent means mode off (the library stays inert)."""
    if not isinstance(value, dict):
        return dict(DEFAULTS)
    for key in value.keys() - DEFAULTS.keys():
        warn(f"unknown memory_guard key {key}; ignored")
    settings = {key: value.get(key, default) for key, default in DEFAULTS.items()}
    numeric = [key for key, default in DEFAULTS.items() if key not in ("mode", "lane_cap_script")]
    if number(settings["max_heavy_slots"]) and settings["max_heavy_slots"] > HEAVY_HARD_CEILING:
        warn(f"memory_guard max_heavy_slots clamped to {HEAVY_HARD_CEILING}")
        settings["max_heavy_slots"] = HEAVY_HARD_CEILING
    if settings["mode"] not in MODES or not all(number(settings[key]) and settings[key] >= 0 for key in numeric) \
            or not isinstance(settings["lane_cap_script"], str):
        warn("invalid memory_guard; using mode off")
        return dict(DEFAULTS)
    return settings


def load_guard_settings(config_path):
    """memory_guard from config.json overlaid by config.local.json (key-wise), without importing pi_phase."""
    merged = {}
    for path in (Path(config_path), Path(config_path).with_name("config.local.json")):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("memory_guard"), dict):
            merged.update(data["memory_guard"])
    return guard_config(merged or None)


# ---- parsing -------------------------------------------------------------------------------------------------

def parse_vm_stat(text):
    """`vm_stat` -> pageSize and the monotonically increasing Swapins/Swapouts page counters."""
    size = re.search(r"page size of (\d+) bytes", text)
    ins = re.search(r"^Swapins:\s+(\d+)\.?", text, re.M)
    outs = re.search(r"^Swapouts:\s+(\d+)\.?", text, re.M)
    if not (size and ins and outs):
        raise ValueError("unrecognized vm_stat output")
    return dict(pageSize=int(size.group(1)), swapIns=int(ins.group(1)), swapOuts=int(outs.group(1)))


def parse_sysctl(text):
    """Output of `sysctl -n` for SYSCTL_NAMES -> swapMb (used), cmpPct, pl."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != len(SYSCTL_NAMES):
        raise ValueError("unrecognized sysctl output")
    used = re.search(r"\bused\s*=\s*([0-9.]+)M", lines[0])
    compressor, memsize, level = int(lines[1]), int(lines[2]), int(lines[3])
    if not used or compressor < 0 or memsize <= 0 or level < 0:
        raise ValueError("invalid sysctl values")
    return dict(swapMb=float(used.group(1)), cmpPct=round(compressor * 100 / memsize, 2), pl=level)


def run_text(command, timeout):
    return subprocess.run(command, capture_output=True, text=True, check=True, timeout=timeout).stdout


def count_lines(text):
    return len([line for line in text.splitlines() if line.strip()])


PS_COLUMNS = "pid=,ppid=,uid=,rss=,comm="


def category_of(comm):
    base = comm.strip().rsplit("/", 1)[-1]
    for name, patterns in CATEGORIES:
        if any(fnmatch.fnmatchcase(base, pattern) for pattern in patterns):
            return name
    return "other"


def parse_ps_table(text, uid=None):
    """`ps -axo pid=,ppid=,uid=,rss=,comm=` -> {pid: dict(ppid, uid, rssKb, comm, category)}; uid filters when given."""
    table = {}
    for line in text.splitlines():
        parts = line.split(None, 4)
        if len(parts) != 5 or not all(part.isdigit() for part in parts[:4]):
            continue
        if uid is not None and int(parts[2]) != uid:
            continue
        table[int(parts[0])] = dict(ppid=int(parts[1]), uid=int(parts[2]), rssKb=int(parts[3]), comm=parts[4].strip(),
                                    category=category_of(parts[4]))
    return table


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


def has_pi_ancestor(table, pid):
    """True when a live pi session is an ancestor (the owning lane exists)."""
    seen = set()
    current = table.get(pid, {}).get("ppid")
    while current and current > 1 and current not in seen and current in table:
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


def reclaim_candidates(table, level, phases_running, self_pid=None):
    """[(pid, comm, why)] wasted processes. Never anything with a live pi ancestor, nothing but orphaned MCP servers
    while a pi-phase phase runs, and idle .NET build servers only at level >= 2 with no phase running."""
    found = []
    for pid, entry in sorted(table.items()):
        category = entry["category"]
        if pid == self_pid or has_pi_ancestor(table, pid):
            continue
        if category in ORPHAN_CATEGORIES and (not phases_running or category == "mcp"):
            if entry["ppid"] == 1 or category == "mcp":
                found.append((pid, entry["comm"], f"orphaned {category} (no live pi ancestor)"))
        elif category == BUILD_SERVER_CATEGORY and level >= 2 and not phases_running:
            found.append((pid, entry["comm"], "idle build server (no phase running)"))
    return found


# ---- signals -------------------------------------------------------------------------------------------------

def swap_in_rate(previous, current):
    """Pages/s between two samples (Swapins counter delta); None without a usable pair."""
    if not previous or not current or "swapIns" not in previous or "swapIns" not in current:
        return None
    span = current["t"] - previous["t"]
    delta = current["swapIns"] - previous["swapIns"]
    return round(delta / span, 1) if span > 0 and delta >= 0 else None


def swap_growth(history, current):
    """MB/min of swap used against the oldest sample within GROWTH_WINDOW_S that is at least MIN_SPAN_S old."""
    for old in history:
        span = current["t"] - old["t"]
        if span <= GROWTH_WINDOW_S and span >= MIN_SPAN_S and number(old.get("swapMb")):
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


def emergency_reasons(sample, limits):
    reasons = []
    if sample["pl"] >= limits["emergency_pressure_level"]:
        reasons.append(f"memory pressure level {sample['pl']} (critical)")
    if sample["cmpPct"] >= limits["emergency_compressor_percent"]:
        reasons.append(f"compressor {sample['cmpPct']:g}% >= {limits['emergency_compressor_percent']:g}%")
    if at_least(sample.get("psLatency"), limits["emergency_ps_latency_s"]):
        reasons.append(f"ps latency {sample['psLatency']:g}s")
    return reasons


def shed_reasons(sample, history, limits):
    reasons = []
    if sample["cmpPct"] >= limits["shed_compressor_percent"]:
        reasons.append(f"compressor {sample['cmpPct']:g}% >= {limits['shed_compressor_percent']:g}%")
    if sustained(sample, history, "swapInRate", limits["shed_swap_in_pages_per_s"]):
        reasons.append(f"swap-in {sample['swapInRate']:g} pages/s sustained")
    previous = history[-1] if history else None
    if sample["pl"] >= limits["shed_pressure_level"] and previous and previous.get("pl", 0) >= limits["shed_pressure_level"]:
        reasons.append(f"memory pressure level {sample['pl']} held")
    return reasons


def stop_reasons(sample, history, limits):
    reasons = []
    if sample["cmpPct"] >= limits["stop_compressor_percent"]:
        reasons.append(f"compressor {sample['cmpPct']:g}% >= {limits['stop_compressor_percent']:g}%")
    if at_least(sample.get("swapGrowth"), limits["stop_swap_growth_mb_per_min"]):
        reasons.append(f"swap growth {sample['swapGrowth']:g} MB/min")
    if sustained(sample, history, "swapInRate", limits["stop_swap_in_pages_per_s"]):
        reasons.append(f"swap-in {sample['swapInRate']:g} pages/s sustained")
    if sample.get("sessions", 0) > limits["hard_live_sessions"]:
        reasons.append(f"{sample['sessions']} live pi > hard cap {limits['hard_live_sessions']:g}")
    if at_least(sample.get("psLatency"), limits["stop_ps_latency_s"]):
        reasons.append(f"ps latency {sample['psLatency']:g}s")
    return reasons


def warn_reasons(sample, limits):
    reasons = []
    if sample["pl"] >= limits["warn_pressure_level"]:
        reasons.append(f"memory pressure level {sample['pl']}")
    if sample["cmpPct"] >= limits["warn_compressor_percent"]:
        reasons.append(f"compressor {sample['cmpPct']:g}% >= {limits['warn_compressor_percent']:g}%")
    if sample.get("sessions", 0) > limits["max_live_sessions"]:
        reasons.append(f"{sample['sessions']} live pi > soft cap {limits['max_live_sessions']:g}")
    if at_least(sample.get("psLatency"), limits["warn_ps_latency_s"]):
        reasons.append(f"ps latency {sample['psLatency']:g}s")
    return reasons


def classify(sample, history, limits):
    """(level 0..4, reasons) for one enriched sample. `sample` None is a failed probe: two in a row => emergency."""
    if sample is None:
        if history and history[-1] is None:
            return 4, ["guard could not sample twice in a row"]
        return 1, ["sample failed once"]
    for level, reasons in ((4, emergency_reasons(sample, limits)), (3, shed_reasons(sample, history, limits)),
                           (2, stop_reasons(sample, history, limits)), (1, warn_reasons(sample, limits))):
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
        else:
            self.clear += 1
            if self.clear >= self.clear_ticks:
                self.level, self.clear = max(raw, self.level - 1), 0
        return self.level


# ---- effective slots -----------------------------------------------------------------------------------------

def has_headroom(sample, limits):
    """Room to grow: low compressor, no swap-in, normal pressure, fast ps. A single-sample test; callers debounce."""
    return (sample is not None and sample["pl"] <= 1 and sample["cmpPct"] < limits["headroom_compressor_percent"]
            and (sample.get("swapInRate") or 0) < limits["headroom_swap_in_pages_per_s"]
            and (sample.get("swapGrowth") or 0) <= 0 and (sample.get("psLatency") or 0) < limits["warn_ps_latency_s"])


def session_cap(level, headroom, limits):
    """Live-pi cap: hard cap with headroom at level 0, soft cap at level 0, reduced at level 1, none above."""
    if level >= 2:
        return 0
    if level == 1:
        return max(0, limits["max_live_sessions"] - limits["level1_cap_reduction"])
    return limits["hard_live_sessions"] if headroom else limits["max_live_sessions"]


def effective_slots(level, configured, sessions, headroom=False, limits=None):
    """({heavy, fast, integration}, {pool: reason}). Falls with the level; with headroom at level 0 heavy and fast
    rise to the configured ceilings (max_heavy_slots <= 4, max_fast_slots); otherwise heavy never exceeds 3."""
    limits = limits or DEFAULTS
    grow = level == 0 and headroom
    ceiling = min(limits["max_heavy_slots"], HEAVY_HARD_CEILING) if grow else NORMAL_HEAVY_CEILING
    table = {0: {}, 1: {}, 2: dict(heavy=1, fast=1, integration=0), 3: dict(heavy=0, fast=1, integration=0),
             4: dict(heavy=0, fast=0, integration=0)}[min(level, 4)]
    effective, rules = {}, {}
    for pool, wanted in configured.items():
        target = wanted
        if grow and pool in ("heavy", "fast"):
            target = max(wanted, ceiling if pool == "heavy" else limits["max_fast_slots"])
        cap = table.get(pool, ceiling if pool == "heavy" else target)
        cap = min(cap, ceiling) if pool == "heavy" else cap
        effective[pool] = min(target, cap)
        if effective[pool] < wanted:
            rules[pool] = (f"guard level {level}" if pool in table
                           else f"heavy ceiling {ceiling} (no headroom, {sessions} live pi)")
        elif effective[pool] > wanted:
            rules[pool] = f"headroom (raised from {wanted})"
    return effective, rules


# ---- state file ----------------------------------------------------------------------------------------------

def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    os.replace(tmp, path)


def write_state(directory, state):
    atomic_write(Path(directory) / STATE_NAME, state)


def load_state(directory):
    try:
        data = json.loads((Path(directory) / STATE_NAME).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read_level(directory, stale_s=180, now=None):
    """Guard state for consumers; missing or stale => level 1 and stale=True ("guard not running")."""
    now = time.time() if now is None else now
    data = load_state(directory)
    fresh = number(data.get("t")) and 0 <= now - data["t"] <= stale_s and type(data.get("level")) is int
    if not fresh:
        return dict(data, level=1, stale=True, reasons=["guard not running (state missing or stale)"])
    return dict(data, stale=False)


# ---- sampling ------------------------------------------------------------------------------------------------

def read_sample(runner=run_text, clock=time.time, monotonic=time.monotonic):
    """One host sample, or raises. `ps` (per-category RSS + latency) never fails the sample; no `ps -o lstart` anywhere."""
    sample = parse_sysctl(runner(["sysctl", "-n", *SYSCTL_NAMES], 5))
    sample.update(parse_vm_stat(runner(["vm_stat"], 5)))
    sample["sessions"] = count_lines(runner(["pgrep", "-x", "pi"], 5))
    began = monotonic()
    try:
        table = parse_ps_table(runner(["ps", "-axo", PS_COLUMNS], PS_TIMEOUT_S), os.getuid())
        sample["psLatency"] = round(monotonic() - began, 2)
        sample["mem"], sample["procs"] = category_mb(table), counts_by_category(table)
    except (OSError, subprocess.SubprocessError):
        sample["mem"], sample["procs"], sample["psLatency"] = {}, {}, float(PS_TIMEOUT_S)
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


# ---- actions -------------------------------------------------------------------------------------------------

def plan_actions(level, mode, limits, previous_level, now, last_notify):
    """[(name, destructive, argument)] the guard would take at this level. Pure."""
    actions = []
    if level >= 1 and (level != previous_level or now - last_notify >= NOTIFY_EVERY_S):
        actions.append(("notify", False, level))
    if level != previous_level and level >= 1:
        actions.append(("message", False, level))
    if level >= 1:
        actions.append(("reclaim", True, limits["reclaim_max_per_tick"]))  # waste first, before any lane is shed
    if level >= 3:
        actions.append(("reap-build-servers", True, None))
        idle = limits["emergency_idle_s"] if level >= 4 else limits["shed_idle_s"]
        actions.append(("shed-lanes", True, (limits["max_shed_per_tick"], idle)))
    if level >= 4:
        actions.append(("docker-stop-unpinned", True, None))
    return actions


class Actuator:
    """Executes planned actions; `execute` False (dry run) or destructive actions in observe mode only log."""
    def __init__(self, settings, log, runner=run_text, execute=True):
        self.settings, self.log, self.runner, self.execute = settings, log, runner, execute

    def perform(self, level, actions, reasons):
        done = []
        for name, destructive, argument in actions:
            live = self.execute and (not destructive or self.settings["mode"] == "enforce")
            prefix = "" if live else "would "
            self.log(f"level {level} {prefix}{name} ({'; '.join(reasons)})")
            if live:
                getattr(self, name.replace("-", "_"))(argument, level, reasons)
            done.append(f"{prefix}{name}")
        return done

    def notify(self, level, _level, reasons):
        text = f"memory guard level {level} ({LEVEL_NAMES[level]}): {'; '.join(reasons)}"[:200].replace('"', "'")
        self.quiet(["osascript", "-e", f'display notification "{text}" with title "memory-guard"'])
        if level >= 4:
            self.quiet(["say", "memory emergency"])

    def message(self, level, _level, reasons):
        directory = os.environ.get("PI_MEM_GUARD_MESSAGES")
        if directory and os.path.isdir(directory):
            text = (f"# memory guard level {level} ({LEVEL_NAMES[level]})\n\n" + "\n".join(f"- {r}" for r in reasons)
                    + "\n\nAt level >= 2 new lanes and builds are refused; level 3 sheds idle lanes.\n")
            Path(directory, f"ALL-from-GUARD-memory-{time.strftime('%H%M')}.md").write_text(text)

    def quiet(self, command, timeout=10):
        try:
            return self.runner(command, timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            self.log(f"{command[0]} failed: {exc}")
            return ""

    def reclaim(self, limit, level, _reasons):
        table = parse_ps_table(self.quiet(["ps", "-axo", PS_COLUMNS], PS_TIMEOUT_S), os.getuid())
        running = phase_running(self.runner)
        for pid, comm, why in reclaim_candidates(table, level, running, os.getpid())[:int(limit)]:
            self.log(f"SIGTERM {pid} {comm}: {why}")
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError as exc:
                self.log(f"kill {pid} failed: {exc}")

    def reap_build_servers(self, _argument, _level, _reasons):
        tool = agent_dir() / "bin" / "reap-build-servers"
        if tool.exists():
            self.quiet([str(tool)], 30)

    def shed_lanes(self, argument, _level, _reasons):
        script = self.settings["lane_cap_script"]
        if not script:
            self.log("no lane_cap_script configured; not shedding")
            return
        count, idle = argument
        self.log(self.quiet(["bash", script, "--shed", str(int(count)), "--min-idle-s", str(int(idle))], 120).strip()
                 or "lane-cap: nothing shed")

    def docker_stop_unpinned(self, _argument, _level, _reasons):
        pinned = pins(Path(os.environ.get("DOCKER_GUARDIAN_STATE") or agent_dir() / "docker-guardian"))
        for line in self.quiet(["docker", "ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"], 15).splitlines():
            ident, *refs = line.split("\t")
            if ident and not any(fnmatch.fnmatchcase(ref, pin) for ref in refs for pin in pinned):
                self.log(f"docker stop {ident} ({' '.join(refs)})")
                self.quiet(["docker", "stop", "-t", "20", ident], 40)


def pins(directory):
    try:
        lines = (directory / "pinned.txt").read_text().splitlines()
    except OSError:
        return []
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


# ---- guard tick ----------------------------------------------------------------------------------------------

def append_log(path, line):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        stream.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")


def rotate_append(path, record, limit=SAMPLE_LOG_MAX):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.stat().st_size > limit:
            os.replace(path, path.with_name(path.name + ".1"))
    except OSError:
        pass
    with path.open("a") as stream:
        stream.write(json.dumps(record, separators=(",", ":")) + "\n")


def compact(sample):
    return None if sample is None else {key: sample.get(key) for key in (
        "t", "pl", "cmpPct", "swapMb", "swapIns", "swapInRate", "swapGrowth", "sessions", "psLatency")}


def tick(settings, directory, sample, previous_state, now, actuator, execute=True):
    """One guard decision. Returns the new state (written unless execute is False) and the actions taken/planned."""
    history = list(previous_state.get("hist", []))
    enriched = enrich(sample, history) if sample is not None else None
    raw, reasons = classify(enriched, history, settings)
    hysteresis = Hysteresis(previous_state.get("level", 0), previous_state.get("clear", 0))
    level = hysteresis.update(raw)
    if level > raw and not reasons:
        reasons = [f"holding level {level} until {hysteresis.clear_ticks - hysteresis.clear} more clear tick(s)"]
    actions = plan_actions(level, settings["mode"], settings, previous_state.get("level", 0), now,
                           previous_state.get("lastNotify", 0))
    done = actuator.perform(level, actions, reasons)
    # Capacity rises slowly (headroom must hold headroom_ticks ticks) and falls at once.
    ticks = previous_state.get("headroomTicks", 0) + 1 if level == 0 and has_headroom(enriched, settings) else 0
    headroom = ticks >= settings["headroom_ticks"]
    state = dict(level=level, raw=raw, reasons=reasons, t=now, clear=hysteresis.clear, mode=settings["mode"],
                 headroom=headroom, headroomTicks=ticks, cap=session_cap(level, headroom, settings),
                 mem=(sample or {}).get("mem"), procs=(sample or {}).get("procs"), hist=(history + [compact(enriched)])[-HISTORY_KEEP:],
                 lastNotify=now if any(a[0] == "notify" for a in actions) else previous_state.get("lastNotify", 0),
                 **{key: (enriched or {}).get(key) for key in ("sessions", "pl", "cmpPct", "swapMb", "swapGrowth",
                                                            "swapInRate", "psLatency")})
    if execute:
        write_state(directory, state)
    return state, done


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
    return "memory: rss by category " + ", ".join(f"{name} {mb} MB x{procs.get(name, 0)}" for name, mb in mem.items()
                                                  if mb) + " (RSS undercounts compressed pages)"


def describe(state, settings, configured=None, used=None):
    """Lines for the `memory:` block of `pi-phase status` and for `memory-guard --once`."""
    def fmt(key, unit=""):
        value = state.get(key)
        return "n/a" if value is None else f"{value:g}{unit}"
    stale = state.get("stale")
    level = state.get("level", 1)
    lines = [f"memory: guard level {level} ({LEVEL_NAMES[min(level, 4)]}) mode={settings['mode']}"
             + (" [guard not running: state missing or stale]" if stale else ""),
             f"memory: pressure level {fmt('pl')} compressor {fmt('cmpPct', '%')} swap used {fmt('swapMb', ' MB')}"
             f" growth {fmt('swapGrowth', ' MB/min')} swap-in {fmt('swapInRate', ' pages/s')}",
             f"memory: live pi {fmt('sessions')} (soft cap {settings['max_live_sessions']:g},"
             f" hard {settings['hard_live_sessions']:g})"]
    if state.get("reasons"):
        lines.append("memory: reasons " + "; ".join(state["reasons"]))
    if category_line(state):
        lines.append(category_line(state))
    effective = None
    if configured:
        effective, rules = effective_slots(level, configured, state.get("sessions") or 0,
                                           bool(state.get("headroom")), settings)
        parts = [f"{pool} {configured[pool]}->{effective[pool]}" + (f" ({rules[pool]})" if pool in rules else "")
                 for pool in ("heavy", "fast", "integration") if pool in configured]
        lines.append("memory: slots configured->effective " + ", ".join(parts))
    lines.append(headroom_line(state, settings, effective, used))
    return lines


# ---- spawn gate ----------------------------------------------------------------------------------------------

def gate_decision(settings, directory, sessions, runner=run_text, now=None):
    """(allowed, message). Refuses at >= soft cap or guard level >= 2 (or stale state with pressure level >= 2)."""
    sample = injected_sample()
    if sample is not None:
        level, reasons = classify(enrich(sample, []), [], settings)
        stale, cap = False, session_cap(level, False, settings)
    else:
        info = read_level(directory, settings["stale_s"], now)
        level, reasons, stale = info["level"], info.get("reasons", []), info["stale"]
        cap = settings["max_live_sessions"] if stale else info.get("cap", settings["max_live_sessions"])
    if level >= 2:
        return False, f"memory guard level {level}: {'; '.join(reasons)}"
    if sessions is not None and sessions >= cap:
        return False, f"{sessions} live pi >= cap {cap:g} (adaptive: memory_guard max_live_sessions/hard_live_sessions)"
    if stale and sample is None and pressure_level(runner) >= 2:
        return False, "memory guard not running and memory pressure level >= 2"
    return True, f"ok (level {level}, {sessions} live pi)"


def pressure_level(runner):
    try:
        return int(runner(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], 3).strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def run_gate(settings, directory, log, runner=run_text):
    if settings["mode"] == "off":
        print("memory guard off; not checking")
        return 0
    allowed, message = gate_decision(settings, directory, pgrep_count(runner), runner)
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


# ---- command line --------------------------------------------------------------------------------------------

def default_config_path():
    return Path(os.environ.get("PI_MEM_GUARD_CONFIG") or Path(__file__).resolve().parent / "config.json")


def reclaim_list(runner, level):
    try:
        table = parse_ps_table(runner(["ps", "-axo", PS_COLUMNS], PS_TIMEOUT_S), os.getuid())
    except (OSError, subprocess.SubprocessError):
        return []
    return reclaim_candidates(table, level, phase_running(runner), os.getpid())


def run_once(settings, directory, dry_run, runner=run_text):
    log_path = agent_dir() / "logs" / "mem-guard.log"
    log = (lambda line: None) if dry_run else (lambda line: append_log(log_path, line))
    previous = load_state(directory)
    try:
        sample = injected_sample() or read_sample(pgrep_tolerant(runner))
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        append_log(log_path, f"sample failed: {exc}") if not dry_run else None
        sample = None
    actuator = Actuator(settings, log, runner, execute=not dry_run)
    state, done = tick(settings, directory, sample, previous, time.time(), actuator, execute=not dry_run)
    if sample is not None and not dry_run:
        rotate_append(agent_dir() / "logs" / "mem-samples.jsonl", dict(sample, level=state["level"]))
    for line in describe(state, settings):
        print(line)
    if dry_run and state["level"] >= 1:
        for pid, comm, why in reclaim_list(runner, state["level"]):
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
