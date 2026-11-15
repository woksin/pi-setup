"""memory guard (#222): config clamp, live reload, guard levels, slots, swap signals, state machine, gate."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import memory_guard as mg
import pi_phase

LIMITS = mg.guard_config(dict(mode="enforce"))
HERE = Path(__file__).resolve().parent


def sample(t=1000.0, **fields):
    base = dict(t=t, pl=1, cmpPct=10.0, swapMb=12800.0, swapIns=1000, sessions=20, psLatency=0.2)
    return dict(base, **fields)


class ConfigClampTests(unittest.TestCase):
    def test_critical_pressure_level_is_clamped_to_two(self):
        warnings = []
        config = pi_phase.host_pressure_config(dict(mode="enforce", max_pressure_level=4), warnings.append)
        self.assertEqual(config["max_pressure_level"], 2)
        self.assertTrue(any("allow_critical" in w for w in warnings))

    def test_allow_critical_keeps_the_configured_level(self):
        config = pi_phase.host_pressure_config(dict(mode="enforce", max_pressure_level=4, allow_critical=True))
        self.assertEqual(config["max_pressure_level"], 4)

    def test_low_min_free_percent_warns(self):
        warnings = []
        pi_phase.memory_admission_config(dict(min_free_percent=10), warnings.append)
        self.assertTrue(any("min_free_percent" in w for w in warnings))

    def test_memory_guard_key_is_known_and_off_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps(dict(memory_guard=dict(mode="observe"))))
            self.assertEqual(pi_phase.config(path).options["memory_guard"]["mode"], "observe")
            self.assertEqual(pi_phase.config(Path(tmp) / "none.json").options["memory_guard"]["mode"], "off")


class ReloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "config.json"
        self.write(heavy_slots=2, memory_admission=dict(min_free_percent=30),
                   host_pressure=dict(mode="enforce", max_compressor_percent=30))

    def write(self, **data):
        self.path.write_text(json.dumps(data))

    def test_changed_memory_and_host_options_are_picked_up_within_one_tick(self):
        group = pi_phase.AdmissionSet(self.root)
        group.update(pi_phase.config(self.path).options)
        first = group.admission, group.pressure
        self.assertEqual(group.pressure.settings["max_compressor_percent"], 30)
        self.write(heavy_slots=2, memory_admission=dict(min_free_percent=45),
                   host_pressure=dict(mode="enforce", max_compressor_percent=20))
        group.update(pi_phase.config(self.path).options)
        self.assertEqual(group.admission.thresholds["min_free_percent"], 45)
        self.assertEqual(group.pressure.settings["max_compressor_percent"], 20)
        self.assertIsNot(group.admission, first[0])

    def test_unchanged_options_keep_the_sample_cache_objects(self):
        group = pi_phase.AdmissionSet(self.root)
        group.update(pi_phase.config(self.path).options)
        first = group.admission, group.pressure
        group.update(pi_phase.config(self.path).options)
        self.assertEqual((group.admission, group.pressure), first)

    def test_unreadable_config_keeps_previous_settings(self):
        previous = pi_phase.config(self.path)
        self.path.write_text("{broken")
        self.assertIs(pi_phase.reload_config(self.path, previous, set()), previous)
        self.write(heavy_slots=3)
        self.assertEqual(pi_phase.reload_config(self.path, previous, set())[0], 3)


class SlotTests(unittest.TestCase):
    CONFIGURED = dict(heavy=6, fast=4, integration=2)

    def test_effective_slots_by_level(self):
        expected = {0: (3, 4, 2), 1: (3, 4, 2), 2: (1, 1, 0), 3: (0, 1, 0), 4: (0, 0, 0)}
        for level, wanted in expected.items():
            slots, _ = mg.effective_slots(level, self.CONFIGURED, 20, False, LIMITS)
            self.assertEqual((slots["heavy"], slots["fast"], slots["integration"]), wanted, level)

    def test_heavy_four_only_at_level_zero_with_confirmed_headroom(self):
        slots, rules = mg.effective_slots(0, self.CONFIGURED, 31, True, LIMITS)
        self.assertEqual(slots["heavy"], 4)
        slots, rules = mg.effective_slots(0, self.CONFIGURED, 31, False, LIMITS)
        self.assertEqual(slots["heavy"], 3)
        self.assertIn("31 live pi", rules["heavy"])
        self.assertEqual(mg.effective_slots(1, self.CONFIGURED, 5, True, LIMITS)[0]["heavy"], 3)

    def test_headroom_raises_low_configured_slots_up_to_the_ceilings(self):
        slots, rules = mg.effective_slots(0, dict(heavy=2, fast=1, integration=1), 10, True, LIMITS)
        self.assertEqual((slots["heavy"], slots["fast"], slots["integration"]), (4, 4, 1))
        self.assertIn("headroom", rules["heavy"])

    def test_config_cannot_raise_heavy_above_four(self):
        self.assertEqual(mg.guard_config(dict(mode="enforce", max_heavy_slots=9), lambda m: None)["max_heavy_slots"], 4)

    def test_session_cap_adapts_both_ways(self):
        self.assertEqual(mg.session_cap(0, True, LIMITS), 42)
        self.assertEqual(mg.session_cap(0, False, LIMITS), 36)
        self.assertEqual(mg.session_cap(1, True, LIMITS), 30)
        self.assertEqual(mg.session_cap(2, True, LIMITS), 0)

    def test_headroom_needs_quiet_signals_and_is_debounced(self):
        self.assertTrue(mg.has_headroom(mg.enrich(sample(cmpPct=10), []), LIMITS))
        self.assertFalse(mg.has_headroom(mg.enrich(sample(cmpPct=25), []), LIMITS))
        self.assertFalse(mg.has_headroom(mg.enrich(sample(pl=2), []), LIMITS))
        previous = {}
        for expected in (False, False, True):
            state, _ = TickTests().run_tick("observe", sample(), previous)[:2]
            previous = state
            self.assertEqual(state["headroom"], expected)
        self.assertEqual(state["cap"], 42)

    def test_lowered_pools_name_the_rule(self):
        _, rules = mg.effective_slots(2, dict(heavy=2, fast=2, integration=1), 10)
        self.assertEqual(sorted(rules), ["fast", "heavy", "integration"])
        self.assertIn("guard level 2", rules["heavy"])

    def test_pi_phase_applies_guard_slots_only_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"PI_MEM_GUARD_STATE": tmp}):
            mg.write_state(tmp, dict(level=2, reasons=["compressor 36%"], t=time.time(), sessions=10))
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps(dict(heavy_slots=3, integration_slots=1)))
            off = pi_phase.guarded_limits(pi_phase.config(path))
            self.assertEqual(tuple(off), (3, 1))
            path.write_text(json.dumps(dict(heavy_slots=3, integration_slots=1, memory_guard=dict(mode="observe"))))
            on = pi_phase.guarded_limits(pi_phase.config(path))
            self.assertEqual(tuple(on), (1, 0))
            self.assertEqual(on.options["fast_lane"]["slots"], 1)
            self.assertIn("level 2", on.guard_note)


class SwapSignalTests(unittest.TestCase):
    def test_flat_latched_swap_does_not_trip(self):
        history = [sample(t=1000 + 30 * n) for n in range(4)]
        current = mg.enrich(sample(t=1120, cmpPct=20.0), history)
        self.assertEqual(current["swapGrowth"], 0.0)
        self.assertEqual(mg.classify(current, history, LIMITS), (0, []))

    def test_swap_in_rate_pages_per_second(self):
        self.assertEqual(mg.swap_in_rate(sample(t=100, swapIns=0), sample(t=110, swapIns=30000)), 3000.0)
        self.assertIsNone(mg.swap_in_rate(sample(t=100, swapIns=500), sample(t=110, swapIns=10)))  # counter reset

    def test_high_swap_in_rate_trips_only_when_sustained(self):
        history = [sample(t=1000)]
        first = mg.enrich(sample(t=1030, swapIns=1000 + 90000), history)  # 3000 pages/s
        self.assertEqual(mg.classify(first, history, LIMITS)[0], 0)
        history.append(first)
        second = mg.enrich(sample(t=1060, swapIns=1000 + 180000), history)
        level, reasons = mg.classify(second, history, LIMITS)
        self.assertEqual(level, 2)
        self.assertIn("swap-in", reasons[0])

    def test_swap_growth_trips_stop_admission(self):
        history = [sample(t=1000, swapMb=1000.0)]
        current = mg.enrich(sample(t=1060, swapMb=1400.0), history)
        self.assertEqual(current["swapGrowth"], 400.0)
        self.assertEqual(mg.classify(current, history, LIMITS)[0], 2)

    def test_parse_vm_stat_and_ps(self):
        text = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins:  1234.\nSwapouts: 99.\n"
        self.assertEqual(mg.parse_vm_stat(text), dict(pageSize=16384, swapIns=1234, swapOuts=99))
        classes = mg.category_mb(mg.parse_ps_table("1 0 5 2048 /usr/local/bin/pi\n2 1 5 1024 node\n3 1 5 3072 /x/VBCSCompiler\nbad line\n"))
        self.assertEqual((classes["pi"], classes["node"], classes["build-server"]), (2, 1, 3))


class LevelTests(unittest.TestCase):
    def level(self, **fields):
        return mg.classify(mg.enrich(sample(**fields), []), [], LIMITS)[0]

    def test_threshold_ladder(self):
        self.assertEqual(self.level(), 0)
        self.assertEqual(self.level(cmpPct=31), 1)
        self.assertEqual(self.level(sessions=37), 1)
        self.assertEqual(self.level(psLatency=4), 1)
        self.assertEqual(self.level(cmpPct=36), 2)
        self.assertEqual(self.level(sessions=43), 2)
        self.assertEqual(self.level(psLatency=9), 2)
        self.assertEqual(self.level(cmpPct=41), 3)
        self.assertEqual(self.level(cmpPct=46), 4)
        self.assertEqual(self.level(pl=4), 4)
        self.assertEqual(self.level(psLatency=21), 4)

    def test_ps_timeout_trigger_is_emergency(self):
        self.assertEqual(self.level(psLatency=float(mg.PS_TIMEOUT_S)), 4)

    def test_two_failed_samples_in_a_row_are_an_emergency(self):
        self.assertEqual(mg.classify(None, [], LIMITS)[0], 1)
        self.assertEqual(mg.classify(None, [None], LIMITS)[0], 4)

    def test_hysteresis_rises_at_once_and_falls_after_three_clear_ticks(self):
        h = mg.Hysteresis()
        self.assertEqual(h.update(3), 3)
        self.assertEqual([h.update(0) for _ in range(3)], [3, 3, 2])
        self.assertEqual([h.update(0) for _ in range(3)], [2, 2, 1])
        self.assertEqual(h.update(2), 2)
        self.assertEqual(h.clear, 0)

    def test_stale_or_missing_state_reads_as_level_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(mg.read_level(tmp)["level"], 1)
            self.assertTrue(mg.read_level(tmp)["stale"])
            mg.write_state(tmp, dict(level=3, reasons=[], t=1000.0))
            self.assertEqual(mg.read_level(tmp, now=1100.0)["level"], 3)
            self.assertEqual(mg.read_level(tmp, now=1300.0)["level"], 1)


PS = """\
100 1 501 40000 /usr/local/bin/pi
101 100 501 800 node
102 101 501 600 /x/chrome-devtools-mcp
900 1 501 90000 chrome-devtools-mcp
901 1 501 5000 node
902 1 501 4000 testhost
903 1 501 300000 csc
904 1 501 700000 VBCSCompiler
905 800 501 9000 com.docker.backend
906 1 501 50 launchd_helper
907 1 999 5000 node
"""


class ReclaimTests(unittest.TestCase):
    def setUp(self):
        self.table = mg.parse_ps_table(PS, 501)

    def test_categories_and_accounting(self):
        self.assertEqual(self.table[100]["category"], "pi")
        self.assertEqual(self.table[102]["category"], "mcp")
        self.assertEqual(self.table[903]["category"], "build-server")
        self.assertEqual(self.table[905]["category"], "docker")
        self.assertEqual(mg.category_mb(self.table)["build-server"], round(1000000 / 1024))
        self.assertNotIn(907, self.table)  # other user's process

    def pids(self, level, running):
        return [pid for pid, _, _ in mg.reclaim_candidates(self.table, level, running)]

    def test_orphans_listed_but_never_children_of_a_live_pi_or_docker(self):
        pids = self.pids(1, False)
        self.assertEqual(pids, [900, 901, 902])
        self.assertTrue({100, 101, 102, 905, 906} .isdisjoint(pids))

    def test_build_servers_only_at_level_two_with_no_phase_running(self):
        self.assertEqual(self.pids(2, False), [900, 901, 902, 903, 904])
        self.assertEqual(self.pids(2, True), [900])  # a running phase protects node/testhost/build servers

    def test_phase_running_uses_pgrep_and_fails_safe(self):
        def raises(error):
            def run(command, timeout):
                raise error
            return run
        self.assertTrue(mg.phase_running(lambda command, timeout: "123\n"))
        self.assertFalse(mg.phase_running(raises(subprocess.CalledProcessError(1, "pgrep"))))
        self.assertTrue(mg.phase_running(raises(OSError("no pgrep"))))

    def test_enforce_reclaim_signals_candidates_and_observe_does_not(self):
        killed = []
        for mode in ("observe", "enforce"):
            settings = dict(mg.guard_config(dict(mode=mode)))
            actuator = mg.Actuator(settings, lambda line: None, lambda command, timeout=10: PS)
            with patch.object(mg.os, "kill", lambda pid, sig: killed.append((mode, pid))), \
                    patch.object(mg.os, "getuid", return_value=501), patch.object(mg, "phase_running", return_value=False):
                actuator.perform(1, [("reclaim", True, 40)], ["x"])
        self.assertEqual([pid for mode, pid in killed if mode == "observe"], [])
        self.assertEqual([pid for mode, pid in killed if mode == "enforce"], [900, 901, 902])


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, command, timeout=10):
        self.calls.append(command)
        return ""


class TickTests(unittest.TestCase):
    def run_tick(self, mode, current, previous=None, execute=True):
        settings = mg.guard_config(dict(mode=mode))
        lines, runner = [], Recorder()
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"PI_MEM_GUARD_AGENT_DIR": tmp}):
            actuator = mg.Actuator(dict(settings, lane_cap_script="/x/lane-cap.sh"), lines.append, runner, execute)
            state, done = mg.tick(settings, tmp, current, previous or {}, 2000.0, actuator, execute)
            written = (Path(tmp) / mg.STATE_NAME).exists()
        return state, done, runner.calls, written

    def test_observe_mode_only_logs_destructive_actions(self):
        state, done, calls, _ = self.run_tick("observe", sample(cmpPct=41))
        self.assertEqual(state["level"], 3)
        self.assertIn("would shed-lanes", done)
        self.assertFalse([c for c in calls if c[0] == "bash"])
        self.assertTrue([c for c in calls if c[0] == "osascript"])

    def test_enforce_mode_sheds_with_the_per_tick_cap(self):
        _, done, calls, _ = self.run_tick("enforce", sample(cmpPct=41))
        shed = [c for c in calls if c[0] == "bash"][0]
        self.assertEqual(shed[1:], ["/x/lane-cap.sh", "--shed", "3", "--min-idle-s", "1800"])
        self.assertIn("shed-lanes", done)

    def test_emergency_drops_idle_floor_and_stops_containers(self):
        _, done, calls, _ = self.run_tick("enforce", sample(pl=4))
        self.assertIn("docker-stop-unpinned", done)
        self.assertIn("600", [c for c in calls if c[0] == "bash"][0])

    def test_dry_run_takes_no_action_and_writes_nothing(self):
        state, done, calls, written = self.run_tick("enforce", sample(pl=4), execute=False)
        self.assertEqual(calls, [])
        self.assertFalse(written)
        self.assertTrue(all(item.startswith("would ") for item in done))

    def test_reclaim_runs_before_shedding_and_at_level_one(self):
        names = [a[0] for a in mg.plan_actions(3, "enforce", LIMITS, 0, 0, 0)]
        self.assertLess(names.index("reclaim"), names.index("shed-lanes"))
        self.assertIn("reclaim", [a[0] for a in mg.plan_actions(1, "enforce", LIMITS, 1, 0, 0)])
        self.assertNotIn("reclaim", [a[0] for a in mg.plan_actions(0, "enforce", LIMITS, 0, 0, 0)])

    def test_fixtures_idle_and_latched(self):
        self.assertEqual(self.run_tick("enforce", sample())[0]["level"], 0)
        self.assertEqual(self.run_tick("enforce", sample(cmpPct=20.0))[0]["level"], 0)

    def test_describe_lists_all_signals(self):
        state = dict(level=2, reasons=["compressor 36%"], pl=2, cmpPct=36.0, swapMb=12800.0, swapGrowth=0.0,
                     swapInRate=10.0, sessions=43, stale=False)
        text = "\n".join(mg.describe(state, LIMITS, configured=dict(heavy=3, fast=2, integration=1)))
        for needle in ("guard level 2", "compressor 36%", "growth 0 MB/min", "swap-in 10", "live pi 43",
                       "heavy 3->1 (guard level 2)", "integration 1->0"):
            self.assertIn(needle, text)


class GateCliTests(unittest.TestCase):
    """`memory_guard.py gate` with a stub pgrep on PATH and an injected sample file."""
    def gate(self, pids, sample_fields=None, override=None, mode="observe"):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "bin").mkdir()
            stub = tmp / "bin" / "pgrep"
            stub.write_text("#!/bin/sh\n" + "".join("echo 1\n" for _ in range(pids)) + ("exit 1\n" if not pids else ""))
            stub.chmod(0o755)
            (tmp / "config.json").write_text(json.dumps(dict(memory_guard=dict(mode=mode))))
            env = dict(os.environ, PATH=f"{tmp / 'bin'}:{os.environ['PATH']}", PI_MEM_GUARD_CONFIG=str(tmp / "config.json"),
                       PI_MEM_GUARD_AGENT_DIR=str(tmp), PI_MEM_GUARD_STATE=str(tmp / "state"))
            env.pop("LANE_CAP_OVERRIDE", None)
            if sample_fields is not None:
                (tmp / "sample.json").write_text(json.dumps(sample(**sample_fields)))
                env["PI_MEM_GUARD_SAMPLE"] = str(tmp / "sample.json")
            if override:
                env["LANE_CAP_OVERRIDE"] = override
            result = subprocess.run([sys.executable, str(HERE / "memory_guard.py"), "gate"], env=env,
                                    capture_output=True, text=True)
            log = tmp / "logs" / "mem-guard.log"
            return result.returncode, result.stdout, log.read_text() if log.exists() else ""

    def test_allows_below_cap_at_level_zero(self):
        self.assertEqual(self.gate(10, {})[0], 0)

    def test_refuses_above_cap(self):
        code, out, _ = self.gate(40, {})
        self.assertEqual(code, 3)
        self.assertIn("cap", out)

    def test_refuses_at_level_two_or_above(self):
        code, out, _ = self.gate(5, dict(cmpPct=36))
        self.assertEqual(code, 3)
        self.assertIn("level 2", out)

    def test_override_allows_once_and_is_audited(self):
        code, out, log = self.gate(40, {}, override="L0 incident")
        self.assertEqual(code, 0)
        self.assertIn("L0 incident", log)

    def test_off_mode_does_not_check(self):
        self.assertEqual(self.gate(99, {}, mode="off")[0], 0)


if __name__ == "__main__":
    unittest.main()
