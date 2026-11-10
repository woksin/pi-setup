"""Disk reclaim rules of pi-cleanup (pi-setup#207): merged-idle worktrees, .ai-work artifacts, temp leftovers,
~/.net extractions, unused NuGet versions. Every fixture lives in a temp dir that is removed afterwards."""
import contextlib
import io
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
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
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
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


class ReclaimFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix='pisetup-test.reclaim.')))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / 'home'
        self.home.mkdir()
        env = patch.dict(os.environ, {'HOME': str(self.home)})
        env.start()
        self.addCleanup(env.stop)

    def age(self, path, days):
        when = time.time() - days * DAY
        os.utime(path, (when, when), follow_symlinks=False)

    def ctx(self, held=()):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.snap = cleanup.PathSet(list(held))
        return ctx


class AiWorkArtifactTests(ReclaimFixture):
    def setUp(self):
        super().setUp()
        self.repo = self.tmp / 'repo'
        self.work = self.repo / '.ai-work'
        (self.work / 'keep').mkdir(parents=True)
        self.checkouts = [SimpleNamespace(exists=True, path=str(self.repo), parent=None)]

    def make(self, name, days):
        path = self.work / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('x' * 10)
        self.age(path, days)
        return path

    def plan(self, ctx=None):
        return cleanup.plan_artifacts(ctx or self.ctx(), self.checkouts)

    def test_suffix_ages_and_keep_dir_are_included(self):
        old = [self.make('a.trx', 3), self.make('keep/b.dll', 3), self.make('out/c.pdb', 3),
               self.make('d.nettrace', 3), self.make('e.etlx', 3), self.make('f.dmp', 3), self.make('.coverage', 3),
               self.make('g.nupkg', 8), self.make('h.snupkg', 8), self.make('i.jar', 8)]
        young = [self.make('young.trx', 1), self.make('young.nupkg', 3)]
        item = self.plan()
        self.assertEqual(item['action'], 'run')
        self.assertEqual(sorted(item['paths']), sorted(str(p) for p in old))
        self.assertFalse(set(map(str, young)) & set(item['paths']))

    def test_notes_logs_and_bundles_are_never_matched(self):
        for name in ('notes.md', 'build.log', 'repo.bundle', 'data.json', 'plan.txt'):
            self.make(name, 30)
        self.assertEqual(self.plan()['paths'], [])

    def test_retained_symlinked_and_open_files_are_skipped(self):
        retained = self.make('keep/r.trx', 5)
        opened = self.make('open.dll', 5)
        plain = self.make('plain.trx', 5)
        outside = self.tmp / 'outside.trx'
        outside.write_text('x')
        self.age(outside, 5)
        (self.work / 'link.trx').symlink_to(outside)
        (self.work / 'linkdir').symlink_to(self.tmp)
        with patch.object(cleanup, 'retained_reason', side_effect=lambda p, **k: 'retained' if p == str(retained) else None):
            item = self.plan(self.ctx(held=[str(opened)]))
        self.assertEqual(item['paths'], [str(plain)])

    def test_symlinked_ai_work_is_not_walked(self):
        shutil.rmtree(self.work)
        target = self.tmp / 'elsewhere'
        target.mkdir()
        (target / 'x.trx').write_text('x')
        self.age(target / 'x.trx', 5)
        self.work.symlink_to(target)
        self.assertEqual(self.plan()['paths'], [])

    def test_unknown_snapshot_removes_nothing(self):
        self.make('a.trx', 5)
        ctx = self.ctx()
        ctx.snap = None
        self.assertEqual(self.plan(ctx)['action'], 'skip')

    def test_apply_deletes_planned_files_only_and_dry_run_plan_does_not(self):
        old, notes = self.make('a.trx', 5), self.make('notes.md', 5)
        item = self.plan()
        self.assertTrue(old.exists())  # planning is read-only
        cleanup.apply_reclaim(self.ctx(), item)
        self.assertEqual((old.exists(), notes.exists()), (False, True))
        self.assertEqual(item['result']['deleted'], 1)

    def test_apply_refuses_changed_held_and_retained_files(self):
        changed, held, retained, ok = (self.make(n, 5) for n in ('c.trx', 'h.trx', 'r.trx', 'k.trx'))
        item = self.plan()
        changed.write_text('rewritten')  # mtime moves
        ctx = self.ctx(held=[str(held)])
        with patch.object(cleanup, 'retained_reason', side_effect=lambda p, **k: 'retained' if p == str(retained) else None):
            cleanup.apply_reclaim(ctx, item)
        self.assertEqual([p.exists() for p in (changed, held, retained, ok)], [True, True, True, False])
        self.assertEqual(item['result']['skipped'], 3)

    def test_apply_refuses_a_path_swapped_for_a_symlink(self):
        victim = self.tmp / 'victim.trx'
        victim.write_text('precious')
        path = self.make('a.trx', 5)
        item = self.plan()
        path.unlink()
        path.symlink_to(victim)
        cleanup.apply_reclaim(self.ctx(), item)
        self.assertTrue(victim.exists())
        self.assertEqual(item['result']['deleted'], 0)


