"""Default-off trial instrumentation and read-only analysis (#93)."""
import io
import json
import unittest
from contextlib import redirect_stdout

import pi_phase
from test_observability import RunBase


TRIAL = dict(name="ab-slots", arm="4x2", started="2026-11-03T08:00:00Z")


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
