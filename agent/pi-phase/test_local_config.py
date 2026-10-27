"""Machine-local configuration overlays are optional and preserve shipped defaults."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pi_phase


class LocalConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "config.json"
        self.path.write_text(json.dumps({"heavy_slots": 3, "phase_nice": 2,
                                         "fast_lane": {"slots": 4, "max_expected_s": 60},
                                         "policy": [{"path": "/shipped/*", "policy": "direct", "kinds": ["test"]}]}))
        self.local = self.path.with_name("config.local.json")

    def test_absent_overlay_keeps_shipped_config(self):
        config = pi_phase.config(self.path)
        self.assertEqual(config[0], 3)
        self.assertEqual(config.options["phase_nice"], 2)
        self.assertEqual(config.options["fast_lane"]["slots"], 4)

    def test_overlay_overrides_scalar(self):
        self.local.write_text('{"heavy_slots": 5}')
        config = pi_phase.config(self.path)
        self.assertEqual(config[0], 5)
        self.assertEqual(config.options["phase_nice"], 2)

    def test_nested_merge_preserves_siblings_and_replaces_arrays(self):
        self.local.write_text(json.dumps({"fast_lane": {"slots": 1}, "policy": []}))
        config = pi_phase.config(self.path)
        self.assertEqual(config.options["fast_lane"]["slots"], 1)
        self.assertEqual(config.options["fast_lane"]["max_expected_s"], 60)
        self.assertEqual(config.options["policy"], [])
        self.assertEqual(pi_phase.merge_config({"a": {"b": {"c": 1, "d": 2}}},
                                               {"a": {"b": {"c": 3}}}),
                         {"a": {"b": {"c": 3, "d": 2}}})

    def test_invalid_overlay_reports_clear_error_and_keeps_base(self):
        for content in ("{broken", "[]", "null"):
            with self.subTest(content=content):
                self.local.write_text(content)
                with patch.object(pi_phase, "note") as note:
                    config = pi_phase.config(self.path)
                self.assertEqual(config[0], 3)
                message = note.call_args.args[0]
                self.assertIn("invalid config.local.json", message)
                self.assertIn("ignoring local overlay", message)


if __name__ == "__main__":
    unittest.main()
