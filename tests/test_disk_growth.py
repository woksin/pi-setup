"""Isolated specs for the disk-growth sampler and bounded probe."""
from datetime import datetime, timezone
import importlib.machinery
import importlib.util
import io
import itertools
import json
import os
from pathlib import Path
import plistlib
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('disk_growth', str(ROOT / 'agent/bin/disk-growth'))
spec = importlib.util.spec_from_loader(loader.name, loader)
dg = importlib.util.module_from_spec(spec)
loader.exec_module(dg)
probe = runpy.run_path(str(ROOT / 'agent/bin/disk_growth_probe.py'))
G = 1 << 30


class DiskGrowthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.home_patch = patch.object(Path, 'home', return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.agent = self.home / '.pi/agent'
        self.agent.mkdir(parents=True)
        self.messages = self.home / 'messages'
        self.messages.mkdir()
        self.env = {'HOME': str(self.home), 'DISK_GROWTH_MESSAGES': str(self.messages)}
        self.cfg = dg.settings(self.env, self.home)

    def evaluate(self, values, last=None):
        return dg.evaluate([{'ts': ts, 'free': free * G, 'watch': {}} for ts, free in values],
                           1000, self.cfg, last)

    def test_threshold_window_and_future(self):
        status, info = self.evaluate([(880, 30), (940, 28), (1000, 24.5)])
        self.assertEqual(status, 'fire')
        self.assertEqual(info['drop'], 5.5 * G)
        self.assertEqual(info['baseline']['free'], 30 * G)
        self.assertEqual(self.evaluate([(940, 30), (1000, 25)])[0], 'fire')
        for values in ([(940, 30), (1000, 25.1)], [(654, 30), (1000, 24)],
                       [(1000, 24), (1001, 99)]):
            self.assertIn(self.evaluate(values)[0], ('quiet', 'seed'))

    def test_debounce_rearm_and_expiry(self):
        last = {'ts': 400, 'free': 24 * G}
        self.assertEqual(self.evaluate([(940, 30), (1000, 22)], last)[0], 'suppressed')
        self.assertEqual(self.evaluate([(940, 30), (1000, 18.9)], last)[0], 'fire')
        self.assertEqual(self.evaluate([(940, 30), (1000, 22)], {'ts': -801, 'free': 24 * G})[0], 'fire')

    def test_settings_validation_and_inbox_fallbacks(self):
        user = {'reposRoot': str(self.home / 'repos'), 'orchRepoRoot': str(self.home / 'orch')}
        path = self.agent / 'user.json'
        path.write_text(json.dumps(user))
        env = {'HOME': str(self.home)}
        self.assertEqual(dg.settings(env, self.home)['messages_dirs'], [str(self.home / 'orch/.ai-work/messages')])
        env['PI_ORCH_REPO_ROOT'] = str(self.home / 'override')
        self.assertEqual(dg.settings(env, self.home)['messages_dirs'], [str(self.home / 'override/.ai-work/messages')])
        user['orchMessagesDir'] = 'user-inbox'
        path.write_text(json.dumps(user))
        self.assertEqual(dg.settings(env, self.home)['messages_dirs'], ['user-inbox'])
        env['PI_ORCH_MESSAGES_DIR'] = 'env-inbox'
        self.assertEqual(dg.settings(env, self.home)['messages_dirs'], ['env-inbox'])
        env['DISK_GROWTH_MESSAGES'] = os.pathsep.join(['one', 'two'])
        self.assertEqual(dg.settings(env, self.home)['messages_dirs'], ['one', 'two'])
        for invalid in (-1, True, float('nan'), '5'):
            (self.agent / 'disk-growth.json').write_text(json.dumps({'drop_gib': invalid}))
            self.assertEqual(dg.settings(env, self.home)['drop_gib'], 5)
        (self.agent / 'disk-growth.json').write_text(json.dumps({'drop_gib': 7, 'roots': ['custom']}))
        self.assertEqual(dg.settings(env, self.home)['drop_gib'], 7)
        self.assertEqual(dg.settings(env, self.home)['roots'], ['custom'])
        env['DISK_GROWTH_DROP_GIB'] = '8'
        self.assertEqual(dg.settings(env, self.home)['drop_gib'], 8)

    def test_notice_is_fixed_and_posted_to_existing_dirs(self):
        _, info = self.evaluate([(880, 30), (1000, 24.5)])
        writers = [{'path': str(self.home / 'repo'), 'bytes': 6 * G, 'categories': {'dumps': 6 * G}, 'procs': ['dotnet']}]
        coverage = {'walked': 1, 'total': 2, 'partial': True}
        text = dg.format_notice(1000, info, writers, coverage, self.cfg)
        clock = time.strftime('%H:%M', time.localtime(1000))
        self.assertEqual(text.splitlines()[0], f'disk-growth ({clock}): free space dropped 5.5 GiB in 2 min (30.0 -> 24.5 GiB free).')
        self.assertIn('partial: walked 1 of 2 units', text)
        self.assertIn('- 6.0 GiB  ~/repo  (dumps 6.0)  procs: dotnet', text)
        self.assertTrue(text.endswith('Next notice after 30 min unless free space drops another 5 GiB.\n'))
        self.assertEqual(text, dg.format_notice(1000, info, writers, coverage, self.cfg))
        self.assertIn('docker system df', dg.format_notice(1000, info, [], coverage, self.cfg))
        second = self.home / 'second'
        second.mkdir()
        dg.post_notice(text, [self.messages, second, self.home / 'absent'], 1000)
        for directory in (self.messages, second):
            files = sorted(directory.iterdir())
            self.assertEqual(len(files), 2)
            self.assertRegex(files[1].name, r'^PISETUP-to-L0-disk-growth-\d{4}\.md$')
            self.assertEqual(files[1].read_text(), text)
            self.assertRegex(files[0].name, r'^BCAST-disk-growth-\d{4}\.md$')
            self.assertEqual(files[0].read_text(), text)

    @patch.object(dg, 'attribution_lines', return_value=['Likely writers (mocked):'])
    def test_run_state_log_dry_run_and_timeout_notice(self, attribution):
        empty = lambda **kwargs: ([], {'walked': 0, 'total': 0, 'partial': False})
        for now, free, status in [(1000, 30, 'seed'), (1060, 24, 'fire'), (1120, 23, 'suppressed')]:
            self.assertEqual(dg.run(now=now, free_bytes=free * G, env=self.env,
                                    notifier=lambda text: None, probe=empty), status)
        state = self.agent / 'disk-growth/state.json'
        saved = state.read_text()
        self.assertEqual(json.loads(saved)['last_alert'], {'ts': 1060, 'free': 24 * G})
        log = (self.agent / 'logs/disk-growth.log').read_text()
        self.assertIn('fired drop=6.0GiB', log)
        self.assertIn('suppressed drop=7.0GiB', log)
        dg.run(now=1180, free_bytes=10 * G, env=self.env, notifier=lambda text: None, probe=empty, dry_run=True)
        self.assertEqual(state.read_text(), saved)
        (self.agent / 'disk-growth.json').write_text(json.dumps({'probe_budget_seconds': 0.05}))
        with patch.object(dg, 'worker_command', return_value=['/bin/sleep', '10']):
            start = time.monotonic()
            dg.run(now=1240, free_bytes=10 * G, env=self.env, notifier=lambda text: None)
        self.assertLess(time.monotonic() - start, 3)
        notice = self.messages / f"BCAST-disk-growth-{dg.clock(1240, '%H%M')}.md"
        self.assertIn('probe timed out/partial', notice.read_text())
        self.assertIn('Likely writers (mocked):', notice.read_text())

    def write_lease(self, name, **values):
        state = self.agent / 'pi-phase/state'
        state.mkdir(parents=True, exist_ok=True)
        (state / f'{name}.lock').touch()
        data = dict(token=name, pid=os.getpid(), kind='test', label=name,
                    cwd=str(self.home / 'repo space'), started=880)
        data.update(values)
        path = state / f'{name}.json'
        path.write_text(json.dumps(data))
        return path

    def test_running_leases_order_window_first_and_deduplicate_without_commands(self):
        self.write_lease('heavy-0', token='shared', kind='build', label='older build', started=400)
        self.write_lease('integration-0', token='shared', kind='build', label='older build', started=400)
        self.write_lease('fast-0', label='recent tests')
        self.write_lease('direct-boundary', label='boundary', started=820)
        (self.agent / 'pi-phase/state/coordinator.lock').touch()
        (self.agent / 'pi-phase/state/heavy-1.lock').touch()
        (self.agent / 'pi-phase/state/host-sample.json').write_text('{}')
        commands = Mock()
        with patch.object(dg.time, 'time', return_value=1000):
            lines = dg.phase_lines(commands, 180, str(self.home))
        self.assertEqual(lines, ['- test recent tests cwd=~/repo space elapsed=120s',
                                 '- test boundary cwd=~/repo space elapsed=180s',
                                 '- build older build cwd=~/repo space elapsed=600s'])
        commands.run.assert_not_called()

    def test_dead_lease_pid_is_skipped_without_status_fallback(self):
        self.write_lease('direct-dead', pid=123456)
        commands = Mock()
        with patch.object(dg.os, 'kill', side_effect=ProcessLookupError) as kill:
            self.assertEqual(dg.phase_lines(commands, 180, str(self.home)), ['- none'])
        kill.assert_called_once_with(123456, 0)
        commands.run.assert_not_called()

    def test_malformed_lease_files_are_skipped(self):
        self.write_lease('direct-live')
        self.write_lease('direct-bad-json').write_text('{')
        self.write_lease('direct-not-object').write_text('[]')
        for key, value in [('pid', -1), ('pid', True), ('started', '880'),
                           ('started', float('nan')), ('cwd', None), ('label', '')]:
            self.write_lease(f'direct-bad-{key}-{value}', **{key: value})
        commands = Mock()
        with patch.object(dg.time, 'time', return_value=1000), \
                patch.object(dg.os, 'kill') as kill:
            lines = dg.phase_lines(commands, 180, str(self.home))
        self.assertEqual(lines, ['- test direct-live cwd=~/repo space elapsed=120s'])
        kill.assert_called_once_with(os.getpid(), 0)
        commands.run.assert_not_called()

    def test_unreadable_lease_format_falls_back_to_status(self):
        self.write_lease('direct-invalid').write_text('{"different": "format"}')
        commands = Mock()
        commands.run.return_value = ('pi-phase: test fallback pid=1 cwd=/tmp/repo '
                                     'elapsed=10s running\n')
        self.assertEqual(dg.phase_lines(commands, 180, str(self.home)),
                         ['- test fallback cwd=/tmp/repo elapsed=10s'])
        self.assertEqual(commands.run.call_args.args[0][-1], 'status')

    def test_empty_lease_state_does_not_run_status(self):
        (self.agent / 'pi-phase/state').mkdir(parents=True)
        commands = Mock()
        self.assertEqual(dg.phase_lines(commands, 180, str(self.home)), ['- none'])
        commands.run.assert_not_called()

    def test_running_lease_ten_entry_limit(self):
        for age in range(600, 612):
            self.write_lease(f'direct-{age}', started=1000 - age)
        commands = Mock()
        with patch.object(dg.time, 'time', return_value=1000):
            lines = dg.phase_lines(commands, 180, str(self.home))
        self.assertEqual(len(lines), 10)
        self.assertEqual(lines[-1], '- test direct-609 cwd=~/repo space elapsed=609s')
        commands.run.assert_not_called()

    def test_phase_attribution_orders_window_first_and_preserves_spaced_labels(self):
        output = ('pi-phase: build older build pid=1 cwd=/tmp/old elapsed=600s running policy=queued source=flag\n'
                  f'pi-phase: test recent tests pid=2 cwd={self.home}/repo space elapsed=120s running fast\n'
                  'pi-phase: build boundary pid=3 cwd=/tmp/boundary elapsed=180s running\n'
                  'pi-phase: queued kind=test label=waiting waited=1s\n'
                  'pi-phase: build orphan pid=4 cwd=/tmp/orphan elapsed=1s orphan-group\n')
        with patch.object(dg.subprocess, 'run', return_value=Mock(returncode=0, stdout='', stderr=output)) as run:
            lines = dg.phase_lines(dg.AttributionCommands(), 180, str(self.home))
        self.assertEqual(lines, ['- test recent tests cwd=~/repo space elapsed=120s',
                                 '- build boundary cwd=/tmp/boundary elapsed=180s',
                                 '- build older build cwd=/tmp/old elapsed=600s'])
        self.assertEqual(run.call_args.args[0], [str(ROOT / 'agent/bin/pi-phase'), 'status'])
        self.assertLessEqual(run.call_args.kwargs['timeout'], 10)

    def test_real_phase_status_installed_lookup_tokens_and_ten_entry_limit(self):
        installed = self.agent / 'bin/pi-phase'
        installed.parent.mkdir()
        installed.touch()
        output = ('pi-phase: test <label> pid=108 cwd=/path elapsed=133s running policy=direct source=flag\n'
                  'pi-phase: test bc-mcp-green pid=6162 cwd=/Volumes/sourcecode/repos/cratis/.worktrees/screenplay-mcp elapsed=439s running policy=queued source=default\n'
                  'pi-phase: test cli-hard Cli.Specs pid=90277 cwd=/Volumes/sourcecode/repos/cratis/.worktrees/cli elapsed=39s running policy=queued source=default\n'
                  'pi-phase: test ux-p0b-app pid=81014 cwd=/Volumes/sourcecode/repos/Mesta/.worktrees/ux-main elapsed=190s running policy=queued source=default\n'
                  'pi-phase: queued priority=normal kind=test label=pi-setup-tests waited=353s rank=3 expected=143s basis=exact order=short policy=queued source=default id=86645c7f06de\n')
        output += '\n'.join(f'pi-phase: build old {age} cwd=/tmp/repo space elapsed={age}s pid={age} running policy=direct source=flag'
                            for age in range(600, 620))
        with patch.object(dg.subprocess, 'run', return_value=Mock(returncode=0, stdout=output, stderr='')) as run:
            lines = dg.phase_lines(dg.AttributionCommands(), 180, str(self.home))
        self.assertEqual(run.call_args.args[0], [str(installed), 'status'])
        self.assertEqual(len(lines), 10)
        self.assertIn('cli-hard Cli.Specs', lines[0])
        self.assertEqual(lines[1], '- test <label> cwd=/path elapsed=133s')
        self.assertIn('ux-p0b-app', lines[2])
        self.assertIn('bc-mcp-green', lines[3])
        self.assertEqual(lines[-1], '- build old 605 cwd=/tmp/repo space elapsed=605s')
        self.assertNotIn('queued', '\n'.join(lines))

    def test_process_attribution_window_truncation_and_ten_cwd_limit(self):
        args = f'node {self.home}/npm-cli.js install ' + 'x' * 200
        output = ' PID ELAPSED COMM ARGS\n' + '\n'.join(
            f'{pid} 03:00 /usr/bin/node {args}' for pid in range(1, 13))
        output += ('\n13 03:01 dotnet dotnet build\n14 1-00:00:00 cp cp a b\n'
                   '15 00:10 node node server.js\n16 01:00:00 cargo cargo build\n')
        def run(command, **kwargs):
            stdout = output if command[0] == 'ps' else f'p{command[3]}\nn{self.home}/repo\n'
            return Mock(returncode=0, stdout=stdout, stderr='')
        with patch.object(dg.subprocess, 'run', side_effect=run) as call:
            commands = dg.AttributionCommands()
            processes = dg.recent_processes(commands, 120)
            lines = dg.process_lines(processes, commands, str(self.home))
        self.assertEqual([process[1] for process in processes], list(range(1, 11)))
        self.assertEqual(call.call_args_list[0].args[0], ['ps', '-axo', 'pid,etime,comm,args'])
        lookups = [item.args[0] for item in call.call_args_list[1:]]
        self.assertEqual(lookups, [['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'] for pid in range(1, 11)])
        self.assertIn('node ~/npm-cli.js install', lines[0])
        self.assertNotIn(str(self.home), '\n'.join(lines))
        self.assertTrue(lines[0].startswith('- pid=1 elapsed=03:00 cwd=~/repo node '))
        self.assertEqual(len(lines[0].split('cwd=~/repo ', 1)[1]), 120)
        self.assertTrue(lines[0].endswith('...'))
        self.assertEqual(len(lines), 10)
        self.assertIn('cwd=~/repo', lines[-1])
        self.assertEqual(dg.elapsed_seconds('2-01:02:03'), 176523)

    def test_heavy_processes_exclude_chrome_helpers_and_sort_shortest_first(self):
        chrome = ('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/'
                  'Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper'
                  ' --disable-features=dotnet --disable-gpu --node npm go cargo')
        output = ('PID ELAPSED COMM ARGS\n'
                  f'10 00:00 /Applications/Go {chrome}\n'
                  '11 00:01 chrome-helper chrome-helper --disable-features=dotnet --node npm go cargo\n'
                  '12 00:20 /usr/local/shar /usr/local/share/dotnet/dotnet test Arc.Core.Specs\n'
                  '13 00:10 /usr/local/shar /usr/local/share/dotnet/dotnet build\n')
        output += '\n'.join(f'{pid} 00:{pid} dotnet dotnet test' for pid in range(30, 42))
        with patch.object(dg.subprocess, 'run', return_value=Mock(returncode=0, stdout=output, stderr='')):
            processes = dg.recent_processes(dg.AttributionCommands(), 120)
        self.assertEqual([row[1] for row in processes], [13, 12, *range(30, 38)])
        self.assertEqual(len(processes), 10)
        self.assertIn('dotnet test Arc.Core.Specs', processes[1][3])
        self.assertFalse(dg.writer_command('/Applications/Example.app/Contents/MacOS/node', 'node npm-cli.js'))
        self.assertFalse(dg.writer_command('node', 'node --disable-feature=npm server.js'))
        self.assertFalse(dg.writer_command('not-python', 'not-python -m pip install x'))
        self.assertTrue(dg.writer_command('/usr/local/shar', '/usr/local/share/dotnet/dotnet test'))

    def test_redacts_url_userinfo_before_process_argument_truncation(self):
        commands = Mock()
        commands.run.return_value = f'p123\nn{self.home}/repo\n'
        for userinfo in ['reader:' + 'private-value' * 30, 'private-value' * 30]:
            args = f'git clone https://{userinfo}@example.com/repo'
            with self.subTest(userinfo=userinfo):
                lines = dg.process_lines([(0, 123, '00:00', args)], commands, str(self.home))
                self.assertEqual(lines, ['- pid=123 elapsed=00:00 cwd=~/repo git clone https://***@example.com/repo'])
        self.assertEqual(dg.short_text('git+ssh://reader:private-value@example.com/repo', str(self.home)),
                         'git+ssh://***@example.com/repo')

    def test_redacts_sensitive_flag_values_and_preserves_environment_names(self):
        flags = ['-k', '--api-key', '-p', '--password', '--token', '--build-arg', '--secret', '-e', '--env']
        values = ['private-value', '"private value"', "'private value'", '"private value']
        for flag, separator, value in itertools.product(flags, [' ', '='], values):
            with self.subTest(flag=flag, separator=separator, value=value):
                self.assertEqual(dg.short_text(f'dotnet test {flag}{separator}{value}', str(self.home)),
                                 f'dotnet test {flag}{separator}***')
        values = ['NAME=private-value', '"NAME=private value"', 'NAME="private value"']
        for flag, separator, value in itertools.product(['--build-arg', '-e', '--env'], [' ', '='], values):
            with self.subTest(flag=flag, separator=separator, value=value):
                self.assertEqual(dg.short_text(f'docker build {flag}{separator}{value}', str(self.home)),
                                 f'docker build {flag}{separator}NAME=***')
        self.assertEqual(dg.short_text("dotnet test --label can't --token private-value", str(self.home)),
                         "dotnet test --label can't --token ***")
        self.assertEqual(dg.short_text('dotnet test "--token" "private value"', str(self.home)),
                         'dotnet test --token ***')

    def test_redacts_sensitive_assignments_including_nested_options(self):
        keys = ['TOKEN', 'client_secret', 'PASS', 'Password', 'PWD', 'api_key', 'Auth', 'CREDENTIAL']
        values = ['private-value', '"private value"', 'private" value"']
        for key, prefix, value in itertools.product(keys, ['', '--x='], values):
            with self.subTest(key=key, prefix=prefix, value=value):
                result = dg.short_text(f'dotnet test {prefix}{key}={value}', str(self.home))
                self.assertIn(f'{prefix}{key}=***', result)
                self.assertNotIn('private', result)
                self.assertNotIn('value', result)
        self.assertEqual(dg.short_text('dotnet test MODE=release --x=COUNT=3', str(self.home)),
                         'dotnet test MODE=release --x=COUNT=3')

    def test_redacts_npm_registry_auth_token(self):
        self.assertEqual(dg.short_text('npm config set //registry.example/:_authToken=private-value', str(self.home)),
                         'npm config set //registry.example/:_authToken=***')

    def test_redacts_authorization_and_api_key_headers(self):
        home = str(self.home)
        self.assertEqual(dg.short_text('curl -H "Authorization: Bearer abc123" https://x', home),
                         'curl -H "Authorization: Bearer ***" https://x')
        self.assertEqual(dg.short_text("curl --header 'authorization: basic dXNlcjpw' x", home),
                         "curl --header 'authorization: basic ***' x")
        self.assertEqual(dg.short_text('curl -H "X-Api-Key: k123" x', home),
                         'curl -H "X-Api-Key: ***" x')

    def test_redacts_long_flags_case_insensitively(self):
        self.assertEqual(dg.short_text('tool --PASSWORD hunter2 --Token t', str(self.home)),
                         'tool --PASSWORD *** --Token ***')

    def test_short_text_only_abbreviates_home_path_prefix(self):
        home = str(self.home)
        self.assertEqual(dg.short_text(f'{home} {home}/repo {home}-backup/repo', home, 1000),
                         f'~ ~/repo {home}-backup/repo')

    def test_attribution_section_handles_unexpected_errors_without_leaking_arguments(self):
        collect = Mock(side_effect=RuntimeError('unexpected --token private-value'))
        self.assertEqual(dg.attribution_section('Processes', collect, str(self.home)),
                         ['Processes:', '- unavailable: unexpected --token ***'])

    def test_writer_patterns(self):
        positives = [('dotnet', 'dotnet build'), ('MSBuild', 'MSBuild x'), ('VBCSCompiler', 'VBCSCompiler'),
                     ('node', '/bin/node /lib/yarn/bin/yarn.js'), ('node', 'node /lib/pnpm.cjs install'),
                     ('node', 'node /lib/npm-cli.js ci'), ('python3', 'python3 -m pip install x'),
                     ('python', 'python /bin/pip install x')]
        positives += [(name, f'{name} x') for name in ('yarn', 'npm', 'pnpm', 'cargo', 'go', 'tar', 'cp', 'rsync', 'ditto')]
        positives += [('docker', f'docker {cmd} x') for cmd in ('build', 'buildx', 'compose', 'pull')]
        positives += [('git', f'git {cmd} x') for cmd in ('clone', 'worktree', 'fetch')]
        for command, args in positives:
            with self.subTest(args=args):
                self.assertTrue(dg.writer_command('/bin/' + command, args))
        for command, args in [('node', 'node server.js'), ('docker', 'docker ps'), ('git', 'git status'),
                              ('python3', 'python3 script.py'), ('sleep', 'sleep 100')]:
            with self.subTest(args=args):
                self.assertFalse(dg.writer_command(command, args))

    def test_docker_attribution_uses_uptime_and_existing_allocation_only(self):
        output = ('a\trecent\tUp 2 minutes (healthy)\nb\told\tUp 3 minutes\n'
                  'c\tjust-started\tUp Less than a second\nd\tminute\tUp About a minute\n'
                  'e\trestarting\tRestarting (1) 2 seconds ago\n')
        _, info = self.evaluate([(880, 30), (1000, 24)])
        info['current']['watch'] = {'/docker/Docker.raw': 7 * G}
        def run(command, **kwargs):
            outputs = {'status': 'pi-phase: no active phases\n',
                       'ps': 'PID ELAPSED COMM ARGS\n', 'docker': output}
            return Mock(returncode=0, stdout=outputs.get(command[0], outputs.get(command[-1], '')), stderr='')
        with patch.object(dg.subprocess, 'run', side_effect=run) as call:
            lines = dg.attribution_lines(info, self.cfg)
        text = '\n'.join(lines)
        self.assertIn('a recent Up 2 minutes (healthy)', text)
        self.assertIn('c just-started', text)
        self.assertIn('d minute', text)
        self.assertNotIn('b old', text)
        self.assertNotIn('e restarting', text)
        self.assertIn('Docker.raw allocated now: 7.0 GiB', text)
        docker_calls = [item.args[0] for item in call.call_args_list if item.args[0][0] == 'docker']
        self.assertEqual(docker_calls, [['docker', 'ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}']])

    def test_attribution_failures_are_one_line_and_do_not_break_dry_run(self):
        _, info = self.evaluate([(880, 30), (1000, 24)])
        for failure in [FileNotFoundError('missing tool'), subprocess.TimeoutExpired('tool', 1),
                        Mock(returncode=1, stdout='', stderr='permission denied\nmore detail')]:
            with self.subTest(failure=failure), patch.object(dg.subprocess, 'run') as run:
                if isinstance(failure, Exception):
                    run.side_effect = failure
                else:
                    run.return_value = failure
                output = io.StringIO()
                with patch.object(sys, 'stdout', output):
                    dg.alert(1000, info, self.cfg, lambda text: self.fail('notified during dry run'),
                             lambda **kw: ([], {'walked': 0, 'total': 0, 'partial': False}), True)
                text = output.getvalue()
                self.assertIn('Likely writers (walk-free attribution', text)
                self.assertEqual(text.count('unavailable:'), 3)
                self.assertNotIn('\nmore detail', text)
                self.assertIn('Next notice after', text)

    def test_attribution_shared_deadline_and_cwd_failures(self):
        with patch.object(dg.time, 'monotonic', side_effect=[0, 24, 25]), \
                patch.object(dg.subprocess, 'run', return_value=Mock(returncode=0, stdout='', stderr='')) as run:
            commands = dg.AttributionCommands()
            commands.run(['ps'], 2)
            with self.assertRaisesRegex(OSError, 'budget exhausted'):
                commands.run(['docker'], 2)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.kwargs['timeout'], 1)
        with patch.object(dg.subprocess, 'run', side_effect=subprocess.TimeoutExpired('lsof', 1)):
            lines = dg.process_lines([(0, 123, '00:00', 'dotnet build')], dg.AttributionCommands(), str(self.home))
        self.assertEqual(lines, ['- pid=123 elapsed=00:00 cwd=unavailable: timed out dotnet build'])
        with patch.object(dg.subprocess, 'run', return_value=Mock(returncode=0, stdout='malformed', stderr='')):
            lines = dg.attribution_lines({'baseline': {'ts': 0}, 'current': {'ts': 120}}, self.cfg)
        self.assertIn('- unavailable: no readable running phases in status', lines)
        self.assertIn('- unavailable: unreadable docker ps output', lines)

    def test_isolated_probe_returns_partial_json_before_parent_deadline(self):
        worker = self.home / 'worker.py'
        worker.write_text("import json, sys, time\n"
                          "request = json.load(sys.stdin)\n"
                          "time.sleep(max(0, request['deadline'] - time.monotonic()))\n"
                          "json.dump([[], {'walked': 1, 'total': 2, 'partial': True}], sys.stdout)\n")
        self.cfg['probe_budget_seconds'] = 3.3
        start = time.monotonic()
        with patch.object(dg, 'worker_command', return_value=[sys.executable, str(worker)]):
            writers, coverage = dg.isolated_probe(self.cfg, 0)
        self.assertEqual(writers, [])
        self.assertEqual(coverage, {'walked': 1, 'total': 2, 'partial': True})
        self.assertLess(time.monotonic() - start, 2)

    def test_priority_units_from_active_and_recent_ledger_walk_before_discovery(self):
        roots = [self.home / name for name in ('active', 'recent', 'running', 'stale', 'other')]
        for root in roots:
            (root / 'src').mkdir(parents=True)
            (root / '.git').write_text('gitdir: elsewhere')
        ledger = self.agent / 'pi-phase/state/ledger' / f'{datetime.now(timezone.utc):%Y-%m-%d}.jsonl'
        ledger.parent.mkdir(parents=True)
        stamp = lambda age: datetime.fromtimestamp(time.time() - age, timezone.utc).isoformat()
        rows = [{'cwd': str(roots[1] / 'src'), 'endedAt': stamp(299)},
                {'cwd': str(roots[2]), 'endedAt': None},
                {'cwd': str(roots[3]), 'endedAt': stamp(301)},
                {'cwd': str(roots[0]), 'endedAt': stamp(1)}]
        ledger.write_text('x' * 1048576 + '\nnot json\n[]\n' + '\n'.join(map(json.dumps, rows)))
        active = {str(roots[0] / 'src'): {'dotnet'}}
        self.assertEqual(probe['priority_units'](active, time.time() - 300), list(map(str, roots[:3])))
        calls = []
        def walk(unit, *args):
            calls.append(unit)
            return 0, {}, True
        def discover(*args):
            self.assertEqual(calls, list(map(str, roots[:3])))
            return list(map(str, roots))
        def rank(found, *args):
            self.assertEqual(found, list(map(str, roots[3:])))
            return [((1, 0, unit), unit, []) for unit in found]
        with patch.dict(probe['top_writers'].__globals__, {'walk_unit': walk, 'discover_roots': discover,
                                                         'rank_units': rank}):
            _, coverage = probe['top_writers']([], None, 0, time.monotonic() + 5, active=active)
        self.assertEqual(calls, list(map(str, roots)))
        self.assertEqual(coverage, {'walked': 5, 'total': 5, 'partial': False})

    def test_walk_ranked_shares_remaining_time_and_keeps_partial_bytes(self):
        now = [0]
        deadlines = []
        def walk(unit, since, deadline, budget):
            deadlines.append(deadline)
            if unit == 'huge':
                now[0] = deadline
                budget.available()
                return 8192, {'other': 8192}, False
            return 4096, {'other': 4096}, True
        budget = probe['Budget'](10)
        ranked = [((0,), 'huge', []), ((1,), 'small', [])]
        with patch.object(time, 'monotonic', side_effect=lambda: now[0]), \
                patch.dict(probe['walk_ranked'].__globals__, {'walk_unit': walk}):
            writers, walked = probe['walk_ranked'](ranked, 0, budget)
        self.assertEqual(deadlines, [5, 10])
        self.assertEqual([writer['bytes'] for writer in writers], [8192, 4096])
        self.assertEqual(walked, 1)
        self.assertTrue(budget.partial)

    def test_sample_watch_allocated_size(self):
        watched = self.home / 'Docker.raw'
        watched.write_bytes(b'x' * 8192)
        self.cfg['watch_files'] = [str(watched), str(self.home / 'missing')]
        result = dg.sample(1000, self.cfg)
        self.assertEqual(result['watch'], {str(watched): watched.stat().st_blocks * 512})
        self.assertGreater(result['free'], 0)

    def test_probe_units_categories_symlinks_order_and_bounds(self):
        repos = self.home / 'repos'
        repo = repos / 'org/repo'
        wt = repos / 'org/.worktrees/wt'
        paths = ['TestResults/x.dmp', 'TestResults/result', 'src/obj/a.dll', '.ai-work/note', 'node_modules/pkg', 'other']
        for unit in (repo, wt):
            unit.mkdir(parents=True)
        for name in paths:
            file = wt / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b'x' * 8192)
        old = wt / 'old'
        old.write_bytes(b'x' * 8192)
        os.utime(old, (1, 1))
        (wt / 'link').symlink_to(old)
        (wt / 'linked-dir').symlink_to(repo, target_is_directory=True)
        self.assertEqual(set(probe['units'](repos, repos)), {str(repo), str(wt)})
        writers, coverage = probe['top_writers']([str(repos)], str(repos), time.time() - 60,
                                                time.monotonic() + 5, active={str(wt / 'src'): {'dotnet'}})
        self.assertFalse(coverage['partial'])
        self.assertEqual(writers[0]['path'], str(wt))
        self.assertEqual(writers[0]['bytes'], sum((wt / p).stat().st_blocks * 512 for p in paths))
        self.assertEqual(writers[0]['procs'], ['dotnet'])
        self.assertEqual(set(writers[0]['categories']), {'dumps', 'TestResults', 'bin/obj', '.ai-work', 'node_modules', 'other'})
        self.assertEqual(probe['top_writers']([str(repos)], str(repos), 0, time.monotonic() - 1, active={})[1],
                         {'walked': 0, 'total': 0, 'partial': True})
        budget = probe['Budget'](time.monotonic() + 5, cap=3)
        self.assertFalse(probe['walk_unit'](wt, 0, budget.deadline, budget=budget)[2])
        budget = probe['Budget'](time.monotonic() + 5, cap=2)
        probe['units'](repos, repos, budget=budget)
        self.assertTrue(budget.partial)
        with patch.dict(probe['top_writers'].__globals__, {'walk_unit': lambda unit, *a, **kw: (0, {}, True)}) as scope:
            with patch.dict(scope, {'walk_unit': unittest.mock.Mock(side_effect=scope['walk_unit'])}):
                probe['top_writers']([str(repos)], str(repos), 0, time.monotonic() + 5, active={str(wt): {'dotnet'}})
                self.assertEqual(scope['walk_unit'].call_args_list[0].args[0], str(wt))

    def test_huge_fake_directory_is_entry_bounded(self):
        file_path = str(self.home / 'huge/file')
        class HugeDirectory:
            visited = 0

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def __iter__(self):
                for _ in range(1000000):
                    self.visited += 1
                    yield unittest.mock.Mock(path=file_path, is_symlink=lambda: False,
                                             is_dir=lambda **kw: False, is_file=lambda **kw: True,
                                             stat=lambda **kw: unittest.mock.Mock(st_blocks=8, st_mtime=time.time()))

        directory = HugeDirectory()
        budget = probe['Budget'](time.monotonic() + 5, cap=10)
        with patch.object(os, 'scandir', return_value=directory):
            probe['units'](self.home, None, budget=budget)
        self.assertTrue(budget.partial)
        self.assertLessEqual(directory.visited, 11)
        small = self.home / 'small'
        small.mkdir()
        (small / 'file').write_bytes(b'x' * 8192)
        real_scandir = os.scandir
        budget = probe['Budget'](time.monotonic() + 5, cap=20)
        ranked = [((0,), str(self.home / 'huge'), []), ((1,), str(small), [])]
        with patch.object(os, 'scandir', side_effect=lambda path: directory if path == ranked[0][1]
                          else real_scandir(path)):
            writers, walked = probe['walk_ranked'](ranked, 0, budget)
        self.assertEqual(walked, 1)
        self.assertEqual({w['path'] for w in writers}, {str(self.home / 'huge'), str(small)})
        self.assertTrue(all(w['bytes'] > 0 for w in writers))
        self.assertLessEqual(budget.entries, 20)
        self.assertTrue(budget.partial)
        self.assertEqual(probe['parse_cwds']('p12\ncdotnet\nn/tmp/repo\np13\nctesthost\nn/tmp/repo\n'),
                         {'/tmp/repo': {'dotnet', 'testhost'}})

    def test_plist(self):
        with (ROOT / 'agent/launchd/com.example.disk-growth.plist').open('rb') as stream:
            value = plistlib.load(stream)
        self.assertEqual(value['Label'], 'com.example.disk-growth')
        self.assertEqual(value['ProgramArguments'], ['__HOME__/.pi/agent/bin/disk-growth'])
        self.assertEqual(value['StartInterval'], 60)
        self.assertEqual(value['ProcessType'], 'Standard')
        self.assertFalse(value['LowPriorityIO'])
        self.assertTrue(value['RunAtLoad'])
        self.assertEqual(value['EnvironmentVariables']['PYTHONDONTWRITEBYTECODE'], '1')


if __name__ == '__main__':
    unittest.main()
