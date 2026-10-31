"""host_pressure admission (#81 step 5): parsing, shared sample cache, growth, observe vs enforce, config."""
import json
import os
import subprocess
import time
import unittest
from unittest.mock import patch

import pi_phase
from test_queue_order import Harness

SYSCTL = ("vm.swapusage: total = 14336.00M  used = 13400.50M  free = 935.50M  (encrypted)\n"
          "4294967296\n17179869184\n2\n54\n").replace("vm.swapusage: ", "")
OK = dict(swapMb=100.0, cmpPct=5.0, pl=1, level=54.0)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


class HostPressureTests(Harness):
    def pressure(self, mode="enforce", probe=None, clock=None, **settings):
        self.state.mkdir(exist_ok=True)
        self.probes = []

        def default_probe(timeout):
            self.probes.append(timeout)
            return dict(OK)
        config = pi_phase.host_pressure_config(dict(mode=mode, **settings))
        return pi_phase.HostPressure(config, self.state, probe or default_probe, clock or Clock())

    def claim(self, pressure, kind="build", scan=None):
        self.state.mkdir(exist_ok=True)
        held = pi_phase.claim(self.state, pi_phase.slot_paths(self.state, kind, 2, 1, ("repo", "1", "sha")),
                              time.monotonic() + 2, lambda: False, scan=scan, pressure=pressure)
        if held:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def running_phase(self):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, fd)

    def test_parse_five_name_sysctl_output(self):
        self.assertEqual(pi_phase.parse_host_pressure(SYSCTL), dict(swapMb=13400.5, cmpPct=25.0, pl=2, level=54.0))
        for bad in ("", SYSCTL + "1\n", SYSCTL.replace("used", "usd"), SYSCTL.replace("17179869184", "0")):
            with self.assertRaises(ValueError):
                pi_phase.parse_host_pressure(bad)

    def test_config_defaults_and_invalid_values_fall_back_to_off(self):
        self.assertEqual(pi_phase.config(self.config).options["host_pressure"], dict(mode="off"))
        full = pi_phase.host_pressure_config(dict(mode="observe"))
        self.assertEqual(full, dict(mode="observe", **pi_phase.HOST_PRESSURE_DEFAULTS))
        for bad in (True, "observe", dict(mode="loud"), dict(mode="observe", max_compressor_percent=0),
                    dict(mode="observe", max_pressure_level=1.5), dict(mode="enforce", sample_ttl_s="5"),
                    dict(mode="enforce", max_swap_growth_mb_per_min=True)):
            warnings = []
            self.assertEqual(pi_phase.host_pressure_config(bad, warnings.append), dict(mode="off"), bad)
            self.assertTrue(warnings)

    def test_cache_is_shared_so_n_waiters_cost_one_probe(self):
        clock = Clock()
        first, second = self.pressure(clock=clock), self.pressure(clock=clock)
        deadline = time.monotonic() + 5
        for waiter in (first, second, first, second):
            self.assertIsNone(waiter.reason(deadline))
        self.assertEqual(len(self.probes), 1)
        clock.now += 6
        first.reason(deadline)
        self.assertEqual(len(self.probes), 2)

    def test_corrupt_or_missing_cache_probes_again(self):
        waiter = self.pressure()
        (self.state / "host-sample.json").write_text("{not json")
        waiter.reason(time.monotonic() + 5)
        self.assertEqual(len(self.probes), 1)
        self.assertEqual(json.loads((self.state / "host-sample.json").read_text())["pl"], 1)

    def test_swap_growth_uses_oldest_and_newest_at_least_a_minute_apart(self):
        self.assertIsNone(pi_phase.swap_growth([[0, 100]]))
        self.assertIsNone(pi_phase.swap_growth([[0, 100], [30, 900]]))
        self.assertEqual(pi_phase.swap_growth([[0, 100], [60, 400], [120, 700]]), 300)
        clock, swap = Clock(), [0]
        waiter = self.pressure(probe=lambda timeout: dict(OK, swapMb=swap[0]), clock=clock, max_swap_growth_mb_per_min=256)
        deadline = time.monotonic() + 5
        for minute, used in ((0, 0), (1, 100), (2, 600)):
            clock.now, swap[0] = 1000 + 60 * minute, used
            reason = waiter.reason(deadline)
        self.assertEqual(reason, "swap growth 300 MB/min >= 256")

    def test_reasons_for_level_and_compressor(self):
        level = self.pressure(probe=lambda t: dict(OK, pl=2))
        self.assertEqual(level.reason(time.monotonic() + 5), "memory pressure level 2 >= 2")
        (self.state / "host-sample.json").unlink()
        compressor = self.pressure(probe=lambda t: dict(OK, cmpPct=31))
        self.assertEqual(compressor.reason(time.monotonic() + 5), "compressor 31% >= 30%")

    def test_probe_failure_fails_open_and_notes_once(self):
        def fail(timeout):
            raise subprocess.TimeoutExpired("sysctl", timeout)
        waiter = self.pressure(probe=fail, clock=Clock())
        with patch.object(pi_phase, "note") as note:
            self.assertIsNone(waiter.reason(time.monotonic() + 5))
            self.assertIsNone(waiter.reason(time.monotonic() + 5))
        note.assert_called_once()
        self.assertFalse((self.state / "host-sample.json").exists())

    def test_probe_runs_outside_the_coordinator_lock(self):
        def probe(timeout):
            coordinator = pi_phase.lock_file(self.state / "coordinator.lock")
            self.assertIsNotNone(coordinator)
            pi_phase.unlock(coordinator)
            return dict(OK, pl=4)
        self.running_phase()
        self.assertIsNone(self.claim(self.pressure(probe=probe)))

    def test_enforce_holds_only_while_a_phase_runs(self):
        busy = self.pressure(probe=lambda t: dict(OK, pl=4))
        self.assertTrue(self.claim(busy), "an idle host still starts one phase (anti-deadlock)")
        for path in self.state.glob("heavy-*.lock"):
            path.unlink()
        self.running_phase()
        scan = {}
        with patch.object(pi_phase, "note") as note:
            self.assertIsNone(self.claim(busy, scan=scan))
        self.assertEqual(scan["reason"], "memory")
        note.assert_called_once_with("waiting: memory pressure level 4 >= 2")
        self.assertNotIn("wouldHold", scan)

    def test_observe_never_holds_and_reports_would_hold(self):
        self.running_phase()
        scan = {}
        held = self.claim(self.pressure(mode="observe", probe=lambda t: dict(OK, pl=4)), scan=scan)
        self.assertTrue(held)
        self.assertEqual(scan["wouldHold"], "host:memory pressure level 4 >= 2")
        self.assertNotEqual(scan.get("reason"), "memory")

    def test_missing_pressure_key_changes_nothing(self):
        self.running_phase()
        scan = {}
        self.assertTrue(self.claim(None, scan=scan))
        self.assertNotIn("wouldHold", scan)
        self.assertFalse((self.state / "host-sample.json").exists())

    def test_telemetry_counts_would_hold_time_without_changing_other_fields(self):
        telemetry = pi_phase.WaitTelemetry(0, clock=iter([1, 4, 6]).__next__)
        with patch.object(pi_phase.os, "getloadavg", return_value=(1, 1, 1)):
            telemetry.record(dict(reason="slots", wouldHold="host:level"))
            telemetry.record(dict(reason="slots"))
            telemetry.record(dict(reason="cpu", wouldHold="cpu:7/6"))
        telemetry.close(10)
        fields = telemetry.fields()
        self.assertEqual(fields["waitWouldHold"], dict(host=3, cpu=4))
        self.assertEqual(fields["waitBreakdown"], dict(other=1, slots=5, order=0, memory=0, cpu=4))
        plain = pi_phase.WaitTelemetry(0, clock=lambda: 1)
        plain.record(dict(reason="slots"))
        self.assertNotIn("waitWouldHold", plain.fields())
        self.assertNotIn("cpu", plain.fields()["waitBreakdown"])

    def test_ledger_host_fields_come_from_the_cache_only(self):
        waiter = self.pressure()
        self.assertEqual(waiter.cached_fields(), {})
        waiter.reason(time.monotonic() + 5)
        fields = waiter.cached_fields()
        self.assertEqual((fields["pl"], fields["cmpPct"], fields["swapMb"]), (1, 5.0, 100.0))
        self.assertEqual(len(self.probes), 1)


if __name__ == "__main__":
    unittest.main()
