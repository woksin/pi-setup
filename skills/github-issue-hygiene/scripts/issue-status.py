#!/usr/bin/env python3
"""Safely create or replace the agent-managed status block in a GitHub issue body.

Only the block between the markers below is ever changed; the rest of the issue
description is preserved exactly. Concurrent edits are detected by re-reading the
issue immediately before writing and verifying afterwards.

Usage:
  issue-status.py show   --repo OWNER/REPO --issue N
  issue-status.py update --repo OWNER/REPO --issue N --file status.md [--dry-run] [--expect-file expected.md | --expect-absent]

--expect-file: the exact text between the markers that the new status was based on
(byte-exact, CRLF kept; an empty file means an empty block, not a missing one).
--expect-absent: the new status was based on there being no block at all.
With either, the update is refused with exit code 3 when the issue's current block
differs, checked on every read before writing.

The exact status block that is inserted is scanned once with the shared publication scanner
(`pi-publish check`) before anything is written, also with --dry-run. A refusal exits with code 4
and prints only value-free kinds, line numbers and counts; a missing or failing scanner fails closed.
Only newly emitted text is scanned; the unchanged remainder of the issue body is not.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

START = '<!-- agent-status:start -->'
END = '<!-- agent-status:end -->'
MISMATCH_EXIT = 3
SCAN_REFUSED_EXIT = 4
SCAN_TIMEOUT = 60
# The only scanner output lines that are ever forwarded; everything else is withheld.
SCAN_LINE = re.compile(r'^(publish: [a-z-]+|[\w\[\]]+: line \d+ [a-z-]+|findings: \d+)$')


class GhFailure(SystemExit):
    """gh exited non-zero. Uncaught, it exits 1 with gh's message; callers may replace the message."""

    def __init__(self, returncode, stderr):
        super().__init__(f'gh api failed: {stderr.strip()}')
        self.returncode = returncode


