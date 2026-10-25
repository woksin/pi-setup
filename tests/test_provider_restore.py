"""provider-restore CLI: clears a provider's account and per-model limit marks and always writes the broadcast signal."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'agent/bin/provider-restore'
MARK = {'until': 9_999_999_999_999, 'since': 0}


def run(state: Path, *args):
    env = {**os.environ, 'PI_PROVIDER_FALLBACK_STATE': str(state)}
    return subprocess.run(['node', str(SCRIPT), *args], env=env, text=True, capture_output=True, timeout=30)


class ProviderRestoreTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.state = self.dir / '.provider-limits.json'
        self.signals = self.dir / '.provider-restore.json'

    def test_clears_account_and_model_keys_of_the_provider_only(self):
        self.state.write_text(json.dumps({'anthropic': MARK, 'anthropic/x': MARK, 'anthropic-x/y': MARK, 'kimi': MARK}))
        result = run(self.state, 'anthropic')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(json.loads(self.state.read_text())), ['anthropic-x/y', 'kimi'])
        self.assertIn('anthropic limits (all models)', result.stdout)
        self.assertIn('anthropic', json.loads(self.signals.read_text()))
        self.assertFalse(Path(f'{self.state}.lock').exists())

    def test_no_args_clears_everything_and_signals_all(self):
        self.state.write_text(json.dumps({'anthropic/x': MARK}))
        self.assertEqual(run(self.state).returncode, 0)
        self.assertEqual(json.loads(self.state.read_text()), {})
        self.assertIn('*', json.loads(self.signals.read_text()))

    def test_all_and_all_sessions_are_accepted_and_signal_is_written(self):
        for flag in ('--all', '--all-sessions'):
            self.signals.unlink(missing_ok=True)
            result = run(self.state, 'kimi', flag)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('kimi', json.loads(self.signals.read_text()))

    def test_bad_flag_exits_2(self):
        result = run(self.state, '--bogus')
        self.assertEqual(result.returncode, 2)
        self.assertIn('Usage', result.stderr)

    def test_a_held_lock_times_out_without_deleting_and_exits_nonzero(self):
        self.state.write_text(json.dumps({'kimi': MARK}))
        Path(f'{self.state}.lock').write_text('')
        result = run(self.state, 'kimi')
        self.assertEqual(result.returncode, 2)
        self.assertIn('nothing was cleared, retry', result.stderr)
        self.assertIn('kimi', json.loads(self.state.read_text()))
        self.assertFalse(self.signals.exists())

    def test_a_stale_lock_is_taken_over(self):
        lock = Path(f'{self.state}.lock')
        lock.write_text('')
        os.utime(lock, (1, 1))
        self.assertEqual(run(self.state, 'kimi').returncode, 0)
        self.assertFalse(lock.exists())


if __name__ == '__main__':
    unittest.main()
