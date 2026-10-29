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
import subprocess
import time
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


class BinSweepScenarios(CleanupConfigTests):
    def setUp(self):
        super().setUp()
        self.root = self.home / 'repos/worktree'
        self.bin = self.root / 'Source/App/bin'
        self.bin.mkdir(parents=True)
        (self.bin.parent / 'App.csproj').write_text('<Project />')
        self.output = self.bin / 'package.dll'
        self.output.write_bytes(b'package copy')
        os.utime(self.output, (time.time() - 7200,) * 2)
        self.obj = self.root / 'Source/App/obj/state'
        self.obj.parent.mkdir()
        self.obj.write_text('incremental state')
        genv_home = tempfile.TemporaryDirectory(prefix='pi-cleanup-home.')
        self.addCleanup(genv_home.cleanup)
        self.genv = git_env(genv_home.name)  # hermetic: no inherited GIT_*
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True, env=self.genv)
        self.lsof = ''
        self.phase = 'pi-phase: no active phases\n'
        self.free = patch.object(cleanup.shutil, 'disk_usage')
        self.usage = self.free.start()
        self.usage.return_value.free = 30 * 1024 ** 3
        self.addCleanup(self.free.stop)

    def probe(self, cmd, timeout=10):
        if cmd[0] == 'lsof':
            return self.lsof
        if cmd[-1] == 'status':
            return self.phase
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=self.genv)
        return result.stdout if result.returncode == 0 else None

    def sweep(self, apply=True):
        return cleanup.BIN_SWEEP['sweep']([self.root], self.probe, apply)[0]

    def test_dry_run_then_apply_keeps_obj(self):
        row = self.sweep(False)
        self.assertEqual(row['action'], 'planned')
        self.assertEqual(row['bytes'], len(b'package copy'))
        self.assertTrue(self.output.exists())
        row = self.sweep()
        self.assertEqual(row['action'], 'cleared')
        self.assertEqual(row['bytes_freed'], len(b'package copy'))
        self.assertFalse(self.bin.exists())
        self.assertEqual(self.obj.read_text(), 'incremental state')

    def test_non_dotnet_bins_and_pruned_environments_are_kept(self):
        kept = []
        for name in ('.venv', 'venv', '.tox/python', 'vendor', 'target', '__pycache__', 'tools'):
            path = self.root / name / 'bin'
            path.mkdir(parents=True)
            output = path / 'keep'
            output.write_text('not .NET output')
            os.utime(output, (time.time() - 7200,) * 2)
            if name != 'tools':
                # Even a misleading project file cannot undo directory pruning.
                (path.parent / 'Keep.csproj').write_text('<Project />')
            kept.append(output)
        self.assertEqual(self.sweep()['action'], 'cleared')
        self.assertFalse(self.bin.exists())
        self.assertTrue(all(path.exists() for path in kept))

    def test_dotnet_project_extensions_and_assets_sibling_qualify(self):
        (self.bin.parent / 'App.csproj').unlink()
        for extension in ('.fsproj', '.vbproj', 'assets'):
            with self.subTest(extension=extension):
                project = (self.obj.parent / 'project.assets.json' if extension == 'assets'
                           else self.bin.parent / ('App' + extension))
                project.write_text('{}')
                self.assertEqual(self.sweep(False)['action'], 'planned')
                project.unlink()
        self.assertIn('no bin directories', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_busy_open_file_keeps_worktree(self):
        self.lsof = f'p12\ncMicrosoft.Build\nn{self.output}\n'
        self.assertIn('open files', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_any_process_with_open_bin_files_blocks_but_not_other_files(self):
        for process in ('python', 'node', 'bash'):
            self.lsof = f'p12\nc{process}\nn{self.output}\n'
            self.assertIn('open files in bin', self.sweep()['reason'])
            self.assertTrue(self.output.exists())
        self.lsof = f'p12\ncdotnet\nn{self.obj}\n'
        self.assertIn('build process', self.sweep()['reason'])
        self.lsof = f'p12\ncpython\nn{self.obj}\n'
        self.assertEqual(self.sweep(False)['action'], 'planned')

    def test_apply_rechecks_arbitrary_open_bin_files(self):
        calls = []
        def probe(cmd, timeout=10):
            if cmd[0] == 'lsof':
                calls.append(cmd)
                if len(calls) > 1:
                    return f'p12\ncpython\nn{self.output}\n'
            return self.probe(cmd, timeout)
        row = cleanup.BIN_SWEEP['sweep']([self.root], probe, True)[0]
        self.assertEqual(row['action'], 'skipped')
        self.assertIn('opened files in bin', row['reason'])
        self.assertTrue(self.output.exists())

    def test_orphan_group_is_a_running_phase_even_with_idle_line(self):
        self.phase = (f'pi-phase: unknown orphan pid=? cwd={self.root} elapsed=2s orphan-group\n'
                      'pi-phase: no active phases\n')
        self.assertIn('phase cwd', self.sweep()['reason'])
        self.assertTrue(self.output.exists())
        self.phase = 'pi-phase: unknown orphan pid=? cwd=? elapsed=2s orphan-group\n'
        self.assertIn('cwd unknown', self.sweep()['reason'])

    def test_current_suffixed_status_forms_keep_bins(self):
        for suffix in (' policy=queued source=default', ' fast policy=direct source=cli'):
            self.phase = f'pi-phase: build fake pid=12 cwd={self.root} elapsed=2s running{suffix}\n'
            self.assertIn('phase cwd', self.sweep()['reason'])
            self.assertTrue(self.output.exists())

    def test_unknown_trailing_field_is_unknown_status(self):
        self.phase = f'pi-phase: build fake pid=12 cwd={self.root} elapsed=2s running surprise=1\n'
        self.assertIn('status unknown', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_phase_cwd_keeps_worktree_including_spaces(self):
        self.phase = f'pi-phase: build fake pid=12 cwd={self.root}/directory with spaces elapsed=2s running\n'
        self.assertIn('phase cwd', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_recent_write_keeps_all_bins(self):
        os.utime(self.output, None)
        self.assertIn('60 min', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_tracked_file_keeps_worktree(self):
        subprocess.run(['git', '-C', str(self.root), 'add', str(self.output)], check=True, capture_output=True, env=self.genv)
        self.assertIn('tracked files', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_probe_failures_keep_everything(self):
        for lsof, phase in ((None, self.phase), ('', None), ('', 'unknown'), ('n/path\n', self.phase)):
            with self.subTest(lsof=lsof, phase=phase):
                self.lsof, self.phase = lsof, phase
                self.assertEqual(self.sweep()['action'], 'skipped')
                self.assertTrue(self.output.exists())

    def test_apply_rechecks_guards_after_scan(self):
        calls = []
        def probe(cmd, timeout=10):
            if cmd[-1] == 'status':
                calls.append(cmd)
                if len(calls) > 1:
                    return f'pi-phase: build new pid=1 cwd={self.root} elapsed=1s running'
            return self.probe(cmd, timeout)
        row = cleanup.BIN_SWEEP['sweep']([self.root], probe, True)[0]
        self.assertEqual(row['action'], 'skipped')
        self.assertTrue(self.output.exists())

    def test_above_threshold_and_config_override(self):
        self.usage.return_value.free = 50 * 1024 ** 3
        self.assertIn('free ≥ 50', self.sweep()['reason'])
        self.config.write_text(json.dumps({'disk': {'bin_sweep_below_gib': 60}}))
        self.assertEqual(self.sweep()['action'], 'cleared')

    def test_symlinked_bin_and_pruned_directories_untouched(self):
        for name in ('node_modules/pkg/bin', '.git/cache/bin', 'obj/nested/bin'):
            path = self.root / name
            path.mkdir(parents=True)
            (path / 'keep').write_text('keep')
        outside = self.home / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        (self.root / 'Other').mkdir()
        (self.root / 'Other/bin').symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.sweep()['action'], 'cleared')
        self.assertTrue((outside / 'keep').exists())
        for name in ('node_modules/pkg/bin', '.git/cache/bin', 'obj/nested/bin'):
            self.assertTrue((self.root / name / 'keep').exists())

    def test_cli_dispatch_and_scheduled_selection(self):
        self.assertIn('bins', cleanup.parse_args(['--scheduled']).steps)
        with patch.object(cleanup, 'discover', return_value=[cleanup.Checkout(str(self.root), 'linked', None, None)]), \
             patch.object(cleanup, 'run', side_effect=lambda cmd, **kw: (0, self.probe(cmd, **kw), '')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cleanup.main(['--only', 'bins', '--roots', str(self.home / 'repos'), '--json']), 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report['steps']['bins']['rows'][0]['action'], 'planned')
        self.assertTrue(self.output.exists())

    def test_doctor_sample_estimate_is_suggest_only(self):
        from test_dev_doctor import doctor
        found = doctor.check_disk(self.probe, root=self.home / 'repos')
        estimate = found[-1]
        self.assertIn('Sampled reclaimable bins:', estimate['evidence'])
        self.assertEqual(estimate['suggest'], '~/.pi/agent/bin/pi-cleanup --only bins --apply')
        self.assertFalse(estimate['auto'])
        self.assertTrue(self.output.exists())


def git_env(home):
    """Hermetic git environment: no inherited GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...), temp HOME/config."""
    home = Path(home)
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    empty = home / 'empty-gitconfig'
    empty.touch()
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'xdg'), GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL=str(empty),
               GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.invalid',
               GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@example.invalid')
    return env


def g(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, env=git_env(os.environ['HOME']), check=True,
                          capture_output=True, text=True).stdout


class RepoFixture(unittest.TestCase):
    """Real git: bare origin, a main clone on `main`, and linked worktree `wt` on branch `feature`."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.tmp = Path(self.temp.name).resolve()
        env = patch.dict(os.environ, HOME=str(self.tmp / 'home'))
        env.start()
        self.addCleanup(env.stop)
        (self.tmp / 'home').mkdir()
        tool_env = dict(git_env(self.tmp / 'home'), GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0',
                        GH_PROMPT_DISABLED='1', GH_NO_UPDATE_NOTIFIER='1', LC_ALL='C')
        for key in ('GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'):
            tool_env.pop(key)
        env = patch.dict(cleanup.ENV, tool_env, clear=True)  # the tool's git/gh env, sanitised
        env.start()
        self.addCleanup(env.stop)
        self.repos = self.tmp / 'repos'
        self.main = self.repos / 'main'
        self.wt = self.repos / 'wt'
        self.main.mkdir(parents=True)
        g(self.tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
        g(self.main, 'init', '-q', '-b', 'main')
        (self.main / '.gitignore').write_text('bin/\nobj/\nnode_modules/\n.ai-work/\n.env\nnotes.local\n')
        (self.main / 'README.md').write_text('hello\n')
        g(self.main, 'add', '.')
        g(self.main, 'commit', '-q', '-m', 'init')
        g(self.main, 'remote', 'add', 'origin', str(self.tmp / 'origin.git'))
        g(self.main, 'push', '-q', '-u', 'origin', 'main')
        g(self.main, 'worktree', 'add', '-q', '-b', 'feature', str(self.wt))
        self.gh_calls = []
        for name, side in (('take_snapshot', lambda: cleanup.PathSet([])),):
            p = patch.object(cleanup, name, side_effect=side)
            p.start()
            self.addCleanup(p.stop)
        real_run = cleanup.run

        def fake_run(args, **kw):
            if args[0] == 'gh':
                self.gh_calls.append(args)
                return 1, '', 'gh disabled in tests'
            return real_run(args, **kw)
        p = patch.object(cleanup, 'run', side_effect=fake_run)
        p.start()
        self.addCleanup(p.stop)

    def context(self, *flags, idle=True):
        argv = ['--only', 'worktrees,build', '--roots', str(self.repos), *flags]
        if idle:
            argv += ['--idle-days', '0', '--worktree-min-idle-days', '0']
        ctx = cleanup.Ctx(cleanup.parse_args(argv))
        notes = []
        checkouts = cleanup.discover([str(self.repos)], notes)
        ctx.roots = cleanup.PathSet([c.path for c in checkouts])
        self.checkouts = checkouts
        self.by_path = {c.path: c for c in checkouts}
        return ctx

    def plan(self, ctx=None):
        ctx = ctx or self.context()
        rows = cleanup.plan_worktrees(ctx, self.checkouts, [])
        self.ctx = ctx
        return {r['name']: r for r in rows}

    def reset_wt(self):
        g(self.wt, 'reset', '-q', '--hard')
        g(self.wt, 'clean', '-qfd')


class WorktreeRemovalSafetyTests(RepoFixture):
    def test_clean_worktree_on_default_is_removable(self):
        row = self.plan()['wt']
        self.assertEqual((row['action'], row['blockers']), ('remove', []))
        self.assertTrue(row['basis'].startswith('on-default'))

    def test_dry_run_is_default_and_apply_removes_only_the_worktree(self):
        self.assertFalse(cleanup.parse_args([]).apply)
        self.assertTrue(cleanup.parse_args(['--scheduled']).apply)
        argv = ['--only', 'worktrees', '--roots', str(self.repos), '--json', '--idle-days', '0',
                '--worktree-min-idle-days', '0']
        logs = patch.multiple(cleanup, LOG_DIR=str(self.tmp / 'logs'), LOCK_FILE=str(self.tmp / 'logs/lock'))
        with logs, patch.object(cleanup, 'docker_running', return_value=False):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cleanup.main(argv), 0)
            summary = json.loads(out.getvalue())['steps']['worktrees']['summary']
            self.assertEqual((summary['removable'], summary['removed']), (1, 0))
            self.assertTrue(self.wt.is_dir())
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(cleanup.main(argv + ['--apply']), 0)
        self.assertEqual(json.loads(out.getvalue())['steps']['worktrees']['summary']['removed'], 1)
        self.assertFalse(self.wt.exists())
        self.assertTrue((self.main / 'README.md').is_file())
        self.assertIn('feature', g(self.main, 'branch', '--list', 'feature'))
        self.assertNotIn(str(self.wt), g(self.main, 'worktree', 'list'))

    def test_dirty_worktrees_are_kept(self):
        cases = {
            'modified tracked': lambda: (self.wt / 'README.md').write_text('changed\n'),
            'untracked notes': lambda: (self.wt / 'notes.txt').write_text('my notes\n'),
            'staged new file': lambda: (g(self.wt, 'add', '-N', '.') if (self.wt / 'x').write_text('x') else None),
        }
        for name, make in cases.items():
            with self.subTest(name):
                self.reset_wt()
                make()
                row = self.plan()['wt']
                self.assertEqual(row['action'], 'keep')
                self.assertTrue(any(b.startswith('dirty') for b in row['blockers']), row['blockers'])

    def test_unmerged_or_unpushed_commits_are_kept(self):
        (self.wt / 'new.txt').write_text('work\n')
        g(self.wt, 'add', 'new.txt')
        g(self.wt, 'commit', '-q', '-m', 'local only')
        row = self.plan()['wt']
        self.assertEqual(row['action'], 'keep')
        self.assertTrue(any(b.startswith('unmerged(1 ahead') for b in row['blockers']), row['blockers'])
        g(self.wt, 'push', '-q', 'origin', 'feature')  # pushed is still not merged
        row = self.plan()['wt']
        self.assertEqual(row['action'], 'keep')
        self.assertTrue(any(b.startswith('unmerged') for b in row['blockers']), row['blockers'])
        self.assertTrue(self.gh_calls)  # only a merged PR (here: gh unavailable) could override

    def test_precious_ignored_files_are_kept(self):
        for rel, kind in (('.env', 'sensitive'), ('.ai-work/secrets.txt', 'sensitive'),
                          ('.ai-work/api.key', 'sensitive'), ('notes.local', 'unknown')):
            with self.subTest(rel=rel):
                self.reset_wt()
                g(self.wt, 'clean', '-qfdX')
                (self.wt / rel).parent.mkdir(exist_ok=True)
                (self.wt / rel).write_text('precious\n')
                row = self.plan()['wt']
                self.assertEqual(row['action'], 'keep')
                self.assertTrue(any(b.startswith(kind + '-ignored') for b in row['blockers']), row['blockers'])

    def test_build_output_and_plain_ai_work_do_not_block_removal(self):
        for rel in ('bin/a.dll', 'obj/b', 'node_modules/pkg/index.js', '.ai-work/plan.md'):
            (self.wt / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.wt / rel).write_text('x')
        row = self.plan()['wt']
        self.assertEqual((row['action'], row['blockers']), ('remove', []))
        self.assertTrue(row['ai_work'])

    def test_locked_busy_and_recently_active_worktrees_are_kept(self):
        g(self.main, 'worktree', 'lock', str(self.wt))
        self.assertIn('locked', self.plan()['wt']['blockers'])
        g(self.main, 'worktree', 'unlock', str(self.wt))
        ctx = self.context()
        ctx.snap = cleanup.PathSet([str(self.wt / 'src/open.txt')])
        row = self.plan(ctx)['wt']
        self.assertEqual(row['action'], 'keep')
        self.assertTrue(row['blockers'][0].startswith('ACTIVE: process'))
        row = self.plan(self.context(idle=False))['wt']  # default 3 day idle threshold
        self.assertEqual(row['action'], 'keep')
        self.assertTrue(row['blockers'][0].startswith('ACTIVE: modified'), row['blockers'])

    def apply(self, rows):
        by = self.by_path
        return cleanup.apply_worktrees(self.ctx, list(rows.values()), by)

    def test_apply_never_forces_removal(self):
        rows = self.plan()
        calls = []
        real = cleanup.git
        def spy(args, cwd, **kw):
            calls.append(list(args))
            return real(args, cwd, **kw)
        with patch.object(cleanup, 'git', side_effect=spy):
            self.assertIsNone(self.apply(rows))
        removals = [c for c in calls if c[:2] == ['worktree', 'remove']]
        self.assertEqual(removals, [['worktree', 'remove', str(self.wt)]])
        self.assertFalse(any(a in ('--force', '-f') for c in calls for a in c), calls)
        self.assertFalse(self.wt.exists())

    def test_failed_removal_stops_processing_and_leaves_worktrees(self):
        g(self.main, 'worktree', 'add', '-q', '-b', 'second', str(self.repos / 'wt2'))
        rows = self.plan()
        self.assertEqual({r['action'] for r in rows.values()}, {'remove'})
        real = cleanup.git
        def failing(args, cwd, **kw):
            if args[:2] == ['worktree', 'remove']:
                return 1, '', 'contains modified files'
            return real(args, cwd, **kw)
        with patch.object(cleanup, 'git', side_effect=failing):
            failed = self.apply(rows)
        self.assertEqual(failed['action'], 'failed')
        self.assertEqual(sorted(r['action'] for r in rows.values()), ['failed', 'keep'])
        self.assertTrue(self.wt.is_dir() and (self.repos / 'wt2').is_dir())

    def test_recheck_before_removal_catches_late_changes(self):
        rows = self.plan()
        (self.wt / 'late.txt').write_text('typed after planning\n')
        self.assertIsNone(self.apply(rows))
        self.assertEqual(rows['wt']['action'], 'keep')
        self.assertTrue(any('re-check' in b for b in rows['wt']['blockers']), rows['wt']['blockers'])
        self.assertTrue((self.wt / 'late.txt').is_file())
        self.reset_wt()
        rows = self.plan()
        (self.wt / 'c.txt').write_text('c')
        g(self.wt, 'add', 'c.txt')
        g(self.wt, 'commit', '-q', '-m', 'late commit')
        os.utime(self.main / '.git/worktrees/wt/HEAD', (time.time() + 5,) * 2)
        self.assertIsNone(self.apply(rows))
        self.assertEqual(rows['wt']['action'], 'keep')
        self.assertTrue(self.wt.is_dir())

    def test_ai_work_is_archived_before_removal(self):
        (self.wt / '.ai-work').mkdir()
        (self.wt / '.ai-work/plan.md').write_text('keep me\n')
        (self.wt / '.ai-work/bin').mkdir()
        (self.wt / '.ai-work/bin/skip.dll').write_text('junk')
        rows = self.plan()
        self.assertIsNone(self.apply(rows))
        self.assertEqual(rows['wt']['action'], 'removed')
        archive = self.main / '.ai-work/keep/removed-worktrees/wt'
        self.assertEqual((archive / 'plan.md').read_text(), 'keep me\n')
        self.assertFalse((archive / 'bin').exists())
        self.assertFalse(self.wt.exists())

    def test_unarchivable_ai_work_keeps_the_worktree(self):
        (self.wt / '.ai-work').mkdir()
        (self.wt / '.ai-work/plan.md').write_text('keep me\n')
        rows = self.plan()
        (self.main / '.gitignore').write_text('bin/\n')  # parent no longer ignores .ai-work
        self.assertIsNone(self.apply(rows))
        self.assertEqual(rows['wt']['action'], 'failed')
        self.assertIn('archive aborted', rows['wt']['result'])
        self.assertEqual((self.wt / '.ai-work/plan.md').read_text(), 'keep me\n')


class InheritedGitEnvironmentTests(WorktreeRemovalSafetyTests):
    """Run the removal scenarios with GIT_DIR & co pointing at a decoy repo; the decoy must stay untouched."""

    def setUp(self):
        self.decoy_temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.decoy_temp.cleanup)
        self.decoy = Path(self.decoy_temp.name).resolve()
        clean = git_env(self.decoy)
        for args in (('init', '-q', '-b', 'main'),):
            subprocess.run(['git', *args], cwd=self.decoy, env=clean, check=True, capture_output=True)
        (self.decoy / 'tracked.txt').write_text('original\n')
        subprocess.run(['git', 'add', '.'], cwd=self.decoy, env=clean, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-q', '-m', 'decoy'], cwd=self.decoy, env=clean, check=True, capture_output=True)
        (self.decoy / 'tracked.txt').write_text('uncommitted edit\n')
        (self.decoy / 'untracked.txt').write_text('precious\n')
        self.before = self.decoy_state()
        env = patch.dict(os.environ, GIT_DIR=str(self.decoy / '.git'), GIT_WORK_TREE=str(self.decoy),
                         GIT_INDEX_FILE=str(self.decoy / '.git/index'))
        env.start()
        self.addCleanup(env.stop)
        super().setUp()

    def decoy_state(self):
        clean = git_env(self.decoy)
        status = subprocess.run(['git', 'status', '--porcelain'], cwd=self.decoy, env=clean, capture_output=True,
                                text=True).stdout
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.decoy, env=clean, capture_output=True,
                              text=True).stdout
        return (status, head, (self.decoy / 'tracked.txt').read_text(), (self.decoy / 'untracked.txt').read_text())

    def tearDown(self):
        self.assertEqual(self.decoy_state(), self.before)

    def test_decoy_repo_is_untouched_by_fixtures_reset_and_apply(self):
        self.reset_wt()  # reset --hard + clean in the fixture
        rows = self.plan()
        self.assertIsNone(self.apply(rows))
        self.assertFalse(self.wt.exists())
        self.assertEqual(self.decoy_state(), self.before)


class BuildPurgeSafetyTests(RepoFixture):
    def setUp(self):
        super().setUp()
        for rel in ('bin/a.dll', 'obj/b', 'node_modules/pkg/index.js'):
            (self.wt / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.wt / rel).write_text('x')

    def plan_build(self, ctx=None):
        ctx = ctx or self.context()
        self.ctx = ctx
        return {os.path.basename(r['path']): r for r in cleanup.plan_build(ctx, self.checkouts, set())}

    def test_plan_is_a_dry_run_and_apply_deletes_only_ignored_build_dirs(self):
        row = self.plan_build()['wt']
        self.assertEqual(sorted(d['name'] for d in row['dirs'] if d['action'] == 'delete'),
                         ['bin', 'node_modules', 'obj'])
        self.assertTrue((self.wt / 'bin/a.dll').exists())
        cleanup.apply_build(self.ctx, [row], self.by_path)
        for rel in ('bin', 'obj', 'node_modules'):
            self.assertFalse((self.wt / rel).exists(), rel)
        self.assertTrue(self.wt.is_dir() and (self.wt / 'README.md').is_file())

    def test_tracked_content_open_files_and_active_roots_are_kept(self):
        g(self.wt, 'add', '-f', 'bin/a.dll')
        row = self.plan_build()['wt']
        self.assertNotIn('bin', [d['name'] for d in row['dirs'] if d['action'] == 'delete'])
        ctx = self.context()
        ctx.snap = cleanup.PathSet([str(self.wt / 'node_modules/pkg/index.js')])
        row = self.plan_build(ctx)['wt']
        self.assertTrue(row['skip'].startswith('ACTIVE') and not row['dirs'])  # an open file makes the root ACTIVE
        cleanup.apply_build(ctx, [row], self.by_path)
        for rel in ('bin/a.dll', 'node_modules/pkg/index.js', 'obj/b'):
            self.assertTrue((self.wt / rel).exists(), rel)
        ctx = self.context()
        ctx.snap = cleanup.PathSet([str(self.wt)])  # a process cwd inside the root: whole root is ACTIVE
        row = self.plan_build(ctx)['wt']
        self.assertTrue(row['skip'].startswith('ACTIVE') and not row['dirs'])

    def snapshot(self, files, cwds=()):
        snap = cleanup.PathSet(list(files) + list(cwds))
        snap.cwds = cleanup.PathSet(list(cwds))
        return snap

    def test_hard_linked_open_file_in_build_output_is_not_a_hold(self):
        linked = self.wt / 'bin/linked.dll'
        os.link(self.wt / 'bin/a.dll', linked)  # st_nlink 2: lsof may name either link
        ctx = self.context()
        ctx.snap = self.snapshot([str(linked)])
        row = self.plan_build(ctx)['wt']
        self.assertIsNone(row['skip'])
        self.assertIn('bin', [d['name'] for d in row['dirs'] if d['action'] == 'delete'])
        with patch.object(cleanup, 'take_snapshot', return_value=self.snapshot([str(linked)])):
            cleanup.apply_build(ctx, [row], self.by_path)
        self.assertFalse((self.wt / 'bin').exists())

    def test_single_link_cwd_and_non_regular_reports_still_hold_build_output(self):
        (self.wt / 'obj/dir').mkdir()
        for snap in (self.snapshot([str(self.wt / 'bin/a.dll')]),            # st_nlink 1
                     self.snapshot([], [str(self.wt / 'bin')]),             # cwd
                     self.snapshot([str(self.wt / 'obj/dir')]),             # not a regular file
                     self.snapshot([str(self.wt / 'bin/gone.dll')])):       # cannot stat: fail closed
            ctx = self.context()
            ctx.snap = snap
            self.assertTrue(self.plan_build(ctx)['wt']['skip'].startswith('ACTIVE'))
        os.link(self.wt / 'bin/a.dll', self.wt / 'bin/l.dll')
        # nlink > 1 outside a build dir is not forgiven
        os.link(self.wt / 'README.md', self.wt / 'README.link')
        ctx = self.context()
        ctx.snap = self.snapshot([str(self.wt / 'README.link')])
        self.assertTrue(self.plan_build(ctx)['wt']['skip'].startswith('ACTIVE'))

    def test_recently_modified_root_is_skipped_with_default_idle(self):
        row = self.plan_build(self.context(idle=False))['wt']
        self.assertTrue(row['skip'].startswith('ACTIVE: modified'), row['skip'])
        self.assertTrue((self.wt / 'bin/a.dll').exists())


if __name__ == '__main__':
    unittest.main()
