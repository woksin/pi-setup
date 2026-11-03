"""pi-holders and the shared holder rule: true holders block, shared-inode names do not, failures fail closed."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_pi_cleanup import cleanup

SCRIPT = Path(__file__).resolve().parents[1] / 'agent/bin/pi-holders'
loader = importlib.machinery.SourceFileLoader('pi_holders', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
holders = importlib.util.module_from_spec(spec)
loader.exec_module(holders)
LIB = holders.HOLDERS['snapshot'].__globals__


class HoldersCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.target = self.root / 'target'
        self.target.mkdir()
        (self.root / 'sibling').mkdir()
        self.file = self.target / 'a.dll'
        self.file.write_text('x')

    def lsof(self, everything='', cwds='', rc=0, cwd_rc=0):
        def run(args, timeout):
            if '-d' in args:
                return cwd_rc, cwds, '' if cwd_rc == 0 else 'err'
            return rc, everything, '' if rc == 0 else 'timeout'
        return patch.dict(LIB, {'run': run})

    def main(self, *argv, **canned):
        out, err = io.StringIO(), io.StringIO()
        with self.lsof(**canned), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = holders.main(list(argv) or [str(self.target)])
        return code, out.getvalue(), err.getvalue()

    @staticmethod
    def proc(pid, command, *names, parent=None):
        lines = [f'p{pid}'] + ([f'R{parent}'] if parent else []) + [f'c{command}']
        return '\n'.join(lines + [f'n{n}' for n in names]) + '\n'


class HolderSpecs(HoldersCase):
    def test_a_cwd_below_the_path_holds(self):
        cwd = self.proc(100, 'bash', self.target / 'deep')
        code, out, _ = self.main(everything=cwd, cwds=cwd)
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), f'100 bash cwd {self.target / "deep"}')

    def test_b_open_single_link_file_holds(self):
        code, out, _ = self.main(everything=self.proc(101, 'dotnet', self.file), cwds=self.proc(101, 'dotnet', self.root))
        self.assertEqual((code, out.strip()), (1, f'101 dotnet open {self.file}'))

    def test_c_open_shared_inode_file_is_ambiguous_not_holding(self):
        os.link(self.file, self.root / 'sibling/a.dll')
        everything = self.proc(102, 'dotnet', self.file)
        code, out, err = self.main(everything=everything, cwds=self.proc(102, 'dotnet', self.root))
        self.assertEqual((code, out), (0, ''))
        self.assertIn('1 shared-inode names ignored', err)
        code, out, _ = self.main('--json', '--verbose', str(self.target), everything=everything, cwds='p1\nn/\n')
        data = json.loads(out)
        self.assertEqual((code, data['status']), (0, 'clear'))
        self.assertEqual(data['paths'][0]['ambiguous'], 1)
        self.assertEqual(data['paths'][0]['ambiguous_names'][0]['name'], str(self.file))

    def test_d_name_outside_the_path_sharing_an_inode_is_not_reported(self):
        os.link(self.file, self.root / 'sibling/a.dll')
        code, out, _ = self.main(everything=self.proc(103, 'dotnet', self.root / 'sibling/a.dll'), cwds='p1\nn/\n')
        self.assertEqual((code, out), (0, ''))

    def test_e_lsof_failures_fail_closed(self):
        for canned in ({'rc': 124, 'everything': ''}, {'everything': ''}, {'everything': 'p1\n', 'cwd_rc': 124},
                       {'everything': 'p1\n', 'cwds': ''}, {'rc': 127, 'everything': ''}):
            with self.subTest(canned=canned):
                code, out, err = self.main(**canned)
                self.assertEqual(code, 3)
                self.assertIn('inspection failed', err)

    def test_partial_lsof_output_is_unknown_never_free(self):
        """lsof exits non-zero with partial output when it cannot read some processes: that is unknown, not clear."""
        clear = self.proc(1, 'launchd', '/')
        for canned in ({'rc': 1, 'everything': clear, 'cwds': clear}, {'cwd_rc': 1, 'everything': clear, 'cwds': clear},
                       {'rc': 2, 'everything': self.proc(7, 'x', self.root)}, {'cwd_rc': 1, 'everything': clear, 'cwds': clear}):
            with self.subTest(canned=canned):
                code, out, err = self.main('--json', str(self.target), **canned)
                self.assertEqual(code, 3)
                self.assertEqual(json.loads(out)['status'], 'error')
                self.assertIn('inspection failed', err)

    def test_f_own_pid_and_children_are_excluded(self):
        me = os.getpid()
        everything = (self.proc(me, 'python', self.file) + self.proc(555, 'lsof', self.file, parent=me)
                      + self.proc(556, 'tail', self.target / 'log', parent=me))
        code, out, _ = self.main(everything=everything, cwds='p1\nn/\n')
        self.assertEqual((code, out), (0, ''))

    def test_g_vanished_name_holds(self):
        gone = self.target / 'gone.dll'
        code, out, _ = self.main(everything=self.proc(104, 'dotnet', gone), cwds='p1\nn/\n')
        self.assertEqual((code, out.strip()), (1, f'104 dotnet open {gone}'))

    def test_h_json_shape(self):
        cwd = self.proc(105, 'zsh', self.target)
        code, out, _ = self.main('--json', str(self.target), everything=cwd, cwds=cwd)
        data = json.loads(out)
        self.assertEqual(code, 1)
        self.assertEqual(data['status'], 'held')
        self.assertEqual(data['paths'][0]['holders'], [{'pid': '105', 'command': 'zsh', 'kind': 'cwd', 'name': str(self.target)}])
        self.assertEqual(set(data['paths'][0]), {'path', 'resolved', 'held', 'holders', 'ambiguous'})

    def test_i_help_has_no_side_effects_and_bare_help_is_a_path(self):
        with tempfile.TemporaryDirectory() as home:
            for flag in ('-h', '--help'):
                result = subprocess.run([sys.executable, str(SCRIPT), flag], cwd=home, capture_output=True, text=True,
                                        env={**os.environ, 'PATH': '/nonexistent', 'HOME': home}, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                for marker in ('Usage:', 'Examples:', 'Exit codes:', 'See also:'):
                    self.assertIn(marker, result.stdout)
            self.assertEqual(os.listdir(home), [])
        code, _, err = self.main('help', everything='p1\nn/\n', cwds='p1\nn/\n')
        self.assertEqual(code, 0)
        self.assertIn(': help:', err.replace(str(Path.cwd()) + '/', ''))

    def test_usage_errors_exit_2(self):
        for argv in ([], ['--bogus', 'x'], ['--timeout', 'abc', 'x'], ['--timeout', '0', 'x']):
            with self.subTest(argv=argv):
                self.assertEqual(self.main(*argv or ['--json'], everything='p1\nn/\n')[0], 2)

    def test_multiple_paths_any_held_exits_1(self):
        cwd = self.proc(106, 'bash', self.target)
        code, out, _ = self.main(str(self.root / 'sibling'), str(self.target), everything=cwd, cwds=cwd)
        self.assertEqual(code, 1)


class CleanupRuleSpecs(HoldersCase):
    def test_pi_cleanup_snapshot_treats_partial_lsof_as_unavailable(self):
        clear = 'p1\nn/\n'
        for results in (((1, clear, 'permission denied'), (0, clear, '')), ((0, clear, ''), (1, clear, 'denied')),
                        ((0, '', ''), (0, clear, '')), ((124, clear, 'timeout'), (0, clear, ''))):
            with self.subTest(results=[r[0] for r in results]):
                with patch.object(cleanup, 'run', side_effect=lambda cmd, *a, **k: results[1 if '-d' in cmd else 0]):
                    with self.assertRaises(cleanup.SnapshotError):
                        cleanup.take_snapshot()

    def test_pi_cleanup_complete_lsof_is_accepted(self):
        with patch.object(cleanup, 'run', side_effect=lambda *a, **k: (0, 'p1\nn/\n', '')):
            self.assertIsNotNone(cleanup.take_snapshot())

    """pi-cleanup keeps its narrower rule; a true holder still blocks every kind of removal."""

    def snap(self, files=(), cwds=()):
        snap = cleanup.PathSet([str(p) for p in [*files, *cwds]])
        snap.cwds = cleanup.PathSet([str(p) for p in cwds])
        return snap

    def test_cwd_and_single_link_open_file_still_block_build_and_worktree_removal(self):
        for build_output in (False, True):
            with self.subTest(build_output=build_output):
                self.assertTrue(cleanup.held_inside(self.snap(cwds=[self.target]), str(self.target), build_output))
                self.assertEqual(cleanup.held_inside(self.snap([self.file]), str(self.target), build_output, True), str(self.file))

    def test_shared_inode_is_forgiven_only_for_build_output(self):
        os.link(self.file, self.root / 'sibling/a.dll')
        snap = self.snap([self.file])
        self.assertIsNone(cleanup.held_inside(snap, str(self.target), True, True))
        self.assertEqual(cleanup.held_inside(snap, str(self.target)), str(self.file))  # worktree removal: strict
        self.assertEqual(cleanup.held_inside(snap, str(self.target), True, False), str(self.file))  # not below a build dir

    def test_pi_cleanup_and_the_library_agree_on_the_names_they_share(self):
        classify, policy = cleanup.HOLDERS['classify'], cleanup.HOLDERS['Policy']
        os.link(self.file, self.root / 'sibling/a.dll')
        single = self.target / 'b.dll'
        single.write_text('y')
        for name, shared in ((self.file, True), (single, False), (self.target / 'gone', False)):
            self.assertEqual(classify(str(name), str(self.target), policy(True)) == 'shared', shared)
            self.assertEqual(classify(str(name), str(self.target), policy(False, True)) == 'shared', shared)


if __name__ == '__main__':
    unittest.main()
