#!/usr/bin/env python3
"""Read legacy status blocks or append a scanned event comment; never edit issue text."""
import argparse
import json
import os
import subprocess
import sys

START = '<!-- agent-status:start -->'
END = '<!-- agent-status:end -->'


class GhFailure(SystemExit):
    def __init__(self, returncode, stderr):
        super().__init__(f'gh api failed: {stderr.strip()}')
        self.returncode = returncode


def gh_json(args):
    result = subprocess.run(['gh', 'api', *args], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise GhFailure(result.returncode, result.stderr)
    return json.loads(result.stdout)


def fetch(repo, issue):
    data = gh_json([f'repos/{repo}/issues/{issue}'])
    return data.get('body') or '', data['updated_at'], data.get('state')


def append_comment(args):
    if args.expect_file is not None or args.expect_absent:
        # Older loaded issue_work modules must still reach their local register write.
        print('Skipped legacy status-block write (append-only); reload pi for event comments.')
        return
    if not args.file:
        sys.exit('--file is required for update')
    agent = os.environ.get('PI_CODING_AGENT_DIR') or os.path.join(os.path.expanduser('~'), '.pi', 'agent')
    publisher = os.path.join(agent, 'bin', 'pi-publish')
    command = [publisher, 'check', '--file', args.file] if args.dry_run else [
        publisher, 'issue-comment', '--repo', args.repo, '--number', str(args.issue), '--body-file', args.file]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        sys.exit('publication scanner unavailable; comment not posted')
    # pi-publish emits scanned diagnostics, never raw gh output.
    print(result.stdout, end='')
    if result.returncode:
        sys.exit(result.returncode)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['show', 'update'])
    parser.add_argument('--repo', required=True)
    parser.add_argument('--issue', required=True, type=int)
    parser.add_argument('--file')
    expect = parser.add_mutually_exclusive_group()
    expect.add_argument('--expect-file')
    expect.add_argument('--expect-absent', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if args.command == 'update':
        append_comment(args)
        return
    body, updated_at, state = fetch(args.repo, args.issue)
    if START in body and END in body:
        print(body[body.index(START) + len(START):body.index(END)].strip())
    else:
        print('(no agent status block)')
    print(f'\nstate={state} updated_at={updated_at}')


if __name__ == '__main__':
    main()
