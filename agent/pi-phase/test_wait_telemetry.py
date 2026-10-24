"""Diagnostic admission telemetry must not change queue decisions or legacy output."""
import io
import json
import os
from pathlib import Path
import sys
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import pi_phase
from test_queue_order import Harness


class WaitTelemetryTests(unittest.TestCase):
    def test_intervals_samples_and_close_are_idempotent(self):
        telemetry = pi_phase.WaitTelemetry(0, clock=iter([1, 4, 6]).__next__)
        with patch.object(pi_phase.os, "getloadavg", return_value=(2, 3, 4)):
            telemetry.record(dict(reason="slots", busy={"heavy": (1, 2)}, memFree=40))
            telemetry.record(dict(reason="order", busy={"heavy": (2, 3)}, memFree=20))
            telemetry.record(dict(reason="memory"))
        telemetry.close(10)
        fields = telemetry.fields()
        self.assertEqual(fields["waitV"], 1)
        self.assertEqual(fields["waitBreakdown"], dict(other=1, slots=3, order=2, memory=4))
        self.assertEqual(fields["waitScans"], dict(other=0, slots=1, order=1, memory=1))
        self.assertEqual(sum(fields["waitBreakdown"].values()), 10)
        samples = fields["waitSamples"]
        self.assertEqual(samples["n"], 3)
        self.assertEqual((samples["load1Mean"], samples["load1Max"]), (2, 2))
        self.assertEqual(samples["cpus"], os.cpu_count())
        self.assertEqual(samples["memFreeMin"], 20)
        self.assertEqual(samples["heavy"], dict(mean=1.5, max=2, of=3))
        self.assertNotIn("fast", samples)
        telemetry.close(99)
        telemetry.record(dict(reason="slots"))
        self.assertEqual(telemetry.fields(), fields)

    def test_missing_load_is_null_and_empty_scan_counts_as_other(self):
        telemetry = pi_phase.WaitTelemetry(0, clock=lambda: 1)
        with patch.object(pi_phase.os, "getloadavg", side_effect=OSError("unavailable")):
            telemetry.record({})
        telemetry.close(2)
        fields = telemetry.fields()
        self.assertEqual(fields["waitScans"]["other"], 1)
        self.assertEqual(fields["waitBreakdown"]["other"], 2)
        self.assertEqual(fields["waitSamples"]["n"], 1)
        for key in ("load1Mean", "load1Max", "memFreeMin"):
            self.assertIsNone(fields["waitSamples"][key])

    def test_optional_telemetry_failures_do_not_escape(self):
        telemetry = pi_phase.WaitTelemetry(0, clock=lambda: 1)
        with patch.object(pi_phase.os, "getloadavg", side_effect=RuntimeError("sample")):
            telemetry.record(dict(reason="slots"))
        telemetry.close(None)
        with patch.object(pi_phase.os, "cpu_count", side_effect=RuntimeError("cpu")):
            self.assertEqual(telemetry.fields(), {})


