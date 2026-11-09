"""pi-cleanup `handoffs` step wiring: dry run by default, --apply, --only, report lines."""
import contextlib
import io
import json
import os
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from test_pi_cleanup import cleanup, RepoFixture

SID = '01a1c17e-50b5-760e-a49b-8d4dd0fa7356'
DAY = 86400


class HandoffStepTests(RepoFixture):
    def setUp(self):
        super().setUp()
        self.dir = self.main / '.ai-work/handoffs'
        self.dir.mkdir(parents=True)
        self.status = self.tmp / 'home/.pi/agent/context-budget/status'
        self.status.mkdir(parents=True)
        self.old = [self.handoff(n, 30) for n in (1, 2)]
        self.new = [self.handoff(n, 1) for n in (3, 4, 5)]
        self.other = self.dir / 'wf1-results.txt'
        self.other.write_text('x')
        os.utime(self.other, (time.time() - 90 * DAY,) * 2)
        patches = patch.multiple(cleanup, LOG_DIR=str(self.tmp / 'logs'), LOCK_FILE=str(self.tmp / 'logs/lock'))
        patches.start()
        self.addCleanup(patches.stop)
        for target, value in (('docker_running', False), ('take_snapshot', cleanup.PathSet([]))):
            started = patch.object(cleanup, target, return_value=value)
            started.start()
            self.addCleanup(started.stop)

    def handoff(self, n, days):
        path = self.dir / f'{SID}-{n}.md'
        path.write_text('x' * 100)
        os.utime(path, (time.time() - days * DAY,) * 2)
        return path

    def run_main(self, *flags):
        argv = ['--only', 'handoffs', '--roots', str(self.repos), '--budget', '0', *flags]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = cleanup.main(argv)
        return code, out.getvalue()

    def test_dry_run_is_default_and_reports_counts_and_bytes(self):
        code, text = self.run_main('--json')
        report = json.loads(text)
        step = report['steps']['handoffs']
        self.assertEqual((code, report['steps_selected']), (0, ['handoffs']))
        self.assertEqual([(f['files'], f['bytes'], f['kept']) for f in step['folders'] if f['files']], [(2, 200, 3)])
        self.assertEqual(step['totals']['deleted'], 0)
        self.assertTrue(all(p.exists() for p in self.old + self.new))

    def test_text_summary_line(self):
        code, text = self.run_main('--handoff-keep-newest', '3')
        self.assertEqual(code, 0)
        self.assertIn('handoffs: 2 files, 200 B would be removed (3 kept)', text)
        self.assertTrue(all(p.exists() for p in self.old))

    def test_apply_removes_only_eligible_files(self):
        code, text = self.run_main('--apply', '--json')
        report = json.loads(text)
        self.assertEqual(code, 0)
        self.assertEqual(report['steps']['handoffs']['totals']['deleted'], 2)
        self.assertFalse(any(p.exists() for p in self.old))
        self.assertTrue(all(p.exists() for p in self.new))
        self.assertTrue(self.other.exists())

    def test_apply_reports_failures_with_exit_2(self):
        with patch.object(cleanup, 'delete_candidate', side_effect=PermissionError('denied')):
            code, text = self.run_main('--apply', '--json')
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(text)['steps']['handoffs']['totals']['failed'], 2)
        self.assertTrue(all(p.exists() for p in self.old))

    def test_missing_status_dir_skips_step(self):
        self.status.rmdir()
        code, text = self.run_main('--apply', '--json')
        self.assertIn('liveness unknown', json.loads(text)['steps']['handoffs']['skip'])
        self.assertTrue(all(p.exists() for p in self.old))

    def test_changed_file_is_kept_at_apply(self):
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'handoffs']))
        plan = cleanup.plan_handoffs(ctx, [cleanup.Checkout(str(self.main), 'main')])
        self.old[0].write_text('changed')
        cleanup.apply_handoffs(ctx, plan)
        self.assertTrue(self.old[0].exists())
        self.assertFalse(self.old[1].exists())

    def test_step_deadline_bounds_apply(self):
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'handoffs']))
        plan = cleanup.plan_handoffs(ctx, [cleanup.Checkout(str(self.main), 'main')])
        ctx.deadline = cleanup.StepDeadline('handoffs', 0, [])
        cleanup.apply_handoffs(ctx, plan)
        self.assertTrue(all(p.exists() for p in self.old))


class HandoffArgsTests(unittest.TestCase):
    def test_defaults_scheduled_and_validation(self):
        args = cleanup.parse_args([])
        self.assertEqual((args.handoff_age_days, args.handoff_keep_newest), (14, 3))
        self.assertIn('handoffs', args.steps)
        self.assertIn('handoffs', cleanup.parse_args(['--scheduled', '--only', 'bins']).steps)
        self.assertEqual(cleanup.parse_args(['--only', 'handoffs']).steps, ['handoffs'])
        self.assertEqual(cleanup.parse_args(['--handoff-age-days', '0']).handoff_age_days, 0)
        for flag, value in (('--handoff-age-days', '-1'), ('--handoff-age-days', 'nan'),
                            ('--handoff-keep-newest', '0'), ('--handoff-keep-newest', 'x')):
            with self.subTest(flag=flag, value=value), contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit):
                cleanup.parse_args([flag, value])


if __name__ == '__main__':
    unittest.main()
