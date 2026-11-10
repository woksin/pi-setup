"""Disk reclaim rules of pi-cleanup (pi-setup#207): merged-idle worktrees, .ai-work artifacts, temp leftovers,
~/.net extractions, unused NuGet versions. Every fixture lives in a temp dir that is removed afterwards."""
import os
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from test_pi_cleanup import cleanup, g, RepoFixture

HOUR = 3600
DAY = 86400


class MergedIdleWorktreeTests(RepoFixture):
    def age_worktree(self, hours):
        gitdir = Path(g(self.wt, 'rev-parse', '--absolute-git-dir').strip())
        when = time.time() - hours * HOUR
        for name in ('HEAD', 'logs/HEAD'):
            os.utime(gitdir / name, (when, when))

    def default_plan(self, *flags):
        ctx = self.context(*flags, idle=False)
        return self.plan(ctx)['wt']

    def test_flag_default_and_validation(self):
        self.assertEqual(cleanup.parse_args([]).merged_idle_hours, 4)
        self.assertEqual(cleanup.parse_args(['--merged-idle-hours', '0.5']).merged_idle_hours, 0.5)
        with self.assertRaises(SystemExit):
            cleanup.parse_args(['--merged-idle-hours', '-1'])

    def test_merged_clean_worktree_idle_five_hours_is_removable(self):
        self.age_worktree(5)
        row = self.default_plan()
        self.assertEqual((row['action'], row['blockers']), ('remove', []))

    def test_merged_worktree_modified_one_hour_ago_is_active(self):
        self.age_worktree(1)
        row = self.default_plan()
        self.assertEqual(row['action'], 'keep')
        self.assertTrue(row['blockers'][0].startswith('ACTIVE: modified'), row['blockers'])

    def test_unmerged_worktree_is_kept_after_five_hours(self):
        (self.wt / 'new.txt').write_text('work\n')
        g(self.wt, 'add', 'new.txt')
        g(self.wt, 'commit', '-q', '-m', 'local only')
        self.age_worktree(5)
        row = self.default_plan()
        self.assertEqual(row['action'], 'keep')
        self.assertTrue(any(b.startswith('unmerged') for b in row['blockers']), row['blockers'])

    def test_merged_but_dirty_held_or_retained_is_kept(self):
        self.age_worktree(5)
        (self.wt / 'notes.txt').write_text('mine\n')
        self.assertTrue(any(b.startswith('dirty') for b in self.default_plan()['blockers']))
        (self.wt / 'notes.txt').unlink()
        ctx = self.context(idle=False)
        ctx.snap = cleanup.PathSet([str(self.wt / 'open.txt')])
        self.assertTrue(self.plan(ctx)['wt']['blockers'][0].startswith('ACTIVE: process'))
        with patch.object(cleanup, 'retained_reason', side_effect=lambda p, **k: 'retained' if 'wt' in p else None):
            self.assertEqual(self.default_plan()['blockers'], ['retained'])

    def test_unknown_merge_state_is_kept(self):
        self.age_worktree(5)
        g(self.main, 'remote', 'remove', 'origin')
        row = self.default_plan()
        self.assertEqual(row['action'], 'keep')
        self.assertIn('no-origin-default-branch', row['blockers'])

    def test_stricter_general_threshold_still_wins(self):
        self.age_worktree(5)
        row = self.default_plan('--idle-days', '0', '--worktree-min-idle-days', '0.5')
        self.assertEqual(row['action'], 'remove')  # min(0.5 days, 4 h) = 4 h
        self.age_worktree(1)
        self.assertEqual(self.default_plan('--merged-idle-hours', '0.5')['action'], 'remove')


if __name__ == '__main__':
    unittest.main()