class AdmissionTelemetryTests(Harness):
    def claim(self, token=None, *, scan=None, **options):
        self.state.mkdir(exist_ok=True)
        heavy, integration = options.get("heavy", 1), 1
        candidates = pi_phase.slot_paths(self.state, options.get("kind", "build"), heavy, integration, ())
        held = pi_phase.claim(self.state, candidates, time.monotonic() + 2, lambda: False,
                              token, (heavy, integration), options.get("admission"), scan=scan)
        if held:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def hold(self, name):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / (name + ".lock"))
        self.assertIsNotNone(fd)
        self.addCleanup(os.close, fd)
        return fd

    def test_slots_reports_busy_capacity(self):
        self.hold("heavy-0")
        self.waiter("blocked")
        scan = {}
        self.assertIsNone(self.claim("blocked", scan=scan))
        self.assertEqual(scan["reason"], "slots")
        self.assertEqual(scan["busy"], {"heavy": (1, 1), "integration": (0, 1)})

    def test_shorter_waiter_reserves_free_slot(self):
        self.at(100, self.ranked, "long", 300)
        self.at(101, self.ranked, "short", 5)
        scan = {}
        self.assertIsNone(self.at(102, self.claim, "long", scan=scan))
        self.assertEqual(scan["reason"], "order")
        self.assertEqual(scan["busy"]["heavy"], (0, 1))
        scan = {}
        self.assertTrue(self.at(102, self.claim, "short", scan=scan))
        self.assertNotIn("reason", scan)

    def test_higher_priority_waiter_reserves_free_slot(self):
        pi_phase.grant_priority(self.state, 10, None)
        self.at(100, self.ranked, "normal", 1)
        self.at(101, self.ranked, "high", 300, priority="high")
        scan = {}
        self.assertIsNone(self.at(102, self.claim, "normal", scan=scan))
        self.assertEqual(scan["reason"], "order")

    def test_unsatisfiable_integration_waiter_is_slots_not_order(self):
        self.at(100, self.ranked, "integration", 1, kind="integration")
        self.at(101, self.ranked, "build", 500)
        self.hold("integration-0")
        scan = {}
        self.assertIsNone(self.at(102, self.claim, "integration", kind="integration", scan=scan))
        self.assertEqual(scan["reason"], "slots")
        self.assertTrue(self.at(102, self.claim, "build", scan={}))

    def test_memory_precedes_slots_and_preserves_idle_starvation_guard(self):
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        first = self.hold("heavy-0")
        with patch.object(pi_phase, "read_host_memory", return_value=(20, 1000)), \
                patch.object(pi_phase, "note"):
            scan = {}
            self.assertIsNone(self.claim(heavy=2, admission=admission, scan=scan))
            self.assertEqual((scan["reason"], scan["memFree"]), ("memory", 20))
            second = self.hold("heavy-1")
            scan = {}
            self.assertIsNone(self.claim(heavy=2, admission=admission, scan=scan))
            self.assertEqual(scan["reason"], "memory")
            self.assertEqual(scan["busy"]["heavy"], (2, 2))
            # Release the locks but retain their descriptors for the registered cleanups.
            pi_phase.fcntl.flock(first, pi_phase.fcntl.LOCK_UN)
            pi_phase.fcntl.flock(second, pi_phase.fcntl.LOCK_UN)
            scan = {}
            self.assertTrue(self.claim(heavy=2, admission=admission, scan=scan))
            self.assertNotIn("reason", scan)

    def test_busy_coordinator_and_missing_waiter_are_other(self):
        coordinator = self.hold("coordinator")
        scan = {}
        self.assertIsNone(self.claim(scan=scan))
        self.assertNotIn("reason", scan)
        pi_phase.fcntl.flock(coordinator, pi_phase.fcntl.LOCK_UN)
        self.assertIsNone(self.claim("missing", scan=scan))
        self.assertNotIn("reason", scan)
        telemetry = pi_phase.WaitTelemetry(0, clock=lambda: 1)
        telemetry.record(scan)
        self.assertEqual(telemetry.fields()["waitScans"]["other"], 1)

    def test_non_waiter_reports_slots(self):
        self.hold("heavy-0")
        scan = {}
        self.assertIsNone(self.claim(scan=scan))
        self.assertEqual(scan["reason"], "slots")

    def queue_scenario(self, scenario):
        if scenario == "priority":
            pi_phase.grant_priority(self.state, 10, None)
        self.at(100, self.ranked, "long", 300, age_after=50 if scenario == "aged" else 600)
        if scenario == "legacy":
            self.at(101, self.waiter, "legacy")
        self.at(190, self.ranked, "short", 5,
                priority="high" if scenario == "priority" else "normal")

    def scenario_winners(self, scenario, instrumented):
        self.state = self.root / f"{scenario}-{instrumented}"
        self.queue_scenario(scenario)
        tokens = ("long", "short", "legacy") if scenario == "legacy" else ("long", "short")
        return [token for token in tokens
                if self.at(200, self.claim, token, scan={} if instrumented else None)]

    def test_winners_are_identical_without_instrumentation(self):
        scenarios = (("short", "short"), ("aged", "long"), ("priority", "short"), ("legacy", "long"))
        for scenario, expected in scenarios:
            for instrumented in (False, True):
                with self.subTest(scenario=scenario, instrumented=instrumented):
                    self.assertEqual(self.scenario_winners(scenario, instrumented), [expected])

    def test_scan_adds_no_subprocesses(self):
        self.hold("heavy-0")
        (self.state / "heavy-0.json").write_text(json.dumps(dict(pgid=4242)))
        counts = []
        for scan in (None, {}):
            with patch.object(pi_phase.subprocess, "run", wraps=pi_phase.subprocess.run) as run, \
                    patch.object(pi_phase.subprocess, "Popen", wraps=pi_phase.subprocess.Popen) as popen, \
                    patch.object(pi_phase, "live_groups", return_value=set()):
                self.assertIsNone(self.claim(scan=scan))
                counts.append((run.call_count, popen.call_count))
        self.assertEqual(counts[0], counts[1])

    def test_status_appends_slots_only_for_waiters_and_parser_ignores_it(self):
        self.configure()
        self.waiter("queued")
        self.hold("heavy-0")
        self.hold("integration-0")
        for pool in ("heavy", "integration"):
            (self.state / (pool + "-0.json")).write_text(json.dumps(dict(token="shared", kind="integration")))
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(pi_phase.status(self.state, self.config), 0)
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[-1], "pi-phase: slots heavy=1/2 integration=1/1")
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
        self.addCleanup(sys.path.remove, sys.path[0])
        import phase_status
        self.assertEqual(phase_status.active_phases(out.getvalue()), phase_status.active_phases("\n".join(lines[:-1])))
        self.assertEqual(len(phase_status.active_phases(out.getvalue())), 1)
        (self.state / "waiters" / "queued.json").unlink()
        with redirect_stdout(io.StringIO()) as out:
            pi_phase.status(self.state, self.config)
        self.assertNotIn("pi-phase: slots", out.getvalue())

    def test_status_busy_heavy_slot(self):
        self.configure()
        self.waiter("queued")
        self.hold("heavy-0")
        with redirect_stdout(io.StringIO()) as out:
            pi_phase.status(self.state, self.config)
        self.assertEqual(out.getvalue().splitlines()[-1], "pi-phase: slots heavy=1/2 integration=0/1")


