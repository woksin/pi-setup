"""memory_guard actions: planning (pure) and the Actuator that performs or only logs them."""
import fnmatch
from dataclasses import dataclass
import os
from pathlib import Path
import signal
import subprocess
import time

from memory_guard_config import LEVEL_NAMES, agent_dir
from memory_guard_reclaim import phase_running, reclaim_candidates, reclaim_reason
from memory_guard_sampling import PS_COLUMNS, PS_TIMEOUT_S, parse_ps_table, run_text

NOTIFY_EVERY_S = 1800


@dataclass(frozen=True)
class Transition:
    """Where the guard is going this tick: new level, previous level, now, and when it last notified."""
    level: int
    previous: int
    now: float
    last_notify: float


@dataclass(frozen=True)
class Action:
    name: str
    destructive: bool
    argument: object = None


def shed_action(level, limits):
    idle = limits["emergency_idle_s"] if level >= 4 else limits["shed_idle_s"]
    return Action("shed-lanes", True, (limits["max_shed_per_tick"], idle))


def plan_actions(move, limits):
    """The actions the guard would take at this level. Pure."""
    level = move.level
    changed = level != move.previous
    steps = [
        (level >= 1 and (changed or move.now - move.last_notify >= NOTIFY_EVERY_S), Action("notify", False, level)),
        (level >= 1 and changed, Action("message", False, level)),
        (level >= 1, Action("reclaim", True, limits["reclaim_max_per_tick"])),  # waste first, before any lane is shed
        (level >= 3, Action("reap-build-servers", True)),
        (level >= 3, shed_action(level, limits)),
        (level >= 4, Action("docker-stop-unpinned", True)),
    ]
    return [action for wanted, action in steps if wanted]


def pins(directory):
    try:
        lines = (directory / "pinned.txt").read_text().splitlines()
    except FileNotFoundError:
        return []  # no pins file means nothing is pinned; any other read error propagates (fail closed)
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


class Actuator:
    """Executes planned actions; `execute` False (dry run) or destructive actions in observe mode only log."""
    def __init__(self, settings, log, runner=run_text, execute=True):
        self.settings, self.log, self.runner, self.execute = settings, log, runner, execute

    def is_live(self, action):
        return self.execute and (not action.destructive or self.settings["mode"] == "enforce")

    def perform(self, level, actions, reasons):
        done = []
        for action in actions:
            live = self.is_live(action)
            prefix = "" if live else "would "
            self.log(f"level {level} {prefix}{action.name} ({'; '.join(reasons)})")
            if live:
                getattr(self, action.name.replace("-", "_"))(action.argument, level, reasons)
            elif self.execute and action.name == "reclaim":
                self.reclaim_preview(action.argument, level)
            done.append(f"{prefix}{action.name}")
        return done

    def quiet(self, command, timeout=10):
        try:
            return self.runner(command, timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            self.log(f"{command[0]} failed: {exc}")
            return ""

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

    def reclaim_targets(self, limit, level):
        """(table, running, [(pid, comm, why)]) from one ps snapshot."""
        table = parse_ps_table(self.quiet(["ps", "-axo", PS_COLUMNS], PS_TIMEOUT_S), os.getuid())
        running = phase_running(self.runner)
        return table, running, reclaim_candidates(table, level, running, os.getpid())[:int(limit)]

    @staticmethod
    def target_line(verb, table, pid, comm, why):
        return f"{verb} pid={pid} cmd={comm} category={table[pid]['category']} reason={why}"

    def reclaim_preview(self, limit, level):
        """Observe mode: name every process enforce would SIGTERM, without signalling."""
        table, _running, targets = self.reclaim_targets(limit, level)
        for pid, comm, why in targets:
            self.log(self.target_line("would SIGTERM", table, pid, comm, why))

    def still_target(self, pid, comm, level, running):
        """Re-read one pid just before signalling: same uid, same command and still waste (guards PID reuse)."""
        table = parse_ps_table(self.quiet(["ps", "-p", str(pid), "-o", PS_COLUMNS], PS_TIMEOUT_S), os.getuid())
        entry = table.get(pid)
        return bool(entry) and entry["comm"] == comm and reclaim_reason(entry, level, running) is not None

    def reclaim(self, limit, level, _reasons):
        table, running, targets = self.reclaim_targets(limit, level)
        for pid, comm, why in targets:
            if not self.still_target(pid, comm, level, running):
                self.log(f"skip {pid} {comm}: changed since the snapshot")
                continue
            self.log(self.target_line("SIGTERM", table, pid, comm, why))
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
        try:
            pinned = pins(Path(os.environ.get("DOCKER_GUARDIAN_STATE") or agent_dir() / "docker-guardian"))
        except OSError as exc:
            self.log(f"cannot read pinned.txt ({exc}); not stopping any container")
            return
        for line in self.quiet(["docker", "ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"], 15).splitlines():
            ident, *refs = line.split("\t")
            if ident and not any(fnmatch.fnmatchcase(ref, pin) for ref in refs for pin in pinned):
                self.log(f"docker stop {ident} ({' '.join(refs)})")
                self.quiet(["docker", "stop", "-t", "20", ident], 40)
