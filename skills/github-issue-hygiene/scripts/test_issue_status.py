#!/usr/bin/env python3
"""Mocked append-only publication tests. No real GitHub calls."""
import contextlib
import importlib.util
import io
import pathlib
import subprocess
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name('issue-status.py')
SPEC = importlib.util.spec_from_file_location('issue_status', SCRIPT)
status = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(status)


class IssueStatusTests(unittest.TestCase):
    def run_main(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            status.main(['update', '--repo', 'owner/repo', '--issue', '7', '--file', 'event.md', *extra])
        return out.getvalue()

    @patch.dict('os.environ', {'PI_CODING_AGENT_DIR': '/agent'})
    @patch.object(status.subprocess, 'run')
    def test_update_only_appends_via_scanned_publisher(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'publish: published\n', '')
        self.assertEqual(self.run_main(), 'publish: published\n')
        run.assert_called_once_with([
            '/agent/bin/pi-publish', 'issue-comment', '--repo', 'owner/repo',
            '--number', '7', '--body-file', 'event.md'],
            capture_output=True, text=True, timeout=60)

    @patch.dict('os.environ', {'PI_CODING_AGENT_DIR': '/agent'})
    @patch.object(status.subprocess, 'run')
    def test_dry_run_only_scans(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'publish: scan-clean\n', '')
        self.assertEqual(self.run_main('--dry-run'), 'publish: scan-clean\n')
        self.assertEqual(run.call_args.args[0], ['/agent/bin/pi-publish', 'check', '--file', 'event.md'])

    @patch.object(status.subprocess, 'run')
    def test_old_loaded_claims_skip_body_write_without_failing_or_io(self, run):
        for flags in [('--expect-absent',), ('--expect-file', 'expected.md')]:
            with self.subTest(flags=flags):
                self.assertIn('Skipped legacy status-block write (append-only)', self.run_main(*flags))
        run.assert_not_called()

    @patch.object(status.subprocess, 'run')
    def test_update_needs_file(self, run):
        with self.assertRaisesRegex(SystemExit, '--file is required'):
            status.main(['update', '--repo', 'owner/repo', '--issue', '7'])
        run.assert_not_called()

    @patch.object(status.subprocess, 'run')
    def test_publication_failure_is_not_retried(self, run):
        run.return_value = subprocess.CompletedProcess([], 4, 'publish: scan-refused\n', 'private error')
        with contextlib.redirect_stdout(io.StringIO()) as out, self.assertRaises(SystemExit) as error:
            self.run_main()
        self.assertEqual(error.exception.code, 4)
        self.assertNotIn('private error', out.getvalue())
        run.assert_called_once()

    @patch.object(status.subprocess, 'run')
    def test_missing_or_timed_out_scanner_fails_closed(self, run):
        for failure in [FileNotFoundError('private path'), subprocess.TimeoutExpired('publisher', 60)]:
            run.side_effect = failure
            with self.assertRaisesRegex(SystemExit, 'scanner unavailable; comment not posted'):
                self.run_main()
        self.assertEqual(run.call_count, 2)

    @patch.object(status, 'fetch')
    def test_show_reads_legacy_block_without_rewriting_it(self, fetch):
        body = 'Original problem\n' + status.START + '\n**State:** Paused\n' + status.END
        fetch.return_value = (body, 'today', 'open')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            status.main(['show', '--repo', 'owner/repo', '--issue', '7'])
        self.assertEqual(out.getvalue(), '**State:** Paused\n\nstate=open updated_at=today\n')
        fetch.assert_called_once_with('owner/repo', 7)
        self.assertEqual(fetch.return_value[0], body)

    @patch.object(status, 'fetch', return_value=('Original problem', 'today', 'open'))
    def test_show_without_block(self, fetch):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            status.main(['show', '--repo', 'owner/repo', '--issue', '7'])
        self.assertEqual(out.getvalue(), '(no agent status block)\n\nstate=open updated_at=today\n')


if __name__ == '__main__':
    unittest.main()
