"""All diagnostics use canned probes; no live Docker or machine mutations."""
import contextlib
import datetime as dt
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'agent/bin/dev-doctor'
loader = importlib.machinery.SourceFileLoader('dev_doctor', str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
doctor = importlib.util.module_from_spec(spec)
loader.exec_module(doctor)
CID = 'a' * 64


class Runner:
    def __init__(self, **responses):
        self.responses = responses
        self.calls = []

    def __call__(self, cmd, timeout=10):
        self.calls.append(cmd)
        key = ' '.join(cmd[1:]) if cmd[0] == 'docker' else Path(cmd[0]).name
        return self.responses.get(key)


def container(status='exited', hours=1, labels=None):
    timestamp = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)).isoformat()
    return dict(Id=CID, State=dict(Status=status, Running=status == 'running',
                                  StartedAt=timestamp, FinishedAt=timestamp),
                Config=dict(Labels=labels or {}))


def docker_runner(containers, **responses):
    return Runner(**{'ps -aq --no-trunc': CID, 'inspect ' + CID: json.dumps(containers), **responses})


class DoctorTests(unittest.TestCase):
    def test_runner_success_and_all_failures(self):
        with patch.object(doctor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'out', 'err')):
            self.assertEqual(doctor.run(['tool']), 'outerr')
        with patch.object(doctor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'error')):
            self.assertIsNone(doctor.run(['tool']))
        for error in (FileNotFoundError(), subprocess.TimeoutExpired('tool', 1), PermissionError()):
            with patch.object(doctor.subprocess, 'run', side_effect=error):
                self.assertIsNone(doctor.run(['tool']))

    def test_spotlight_on_off_missing(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(doctor.sys, 'platform', 'darwin'):
            runner = Runner(mdutil='Indexing enabled.', ps=' 30.0 /usr/libexec/mds mds\n 0.1 mdworker mdworker')
            found = doctor.check_spotlight(runner, Path(tmp))
            self.assertEqual(found[0]['severity'], 'warn')
            self.assertIn('30.1%', found[0]['evidence'])
            self.assertFalse(found[0]['auto'])
            self.assertEqual(doctor.check_spotlight(Runner(mdutil='Indexing disabled.'), Path(tmp)), [])
            self.assertIn('Skipped', doctor.check_spotlight(Runner(), Path(tmp))[0]['evidence'])
        with patch.object(doctor.sys, 'platform', 'linux'):
            self.assertIn('macOS', doctor.check_spotlight(Runner(), None)[0]['evidence'])

    def test_docker_memory_pressure_and_healthy(self):
        runner = Runner(**{'info --format {{json .}}': json.dumps(dict(MemTotal=20 * doctor.GIB,
                                                                        OperatingSystem='Docker Desktop'))})
        with patch.object(doctor, 'host_memory', return_value=(48 * doctor.GIB, 5 * doctor.GIB)):
            self.assertTrue(any(f['severity'] == 'high' for f in doctor.check_docker_memory(runner)))
        with patch.object(doctor, 'host_memory', return_value=(64 * doctor.GIB, 0)):
            self.assertTrue(all(f['severity'] == 'info' for f in doctor.check_docker_memory(runner)))
        self.assertIn('Skipped', doctor.check_docker_memory(Runner())[0]['evidence'])
        with patch.object(doctor, 'host_memory', return_value=(None, None)):
            self.assertIn('Skipped', doctor.check_docker_memory(runner)[0]['evidence'])

    def test_host_memory_mac_and_linux(self):
        with patch.object(doctor.sys, 'platform', 'darwin'):
            def runner(cmd):
                return str(48 * doctor.GIB) if cmd[-1] == 'hw.memsize' else 'total = 6144.00M used = 5120.00M free = 1024.00M'
            self.assertEqual(doctor.host_memory(runner), (48 * doctor.GIB, 5 * doctor.GIB))
        with patch.object(doctor.sys, 'platform', 'linux'), patch.object(Path, 'read_text', return_value='MemTotal: 100 kB\nSwapTotal: 80 kB\nSwapFree: 20 kB\n'):
            self.assertEqual(doctor.host_memory(Runner()), (102400, 61440))

    def test_stale_exited_old_young_running_and_missing(self):
        result = doctor.check_docker_stale(docker_runner([container()]))
        self.assertTrue(result[0]['auto'])
        self.assertEqual(result[0]['suggest'], 'docker rm ' + CID)
        for c in (container(hours=.1), container(status='running', hours=1)):
            self.assertEqual(doctor.check_docker_stale(docker_runner([c])), [])
        self.assertEqual(doctor.check_docker_stale(Runner(**{'ps -aq --no-trunc': ''})), [])
        self.assertIn('Skipped', doctor.check_docker_stale(Runner())[0]['evidence'])

    def test_idle_running_and_reclaimable_suggest_only(self):
        runner = docker_runner([container('running', 7)], **{
            'stats --no-stream --format {{.ID}} {{.CPUPerc}}': CID[:12] + ' 0.00%',
            'system df --format {{json .}}': '\n'.join(json.dumps(dict(Type=t, Reclaimable='2GB (50%)'))
                                                       for t in ('Images', 'Build Cache'))})
        result = doctor.check_docker_stale(runner)
        self.assertEqual(len(result), 3)
        self.assertTrue(all(not f['auto'] for f in result))
        self.assertNotIn('prune -a', str(result))
        self.assertIn('docker rm -f', result[0]['suggest'])
        runner.responses['stats --no-stream --format {{.ID}} {{.CPUPerc}}'] = CID[:12] + ' 1.00%'
        self.assertEqual(len(doctor.check_docker_stale(runner)), 2)

    def test_live_or_unknown_phase_protects_testcontainers(self):
        for status in (None, 'pi-phase: test specs pid=1 cwd=/tmp elapsed=1s running'):
            runner = docker_runner([container('running', 7, {'org.testcontainers': 'true'})], **{
                'pi-phase': status, 'stats --no-stream --format {{.ID}} {{.CPUPerc}}': CID[:12] + ' 0.00%'})
            self.assertEqual(doctor.check_docker_stale(runner), [])

    def test_oversubscription_positive_negative(self):
        with patch.object(doctor.os, 'cpu_count', return_value=2), patch.object(doctor, 'read_json', return_value={'heavy_slots': 2}):
            found = doctor.check_oversubscription(Runner(ps=' 80 dotnet dotnet build\n 80 msbuild msbuild\n 80 tsc tsc'))
            self.assertEqual(found[0]['severity'], 'warn')
            self.assertEqual(doctor.check_oversubscription(Runner(ps=' 0 bash bash')), [])
        self.assertIn('Skipped', doctor.check_oversubscription(Runner())[0]['evidence'])

    def test_msbuild_disabled_and_unset(self):
        with patch.dict(os.environ, {'MSBUILDDISABLENODEREUSE': '1'}):
            result = doctor.check_msbuild_env(Runner(ps=' 1 dotnet VBCSCompiler'))[0]
            self.assertIn('=1', result['evidence'])
            self.assertIn('1 VBCSCompiler', result['evidence'])
            self.assertIn('Keep', result['suggest'])
        with patch.dict(os.environ, {}, clear=True):
            result = doctor.check_msbuild_env(Runner(ps=''))[0]
            self.assertIn('unset', result['evidence'])
            self.assertIn('export MSBUILD', result['suggest'])
        self.assertIn('Skipped', doctor.check_msbuild_env(Runner())[0]['evidence'])

    def test_container_specs_test_vs_integration_or_no_containers(self):
        runner = docker_runner([container('running', labels={'org.testcontainers': 'true'})], **{
            'pi-phase': 'pi-phase: test specs pid=1 cwd=/tmp elapsed=1s running'})
        self.assertEqual(doctor.check_testcontainers_in_test(runner)[0]['severity'], 'warn')
        for status in ('pi-phase: integration specs pid=1 cwd=/tmp elapsed=1s running',
                       'pi-phase: no active phases'):
            runner.responses['pi-phase'] = status
            self.assertEqual(doctor.check_testcontainers_in_test(runner), [])
        runner.responses['pi-phase'] = 'pi-phase: test specs pid=1 cwd=/tmp elapsed=1s running'
        runner.responses['inspect ' + CID] = json.dumps([container('running')])
        self.assertEqual(doctor.check_testcontainers_in_test(runner), [])
        self.assertIn('Skipped', doctor.check_testcontainers_in_test(Runner())[0]['evidence'])

    def test_phase_parser_is_conservative(self):
        for status in (None, '', 'unrecognized output'):
            self.assertIsNone(doctor.phase_state(Runner(**{'pi-phase': status})))
        self.assertEqual(doctor.phase_state(Runner(**{'pi-phase': 'pi-phase: no active phases\npi-phase: queued priority=low kind=build label=foo waited=2s rank=1'})), [])
        self.assertEqual(doctor.phase_state(Runner(**{'pi-phase': 'pi-phase: unknown unknown pid=? cwd=? elapsed=0s orphan-group'})), ['unknown'])

    def test_worktree_warm_cold_size_and_bounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('warm', 'cold'):
                path = root / '.worktrees' / name
                path.mkdir(parents=True)
                (path / '.git').write_text('gitdir: /repo/.git/worktrees/' + name)
            output = root / '.worktrees/warm/obj'
            output.mkdir()
            (output / 'test.bin').write_bytes(b'x' * 1024)
            result = doctor.check_worktrees(Runner(), root)[0]
            self.assertIn('2 worktrees, 1 warm', result['evidence'])
            self.assertIn('sample', result['why'])
            self.assertIn('Sampled', doctor.check_worktrees(Runner(), root, max_worktrees=1)[0]['evidence'])
            self.assertIn('no linked', doctor.check_worktrees(Runner(), root, budget=0)[0]['evidence'])
        self.assertIn('Skipped', doctor.check_worktrees(Runner(), None)[0]['evidence'])

    def test_repos_root_precedence_and_missing(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, 'home', return_value=Path(tmp)):
            self.assertIsNone(doctor.repos_root())
            (Path(tmp) / 'repos').mkdir()
            self.assertEqual(doctor.repos_root(), Path(tmp) / 'repos')
            with patch.object(doctor, 'read_json', return_value={'reposRoot': '/saved'}):
                self.assertEqual(doctor.repos_root(), Path('/saved'))
                self.assertEqual(doctor.repos_root('/explicit'), Path('/explicit'))

    def test_apply_refuses_active_unknown_and_allows_idle_only(self):
        for state, allowed in ((None, False), ('garbage', False),
                               ('pi-phase: test specs pid=1 cwd=/tmp elapsed=1s running', False),
                               ('pi-phase: no active phases', True)):
            runner = docker_runner([container()], **{'pi-phase': state, 'rm ' + CID: CID})
            result = doctor.check_docker_stale(runner)
            result.append(doctor.finding('docker-stale', 'warn', 'idle', 'why', 'docker rm -f ' + CID))
            doctor.apply_findings(result, runner)
            self.assertEqual(['docker', 'rm', CID] in runner.calls, allowed)
            self.assertFalse(any('-f' in cmd for cmd in runner.calls))
            if not allowed:
                self.assertIn('refused', result[0]['evidence'])

    def test_json_shape_only_and_no_mutation_by_default(self):
        runner = docker_runner([container()])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(doctor.main(['--json', '--only', 'docker-stale'], runner), 0)
        data = json.loads(out.getvalue())
        self.assertIsInstance(data, list)
        self.assertEqual(set(data[0]), {'id', 'severity', 'evidence', 'why', 'suggest', 'auto'})
        self.assertIsInstance(data[0]['auto'], bool)
        self.assertFalse(any(cmd[1:2] == ['rm'] for cmd in runner.calls))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            doctor.main(['--only', 'bogus'], runner)
        self.assertEqual(error.exception.code, 2)

    def test_total_probe_budget(self):
        runner = Runner()
        with patch.object(doctor.time, 'monotonic', side_effect=[0, 46]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(doctor.main(['--only', 'msbuild-env'], runner), 0)
        self.assertEqual(runner.calls, [])


def psline(pid=100, ppid=1, elapsed='02:00:00', cpu='00:00:10', pcpu=0, rss=1024, tty='??', command='chrome --headless'):
    return f'{pid} {ppid} {elapsed} {cpu} {pcpu} {rss} {tty} {command}'


def anchor(process, timestamp):
    return dict(timestamp=timestamp, elapsed=process['elapsed'], cpu=process['cpu'],
                command_hash=doctor.hashlib.sha256(process['command'].encode()).hexdigest())


def rule():
    return dict(name='example', labels={'managed-by': 'test', 'kind': 'warm'},
                report_labels={'kind': 'session'}, min_age_minutes=30,
                owner_label='owner', owner_hash='sha256-cwd-16',
                owner_process_names=['dotnet', 'testhost', 'Studio'], max_removals=10)


def owned_container(kind='warm', minutes=40, owner='a' * 16, cid=CID):
    c = container('running', labels={'managed-by': 'test', 'kind': kind, 'owner': owner})
    c.update(Id=cid, Name='/warm-example', Created=(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)).isoformat())
    c['Config']['Image'] = 'example:1'
    return c


def owned_runner(population, ps='', **responses):
    # All fixtures use the same id listing to keep command matching deterministic.
    return docker_runner(population, **{
        'context show': 'desktop-linux',
        'context inspect desktop-linux --format {{json .Endpoints.docker.Host}}': '"unix:///tmp/docker.sock"',
        'ps': ps, 'pi-phase': 'pi-phase: no active phases', **responses})


class AddendumTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.env = patch.dict(os.environ, {'DEV_DOCTOR_STATE_DIR': self.scratch.name, 'DOCKER_HOST': ''})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_browser_lifetime_hot_root_only_and_phase_independent(self):
        snapshot = psline(cpu='01:01:00') + '\n' + psline(101, 100, command='chrome --type=renderer')
        runner = Runner(ps=snapshot, **{'kill': '', 'pi-phase': 'pi-phase: test x pid=1 cwd=/tmp elapsed=1s running'})
        findings = doctor.check_browsers(runner)
        self.assertEqual(len(findings), 1)
        self.assertTrue(findings[0]['auto'])
        doctor.apply_findings(findings, runner)
        self.assertIn(['kill', '-TERM', '100'], runner.calls)
        self.assertFalse(any(cmd[-1] == '101' for cmd in runner.calls))
        self.assertFalse(any(Path(cmd[0]).name == 'pi-phase' for cmd in runner.calls))

    def test_browser_recent_cpu_hot_not_current_spike(self):
        runner = Runner(ps=psline(elapsed='03:00:00', cpu='00:40:00', pcpu=0))
        current = doctor.process_snapshot(runner)[100]
        prior = {**current, 'elapsed': 7200, 'cpu': 10}
        samples = {'processes': {'100': anchor(prior, 1000)}}
        self.assertTrue(doctor.check_browsers(runner, samples=samples, now=4600)[0]['auto'])
        # High instantaneous CPU without a sustained average does not qualify.
        self.assertEqual(doctor.check_browsers(Runner(ps=psline(cpu='00:00:01', pcpu=99))), [])
        self.assertEqual(doctor.check_browsers(Runner(ps=psline(elapsed='29:59', cpu='20:00'))), [])

    def test_browser_idle_requires_two_hour_valid_group_delta(self):
        runner = Runner(ps=psline(elapsed='04:00:00', cpu='00:00:20'))
        current = doctor.process_snapshot(runner)[100]
        samples = {'processes': {'100': anchor({**current, 'elapsed': 7200, 'cpu': 10}, 1000)},
                   'browser_groups': {'100': [100]}}
        self.assertIn('idle', doctor.check_browsers(runner, samples=samples, now=8200)[0]['evidence'])
        samples['processes']['100']['timestamp'] = 5000
        self.assertEqual(doctor.check_browsers(runner, samples=samples, now=8200), [])
        # PID reuse / different start time cannot establish idle or sample-hot status.
        self.assertIsNone(doctor.prior_process(samples, current, 8200))

    def test_browser_persistent_and_user_chrome_suggest_only(self):
        for command in ('chrome', 'chrome --headless --user-data-dir=' + str(Path.home() / '.pi/browser-profile'),
                        'chrome --headless --user-data-dir=~/.pi/custom'):
            found = doctor.check_browsers(Runner(ps=psline(command=command, cpu='01:10:00')))
            self.assertEqual(len(found), 1)
            self.assertFalse(found[0]['auto'])
        self.assertFalse(doctor.chrome('node /tmp/chrome.js --headless'))
        self.assertTrue(doctor.chrome('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless'))
        self.assertFalse(doctor.chrome('node chrome-devtools-mcp'))
        for path in ('/tmp/', '/private/tmp/', '/private/var/folders/a/T/'):
            self.assertTrue(doctor.ephemeral_browser('chrome --user-data-dir=' + path + 'puppeteer_dev_chrome_profile-123'))
        self.assertFalse(doctor.ephemeral_browser('chrome --user-data-dir=/permanent/puppeteer_dev_chrome_profile-1'))

    def test_browser_fuse_and_revalidation(self):
        runner = Runner(ps='\n'.join(psline(pid=p, cpu='01:10:00') for p in range(100, 107)), kill='')
        findings = doctor.check_browsers(runner)
        self.assertEqual(sum(f['auto'] for f in findings), 5)
        doctor.apply_findings(findings, runner)
        self.assertEqual(sum(cmd[0] == 'kill' for cmd in runner.calls), 5)
        changed = Runner(ps=psline(elapsed='00:01', command='chrome --headless'), kill='')
        doctor.apply_findings(findings, changed)
        self.assertFalse(any(cmd[0] == 'kill' for cmd in changed.calls))
        self.assertIn('Skipped', doctor.check_browsers(Runner())[0]['evidence'])

    def test_sample_anchors_persist_and_state_is_small(self):
        runner = Runner(ps=psline())
        current = doctor.process_snapshot(runner)[100]
        prior = {**current, 'elapsed': 3600}
        samples = {'processes': {'100': anchor(prior, 1000)}}
        next_samples = {}
        doctor.check_browsers(runner, samples=samples, next_samples=next_samples, now=4600)
        self.assertEqual(next_samples['processes']['100']['timestamp'], 1000)
        self.assertTrue(doctor.save_samples(next_samples))
        self.assertEqual(doctor.load_samples(), next_samples)
        self.assertNotIn('command', next_samples['processes']['100'])
        self.assertEqual(doctor.duration('2-03:04:05'), 183845)
        self.assertIsNone(doctor.process_snapshot(Runner(ps='bad snapshot')))

    def test_idle_pi_session_helpers_and_mcp_rss_are_suggest_only(self):
        snapshot = '\n'.join((psline(elapsed='08:00:00', command='node /opt/pi-coding-agent/dist/cli.js', tty='ttys002'),
                              psline(101, 100, rss=2048, command='gitstatusd'),
                              psline(102, 100, rss=4096, command='node chrome-devtools-mcp')))
        runner = Runner(ps=snapshot)
        current = doctor.process_snapshot(runner)[100]
        samples = {'pi_processes': {'100': anchor({**current, 'elapsed': 14400, 'cpu': 9}, 1000)}}
        found = doctor.check_pi_sessions(runner, samples=samples, now=15400)
        self.assertEqual(len(found), 2)
        self.assertIn('4.0 MiB', found[0]['evidence'])
        self.assertIn('gitstatusd', found[1]['evidence'])
        self.assertIn('TTY=ttys002', found[1]['evidence'])
        self.assertTrue(all(not f['auto'] for f in found))
        self.assertEqual(len(doctor.check_pi_sessions(runner)), 1)
        self.assertFalse(doctor.pi_process('node unrelated.js'))
        self.assertTrue(doctor.pi_process('/usr/local/bin/pi'))
        self.assertIn('Skipped', doctor.check_pi_sessions(Runner())[0]['evidence'])

    def test_docker_sizing_peak_floor_and_units(self):
        runner = Runner(**{'stats --no-stream --format {{json .}}': '{"MemUsage":"2GiB / 14GiB"}\n{"MemUsage":"512MiB / 14GiB"}'})
        next_samples = {}
        found = doctor.docker_sizing(runner, {}, next_samples, 48 * doctor.GIB, 14 * doctor.GIB)
        self.assertEqual(next_samples['docker_peak_bytes'], 2.5 * doctor.GIB)
        self.assertIn('8 GiB', found[0]['suggest'])
        found = doctor.docker_sizing(runner, {'docker_peak_bytes': 10 * doctor.GIB}, next_samples, 48 * doctor.GIB, 14 * doctor.GIB)
        self.assertIn('15 GiB', found[0]['suggest'])
        self.assertEqual(doctor.memory_bytes('1GB'), 1000 ** 3)
        self.assertTrue(all(not f['auto'] for f in found))
        self.assertIn('Skipped', doctor.docker_sizing(Runner(), {}, {}, 1, 1)[0]['evidence'])

    def test_owned_rule_self_test_a_to_e(self):
        owner = doctor.hashlib.sha256(b'/live/owner').hexdigest()[:16]
        a = owned_container(cid='a' * 64)
        b = owned_container(minutes=10, cid='b' * 64)
        c = owned_container(owner=owner, cid='c' * 64)
        d = owned_container(kind='session', cid='d' * 64)
        e = owned_container(cid='e' * 64)
        e['Config']['Labels'] = {}
        runner = owned_runner([a, b, c, d, e], ps=psline(command='dotnet test'), lsof='p100\nn/live/owner', **{'rm -f ' + CID: CID})
        with patch.object(doctor, 'owned_rules', return_value=[rule()]):
            found = doctor.check_owned_containers(runner)
            self.assertEqual([f['suggest'] for f in found if f['auto']], ['docker rm -f ' + CID])
            self.assertTrue(any('report-only' in f['evidence'] for f in found))
            doctor.apply_findings(found, runner)
        self.assertIn(['docker', 'rm', '-f', CID], runner.calls)
        self.assertEqual(sum(cmd[1:3] == ['rm', '-f'] for cmd in runner.calls), 1)

    def test_owned_missing_owner_unreadable_cwd_context_and_phase_block(self):
        for missing in ('', None):
            runner = owned_runner([owned_container(owner=missing)])
            with patch.object(doctor, 'owned_rules', return_value=[rule()]):
                found = doctor.check_owned_containers(runner)
            self.assertFalse(any(f['auto'] for f in found))
            self.assertTrue(any('unknown' in f['why'] for f in found))
        with patch.object(doctor, 'owned_rules', return_value=[rule()]):
            runner = owned_runner([owned_container()], ps=psline(command='dotnet test'))
            self.assertFalse(any(f['auto'] for f in doctor.check_owned_containers(runner)))
            for context in ('remote', None):
                runner = owned_runner([owned_container()], **{'context show': context})
                self.assertIn('Skipped', doctor.check_owned_containers(runner)[0]['evidence'])
            runner = owned_runner([owned_container()], **{'context inspect desktop-linux --format {{json .Endpoints.docker.Host}}': '"tcp://remote:2375"'})
            self.assertFalse(any(f['auto'] for f in doctor.check_owned_containers(runner)))
            for state in (None, 'pi-phase: integration x pid=1 cwd=/tmp elapsed=1s running',
                          'pi-phase: build x pid=1 cwd=/tmp elapsed=1s running'):
                runner = owned_runner([owned_container()], **{'pi-phase': state})
                found = doctor.check_owned_containers(runner)
                doctor.apply_findings(found, runner)
                self.assertFalse(any(cmd[1:3] == ['rm', '-f'] for cmd in runner.calls))
            with patch.dict(os.environ, {'DOCKER_HOST': 'tcp://remote:2375'}):
                self.assertFalse(doctor.local_docker(owned_runner([])))

    def test_owned_fuse_empty_and_invalid_rules(self):
        population = [owned_container(cid=f'{n:064x}') for n in range(1, 12)]
        with patch.object(doctor, 'owned_rules', return_value=[rule()]):
            found = doctor.check_owned_containers(owned_runner(population))
            self.assertEqual(sum(f['auto'] for f in found), 10)
            self.assertTrue(any('fuse' in f['why'] for f in found))
            self.assertIn('checked 0', doctor.check_owned_containers(owned_runner([]))[-1]['evidence'])
        with patch.object(doctor, 'owned_rules', return_value=[{}]):
            self.assertIn('invalid', doctor.check_owned_containers(Runner())[0]['evidence'])
        with patch.object(doctor, 'owned_rules', return_value=[]):
            self.assertIn('Checked 0', doctor.check_owned_containers(Runner())[0]['evidence'])

    def test_profile_symlinks_and_unrelated_tmp_arguments_are_not_safe(self):
        root = Path(self.scratch.name)
        home = root / 'home'
        persistent = home / '.pi/browser-profile'
        persistent.mkdir(parents=True)
        link = root / 'puppeteer_dev_chrome_profile-link'
        link.symlink_to(persistent, target_is_directory=True)
        with patch.object(Path, 'home', return_value=home):
            self.assertFalse(doctor.ephemeral_browser(f'chrome --headless --user-data-dir={link}'))
        self.assertFalse(doctor.ephemeral_browser('chrome --user-data-dir=/permanent/puppeteer_dev_chrome_profile-1 --other=/tmp/'))
        self.assertFalse(doctor.chrome('/usr/bin/node /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless'))

    def test_guardian_periodic_call_missing_and_failure(self):
        root = Path(self.scratch.name)
        binary = root / 'bin'
        binary.mkdir()
        guardian = binary / 'docker-guardian'
        guardian.write_text((SCRIPT.parent / 'docker-guardian').read_text())
        fake = root / 'fake'
        fake.mkdir()
        for tool in ('docker', 'pgrep'):
            path = fake / tool
            path.write_text('#!/bin/sh\nexit 0\n')
            path.chmod(0o755)
        stub = binary / 'dev-doctor'
        stub.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCTOR_CALLS"\nprintf "browsers: action taken: test\\n"\nexit "${DOCTOR_EXIT:-0}"\n')
        stub.chmod(0o755)
        state = root / 'state'
        state.mkdir()
        (state / 'last-gc').write_text(str(int(doctor.time.time())))
        log = root / 'guardian.log'
        calls = root / 'calls'
        env = {**os.environ, 'HOME': str(root), 'DOCKER_GUARDIAN_TEST_PATH': str(fake),
               'DOCKER_GUARDIAN_STATE': str(state), 'DOCKER_GUARDIAN_LOG': str(log),
               'DOCTOR_CALLS': str(calls)}
        def invoke():
            result = subprocess.run(['/bin/bash', str(guardian)], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        invoke()
        self.assertEqual(calls.read_text().splitlines(), ['--apply --only browsers,owned-containers,docker-stale --quiet'])
        self.assertIn('action taken', log.read_text())
        invoke()
        self.assertEqual(len(calls.read_text().splitlines()), 1)
        (state / 'last-doctor').write_text('0')
        env['DOCTOR_EXIT'] = '7'
        invoke()
        self.assertIn('exit=7 (guardian continues)', log.read_text())
        stub.rename(binary / 'unavailable-doctor')
        (state / 'last-doctor').write_text('0')
        invoke()
        self.assertEqual(len(calls.read_text().splitlines()), 2)

    def test_install_new_files_and_preserve_existing_rules(self):
        home = Path(self.scratch.name) / 'install-home'
        home.mkdir()
        env = {**os.environ, 'HOME': str(home)}
        for first in (True, False):
            result = subprocess.run(['./install.sh', '--user', 'einari', '--repos-root', '/tmp/x'],
                                    cwd=SCRIPT.parents[2], env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = home / '.pi/agent/dev-doctor.json'
            if first:
                self.assertIn('owned_container_rules', json.loads(config.read_text()))
                config.write_text('{"owned_container_rules":[]}')
            else:
                self.assertEqual(config.read_text(), '{"owned_container_rules":[]}')
        self.assertTrue(os.access(home / '.pi/agent/bin/dev-doctor', os.X_OK))
        self.assertTrue((home / '.agents/skills/dev-machine-performance/SKILL.md').is_file())

    def test_quiet_actions_only_and_sample_category_preservation(self):
        runner = Runner(ps=psline(cpu='01:10:00'), kill='')
        doctor.save_samples({'pi_processes': {'1': {'timestamp': 1}}})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            doctor.main(['--only', 'browsers', '--quiet'], runner)
        self.assertEqual(out.getvalue(), '')
        self.assertIn('1', doctor.load_samples()['pi_processes'])
        with contextlib.redirect_stdout(out):
            doctor.main(['--only', 'browsers', '--quiet', '--apply'], runner)
        self.assertIn('action taken: kill -TERM 100', out.getvalue())


if __name__ == '__main__':
    unittest.main()