def gh_json(args, payload=None):
    result = subprocess.run(['gh', 'api', *args], input=None if payload is None else json.dumps(payload),
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise GhFailure(result.returncode, result.stderr)
    return json.loads(result.stdout)


def fetch(repo, issue):
    data = gh_json([f'repos/{repo}/issues/{issue}'])
    return data.get('body') or '', data['updated_at'], data.get('state')


def markers_ok(body):
    """Exactly one start marker followed by exactly one end marker, or neither."""
    starts, ends = body.count(START), body.count(END)
    if starts == 0 and ends == 0:
        return True
    return starts == 1 and ends == 1 and body.index(START) < body.index(END)


def current_block(body):
    """The exact text between the markers, or None when there is no block. Requires markers_ok(body)."""
    if START not in body:
        return None
    return body[body.index(START) + len(START):body.index(END)]


def status_block(status):
    """The exact text inserted into the issue body; this is also what gets scanned."""
    return f'{START}\n{status.strip()}\n{END}'


def run_scanner(block):
    """Run the shared scanner on a private 0600 snapshot of the exact block bytes; the snapshot is always removed."""
    agent = os.environ.get('PI_CODING_AGENT_DIR') or os.path.join(os.path.expanduser('~'), '.pi', 'agent')
    directory = tempfile.mkdtemp(prefix='issue-status-')  # 0700, private to this user
    try:
        path = os.path.join(directory, 'status.md')
        with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as handle:
            handle.write(block.encode('utf-8'))
        return subprocess.run([os.path.join(agent, 'bin', 'pi-publish'), 'check', '--file', path],
                              capture_output=True, text=True, timeout=SCAN_TIMEOUT)
    except UnicodeEncodeError:
        sys.exit('status text is not valid UTF-8; status not written')
    except (OSError, subprocess.SubprocessError):
        sys.exit('publication scanner unavailable; status not written')
    finally:
        for name in os.listdir(directory):
            os.unlink(os.path.join(directory, name))
        os.rmdir(directory)


def scan_status(block):
    """Scan the in-memory block. Returns when clean; exits 4 when refused and 1 when it cannot scan."""
    result = run_scanner(block)
    if result.returncode == 0:
        return
    if result.returncode != 3:
        sys.exit(f'publication scanner failed (exit {result.returncode}); status not written')
    forwarded = [line for line in result.stdout.splitlines() if SCAN_LINE.match(line)]
    print('\n'.join(forwarded) if forwarded else 'scanner output withheld', file=sys.stderr)
    sys.exit(SCAN_REFUSED_EXIT)


def compose(body, status):
    if not markers_ok(body):
        sys.exit('Malformed status markers in the issue body (need exactly one start marker followed by one end marker); fix them manually before updating.')
    block = status_block(status)
    if START in body:
        before = body[:body.index(START)]
        after = body[body.index(END) + len(END):]
        return f'{before}{block}{after}'
    # Append, keeping the original body verbatim.
    if not body.strip():
        separator = ''
    elif body.endswith('\n\n'):
        separator = ''
    elif body.endswith('\n'):
        separator = '\n'
    else:
        separator = '\n\n'
    return f'{body}{separator}{block}\n'


ABSENT = object()  # expectation: no block at all


def write_body(repo, issue, new_body):
    try:
        gh_json(['-X', 'PATCH', f'repos/{repo}/issues/{issue}', '--input', '-'], {'body': new_body})
    except GhFailure as failure:
        sys.exit(f'gh api PATCH failed (exit {failure.returncode}); not verified')


def check_expected(body, expected):
    """expected: None (no check), ABSENT (no block) or the exact block text."""
    if expected is None:
        return
    if not markers_ok(body):
        sys.exit('Malformed status markers in the issue body; fix them manually before updating.')
    current = current_block(body)
    matches = current is None if expected is ABSENT else current == expected
    if not matches:
        print('status-mismatch: the status block changed since it was read; re-read and recompute.', file=sys.stderr)
        sys.exit(MISMATCH_EXIT)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['show', 'update'])
    parser.add_argument('--repo', required=True)
    parser.add_argument('--issue', required=True, type=int)
    parser.add_argument('--file')
    expect = parser.add_mutually_exclusive_group()
    expect.add_argument('--expect-file')
    expect.add_argument('--expect-absent', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)

    body, updated_at, state = fetch(args.repo, args.issue)
    if args.command == 'show':
        if START in body and END in body:
            print(body[body.index(START) + len(START):body.index(END)].strip())
        else:
            print('(no agent status block)')
        print(f'\nstate={state} updated_at={updated_at}')
        return
    if not args.file:
        sys.exit('--file is required for update')
    with open(args.file, encoding='utf-8', newline='') as f:
        status = f.read()
    if START in status or END in status:
        sys.exit('The status text must not contain the status markers.')
    expected = ABSENT if args.expect_absent else None
    if args.expect_file is not None:
        with open(args.expect_file, encoding='utf-8', newline='') as f:
            expected = f.read()

    scan_status(status_block(status))  # Once, on the exact bytes composed below; never re-read from --file.
    for attempt in range(2):
        check_expected(body, expected)
        new_body = compose(body, status)
        if new_body == body:
            print('Status block already up to date; nothing written.')
            return
        if args.dry_run:
            print(new_body)
            return
        # Re-read right before writing: another agent or person may have edited the issue.
        fresh_body, fresh_updated, _ = fetch(args.repo, args.issue)
        if fresh_updated != updated_at or fresh_body != body:
            body, updated_at = fresh_body, fresh_updated
            if attempt == 0:
                continue  # Recompose from the fresh body; only our block changes.
            sys.exit('The issue keeps changing concurrently; not writing. Coordinate a single writer.')
        write_body(args.repo, args.issue, new_body)
        verified, _, _ = fetch(args.repo, args.issue)
        if status.strip() not in verified or verified.count(START) != 1:
            sys.exit('Write could not be verified; inspect the issue body manually.')
        print(f'Updated status block on {args.repo}#{args.issue}.')
        return


if __name__ == '__main__':
    main()
