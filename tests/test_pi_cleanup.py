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
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True, capture_output=True)
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
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
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

    def test_phase_cwd_keeps_worktree_including_spaces(self):
        self.phase = f'pi-phase: build fake pid=12 cwd={self.root}/directory with spaces elapsed=2s running\n'
        self.assertIn('phase cwd', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_recent_write_keeps_all_bins(self):
        os.utime(self.output, None)
        self.assertIn('60 min', self.sweep()['reason'])
        self.assertTrue(self.output.exists())

    def test_tracked_file_keeps_worktree(self):
        subprocess.run(['git', '-C', str(self.root), 'add', str(self.output)], check=True, capture_output=True)
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


if __name__ == '__main__':
    unittest.main()
