"""Default-off trial instrumentation and read-only analysis (#93)."""
import io
import json
import unittest
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone
from contextlib import redirect_stdout

import pi_phase
from test_observability import RunBase


TRIAL = dict(name="ab-slots", arm="4x2", started="2026-11-03T08:00:00Z")


class WarmthShadowTests(RunBase):
    def test_warmth_main_linked_unknown_and_scan_budget(self):
        self.assertIsNone(pi_phase.obj_warmth(self.root))
        (self.root / ".git").mkdir()
        self.assertIs(pi_phase.obj_warmth(self.root), False)
        self.assertFalse(pi_phase.cold_worktree(self.root))
        (self.root / ".git").rmdir()
        (self.root / ".git").write_text("gitdir: /elsewhere")
        self.assertTrue(pi_phase.cold_worktree(self.root))
        (self.root / "src" / "project" / "obj").mkdir(parents=True)
        self.assertIs(pi_phase.obj_warmth(self.root), True)
        self.assertFalse(pi_phase.cold_worktree(self.root))
        with patch.object(pi_phase.os, "scandir", side_effect=OSError):
            self.assertIsNone(pi_phase.obj_warmth(self.root))
        entries = [SimpleNamespace(name="file", is_dir=lambda **kw: False)] * 1001
        with patch.object(pi_phase.os, "scandir") as scan:
            scan.return_value.__enter__.return_value = entries
            self.assertIsNone(pi_phase.obj_warmth(self.root))

    def test_shadow_passed_warmth_failures_and_safety(self):
        stamp = datetime.now(timezone.utc).isoformat()
        identity = pi_phase.WorkIdentity("r", "w", "f", "p", "run", False)
        settings = dict(kinds=["build", "test"], max_expected_s=20)
        def record(seconds, **fields):
            return dict(dict(ts=stamp, startedAt=stamp, kind="test", outcome="passed", runS=seconds,
                             fingerprint="fp", workKey="w", familyKey="f", warm=True), **fields)
        records = [record(10), record(20), record(100, warm=False), record(1, outcome="failed")]
        history = pi_phase.PhaseHistory(records)
        shadow = pi_phase.fast_shadow(history, identity, "fp", "test", True, settings)
        self.assertEqual(shadow, dict(v=1, basis="exact-warm", n=2, predS=10.0, p90S=20.0, fails=1, would=True, limS=20))
        self.assertEqual(pi_phase.fast_shadow(history, identity, "fp", "test", False, settings)["basis"], "exact-any")
        self.assertIsNone(pi_phase.fast_shadow(history, identity, "fp", "test", True, False))
        self.assertIsNone(pi_phase.fast_shadow(history, identity, "fp", "integration", True, settings))
        for extra in (record(1, outcome="timeout"), record(1, fastBudgetExceeded=True)):
            verdict = pi_phase.fast_shadow(pi_phase.PhaseHistory(records + [extra]), identity, "fp", "test", True, settings)
            self.assertFalse(verdict["would"])
        self.assertEqual(pi_phase.fast_shadow(history, identity, "other", "test", True, settings)["basis"], "work-warm")
        self.assertEqual(pi_phase.fast_shadow(pi_phase.PhaseHistory([record(4, warm=False), record(6, warm=False)]), identity, "fp", "test", False, settings)["basis"], "exact-cold")
        self.assertEqual(pi_phase.fast_shadow(pi_phase.PhaseHistory([record(9)] * 25), identity, "fp", "test", True, settings)["n"], 20)

    def test_policy_is_unchanged_even_if_shadow_raises(self):
        options = pi_phase.config(self.config).options
        history = pi_phase.PhaseHistory([])
        records = []
        for effect in (None, RuntimeError("shadow unavailable")):
            args = SimpleNamespace(kind="build", queue_timeout=1200, priority="normal", policy="direct", ledger=SimpleNamespace(record={}))
            with patch.object(pi_phase, "fast_shadow", side_effect=effect, return_value=dict(v=1)), redirect_stdout(io.StringIO()):
                pi_phase.prepare_policy(self.state, args, options, "fp", history, None, warm=True)
            records.append({k: args.ledger.record[k] for k in ("policy", "fast", "source", "expectedS", "expectedBasis")})
        self.assertEqual(records[0], records[1])

    def test_started_record_has_warmth_and_shadow(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / "obj").mkdir()
        self.assertEqual(self.run_phase(["true"])[0], 0)
        record = self.records()[0]
        self.assertIs(record["warm"], True)
        self.assertEqual(record["fastShadow"]["v"], 1)