class DotnetExtractionTests(ReclaimFixture):
    def app(self, name, versions):
        base = self.home / '.net' / name
        for version, days in versions.items():
            path = base / version
            path.mkdir(parents=True)
            (path / 'lib.so').write_text('x')
            self.age(path, days)
        return base

    def test_newest_kept_older_removed_held_kept(self):
        base = self.app('cratis', {'a': 5, 'b': 3, 'c': 1})
        item = cleanup.plan_dotnet_extractions(self.ctx(held=[str(base / 'a' / 'lib.so')]))
        self.assertEqual(item['paths'], [str(base / 'b')])
        cleanup.apply_reclaim(self.ctx(), item)
        self.assertEqual([(base / n).exists() for n in 'abc'], [True, False, True])

    def test_three_versions_two_removed(self):
        base = self.app('Cratis.Cli', {'a': 5, 'b': 3, 'c': 1})
        item = cleanup.plan_dotnet_extractions(self.ctx())
        cleanup.apply_reclaim(self.ctx(), item)
        self.assertEqual([(base / n).exists() for n in 'abc'], [False, False, True])
        self.assertEqual(item['result']['deleted'], 2)

    def test_single_version_and_plain_files_are_ignored(self):
        base = self.app('solo', {'a': 9})
        (self.home / '.net' / 'stray.txt').write_text('x')
        (self.home / '.net' / 'cratis-file').write_text('x')
        item = cleanup.plan_dotnet_extractions(self.ctx())
        self.assertEqual(item['paths'], [])
        self.assertTrue((base / 'a').exists())

    def test_symlinked_version_is_not_followed(self):
        base = self.app('cratis', {'a': 5, 'c': 1})
        target = self.tmp / 'precious'
        target.mkdir()
        os.symlink(target, base / 'b')
        item = cleanup.plan_dotnet_extractions(self.ctx())
        cleanup.apply_reclaim(self.ctx(), item)
        self.assertTrue(target.exists())

    def test_unknown_snapshot_removes_nothing(self):
        self.app('cratis', {'a': 5, 'c': 1})
        ctx = self.ctx()
        ctx.snap = None
        self.assertEqual(cleanup.plan_dotnet_extractions(ctx)['action'], 'skip')


class TempLeftoverTests(ReclaimFixture):
    def setUp(self):
        super().setUp()
        self.root = self.tmp / 'T'
        self.root.mkdir()
        for target, value in (('TMP_ROOTS', (str(self.root),)), ('TMP_CLONE_ROOTS', ())):
            patcher = patch.object(cleanup, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def entry(self, name, days, directory=True):
        path = self.root / name
        if directory:
            path.mkdir()
            (path / 'data').write_text('x')
        else:
            path.write_text('x')
        self.age(path, days)
        return path

    def rows(self, held=()):
        ctx = self.ctx(held=held)
        return {os.path.basename(r['tmp_path']): r for r in cleanup.plan_tmp(ctx)}

    def test_each_new_directory_prefix_removed_after_a_day_not_before(self):
        names = ('pisetup-test.abc', 'pisetup-xyz', 'lanes-1', 'cratis-guard-2', 'pfb-3', 'MSBuildTemp501')
        for name in names:
            self.entry(name, 2)
            self.entry(name + '-young', 0.2)
        rows = self.rows()
        self.assertTrue(all(rows[n]['action'] == 'run' for n in names))
        self.assertTrue(all(rows[n + '-young']['action'] == 'skip' for n in names))

    def test_existing_prefixes_keep_their_two_hour_age(self):
        self.entry('pisync.a', 0.2)
        self.entry('gr-stage-ui-b', 0.01)
        rows = self.rows()
        self.assertEqual(rows['pisync.a']['action'], 'run')
        self.assertEqual(rows['gr-stage-ui-b']['action'], 'skip')

    def test_file_patterns_and_unknown_names(self):
        wanted = ('pi-bash-1.log', 'tmpabc.tmp', 'login.keychain', 'login.keychain-db')
        for name in wanted:
            self.entry(name, 2, directory=False)
        self.entry('other.log', 2, directory=False)
        self.entry('unrelated', 2)
        self.entry('pi-bash-young.log', 0.1, directory=False)
        rows = self.rows()
        self.assertEqual(sorted(n for n, r in rows.items() if r['action'] == 'run'), sorted(wanted))
        self.assertNotIn('other.log', rows)
        self.assertNotIn('unrelated', rows)
        self.assertEqual(rows['pi-bash-young.log']['action'], 'skip')

    def test_held_directory_file_and_symlink_are_skipped(self):
        held = self.entry('lanes-held', 2)
        open_file = self.entry('pi-bash-open.log', 2, directory=False)
        outside = self.tmp / 'outside'
        outside.mkdir()
        (self.root / 'lanes-link').symlink_to(outside)
        rows = self.rows(held=[str(held / 'data'), str(open_file)])
        self.assertEqual({n: r['action'] for n, r in rows.items()},
                         {'lanes-held': 'skip', 'pi-bash-open.log': 'skip', 'lanes-link': 'skip'})

    def test_apply_removes_old_dir_and_file_only(self):
        directory = self.entry('pfb-old', 2)
        plain = self.entry('tmp1.tmp', 2, directory=False)
        young = self.entry('pfb-new', 0.1)
        ctx = self.ctx()
        for row in cleanup.plan_tmp(ctx):
            with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])):
                cleanup.apply_tmp(ctx, row)
        self.assertEqual([p.exists() for p in (directory, plain, young)], [False, False, True])

    def test_dry_run_plan_measures_a_bounded_number_of_directories(self):
        for index in range(cleanup.TMP_MEASURE_MAX + 5):
            self.entry(f'lanes-{index:03d}', 2)
        sizes = [r['size'] for r in cleanup.plan_tmp(self.ctx())]
        self.assertEqual(sum(size is not None for size in sizes), cleanup.TMP_MEASURE_MAX)

    def test_extra_roots_come_from_tmpdir_and_getconf(self):
        real = os.path.realpath(self.root)
        with patch.dict(os.environ, {'TMPDIR': str(self.root) + '/'}):
            self.assertIn(real, cleanup.tmp_extra_roots())
        user = self.tmp / 'var' / 'T'
        user.mkdir(parents=True)
        env = {k: v for k, v in os.environ.items() if k != 'TMPDIR'}
        with patch.dict(os.environ, env, clear=True), patch.object(
                cleanup, 'run', return_value=(0, str(user) + '/\n', '')):
            self.assertIn(os.path.realpath(user), cleanup.tmp_extra_roots())

    def test_default_roots_include_extras_and_dedupe(self):
        with patch.object(cleanup, 'TMP_ROOTS', cleanup.DEFAULT_TMP_ROOTS), patch.object(
                cleanup, 'tmp_extra_roots', return_value=[str(self.root), os.path.realpath('/tmp')]):
            roots = cleanup.tmp_roots()
        self.assertIn(str(self.root), roots)
        self.assertEqual(len(roots), len(set(roots)))


