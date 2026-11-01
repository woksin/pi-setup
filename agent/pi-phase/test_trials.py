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