class ChildCpuTests(RunBase):
    def test_started_phase_records_child_cpu_seconds(self):
        command = [pi_phase.sys.executable, "-c", "import time; end=time.process_time()+0.3\nwhile time.process_time()<end: pass"]
        self.assertEqual(self.run_phase(command)[0], 0)
        value = self.records()[0]["childCpuS"]
        self.assertIsInstance(value, float)
        self.assertGreaterEqual(value, 0.1)
        self.assertEqual(value, round(value, 1))

    def test_rejected_phase_has_no_child_cpu(self):
        self.assertNotEqual(self.run_phase(["true"], "--timeout", "0")[0], 0)
        self.assertNotIn("childCpuS", self.records()[0])


class TrialReportTests(RunBase):
    def report(self, *flags):
        output = io.StringIO()
        with redirect_stdout(output):
            code = pi_phase.main(["report", *flags], state=self.state, configuration=self.config)
        return code, output.getvalue()

    def test_empty_trial_is_read_only_and_legacy_ignored(self):
        code, output = self.report("--trial", "ab", "--json")
        self.assertEqual((code, json.loads(output)), (0, dict(trial="ab", windows=[], arms={})))
        self.assertFalse(self.state.exists())
        pi_phase.append_ledger(self.state, dict(v=1, ts=pi_phase.utc_stamp(), kind="test", startedAt=None,
                                               waitS=0, runS=0, outcome="queue-timeout"))
        self.assertEqual(json.loads(self.report("--trial", "ab", "--json")[1])["windows"], [])

    def test_windows_backlog_pooling_latency_and_resources(self):
        from trial_report import trial_summary
        def record(queued, started, ended, **fields):
            base = dict(trial=dict(name="ab", arm="a", started="2026-01-01T00:00:00Z"),
                        ts=ended, queuedAt=queued, startedAt=started, endedAt=ended, kind="test",
                        policy="queued", waitS=1800, runS=600, outcome="passed", repoKey="r",
                        host=dict(swapGrowth=3, swapMb=10, load1=4), peakRssMb=100, childCpuS=60,
                        hangTimeout="applied", hangKill=True)
            return dict(base, **fields)
        a = record("2026-01-01T00:15:00Z", "2026-01-01T00:45:00Z", "2026-01-01T00:50:00Z")
        b = record("2026-01-01T00:20:00Z", "2026-01-01T00:40:00Z", "2026-01-01T00:42:00Z", outcome="timeout", runS=1200)
        settling = record("2025-12-31T23:59:00Z", "2026-01-01T00:10:00Z", "2026-01-01T00:12:00Z", policy="direct", waitS=0)
        spill = record("2026-01-01T00:30:00Z", "2026-01-01T01:00:00Z", "2026-01-01T01:10:00Z", retryOf=b["ts"])
        next_window = record("2026-01-01T01:15:00Z", "2026-01-01T01:45:00Z", "2026-01-01T02:00:00Z",
                             trial=dict(name="ab", arm="b", started="2026-01-01T01:00:00Z"))
        result = trial_summary([a, b, settling, spill, next_window], "ab", 900)
        first = result["windows"][0]
        self.assertEqual((first["spanH"], first["records"], first["started"], first["completed"]), (1, 4, 4, 3))
        self.assertEqual((first["carryOver"], first["settling"], first["spill"]), (1, 1, 1))
        self.assertEqual(first["backlogH"], 0.75)
        self.assertAlmostEqual(first["completedPerBacklogH"], 1 / 0.75)
        self.assertEqual(first["waitRunS"]["all"], dict(p50=2400, p95=3000))
        self.assertEqual(first["timeouts"], 1)
        self.assertAlmostEqual(first["timeoutH"], 1 / 3)
        self.assertAlmostEqual(first["retryAfterTimeoutH"], 1 / 6)
        self.assertEqual((first["swapGrowth"], first["swapMbMax"], first["load1"], first["peakRssMb"]), (3, 10, 4, 100))
        self.assertEqual(first["hang"], dict(applied=4, hangKill=4))
        self.assertEqual((result["arms"]["a"]["windows"], result["arms"]["a"]["validWindows"]), (1, 0))
        pooled = trial_summary([a, dict(a, trial=dict(a["trial"], started="2026-01-01T01:00:00Z"),
                                      endedAt="2026-01-01T02:00:00Z")], "ab", 0)
        self.assertEqual(pooled["arms"]["a"]["windows"], 2)
        self.assertEqual(pooled["arms"]["a"]["records"], 2)

    def test_plain_shadow_accuracy_and_confusion(self):
        from trial_report import shadow_summary
        records = [dict(outcome="passed", runS=10, fast=False,
                        fastShadow=dict(predS=5, basis="exact-warm", would=True, limS=20)),
                   dict(outcome="passed", runS=30, fast=True,
                        fastShadow=dict(predS=30, basis="exact-cold", would=False, limS=20)),
                   dict(outcome="failed", runS=10, fastShadow=dict(predS=5))]
        result = shadow_summary(records)
        self.assertEqual(result["n"], 2)
        self.assertEqual(result["mdapePct"], dict(warm=50, cold=0, any=None))
        self.assertEqual(result["would"], dict(tp=1, fp=0, fn=0, tn=1))
        self.assertEqual(result["current"], dict(tp=0, fp=1, fn=1, tn=0))
        self.assertIn("fastShadow", json.loads(self.report("--json")[1]))
        self.assertIn("hangKill", json.loads(self.report("--json")[1]))


