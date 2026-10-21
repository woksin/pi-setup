"""Package-cache changes operate only on temporary trees and fake probes."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_dev_doctor import doctor, Runner

TOOLS = Path(__file__).resolve().parents[1] / 'agent/bin/package_cache.py'
cache = SimpleNamespace(**runpy.run_path(str(TOOLS)))


class PackageCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'repos'
        self.root.mkdir()
        self.source = self.base / 'packages'
        self.source.mkdir()
        (self.source / 'payload').write_text('cached package')
        self.env = patch.dict(os.environ, {'NUGET_PACKAGES': str(self.source)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_volume_stat_is_injected_and_symlinks_resolved(self):
        link = self.base / 'cache-link'
        link.symlink_to(self.source)
        with patch.dict(os.environ, {'NUGET_PACKAGES': str(link)}):
            for device, severity in ((1, 'info'), (2, 'warn')):
                paths = []
                def stat(path):
                    paths.append(path)
                    return SimpleNamespace(st_dev=1 if path == self.root else device)
                found = cache.check(Runner(), self.root, stat=stat)
                self.assertEqual(found[0][0], severity)
                self.assertIn(self.source, paths)
                self.assertNotIn(link, paths)
                self.assertIn('rewrite a bin file in place', found[0][3])
                self.assertIn('rsync -a --ignore-existing', found[0][3])
                self.assertIn('cache-link.old', found[0][3])
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, 'home', return_value=self.base):
            # expanduser uses HOME rather than Path.home.
            with patch.dict(os.environ, {'HOME': str(self.base)}):
                self.assertEqual(cache.cache_path(), self.base / '.nuget/packages')
        failed = cache.check(Runner(), self.root, stat=lambda _: (_ for _ in ()).throw(OSError()))
        self.assertIn('Skipped', failed[0][1])
        self.assertIn('Skipped', cache.check(Runner(), None)[0][1])

    def test_pnpm_and_berry_only_bounded_suggest_only(self):
        calls = []
        def runner(cmd, timeout=10):
            calls.append((cmd, timeout))
            return {'pnpm': str(self.source), 'yarn --version': '4.5.0',
                    'yarn config get cacheFolder': str(self.source)}.get(
                        ' '.join(cmd) if cmd[0] == 'yarn' else cmd[0])
        found = cache.check(runner, self.root, stat=lambda p: SimpleNamespace(st_dev=1 if p == self.root else 2))
        self.assertEqual(len(found), 3)
        self.assertTrue(all(f[0] == 'warn' for f in found))
        self.assertTrue(all(timeout == 3 for _, timeout in calls))
        self.assertTrue(all('Suggest-only' in f[3] for f in found[1:]))
        for version in ('1.22.0', None, 'garbage'):
            runner = Runner(yarn=version)
            cache.check(runner, self.root)
            self.assertNotIn(['yarn', 'config', 'get', 'cacheFolder'], runner.calls)

    def test_rsp_create_append_backup_idempotence_and_ancestor(self):
        path = self.root / 'Directory.Build.rsp'
        ok, message = cache.write_rsp(self.root, git_probe=lambda _: True)
        self.assertTrue(ok, message)
        self.assertEqual(path.read_text(), ''.join('-p:' + p + '=true\n' for p in cache.PROPERTIES))
        before = path.read_bytes()
        self.assertTrue(cache.write_rsp(self.root, git_probe=lambda _: True)[0])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(self.root.glob('*.backup-*')), [])
        original = '# existing\n-p:' + cache.PROPERTIES[0] + '=true'
        path.write_text(original)
        self.assertTrue(cache.write_rsp(self.root, git_probe=lambda _: True)[0])
        self.assertEqual(path.read_text().count(cache.PROPERTIES[0]), 1)
        backups = list(self.root.glob('*.backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)
        path.rename(self.base / path.name)
        self.assertTrue(cache.write_rsp(self.root, git_probe=lambda _: True)[0])
        self.assertFalse(path.exists())

    def test_rsp_refuses_real_git_checkout_and_unknown_probe_or_symlink(self):
        result = subprocess.run(['git', 'init', '-q', str(self.root)], capture_output=True)
        self.assertEqual(result.returncode, 0)
        nested = self.root / 'nested'
        nested.mkdir()
        for root in (self.root, nested):
            self.assertFalse(cache.write_rsp(root)[0])
            self.assertFalse((root / 'Directory.Build.rsp').exists())
        self.assertTrue(cache.outside_git(self.base))
        self.assertFalse(cache.write_rsp(None)[0])
        self.assertFalse(cache.write_rsp(self.base, git_probe=lambda _: False)[0])
        path = self.base / 'Directory.Build.rsp'
        path.symlink_to(self.source / 'payload')
        self.assertFalse(cache.write_rsp(self.base, git_probe=lambda _: True)[0])
        self.assertEqual((self.source / 'payload').read_text(), 'cached package')
        with patch.object(cache.outside_git.__globals__['subprocess'], 'run', side_effect=OSError):
            self.assertFalse(cache.outside_git(self.base))

    def mover(self, ps='launchd', phase=(), fail_copy=0):
        calls = []
        def runner(cmd, timeout=10):
            calls.append(cmd)
            if cmd[0] == 'ps':
                return ps
            if cmd[0] == 'du':
                self.assertEqual(cmd, ['du', '-sk', str(self.source)])
                self.assertEqual(timeout, 120)
                return '1\t' + str(self.source) + '\n'
            count = len([c for c in calls if c[0] == 'rsync'])
            if count == fail_copy:
                return None
            self.assertEqual(timeout, 4 * 60 * 60)
            self.assertIn('--progress', cmd)
            source, target = Path(cmd[-2]), Path(cmd[-1])
            shutil.copytree(source, target, dirs_exist_ok=True)
            return ''
        return runner, lambda _: list(phase) if phase is not None else None, calls

    def move(self, **kwargs):
        runner, phase, calls = self.mover(**kwargs)
        with patch.object(shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * cache.GIB)):
            ok, log = cache.move(self.root, runner, phase)
        return ok, log, calls

    def test_move_refuses_phase_unknown_active_and_all_build_processes(self):
        for phase in (None, ['build'], ['test'], ['integration']):
            ok, log, calls = self.move(phase=phase)
            self.assertFalse(ok, log)
            self.assertIn('pi-phase', log)
            self.assertEqual(calls, [])
        for ps in (None, '', '/usr/bin/dotnet dotnet build', 'MSBuild.exe',
                   '/sdk/VBCSCompiler.dll', '/sdk/testhost', 'DOTNET'):
            ok, log, calls = self.move(ps=ps)
            self.assertFalse(ok, log)
            self.assertFalse(any(c[0] == 'rsync' for c in calls))
        self.assertTrue(self.source.is_dir())
        self.assertFalse(self.source.is_symlink())

    def test_move_refuses_space_size_failure_and_unsafe_paths(self):
        runner, phase, calls = self.mover()
        for free in (0, 10 * cache.GIB):
            with patch.object(shutil, 'disk_usage', return_value=SimpleNamespace(free=free)):
                ok, log = cache.move(self.root, runner, phase)
                self.assertFalse(ok, log)
                self.assertIn('plus 10 GiB', log)
        with patch.dict(cache.move.__globals__, cache_size=lambda *_: (_ for _ in ()).throw(OSError('scan bound'))):
            self.assertFalse(cache.move(self.root, runner, phase)[0])
        old = self.source.with_name('packages.old')
        target = self.root / '.nuget-packages'
        for path in (old, target):
            path.mkdir()
            self.assertFalse(cache.move(self.root, runner, phase)[0])
            path.rmdir()
        self.assertFalse(cache.move(None, runner, phase)[0])
        self.assertFalse(cache.move(self.source, runner, phase)[0])
        self.source.rename(old)
        self.source.symlink_to(old)
        self.assertFalse(cache.move(self.root, runner, phase)[0])
        self.source.unlink()
        self.assertFalse(cache.move(self.root, runner, phase)[0])
        self.assertFalse(any(c[0] == 'rsync' for c in calls))

    def test_simulated_move_retains_old_and_rechecks_idle(self):
        ok, log, calls = self.move()
        self.assertTrue(ok, log)
        target = self.root / '.nuget-packages'
        old = self.source.with_name('packages.old')
        self.assertTrue(self.source.is_symlink())
        self.assertEqual(self.source.resolve(), target)
        self.assertEqual((old / 'payload').read_text(), (target / 'payload').read_text())
        self.assertEqual(len([c for c in calls if c[0] == 'ps']), 5)
        copies = [c for c in calls if c[0] == 'rsync']
        self.assertEqual(len(copies), 3)
        self.assertIn('--ignore-existing', copies[-1])
        self.assertIn('After a verified build only: rm -rf --', log)
        self.assertEqual(log.count('step:'), 7)

    def test_failed_copy_keeps_source_and_final_failure_keeps_old(self):
        for fail in (1, 2, 3):
            with self.subTest(copy=fail):
                target = self.root / '.nuget-packages'
                ok, log, _ = self.move(fail_copy=fail)
                self.assertFalse(ok, log)
                self.assertTrue((self.source / 'payload').exists())
                if fail < 3:
                    self.assertFalse(self.source.is_symlink())
                    shutil.rmtree(target)  # Only this test's newly created temporary copy.
                else:
                    self.assertTrue(self.source.with_name('packages.old').is_dir())

    def test_move_stops_when_phase_starts_before_second_pass(self):
        runner, _, calls = self.mover()
        states = iter([[], [], ['build']])
        with patch.object(shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * cache.GIB)):
            ok, log = cache.move(self.root, runner, lambda _: next(states))
        self.assertFalse(ok, log)
        self.assertEqual(len([c for c in calls if c[0] == 'rsync']), 1)
        self.assertFalse(self.source.is_symlink())
        self.assertTrue((self.source / 'payload').exists())

    def test_symlink_failure_restores_source(self):
        runner, phase, _ = self.mover()
        with patch.object(shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * cache.GIB)), \
                patch.object(Path, 'symlink_to', side_effect=OSError('link failed')):
            ok, log = cache.move(self.root, runner, phase)
        self.assertFalse(ok, log)
        self.assertFalse(self.source.is_symlink())
        self.assertTrue((self.source / 'payload').exists())
        self.assertFalse(self.source.with_name('packages.old').exists())

    def test_size_scan_uses_du_with_120_second_bound(self):
        calls = []
        def runner(cmd, timeout=10):
            calls.append((cmd, timeout))
            return '987654321\t' + str(self.source) + '\n'
        self.assertEqual(cache.cache_size(self.source, runner), 987654321 * 1024)
        self.assertEqual(calls, [(['du', '-sk', str(self.source)], 120)])
        for output in (None, '', 'garbage', '-1\t/path', '1\t/path\nwarning'):
            with self.subTest(output=output), self.assertRaises(OSError):
                cache.cache_size(self.source, lambda *args, **kw: output)

    def test_size_timeout_refuses_and_prints_manual_commands(self):
        runner, phase, calls = self.mover()
        def timeout_du(cmd, timeout=10):
            if cmd[0] == 'du':
                self.assertEqual(timeout, 120)
                return None  # The runner maps TimeoutExpired to unknown.
            return runner(cmd, timeout)
        printed = []
        ok, log = cache.move(self.root, timeout_du, phase, progress=printed.append)
        self.assertFalse(ok, log)
        self.assertIn('du -sk, 120 s', log)
        self.assertIn('Manual commands', log)
        self.assertIn('rsync -a', log)
        self.assertIn('ln -s', log)
        self.assertEqual(log, '\n'.join(printed))
        self.assertFalse(any(cmd[0] == 'rsync' for cmd in calls))
        self.assertFalse((self.root / '.nuget-packages').exists())

    def test_marked_partial_target_resumes_and_progress_precedes_each_copy(self):
        ok, log, _ = self.move(fail_copy=1)
        self.assertFalse(ok, log)
        target = self.root / '.nuget-packages'
        self.assertTrue((target / cache.MOVE_MARKER).is_file())
        (target / 'partial').write_text('earlier partial run')
        runner, phase, _ = self.mover()
        progress = []
        def verify_progress(cmd, timeout=10):
            if cmd[0] == 'rsync':
                self.assertIn('up to 4 h', progress[-1])
                self.assertIn('rsync', progress[-1])
            return runner(cmd, timeout)
        with patch.object(shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * cache.GIB)):
            ok, log = cache.move(self.root, verify_progress, phase, progress=progress.append)
        self.assertTrue(ok, log)
        self.assertEqual(log, '\n'.join(progress))
        self.assertTrue(self.source.is_symlink())
        self.assertEqual((target / 'partial').read_text(), 'earlier partial run')
        self.assertEqual((target / 'payload').read_text(), 'cached package')

    def test_wrong_or_symlinked_marker_cannot_authorize_a_target(self):
        target = self.root / '.nuget-packages'
        target.mkdir()
        marker = target / cache.MOVE_MARKER
        for contents in ('', '{}', '{', '{"version":1,"source":"/another-cache"}'):
            marker.write_text(contents)
            ok, log, calls = self.move()
            self.assertFalse(ok, log)
            self.assertIn('matching move marker', log)
            self.assertFalse(any(cmd[0] == 'rsync' for cmd in calls))
        marker.unlink()
        marker.symlink_to(self.source / 'payload')
        self.assertFalse(self.move()[0])

    def test_cli_move_has_per_step_budgets_and_live_progress(self):
        calls = []
        def runner(cmd, timeout=10):
            calls.append((cmd, timeout))
            return ''
        def fake_move(root, execute, phase_state, progress):
            # Even after the 45 s diagnostics deadline, moves use their own bounds.
            with patch.object(doctor.time, 'monotonic', return_value=10 ** 12):
                execute(['du', '-sk', str(self.source)], timeout=120)
                execute(['rsync', '-a', '--progress', 'source/', 'target/'], timeout=14400)
            progress('step: transferring')
            return True, 'action taken: moved'
        with patch.object(doctor, 'package_cache_tools', return_value={'move': fake_move}), \
                patch.object(doctor, 'CHECK_FUNCTIONS', {'package-cache-volume': lambda **_: []}), \
                patch.object(doctor, 'load_samples', return_value={}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as progress:
            self.assertEqual(doctor.main(['--move-nuget', '--repos-root', str(self.root)], runner=runner), 0)
        self.assertEqual([timeout for _, timeout in calls], [120, 14400])
        self.assertIn('step: transferring', progress.getvalue())

    def test_cli_routes_real_transfers_to_streaming_runner_and_keeps_json_clean(self):
        def fake_move(root, execute, phase_state, progress):
            self.assertEqual(execute(['rsync', '--progress'], timeout=14400), '')
            progress('step: live transfer')
            return True, 'action taken: moved'
        with patch.object(doctor, 'package_cache_tools', return_value={'move': fake_move}), \
                patch.object(doctor, 'CHECK_FUNCTIONS', {'package-cache-volume': lambda **_: []}), \
                patch.object(doctor, 'load_samples', return_value={}), \
                patch.object(doctor, 'run', return_value='') as probe, \
                patch.object(doctor, 'run_transfer', return_value='') as transfer, \
                contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as progress:
            self.assertEqual(doctor.main(['--move-nuget', '--json', '--repos-root', str(self.root)],
                                         runner=doctor.run), 0)
        transfer.assert_called_once_with(['rsync', '--progress'], timeout=14400)
        probe.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())[0]['id'], 'package-cache-volume')
        self.assertIn('step: live transfer', progress.getvalue())

    def test_real_transfer_boundary_streams_without_capturing_output(self):
        with patch.object(doctor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as execute:
            self.assertEqual(doctor.run_transfer(['rsync', '--progress'], 14400), '')
            self.assertEqual(execute.call_args.kwargs['timeout'], 14400)
            self.assertNotIn('capture_output', execute.call_args.kwargs)
            self.assertIs(execute.call_args.kwargs['stdout'], doctor.sys.stderr)
            self.assertIs(execute.call_args.kwargs['stderr'], doctor.sys.stderr)
        with patch.object(doctor.subprocess, 'run', side_effect=subprocess.TimeoutExpired('rsync', 14400)):
            self.assertIsNone(doctor.run_transfer(['rsync'], 14400))

    def test_cli_only_explicit_apply_writes_rsp_and_move_is_never_implied(self):
        tools = {'check': cache.check}
        events = []
        tools['write_rsp'] = lambda root: (events.append('rsp') is None, 'action taken: rsp')
        tools['move'] = lambda *args, **kwargs: (events.append('move') is None, 'action taken: move')
        with patch.object(doctor, 'package_cache_tools', return_value=tools), contextlib.redirect_stdout(io.StringIO()):
            for flags, expected in ((['--only', 'package-cache-volume'], []),
                                    (['--apply', '--only', 'package-cache-volume'], ['rsp']),
                                    (['--move-nuget'], ['move'])):
                events.clear()
                self.assertEqual(doctor.main(flags + ['--repos-root', str(self.root)], runner=Runner()), 0)
                self.assertEqual(events, expected)
            events.clear()
            with patch.object(doctor, 'CHECK_FUNCTIONS', {'package-cache-volume': doctor.check_package_cache_volume}), \
                    patch.object(doctor, 'CHECKS', ('package-cache-volume',)):
                self.assertEqual(doctor.main(['--apply', '--repos-root', str(self.root)], runner=Runner()), 0)
            self.assertEqual(events, [])
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                doctor.main(['--move-nuget', '--only', 'browsers'], runner=Runner())
