"""Bounded, streamed dry-run planning and conservative temporary-directory cleanup."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import sys
import time
import unittest
from unittest.mock import Mock, call, patch

from test_pi_cleanup import cleanup, RepoFixture


class FlushBuffer(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flushed = []

    def flush(self):
        self.flushed.append(self.getvalue())


class DryBudgetTests(unittest.TestCase):
    def test_default_unlimited_and_invalid_budget(self):
        self.assertEqual(cleanup.parse_args([]).budget, 60)
        self.assertEqual(cleanup.parse_args(['--budget', '0']).budget, 0)
        for value in ('-1', 'nan', 'inf'):
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cleanup.parse_args(['--budget', value])

    def test_slow_probe_stops_at_deadline_without_lingering_worker(self):
        notes = []
        budget = cleanup.DryBudget(.3, notes)
        before = time.monotonic()
        def slow():
            time.sleep(2)
            return 'remove'
        self.assertEqual(budget.measure('slow', 60, slow, 'keep'), 'keep')
        self.assertLess(time.monotonic() - before, 1.5)
        self.assertEqual(notes, ['slow: not measured (budget)'])
        self.assertEqual(cleanup.multiprocessing.active_children(), [])

    def test_budget_expiry_does_not_signal_git_child(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            child = root / 'git'
            child.write_text(f'#!{sys.executable}\n' +
                             'import signal, time\nfrom pathlib import Path\n' +
                             f'root = Path({str(root)!r})\n' +
                             'signal.signal(signal.SIGTERM, lambda *args: (root / "signalled").touch())\n' +
                             '(root / "started").touch()\ntime.sleep(1.4)\n(root / "finished").touch()\n')
            child.chmod(0o700)
            budget = cleanup.DryBudget(.8, [])
            with patch.object(cleanup.os, 'killpg', side_effect=AssertionError('group signal')):
                self.assertEqual(budget.measure('git', 60, lambda: cleanup.run([str(child)], timeout=5), None), None)
            deadline = time.monotonic() + 4
            while not (root / 'finished').exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue((root / 'started').exists())
            self.assertTrue((root / 'finished').exists(), 'git child was killed before completing')
            self.assertFalse((root / 'signalled').exists())

    def test_shutdown_escalates_only_for_worker_after_grace_period(self):
        context = Mock()
        receive, send = Mock(), Mock()
        receive.poll.return_value = False
        context.Pipe.return_value = (receive, send)
        worker = context.Process.return_value
        worker.is_alive.return_value = True
        with patch.object(cleanup.multiprocessing, 'get_context', return_value=context), \
                patch.object(cleanup.os, 'killpg') as killpg:
            cleanup.DryBudget(.1, []).measure('slow', 60, lambda: None, None)
        self.assertEqual(worker.method_calls,
                         [call.start(), call.terminate(), call.join(1), call.is_alive(), call.kill(), call.join()])
        killpg.assert_not_called()

    def test_dry_git_keeps_requested_session_and_disables_optional_writes(self):
        result = cleanup.subprocess.CompletedProcess([], 0, '', '')
        with patch.object(cleanup, 'DRY_WORKER', True), \
                patch.object(cleanup.subprocess, 'run', return_value=result) as run:
            cleanup.run(['git', 'status'], detach=True)
        self.assertTrue(run.call_args.kwargs['start_new_session'])
        self.assertEqual(run.call_args.kwargs['env']['GIT_OPTIONAL_LOCKS'], '0')

    def test_snapshot_failure_keeps_original_error_and_exit_code(self):
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()) as out, \
                patch.object(cleanup, 'docker_running', return_value=False), \
                patch.object(cleanup, 'take_snapshot', side_effect=cleanup.SnapshotError('lsof failed')):
            code = cleanup.main(['--only', 'build', '--roots', root, '--json'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue())['errors'],
                         ['cannot determine which repos are in use, refusing to continue: lsof failed'])

    def test_unlimited_waits_for_measurement(self):
        budget = cleanup.DryBudget(0, [])
        self.assertEqual(budget.measure('probe', 60, lambda: 'measured', None), 'measured')

    def test_sections_flush_in_order_with_budget_fallbacks(self):
        output = FlushBuffer()
        def slow(*args):
            time.sleep(2)
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(output), \
                patch.object(cleanup, 'docker_running', return_value=False), \
                patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
                patch.object(cleanup, 'discover', return_value=[]), \
                patch.object(cleanup, 'plan_build', side_effect=slow):
            before = time.monotonic()
            self.assertEqual(cleanup.main(['--roots', root, '--budget', '.6']), 0)
            self.assertLess(time.monotonic() - before, 1.8)
        text = output.getvalue()
        headings = ['build', 'worktrees', 'docker', 'caches', 'bins', 'suggestions (not done)', 'summary']
        positions = [text.index('== ' + name + ' ==') for name in headings]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('build: not measured (budget)', text)
        for name in headings[:5]:
            self.assertTrue(any(('== ' + name + ' ==') in chunk and '== summary ==' not in chunk
                                for chunk in output.flushed))

    def test_json_is_one_document_without_streamed_headings(self):
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stdout(io.StringIO()) as out, \
                patch.object(cleanup, 'docker_running', return_value=False), \
                patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
                patch.object(cleanup, 'discover', return_value=[]):
            self.assertEqual(cleanup.main(['--only', 'bins', '--roots', root, '--budget', '.3', '--json']), 0)
        self.assertFalse(json.loads(out.getvalue())['apply'])
        self.assertNotIn('== bins ==', out.getvalue())

    def test_unmeasured_items_cannot_be_removed(self):
        checkout = cleanup.Checkout('/missing/wt', 'linked', parent='/missing/main')
        rows = cleanup.unmeasured_worktrees([checkout])
        self.assertEqual(rows[0]['action'], 'keep')
        self.assertEqual(rows[0]['blockers'], ['not measured (budget)'])

    def test_timed_out_planners_keep_each_discovered_checkout(self):
        args = cleanup.parse_args(['--only', 'build,worktrees,bins', '--json'])
        ctx = cleanup.Ctx(args)
        ctx.snap = cleanup.PathSet([])
        ctx.mounts = cleanup.PathSet([])
        checkout = cleanup.Checkout('/not-walked', 'linked', parent='/parent')
        checkout.exists = True
        rep = {'steps': {}, 'notes': []}
        budget = cleanup.DryBudget(.4, rep['notes'])
        def slow(*args):
            time.sleep(2)
        with patch.object(cleanup, 'dry_worktrees', side_effect=slow), \
                patch.object(cleanup, 'plan_build', side_effect=slow), \
                patch.object(cleanup, 'dry_bins', side_effect=slow):
            cleanup.dry_plan_steps(ctx, [checkout], budget, rep)
        self.assertEqual(rep['steps']['worktrees']['rows'][0]['action'], 'keep')
        self.assertEqual(rep['steps']['build']['rows'][0]['skip'], 'not measured (budget)')
        self.assertEqual(rep['steps']['bins']['rows'][0]['action'], 'skipped')

    def test_apply_never_uses_dry_budget(self):
        with patch.object(cleanup, 'DryBudget', side_effect=AssertionError('dry budget used')), \
                patch.object(cleanup, 'LOG_DIR', tempfile.gettempdir()), \
                tempfile.TemporaryDirectory() as root, \
                patch.object(cleanup, 'LOCK_FILE', str(Path(root) / 'lock')), \
                patch.object(cleanup, 'discover', return_value=[]), \
                patch.object(cleanup, 'du_bytes', return_value=0), \
                patch.dict(cleanup.BIN_SWEEP, sweep=lambda *args: []), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cleanup.main(['--apply', '--only', 'bins', '--roots', root, '--budget', '.001']), 0)


class RemoteRefTests(RepoFixture):
    def test_dry_run_uses_existing_refs_without_fetch(self):
        ctx = self.context()
        notes = []
        with patch.object(cleanup, 'git', wraps=cleanup.git) as git:
            rows = cleanup.plan_worktrees(ctx, self.checkouts, notes)
        self.assertFalse(any(call.args[0][0] == 'fetch' for call in git.call_args_list))
        self.assertIn('remote refs not refreshed (dry run)', notes)
        self.assertEqual(rows[0]['action'], 'remove')

    def test_apply_still_fetches(self):
        ctx = self.context('--apply')
        with patch.object(cleanup, 'git', wraps=cleanup.git) as git:
            cleanup.plan_worktrees(ctx, self.checkouts, [])
        self.assertTrue(any(call.args[0] == ['fetch', '--prune', 'origin'] for call in git.call_args_list))


class TemporaryDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        roots = patch.object(cleanup, 'TMP_ROOTS', (str(self.root), str(self.root)))
        roots.start()
        self.addCleanup(roots.stop)
        self.ctx = cleanup.Ctx(cleanup.parse_args([]))
        self.ctx.snap = cleanup.PathSet([])

    def old(self, name):
        path = self.root / name
        path.mkdir()
        (path / 'data').write_text('fixture')
        os.utime(path, (1, 1))
        return path

    def test_dry_run_lists_sizes_once_without_deleting(self):
        path = self.old('pisync.old')
        other = self.old('gr-stage-ui-old')
        rows = cleanup.plan_tmp(self.ctx)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['action'] == 'run' and row['size'] > 0 for row in rows))
        self.assertTrue(path.exists() and other.exists())

    def test_recent_symlinks_unknown_prefix_and_busy_are_not_candidates(self):
        busy = self.old('pisync.busy')
        self.ctx.snap = cleanup.PathSet([str(busy / 'data')])
        (self.root / 'pisync.recent').mkdir()
        (self.root / 'pisync.link').symlink_to(busy, target_is_directory=True)
        self.old('unknown.old')
        rows = cleanup.plan_tmp(self.ctx)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row['action'] == 'skip' for row in rows))

    def test_apply_removes_only_old_idle_directory_after_fresh_snapshot(self):
        path = self.old('pisync.old')
        row = cleanup.plan_tmp(self.ctx)[0]
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])) as snapshot:
            cleanup.apply_tmp(self.ctx, row)
        snapshot.assert_called_once_with()
        self.assertFalse(path.exists())
        self.assertEqual(row['result'], 'removed')

    def test_apply_new_open_file_blocks_removal(self):
        path = self.old('pisync.old')
        row = cleanup.plan_tmp(self.ctx)[0]
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([str(path / 'data')])):
            cleanup.apply_tmp(self.ctx, row)
        self.assertTrue(path.exists())
        self.assertEqual(row['action'], 'skip')

    def test_lifetime_lock_blocks_both_plan_and_apply(self):
        path = self.old('pisync.old')
        row = cleanup.plan_tmp(self.ctx)[0]
        with (path / '.pisync.lock').open('w') as lock:
            cleanup.fcntl.flock(lock, cleanup.fcntl.LOCK_EX | cleanup.fcntl.LOCK_NB)
            os.utime(path, (1, 1))
            self.assertEqual(cleanup.plan_tmp(self.ctx)[0]['action'], 'skip')
            # Refresh the saved directory metadata after creating the lock.
            row['identity'], _ = cleanup.tmp_state(str(path), time.time())
            with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])):
                cleanup.apply_tmp(self.ctx, row)
            self.assertEqual(row['action'], 'skip')
            self.assertTrue(path.exists())

    def test_unknown_snapshot_and_changed_identity_block_removal(self):
        path = self.old('pisync.old')
        row = cleanup.plan_tmp(self.ctx)[0]
        with patch.object(cleanup, 'take_snapshot', side_effect=cleanup.SnapshotError('lsof failed')):
            cleanup.apply_tmp(self.ctx, row)
        self.assertTrue(path.exists())
        row = cleanup.plan_tmp(self.ctx)[0]
        os.utime(path, None)
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])):
            cleanup.apply_tmp(self.ctx, row)
        self.assertEqual(row['action'], 'skip')
        self.assertTrue(path.exists())


if __name__ == '__main__':
    unittest.main()