class ChromeCloneTests(ReclaimFixture):
    def setUp(self):
        super().setUp()
        self.clone = self.tmp / 'var' / 'X' / cleanup.CHROME_CLONE_NAME
        self.clone.mkdir(parents=True)
        for target, value in (('TMP_ROOTS', (str(self.tmp / 'none'),)), ('TMP_CLONE_ROOTS', (str(self.clone),))):
            patcher = patch.object(cleanup, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def child(self, name, hours):
        path = self.clone / name
        path.mkdir()
        (path / 'f').write_text('x')
        self.age(path, hours / 24)
        return path

    def rows(self, commands, held=()):
        with patch.object(cleanup, 'command_lines', return_value=commands):
            return {os.path.basename(r['tmp_path']): r for r in cleanup.plan_tmp(self.ctx(held=held))}

    def test_old_unreferenced_removed_young_and_referenced_kept(self):
        old, young, used, opened = (self.child(n, h) for n, h in (('old', 5), ('young', 1), ('used', 5), ('open', 5)))
        rows = self.rows(['/usr/bin/chrome --path=' + str(used)], held=[str(opened / 'f')])
        self.assertEqual({n: r['action'] for n, r in rows.items()},
                         {'old': 'run', 'young': 'skip', 'used': 'skip', 'open': 'skip'})
        ctx = self.ctx()
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
                patch.object(cleanup, 'command_lines', return_value=['unrelated']):
            cleanup.apply_tmp(ctx, rows['old'])
        self.assertEqual([old.exists(), young.exists(), used.exists()], [False, True, True])

    def test_unlistable_processes_fail_closed(self):
        self.child('old', 5)
        self.assertEqual(self.rows(None)['old']['action'], 'skip')

    def test_apply_rechecks_command_lines(self):
        old = self.child('old', 5)
        row = self.rows(['x'])['old']
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
                patch.object(cleanup, 'command_lines', return_value=['run ' + str(old)]):
            cleanup.apply_tmp(self.ctx(), row)
        self.assertTrue(old.exists())

    def test_derived_roots_only_beside_a_T_directory(self):
        base = self.tmp / 'folders'
        (base / 'T').mkdir(parents=True)
        (base / 'other').mkdir()
        with patch.object(cleanup, 'TMP_ROOTS', cleanup.DEFAULT_TMP_ROOTS), patch.object(
                cleanup, 'TMP_CLONE_ROOTS', None), patch.object(
                cleanup, 'tmp_extra_roots', return_value=[str(base / 'T'), str(base / 'other')]):
            self.assertEqual(cleanup.tmp_clone_roots(), [str(base / 'X' / cleanup.CHROME_CLONE_NAME)])


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
