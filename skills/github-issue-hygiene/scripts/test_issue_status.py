"""Tests for issue-status.py with a mocked gh_json. Run: python3 -m unittest test_issue_status (from this directory)."""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location('issue_status', Path(__file__).with_name('issue-status.py'))
issue_status = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(issue_status)
S, E = issue_status.START, issue_status.END


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


if __name__ == '__main__':
    unittest.main()
