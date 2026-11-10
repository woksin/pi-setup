"""Disk reclaim rules of pi-cleanup (pi-setup#207): merged-idle worktrees, .ai-work artifacts, temp leftovers,
~/.net extractions, unused NuGet versions. Every fixture lives in a temp dir that is removed afterwards."""
import json
import os
import shutil
import tempfile
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


class NugetUnusedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix='pisetup-test.nuget.')))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.packages = self.tmp / 'packages'
        self.packages.mkdir()
        cleanup._nuget_dir_cache.clear()
        self.addCleanup(cleanup._nuget_dir_cache.clear)
        env = patch.dict(os.environ, {'NUGET_PACKAGES': str(self.packages)})
        env.start()
        self.addCleanup(env.stop)

    def version(self, name, version, age_days, source='https://api.nuget.org/v3/index.json'):
        vd = self.packages / name / version
        vd.mkdir(parents=True)
        (vd / 'lib.dll').write_text('x')
        (vd / '.nupkg.metadata').write_text(json.dumps({'source': source}))
        when = time.time() - age_days * DAY
        for path in (vd / 'lib.dll', vd / '.nupkg.metadata', vd):
            os.utime(path, (time.time(), when))  # fresh atime must not count
        return vd

    def ctx(self, *flags, held=()):
        ctx = cleanup.Ctx(cleanup.parse_args(list(flags)))
        ctx.snap = cleanup.PathSet(list(held))
        return ctx

    def candidates(self, *flags, held=()):
        return {Path(p).relative_to(self.packages).as_posix()
                for p in cleanup.plan_nuget_trim(self.ctx(*flags, held=held))[0]}

    def test_stale_removed_fresh_kept_and_newest_does_not_shield_stale(self):
        for number in ('1.0.0', '2.0.0', '3.0.0', '4.0.0'):
            self.version('pkg', number, 10)
        self.version('pkg', '5.0.0', 1)
        self.assertEqual(self.candidates(), {f'pkg/{n}.0.0' for n in (1, 2, 3, 4)})

    def test_keep_versions_flag_still_protects_when_asked(self):
        self.version('pkg', '1.0.0', 10)
        self.version('pkg', '2.0.0', 10)
        self.assertEqual(self.candidates('--nuget-keep-versions', '1'), {'pkg/1.0.0'})

    def test_local_feed_and_open_files_are_kept(self):
        self.version('pkg', '1.0.0', 10, source='/Users/me/local-feed')
        self.version('pkg', '1.0.1-local', 10, source='/Users/me/local-feed')
        held = self.version('pkg', '2.0.0', 10)
        self.version('pkg', '3.0.0', 10)
        self.assertEqual(self.candidates(held=[str(held / 'lib.dll')]), {'pkg/3.0.0'})

    def test_unknown_process_snapshot_keeps_everything(self):
        self.version('pkg', '1.0.0', 10)
        ctx = self.ctx()
        ctx.snap = None
        self.assertEqual(cleanup.plan_nuget_trim(ctx)[0], [])

    def test_low_space_shortens_the_age(self):
        self.version('pkg', '1.0.0', 2)
        self.assertEqual(self.candidates(), set())
        ctx = self.ctx()
        ctx.args.low_space = True
        found = cleanup.plan_nuget_trim(ctx)[0]
        self.assertEqual([Path(p).name for p in found], ['1.0.0'])
        self.assertEqual(cleanup.nuget_unused_days(self.ctx('--nuget-unused-days-low', '0.5').args), 7)

    def test_apply_removes_only_unheld_stale_versions_and_dry_run_does_not(self):
        stale = self.version('pkg', '1.0.0', 10)
        held = self.version('pkg', '2.0.0', 10)
        fresh = self.version('pkg', '3.0.0', 1)
        ctx = self.ctx(held=[str(held / 'lib.dll')])
        item = {'paths': [str(stale), str(held), str(fresh)]}
        cleanup.apply_nuget_paths(ctx, item)
        self.assertEqual((stale.exists(), held.exists(), fresh.exists()), (False, True, True))
        self.assertEqual(item['result']['deleted'], 1)

    def test_resolution_env_dotnet_config_and_fail_closed(self):
        self.assertEqual(cleanup.nuget_packages_dir(), os.path.realpath(self.packages))
        for bad in ('/', os.path.expanduser('~'), str(self.tmp), str(self.tmp / 'missing' / 'packages')):
            cleanup._nuget_dir_cache.clear()
            with patch.dict(os.environ, {'NUGET_PACKAGES': bad}):
                self.assertEqual(cleanup.nuget_packages_dir(), '')
        cleanup._nuget_dir_cache.clear()
        other = self.tmp / 'dotnet-packages'
        other.mkdir()
        with patch.dict(os.environ, {'NUGET_PACKAGES': ''}), patch.object(
                cleanup, 'run', return_value=(0, f'global-packages: {other}\n', '')):
            self.assertEqual(cleanup.nuget_packages_dir(), os.path.realpath(other))
        cleanup._nuget_dir_cache.clear()
        config = self.tmp / 'cfg' / 'packages'
        config.mkdir(parents=True)
        home = self.tmp / 'home'
        (home / '.nuget/NuGet').mkdir(parents=True)
        (home / '.nuget/NuGet/NuGet.Config').write_text(
            f'<configuration><config><add key="globalPackagesFolder" value="{config}"/></config></configuration>')
        with patch.dict(os.environ, {'NUGET_PACKAGES': '', 'HOME': str(home)}), patch.object(
                cleanup, 'run', return_value=(127, '', 'missing')):
            self.assertEqual(cleanup.nuget_packages_dir(), os.path.realpath(config))


if __name__ == '__main__':
    unittest.main()
