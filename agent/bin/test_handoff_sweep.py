"""Specs for handoff_sweep: age, per-session newest, liveness and fail-closed behaviour."""
import json
import os
from pathlib import Path
import runpy
import tempfile
import time
import unittest

SWEEP = runpy.run_path(str(Path(__file__).resolve().with_name('handoff_sweep.py')))
NOW = 2_000_000_000.0
DAY = 86400
SID = '01a1c17e-50b5-760e-a49b-8d4dd0fa7356'
OTHER = '01a1c17e-50b5-760e-a49b-8d4dd0fa0000'


class HandoffSweepSpecs(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.repo = self.root / 'repo'
        self.dir = self.repo / '.ai-work/handoffs'
        self.dir.mkdir(parents=True)
        self.status = self.root / 'status'
        self.status.mkdir()
        self.lanes = self.root / 'lanes'
        self.lanes.mkdir()
        self.alive = lambda pid: False
        self.retained = lambda path: None

    def handoff(self, session, n, days, ext='md', kind=''):
        path = self.dir / f'{session}-{n}{kind}.{ext}'
        path.write_text('x' * 10)
        os.utime(path, (NOW - days * DAY,) * 2)
        return path

    def session(self, session, days_old=30, **fields):
        path = self.status / f'{session}.json'
        path.write_text(json.dumps({'pid': 1, 'at': 'x', 'sessionId': session, **fields}))
        os.utime(path, (NOW - days_old * DAY,) * 2)
        return path

    def plan(self, age=14, keep=3, status=None, lanes=None):
        return SWEEP['plan']([str(self.repo)], NOW, age, keep, str(status or self.status),
                             str(lanes or self.lanes), self.retained, alive=self.alive)

    def rows(self, result):
        return {Path(r['path']).name: r for f in result['folders'] for r in f['rows']}

    def removed(self, result):
        return sorted(name for name, r in self.rows(result).items() if r['action'] == 'remove')

    def test_only_context_budget_files_are_candidates(self):
        for name in ('verify-run3.workflow.js', 'wf1-results.txt', 'test-case-xGVNev-1.md', f'{SID}-1.txt'):
            (self.dir / name).write_text('x')
            os.utime(self.dir / name, (NOW - 90 * DAY,) * 2)
        self.handoff(SID, 1, 90)
        self.assertEqual(list(self.rows(self.plan(keep=1))), [f'{SID}-1.md'])
        self.assertEqual(self.removed(self.plan(keep=1)), [])

    def test_age_window(self):
        for n, days in enumerate((20, 10), start=1):
            self.handoff(SID, n, days)
        self.assertEqual(self.removed(self.plan(keep=1)), [f'{SID}-1.md'])

    def test_newest_units_per_chain_by_numeric_n(self):
        for n in (1, 2, 9, 10):
            self.handoff(SID, n, 40)
        result = self.plan(keep=3)
        self.assertEqual(self.removed(result), [f'{SID}-1.md'])
        self.assertEqual(self.rows(result)[f'{SID}-10.md']['reason'], 'newest handoffs of the session')

    def test_unit_files_are_decided_together(self):
        self.handoff(SID, 1, 40)
        self.handoff(SID, 1, 40, 'json')
        self.handoff(SID, 1, 1, 'md', '.launch-prompt')
        self.handoff(SID, 2, 40)
        result = self.plan(keep=1)
        self.assertEqual(self.removed(result), [])
        self.assertEqual({r['reason'] for r in self.rows(result).values() if r['path'].endswith('-1.md')},
                         {'within retention window'})

    def test_report_counts_bytes_and_kept_reasons(self):
        self.handoff(SID, 1, 40)
        self.handoff(SID, 2, 40, 'json')
        self.handoff(SID, 3, 1)
        folder = self.plan(keep=1)['folders'][0]
        self.assertEqual((folder['files'], folder['bytes'], folder['kept']), (2, 20, 1))
        self.assertEqual(folder['kept_reasons'], {'newest handoffs of the session': 1})

    def test_live_pid_protects_whole_chain(self):
        self.handoff(SID, 1, 40)
        self.session(SID, pid=4242)
        self.alive = lambda pid: pid == 4242
        self.assertEqual(self.removed(self.plan(keep=0)), [])
        self.alive = lambda pid: False
        self.assertEqual(self.removed(self.plan(keep=0)), [f'{SID}-1.md'])

    def test_recent_status_protects_chain_even_with_dead_pid(self):
        self.handoff(SID, 1, 40)
        self.session(SID, days_old=1)
        self.assertEqual(self.removed(self.plan(keep=0)), [])

    def test_last_handoff_path_protects_unit_in_stale_session(self):
        path = self.handoff(OTHER, 1, 40)
        self.handoff(OTHER, 2, 40)
        self.session(SID, days_old=1, lastHandoffPath=str(path))
        self.assertEqual(self.removed(self.plan(keep=0)), [f'{OTHER}-2.md'])

    def test_relaunch_marker_protects_handoff_and_launch_prompt(self):
        handoff = self.handoff(OTHER, 1, 40)
        prompt = self.handoff(OTHER, 2, 40, 'md', '.launch-prompt')
        marker = self.root / 'marker.json'
        marker.write_text(json.dumps({'handoff': str(handoff), 'launchPrompt': str(prompt)}))
        self.session(SID, days_old=1, relaunchMarker=str(marker))
        self.assertEqual(self.removed(self.plan(keep=0)), [])
        marker.write_text('{')
        self.assertIn('liveness unknown', self.plan(keep=0)['skip'])

    def test_lane_status_and_keep_dir_references_protect(self):
        self.handoff(SID, 1, 40)
        self.handoff(SID, 2, 40)
        self.handoff(SID, 3, 40)
        (self.lanes / 'D1.status').write_text(f'working since x see {SID}-1.md')
        keep = self.repo / '.ai-work/keep'
        keep.mkdir()
        (keep / 'link').symlink_to(self.dir / f'{SID}-2.md')
        self.assertEqual(self.removed(self.plan(keep=0)), [f'{SID}-3.md'])

    def test_keep_dir_alone_does_not_protect(self):
        self.handoff(SID, 1, 40)
        (self.repo / '.ai-work/keep').mkdir()
        self.assertEqual(self.removed(self.plan(keep=0)), [f'{SID}-1.md'])

    def scans_of_keep(self):
        calls = []
        real_scan = SWEEP['plan'].__globals__['keep_dir_text']

        def counting(directory):
            calls.append(directory)
            return real_scan(directory)
        SWEEP['plan'].__globals__['keep_dir_text'] = counting
        self.addCleanup(SWEEP['plan'].__globals__.__setitem__, 'keep_dir_text', real_scan)
        return calls

    def test_keep_dir_is_not_scanned_without_removal_candidates(self):
        calls = self.scans_of_keep()
        (self.repo / '.ai-work/keep').mkdir()
        self.handoff(SID, 1, 1)
        self.handoff(SID, 2, 40)
        self.assertEqual(self.removed(self.plan(keep=1)), [])
        self.assertEqual(calls, [])

    def test_keep_dir_is_scanned_once_for_many_candidates(self):
        calls = self.scans_of_keep()
        (self.repo / '.ai-work/keep').mkdir()
        for n in (1, 2, 3):
            self.handoff(SID, n, 40)
        self.assertEqual(len(self.removed(self.plan(keep=0))), 3)
        self.assertEqual(len(calls), 1)

    def test_keep_dir_scan_failure_keeps_all_candidates_of_that_repo(self):
        for n in (1, 2):
            self.handoff(SID, n, 40)
        keep = self.repo / '.ai-work/keep'
        keep.mkdir()
        keep.chmod(0)
        self.addCleanup(keep.chmod, 0o755)
        result = self.plan(keep=0)
        self.assertEqual(self.removed(result), [])
        self.assertIn('keep/ scan incomplete', self.rows(result)[f'{SID}-1.md']['reason'])

    def test_corrupt_status_for_chain_keeps_it(self):
        self.handoff(SID, 1, 40)
        (self.status / f'{SID}.json').write_text('{')
        self.assertEqual(self.removed(self.plan(keep=0)), [])

    def test_pid_check_failure_keeps_chain(self):
        self.handoff(SID, 1, 40)
        self.session(SID)

        def boom(pid):
            raise RuntimeError('boom')
        self.alive = boom
        self.assertEqual(self.removed(self.plan(keep=0)), [])

    def test_missing_status_entry_follows_age_and_newest_only(self):
        self.handoff(SID, 1, 40)
        self.assertEqual(self.removed(self.plan(keep=0)), [f'{SID}-1.md'])

    def test_unknown_liveness_skips_everything(self):
        self.handoff(SID, 1, 40)
        self.assertIn('status dir unreadable', self.plan(keep=0, status=self.root / 'missing')['skip'])
        (self.lanes / 'big').write_bytes(b'x' * (2 * 1024 * 1024))
        result = self.plan(keep=0)
        self.assertIn('liveness unknown', result['skip'])
        self.assertEqual(result['folders'], [])

    def test_recent_unreadable_status_skips_step(self):
        self.handoff(SID, 1, 40)
        (self.status / f'{OTHER}.json').write_text('{')
        os.utime(self.status / f'{OTHER}.json', (NOW,) * 2)
        self.assertIn('liveness unknown', self.plan(keep=0)['skip'])

    def test_retained_reason_and_symlinks_keep(self):
        self.handoff(SID, 1, 40)
        self.retained = lambda path: 'KEEP marker: .ai-work/KEEP'
        self.assertEqual(self.rows(self.plan(keep=0))[f'{SID}-1.md']['reason'], 'KEEP marker: .ai-work/KEEP')
        self.retained = lambda path: None
        target = self.root / 'target.md'
        target.write_text('x')
        (self.dir / f'{SID}-2.md').symlink_to(target)
        self.assertEqual(self.rows(self.plan(keep=0))[f'{SID}-2.md']['reason'], 'not a regular file')

    def test_symlinked_ai_work_is_not_scanned(self):
        elsewhere = self.root / 'elsewhere'
        (elsewhere / 'handoffs').mkdir(parents=True)
        (elsewhere / 'handoffs' / f'{SID}-1.md').write_text('x')
        os.utime(elsewhere / 'handoffs' / f'{SID}-1.md', (NOW - 40 * DAY,) * 2)
        os.rename(self.repo / '.ai-work', self.root / 'moved')
        (self.repo / '.ai-work').symlink_to(elsewhere)
        self.assertEqual(self.plan(keep=0), {'folders': [], 'skip': None})

    def test_items_hook_bounds_folders(self):
        self.handoff(SID, 1, 40)
        result = SWEEP['plan']([str(self.repo)], NOW, 14, 0, str(self.status), str(self.lanes),
                               self.retained, alive=self.alive, items=lambda values: [])
        self.assertEqual(result['folders'], [])

    def test_pid_alive_defaults(self):
        alive = SWEEP['pid_alive']
        self.assertTrue(alive(os.getpid()))
        self.assertTrue(alive(None))
        self.assertTrue(alive(True))
        child = os.fork()
        if child == 0:
            os._exit(0)
        os.waitpid(child, 0)
        self.assertFalse(alive(child))


if __name__ == '__main__':
    unittest.main()
