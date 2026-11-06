import importlib.machinery
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('lane_status_runtime', str(Path(__file__).resolve().parents[1] / 'agent/bin/lane-status'))
spec = importlib.util.spec_from_loader(loader.name, loader)
status = importlib.util.module_from_spec(spec)
loader.exec_module(status)


class LaneStatusTests(unittest.TestCase):
    def test_parked_never_expires_and_working_explicitly_unparks(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'LANE_STATUS_DIR': directory}):
            self.assertEqual(status.main(['set', 'L1', 'parked', 'review / L0', '--until', '2026-01-01T00:00:00Z'], now=100), 0)
            line = status.read_line('L1')
            for now in (0, 2000000000):
                self.assertTrue(status.is_active(line, now))
                self.assertFalse(status.is_expired(line, now))
                self.assertEqual(status.main(['suppressed', 'L1'], now=now), 0)
            self.assertEqual(status.main(['set', 'L1', 'working'], now=100), 0)
            self.assertFalse(status.is_active(status.read_line('L1'), 100))

    def test_finite_waits_keep_expiring_and_status_reads_do_not_consume_inbox(self):
        for kind in ('waiting-on', 'barred-by'):
            line = f'{kind} "review" until 2026-01-01T00:00:00Z'
            self.assertTrue(status.is_active(line, 0))
            self.assertTrue(status.is_expired(line, 2000000000))
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'INBOX_DIR': directory, 'LANE_STATUS_DIR': ''}):
            marker = Path(directory, 'L1-inbox.marker')
            marker.write_text('untouched')
            status.main(['set', 'L1', 'parked', 'owner', '--until', '+1s'], now=1)
            before = marker.stat().st_mtime_ns
            status.main(['suppressed', 'L1'], now=999)
            self.assertEqual(marker.stat().st_mtime_ns, before)
            self.assertEqual(marker.read_text(), 'untouched')
