"""Cleanup configuration and safety checks, isolated from the live machine."""
import argparse
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'agent/bin/pi-cleanup'
loader = importlib.machinery.SourceFileLoader('pi_cleanup', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
cleanup = importlib.util.module_from_spec(spec)
exec(compile(SCRIPT.read_text(), str(SCRIPT), "exec"), cleanup.__dict__)


class CleanupConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.env = patch.dict(os.environ, HOME=str(self.home))
        self.env.start()
        self.addCleanup(self.env.stop)
        self.config = self.home / '.pi/agent/dev-doctor.json'
        self.config.parent.mkdir(parents=True)

    def test_config_threshold_and_numeric_compatibility(self):
        self.assertEqual(cleanup.parse_args(['--if-free-below', 'config']).if_free_below, 40)
        self.config.write_text(json.dumps({'disk': {'cleanup_trigger_gib': 37.5}}))
        self.assertEqual(cleanup.parse_args(['--if-free-below', 'config']).if_free_below, 37.5)
        self.assertEqual(cleanup.parse_args(['--if-free-below', '12.5']).if_free_below, 12.5)
        for value in ('-1', 'nan', 'inf', 'invalid'):
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cleanup.parse_args(['--if-free-below', value])

    def test_invalid_config_falls_back(self):
        for config in ('{', '[]', '{}', '{"disk": null}', '{"disk":{"cleanup_trigger_gib":true}}',
                       '{"disk":{"cleanup_trigger_gib":-1}}', '{"disk":{"cleanup_trigger_gib":"35"}}'):
            with self.subTest(config=config):
                self.config.write_text(config)
                self.assertEqual(cleanup.cleanup_trigger_gib(), 40)


if __name__ == '__main__':
    unittest.main()
