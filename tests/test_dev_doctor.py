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
            self.assertEqual(doctor.check_docker_memory(runner)[0]['severity'], 'high')
        with patch.object(doctor, 'host_memory', return_value=(64 * doctor.GIB, 0)):
            self.assertEqual(doctor.check_docker_memory(runner), [])
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


if __name__ == '__main__':
    unittest.main()
