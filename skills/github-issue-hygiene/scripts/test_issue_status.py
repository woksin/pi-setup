"""Tests for issue-status.py with a mocked gh_json. Run: python3 -m unittest test_issue_status (from this directory)."""
import contextlib
import importlib.util
import io
import sys
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location('issue_status', Path(__file__).with_name('issue-status.py'))
issue_status = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(issue_status)
S, E = issue_status.START, issue_status.END
AGENT = Path(__file__).resolve().parents[3] / 'agent'


def refusing(lines):
    """A scan_status stand-in with the real refusal behaviour: forwarded lines on stderr, exit 4."""
    def scan(block):
        print('\n'.join(lines), file=sys.stderr)
        sys.exit(issue_status.SCAN_REFUSED_EXIT)
    return scan


class FakeGitHub:
    """Serves a sequence of bodies for successive reads; records PATCH writes."""

    def __init__(self, bodies):
        self.bodies = list(bodies)
        self.reads = 0
        self.writes = []

    def __call__(self, args, payload=None):
        if args[0] == '-X':
            self.writes.append(payload['body'])
            self.bodies = [payload['body']]
            return {}
        body = self.bodies[min(self.reads, len(self.bodies) - 1)]
        self.reads += 1
        return {'body': body, 'updated_at': f't{self.bodies.index(body)}', 'state': 'open'}


class IssueStatusTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.original = issue_status.gh_json
        self.addCleanup(setattr, issue_status, 'gh_json', self.original)
        self.real_scan = issue_status.scan_status
        self.addCleanup(setattr, issue_status, 'scan_status', self.real_scan)
        self.scanned = []
        issue_status.scan_status = self.scanned.append  # clean scanner that records its argument

    def file(self, name, text):
        path = os.path.join(self.dir.name, name)
        Path(path).write_bytes(text.encode('utf-8'))  # byte-exact: CRLF is kept
        return path

    def run_update(self, fake, status, expect=None, absent=False):
        issue_status.gh_json = fake
        argv = ['update', '--repo', 'o/r', '--issue', '1', '--file', self.file('s.md', status)]
        if absent:
            argv.append('--expect-absent')
        if expect is not None:
            argv += ['--expect-file', self.file('e.md', expect)]
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                issue_status.main(argv)
            except SystemExit as exit_:
                code = exit_.code if isinstance(exit_.code, int) else 1
        return code, out.getvalue(), err.getvalue()

    def test_append_keeps_body_verbatim(self):
        self.assertEqual(issue_status.compose('Body  \n', 'X'), f'Body  \n\n{S}\nX\n{E}\n')
        self.assertEqual(issue_status.compose('Body', 'X'), f'Body\n\n{S}\nX\n{E}\n')
        self.assertEqual(issue_status.compose('Body\n\n', 'X'), f'Body\n\n{S}\nX\n{E}\n')
        self.assertEqual(issue_status.compose('', 'X'), f'{S}\nX\n{E}\n')

    def test_replace_preserves_surroundings(self):
        self.assertEqual(issue_status.compose(f'A\n{S}\nold\n{E}\nZ', 'new'), f'A\n{S}\nnew\n{E}\nZ')

    def test_malformed_markers_refuse_without_writing(self):
        for body in (f'{S}\na\n{E}\n{S}\nb\n{E}', f'{E}\n{S}', f'{S} only', f'{E} only', f'{S}\n{E}\n{E}'):
            fake = FakeGitHub([body])
            code, _, _ = self.run_update(fake, 'new')
            self.assertNotEqual(code, 0, body)
            self.assertEqual(fake.writes, [], body)

    def test_expect_matches_and_writes(self):
        fake = FakeGitHub([f'Body\n{S}\nold\n{E}\n'])
        code, out, _ = self.run_update(fake, 'new', expect='\nold\n')
        self.assertEqual(code, 0)
        self.assertEqual(fake.writes, [f'Body\n{S}\nnew\n{E}\n'])
        self.assertIn('Updated', out)

    def test_expect_absent_block(self):
        fake = FakeGitHub(['Body'])
        self.assertEqual(self.run_update(fake, 'new', absent=True)[0], 0)
        fake = FakeGitHub([f'Body\n{S}\nsomeone\n{E}'])
        self.assertEqual(self.run_update(fake, 'new', absent=True)[0], issue_status.MISMATCH_EXIT)
        self.assertEqual(fake.writes, [])

    def test_absent_is_not_empty(self):
        # An empty block is a block: --expect-absent refuses it, an empty --expect-file matches it.
        fake = FakeGitHub([f'Body\n{S}{E}'])
        self.assertEqual(self.run_update(fake, 'new', absent=True)[0], issue_status.MISMATCH_EXIT)
        fake = FakeGitHub([f'Body\n{S}{E}'])
        self.assertEqual(self.run_update(fake, 'new', expect='')[0], 0)
        fake = FakeGitHub(['Body'])
        self.assertEqual(self.run_update(fake, 'new', expect='')[0], issue_status.MISMATCH_EXIT)
        self.assertEqual(fake.writes, [])

    def test_crlf_is_compared_losslessly(self):
        body = f'Body\r\n{S}\r\n**State:** Paused\r\n{E}\r\n'
        fake = FakeGitHub([body])
        self.assertEqual(self.run_update(fake, 'new\r\nline', expect='\r\n**State:** Paused\r\n')[0], 0)
        self.assertEqual(fake.writes, [f'Body\r\n{S}\nnew\r\nline\n{E}\r\n'])
        fake = FakeGitHub([body])
        self.assertEqual(self.run_update(fake, 'new', expect='\n**State:** Paused\n')[0], issue_status.MISMATCH_EXIT)
        self.assertEqual(fake.writes, [])

    def test_expect_mismatch_on_first_read(self):
        fake = FakeGitHub([f'Body\n{S}\nchanged by human\n{E}'])
        code, _, err = self.run_update(fake, 'new', expect='\nold\n')
        self.assertEqual(code, issue_status.MISMATCH_EXIT)
        self.assertIn('status-mismatch', err)
        self.assertEqual(fake.writes, [])

    def test_expect_mismatch_on_recompose(self):
        # First read matches; the re-read before writing shows a concurrent block edit.
        fake = FakeGitHub([f'Body\n{S}\nold\n{E}', f'Body\n{S}\nold\n**Remaining:** new item\n{E}'])
        code, _, _ = self.run_update(fake, 'new', expect='\nold\n')
        self.assertEqual(code, issue_status.MISMATCH_EXIT)
        self.assertEqual(fake.writes, [])

    def test_recompose_without_expect_still_works(self):
        fake = FakeGitHub([f'Body\n{S}\nold\n{E}', f'Body edited\n{S}\nold\n{E}'])
        self.assertEqual(self.run_update(fake, 'new')[0], 0)
        self.assertEqual(fake.writes, [f'Body edited\n{S}\nnew\n{E}'])

    def test_scans_exactly_the_inserted_block_once_even_when_recomposing(self):
        fake = FakeGitHub([f'Body\n{S}\nold\n{E}', f'Body edited\n{S}\nold\n{E}'])
        self.assertEqual(self.run_update(fake, '  new\r\nline  \n')[0], 0)
        self.assertEqual(self.scanned, [f'{S}\nnew\r\nline\n{E}'])
        self.assertIn(self.scanned[0], fake.writes[0])

    def test_refusal_exits_4_before_any_write_with_only_forwarded_lines(self):
        issue_status.scan_status = refusing(['publish: scan-refused', 'status: line 2 home-path', 'findings: 1'])
        fake = FakeGitHub(['Body'])
        code, out, err = self.run_update(fake, 'new')
        self.assertEqual(code, issue_status.SCAN_REFUSED_EXIT)
        self.assertEqual(fake.writes, []); self.assertEqual(out, '')
        self.assertEqual(err.splitlines(), ['publish: scan-refused', 'status: line 2 home-path', 'findings: 1'])

    def test_dry_run_scans_too_and_prints_nothing_when_refused(self):
        issue_status.scan_status = refusing(['publish: scan-refused'])
        issue_status.gh_json = FakeGitHub(['Body'])
        argv = ['update', '--repo', 'o/r', '--issue', '1', '--file', self.file('s.md', 'new'), '--dry-run']
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            issue_status.main(argv)
        self.assertEqual(raised.exception.code, issue_status.SCAN_REFUSED_EXIT); self.assertEqual(out.getvalue(), '')

    def test_missing_scanner_fails_closed_without_writing(self):
        fake = FakeGitHub(['Body'])
        issue_status.scan_status = self.real_scan
        cases = [(FileNotFoundError('SECRET-PATH'), 'binary-missing'),
                 (PermissionError('SECRET-PATH'), 'binary-not-executable'),
                 (subprocess.TimeoutExpired('SECRET-COMMAND', 60), 'timeout'),
                 (OSError('SECRET-ERROR'), 'spawn-failed'),
                 (subprocess.SubprocessError('SECRET-ERROR'), 'spawn-failed')]
        for failure, step in cases:
            with self.subTest(step=step):
                issue_status.gh_json = fake
                argv = ['update', '--repo', 'o/r', '--issue', '1', '--file', self.file('s.md', 'new')]
                err = io.StringIO()
                with mock.patch.object(subprocess, 'run', side_effect=failure), contextlib.redirect_stderr(err), \
                        self.assertRaises(SystemExit) as raised:
                    issue_status.main(argv)
                self.assertEqual(raised.exception.code, f'publication scanner unavailable ({step}); status not written')
                self.assertEqual(fake.writes, [])
                self.assertNotIn('SECRET', err.getvalue() + str(raised.exception.code))

    def test_dead_cwd_uses_private_snapshot_directory_and_still_scans_before_writing(self):
        issue_status.scan_status = self.real_scan
        for rc in (0, 4):
            with self.subTest(rc=rc):
                fake = FakeGitHub(['Body'])
                def run(argv, **kwargs):
                    directory = os.path.dirname(argv[-1])
                    self.assertEqual(kwargs['cwd'], directory)
                    self.assertTrue(os.path.isdir(directory))
                    self.assertEqual(Path(argv[-1]).read_text(), f'{S}\nnew\n{E}')
                    return subprocess.CompletedProcess(argv, rc, stdout='publish: adapter-failed\n', stderr='SECRET-STDERR')
                with mock.patch.object(os, 'getcwd', side_effect=FileNotFoundError('SECRET-CWD')), \
                        mock.patch.object(subprocess, 'run', side_effect=run):
                    code, _, err = self.run_update(fake, 'new')
                self.assertEqual(code, 0 if rc == 0 else 1)
                self.assertEqual(fake.writes, [f'Body\n\n{S}\nnew\n{E}\n'] if rc == 0 else [])
                self.assertEqual(err, '' if rc == 0 else 'publish: adapter-failed\n')
                self.assertNotIn('SECRET', err)

    def test_scanner_exit_mapping_and_output_filtering(self):
        issue_status.scan_status = self.real_scan
        done = lambda code, out: subprocess.CompletedProcess([], code, stdout=out, stderr='SECRET-STDERR')
        fake = FakeGitHub(['Body'])
        with mock.patch.object(subprocess, 'run', return_value=done(3, 'publish: scan-refused\nstatus: line 4 token\nleaked SECRET-VALUE\nfindings: 1\n')):
            code, _, err = self.run_update(fake, 'new')
        self.assertEqual(code, 4); self.assertEqual(err.splitlines(), ['publish: scan-refused', 'status: line 4 token', 'findings: 1'])
        with mock.patch.object(subprocess, 'run', return_value=done(3, 'only SECRET-VALUE here')):
            code, _, err = self.run_update(fake, 'new')
        self.assertEqual((code, err.strip()), (4, 'scanner output withheld'))
        with mock.patch.object(subprocess, 'run', return_value=done(5, '')):
            code, _, err = self.run_update(fake, 'new')
        self.assertEqual(code, 1); self.assertNotIn('SECRET', err); self.assertEqual(fake.writes, [])

    def test_infrastructure_failures_forward_only_the_value_free_code_line(self):
        issue_status.scan_status = self.real_scan
        cases = [(2, "publish: invalid-request"), (4, "publish: payload-unreadable"), (4, "publish: adapter-failed"),
                 (4, "publish: cleanup-failed"), (5, "publish: gh-unavailable"), (130, "publish: cancelled")]
        for rc, line in cases:
            with self.subTest(rc=rc, line=line):
                fake = FakeGitHub(["Body"])
                out = f"{line}\nstatus: line 2 token\nfindings: 1\nleaked SECRET-VALUE\n"
                done = subprocess.CompletedProcess([], rc, stdout=out, stderr="SECRET-STDERR")
                issue_status.gh_json = fake
                err = io.StringIO()
                with mock.patch.object(subprocess, "run", return_value=done), contextlib.redirect_stderr(err), \
                        self.assertRaises(SystemExit) as raised:
                    issue_status.main(["update", "--repo", "o/r", "--issue", "1", "--file", self.file("s.md", "new")])
                self.assertEqual(raised.exception.code, f"publication scanner failed (exit {rc}); status not written")
                self.assertEqual(err.getvalue(), line + "\n")
                self.assertEqual(fake.writes, [])
                self.assertNotIn("SECRET", err.getvalue() + str(raised.exception.code))
        for bad in ("publish: Adapter-Failed", "publish: adapter-failed extra", "publish: " + "a" * 41, "xpublish: cancelled"):
            with self.subTest(bad=bad):
                done = subprocess.CompletedProcess([], 4, stdout=bad + "\n", stderr="")
                err = io.StringIO()
                with mock.patch.object(subprocess, "run", return_value=done), contextlib.redirect_stderr(err), \
                        self.assertRaises(SystemExit):
                    issue_status.scan_status("block")
                self.assertEqual(err.getvalue(), "")

    def test_infrastructure_detail_forwarding_is_strict_and_limited_to_one_line(self):
        issue_status.scan_status = self.real_scan
        cases = [('detail: cwd-unavailable ENOENT\n', 'detail: cwd-unavailable ENOENT\n'),
                 ('detail: publish-threw\ndetail: cwd-unavailable ENOENT\n', 'detail: publish-threw\n'),
                 ('detail: leaked SECRET-VALUE\n', ''),
                 ('detail: cwd-unavailable ENOENT SECRET-VALUE\n', ''),
                 ('detail: ' + 'a' * 41 + '\n', '')]
        for detail, forwarded in cases:
            with self.subTest(detail=detail):
                fake = FakeGitHub(['Body'])
                done = subprocess.CompletedProcess([], 4, stdout='publish: adapter-failed\n' + detail, stderr='SECRET-STDERR')
                with mock.patch.object(subprocess, 'run', return_value=done):
                    code, _, err = self.run_update(fake, 'new')
                self.assertEqual(code, 1)
                self.assertEqual(err, 'publish: adapter-failed\n' + forwarded)
                self.assertEqual(fake.writes, [])
                self.assertNotIn('SECRET', err)

    def test_scanner_without_code_line_names_only_allowlisted_infrastructure_steps(self):
        issue_status.scan_status = self.real_scan
        cases = [(126, 'SECRET-STDERR', 'interpreter-or-binary-not-found'),
                 (127, 'SECRET-STDERR', 'interpreter-or-binary-not-found'),
                 (1, 'ERR_MODULE_NOT_FOUND SECRET-PATH', 'node-too-old'),
                 (1, 'ERR_UNKNOWN_FILE_EXTENSION SECRET-PATH', 'node-too-old'),
                 (1, 'bad option --experimental-strip-types SECRET-VALUE', 'node-too-old'),
                 (1, 'uv_cwd SECRET-PATH', 'cwd-unavailable'),
                 (1, 'ENOENT SECRET-PATH', 'cwd-unavailable'),
                 (1, 'SECRET-STDERR', None)]
        for rc, stderr, step in cases:
            with self.subTest(rc=rc, stderr=stderr):
                fake = FakeGitHub(['Body'])
                done = subprocess.CompletedProcess([], rc, stdout='SECRET-STDOUT', stderr=stderr)
                issue_status.gh_json = fake
                err = io.StringIO()
                with mock.patch.object(subprocess, 'run', return_value=done), contextlib.redirect_stderr(err), \
                        self.assertRaises(SystemExit) as raised:
                    issue_status.main(['update', '--repo', 'o/r', '--issue', '1', '--file', self.file('s.md', 'new')])
                self.assertEqual(raised.exception.code, f'publication scanner failed (exit {rc}); status not written')
                self.assertEqual(err.getvalue(), f'step: {step}\n' if step else '')
                self.assertEqual(fake.writes, [])
                self.assertNotIn('SECRET', err.getvalue() + str(raised.exception.code))

    def test_scanner_gets_a_private_file_with_the_exact_bytes_and_cleans_up(self):
        issue_status.scan_status = self.real_scan
        seen = {}
        def run(argv, **kwargs):
            seen.update(argv=argv, kwargs=kwargs, bytes=Path(argv[-1]).read_bytes(), mode=os.stat(argv[-1]).st_mode & 0o777,
                        dirmode=os.stat(os.path.dirname(argv[-1])).st_mode & 0o777)
            return subprocess.CompletedProcess(argv, 0, stdout='scan clean\n', stderr='')
        with mock.patch.object(subprocess, 'run', side_effect=run), mock.patch.dict(os.environ, {'PI_CODING_AGENT_DIR': '/agent'}):
            issue_status.scan_status(f'{S}\r\nx\n{E}')
        self.assertEqual(seen['bytes'], f'{S}\r\nx\n{E}'.encode())
        self.assertEqual((seen['mode'], seen['dirmode']), (0o600, 0o700))
        self.assertEqual(seen['argv'][:3], ['/agent/bin/pi-publish', 'check', '--file'])
        self.assertNotIn('shell', seen['kwargs']); self.assertEqual(seen['kwargs']['timeout'], 60)
        self.assertNotIn('cwd', seen['kwargs'])
        self.assertFalse(os.path.exists(seen['argv'][-1])); self.assertFalse(os.path.exists(os.path.dirname(seen['argv'][-1])))

    def test_patch_failure_prints_a_fixed_message_without_stderr(self):
        base = FakeGitHub(['Body'])
        def failing(args, payload=None):
            if args[0] == '-X':
                raise issue_status.GhFailure(1, 'SECRET-STDERR')
            return base(args, payload)
        code, _, err = self.run_update(failing, 'new')
        self.assertEqual(code, 1); self.assertEqual(base.writes, [])
        issue_status.gh_json = failing
        with self.assertRaises(SystemExit) as raised, contextlib.redirect_stderr(io.StringIO()):
            issue_status.main(['update', '--repo', 'o/r', '--issue', '1', '--file', self.file('t.md', 'new')])
        self.assertEqual(raised.exception.code, 'gh api PATCH failed (exit 1); not verified')

    def test_read_failure_keeps_gh_message(self):
        def failing(args, payload=None):
            raise issue_status.GhFailure(1, 'boom\n')
        issue_status.gh_json = failing
        with self.assertRaises(SystemExit) as raised:
            issue_status.main(['show', '--repo', 'o/r', '--issue', '1'])
        self.assertEqual(raised.exception.code, 'gh api failed: boom')


@unittest.skipUnless(shutil.which('node'), 'node is required for the real scanner')
class RealScannerTest(unittest.TestCase):
    def scan(self, block):
        with tempfile.TemporaryDirectory() as home:
            env = {'PI_CODING_AGENT_DIR': str(AGENT), 'HOME': home}
            err = io.StringIO()
            with mock.patch.dict(os.environ, env), contextlib.redirect_stderr(err):
                try:
                    issue_status.scan_status(block)
                    return 0, err.getvalue()
                except SystemExit as exit_:
                    return exit_.code, err.getvalue()

    def test_clean_block_passes(self):
        self.assertEqual(self.scan(f'{S}\n**State:** Paused\n{E}'), (0, ''))

    def test_home_path_is_refused_without_the_path(self):
        leak = '/'.join(['', 'Users', 'alice', 'notes.md'])
        code, err = self.scan(f'{S}\nline\nSee {leak}\n{E}')
        self.assertEqual(code, issue_status.SCAN_REFUSED_EXIT)
        self.assertIn('line 3 home-path', err)
        self.assertNotIn('alice', err); self.assertNotIn('notes.md', err)


if __name__ == '__main__':
    unittest.main()