class TrialConfigTests(RunBase):
    def test_valid_absent_hash_summary_and_overlay(self):
        original = pi_phase.config(self.config)
        self.assertIsNone(original.options["trial"])
        self.assertNotIn("trial", pi_phase.config_fields(original)[1])
        self.write_config(trial=TRIAL)
        configured = pi_phase.config(self.config)
        self.assertEqual(configured.options["trial"], TRIAL)
        self.assertNotEqual(pi_phase.config_fields(original)[0], pi_phase.config_fields(configured)[0])
        self.assertEqual(pi_phase.config_fields(configured)[1]["trial"], "ab-slots/4x2")
        self.config.with_name("config.local.json").write_text(json.dumps(dict(trial=dict(arm="5x3"))))
        self.assertEqual(pi_phase.config(self.config).options["trial"], dict(TRIAL, arm="5x3"))

    def test_validation_warns_once_and_normalizes_timezone(self):
        invalid = ["trial", [], {}, dict(TRIAL, extra=1), dict(TRIAL, name="bad name"),
                   dict(TRIAL, arm="bad/arm"), dict(TRIAL, name="a" * 65), dict(TRIAL, arm="a" * 33),
                   dict(TRIAL, started="2026-11-03T08:00:00"), dict(TRIAL, started="not-a-date")]
        for value in invalid:
            with self.subTest(value=value):
                self.write_config(trial=value)
                notes = set()
                output = io.StringIO()
                with redirect_stdout(output):
                    self.assertIsNone(pi_phase.config(self.config, notes=notes).options["trial"])
                    self.assertIsNone(pi_phase.config(self.config, notes=notes).options["trial"])
                self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(pi_phase.trial_config(dict(TRIAL, started="2026-11-03T10:00:00+02:00"), self.fail), TRIAL)

    def test_run_records_marker(self):
        self.write_config(trial=TRIAL)
        self.assertEqual(self.run_phase(["true"])[0], 0)
        self.assertEqual(self.records()[0]["trial"], TRIAL)