class LedgerTelemetryTests(Harness):
    def assert_wait_total(self, record):
        self.assertEqual(record["waitV"], 1)
        self.assertAlmostEqual(sum(record["waitBreakdown"].values()), record["waitS"], delta=.01)

    def test_queue_timeout_records_slot_wait(self):
        self.orphan_slots()
        code, output = self.done(self.run_phase(queue=".5"))
        self.assertEqual(code, 75, output)
        record = self.ledger_records()[-1]
        self.assert_wait_total(record)
        self.assertGreater(record["waitBreakdown"]["slots"], 0)
        self.assertGreaterEqual(record["waitScans"]["slots"], 1)

    def test_admitted_run_records_wait_and_parse_rejection_does_not(self):
        self.configure()
        code, output = self.done(self.run_phase())
        self.assertEqual(code, 0, output)
        self.assert_wait_total(self.ledger_records()[-1])
        code, output = self.done(self.run_phase(extra=("--tail", "-1")))
        self.assertEqual(code, 2, output)
        self.assertNotIn("waitV", self.ledger_records()[-1])

    def test_identical_second_run_skips_without_telemetry(self):
        self.configure(cold_worktree_hint=False)
        argv = ["run", "--kind", "test", "--label", "repeat", "--", sys.executable, "-c", "pass"]
        with patch.object(pi_phase, "git_state", return_value=("head", "clean")), redirect_stdout(io.StringIO()):
            for _ in range(2):
                self.assertEqual(pi_phase.main(argv, state=self.state, configuration=self.config), 0)
        records = self.ledger_records()
        self.assert_wait_total(records[-2])
        self.assertEqual(records[-1]["outcome"], "skipped")
        self.assertNotIn("waitV", records[-1])

    def test_legacy_and_new_records_read_stats_and_history(self):
        self.seed([sys.executable, "-c", "pass"], [3])
        legacy = self.ledger_records()[-1]
        telemetry = pi_phase.WaitTelemetry(0)
        telemetry.close(0)
        pi_phase.append_ledger(self.state, dict(legacy, **telemetry.fields()))
        records, skipped = pi_phase.read_ledger(self.state)
        self.assertEqual((len(records), skipped), (2, 0))
        self.assertNotIn("waitV", records[0])
        self.assertEqual(records[1]["waitV"], 1)
        with redirect_stdout(io.StringIO()) as out:
            pi_phase.stats(self.state, 7, None, True)
        total = next(row for row in json.loads(out.getvalue())["rows"] if row["day"] == "total")
        self.assertEqual(total["count"], 2)
        for history in (pi_phase.PhaseHistory(records), pi_phase.load_history(self.state)):
            self.assertEqual(len(history.exact_runs(legacy["fingerprint"])), 2)


if __name__ == "__main__":
    unittest.main()
