"""docker-guardian driven end to end with stub executables, a fake HOME and an isolated state dir.

No real Docker, launchd, osascript or pkill is reached: every external command is a stub placed
first on PATH through DOCKER_GUARDIAN_TEST_PATH, and each call is recorded in a call log.
Time cannot be injected, so budget scenarios use state-file timestamps relative to the real clock.
"""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'agent/bin/docker-guardian'
CID = 'c' * 12


def image_id(char):
    return 'sha256:' + char * 64


DOCKER_STUB = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ['STUB_DIR']
args = sys.argv[1:]
with open(d + '/calls.log', 'a') as f:
    f.write('docker ' + ' '.join(args) + '\n')
cfg = json.load(open(d + '/docker.json'))
def out(text=''):
    if text:
        print(text)
    sys.exit(0)
if args[:2] == ['ps', '-q']:
    sys.exit(cfg.get('ps_rc', 0))
if args[:2] == ['ps', '-aq'] and '--no-trunc' in args:
    out('\n'.join(c['id'] for c in cfg.get('containers', [])))
if args[:2] == ['ps', '-aq']:
    out('\n'.join(c['id'] for c in cfg.get('containers', []) if c['status'] in ('exited', 'dead')))
if args[:1] == ['inspect'] and '--format' in args:
    ids = [a for a in args[3:]]
    by = {c['id']: c for c in cfg.get('containers', [])}
    out('\n'.join(by[i]['image'] for i in ids))
if args[:1] == ['inspect'] and '-f' in args:
    by = {c['id']: c for c in cfg.get('containers', [])}
    out(by[args[-1]]['finished'])
if args[:2] == ['context', 'show']:
    out('desktop-linux')
if args[:2] == ['context', 'inspect']:
    out('"unix:///tmp/stub.sock"')
if args[:3] == ['image', 'ls', '-q']:
    imgs = cfg.get('images', [])
    if '--filter' in args:
        imgs = [i for i in imgs if i.get('dangling')]
    out('\n'.join(i['Id'] for i in imgs))
if args[:2] == ['image', 'inspect']:
    refs = args[2:]
    by = {i['Id']: i for i in cfg.get('images', [])}
    if all(r in by for r in refs):
        out(json.dumps([by[r] for r in refs]))
    found = [i for i in cfg.get('images', []) if refs[0] in (i.get('RepoTags') or [])]
    out(json.dumps(found))
if args[:1] == ['rmi']:
    out('Untagged: ' + args[1])
if args[:2] == ['network', 'ls']:
    out('n1')
sys.exit(0)
'''


class GuardianCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp')  # short path: unix socket limit
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.home.mkdir()
        self.state = self.root / 'state'
        self.state.mkdir()
        self.stubs = self.root / 'stubs'
        self.stubs.mkdir()
        self.bin = self.root / 'bin'  # lone copy: no sibling dev-doctor can be picked up
        self.bin.mkdir()
        shutil.copy(SCRIPT, self.bin / 'docker-guardian')
        shutil.copy(SCRIPT.with_name('phase_status.py'), self.bin / 'phase_status.py')
        self.log = self.root / 'logs/docker-guardian.log'
        self.calls = self.stubs / 'calls.log'
        self.calls.touch()
        self.sock_path = self.root / 's.sock'
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(self.sock_path))
        self.addCleanup(self.server.close)
        (self.stubs / 'running').touch()
        (self.stubs / 'up').touch()
        self.docker_cfg = {}
        self.write_docker()
        self.stub('docker', DOCKER_STUB)
        record = '#!/bin/sh\necho "$(basename "$0") $*" >> "$STUB_DIR/calls.log"\n'
        self.stub('curl', record + '[ -f "$STUB_DIR/up" ]\n')
        self.stub('open', record + 'if [ "${STUB_OPEN_FIXES:-1}" = 1 ]; then touch "$STUB_DIR/up"; fi\n')
        self.stub('pgrep', record + 'case "$*" in *Docker.app*) [ -f "$STUB_DIR/running" ];; *) exit 1;; esac\n')
        for name in ('osascript', 'pkill'):
            self.stub(name, record)
        self.stub('sleep', '#!/bin/sh\nexit 0\n')
        self.stub('sysctl', '#!/bin/sh\necho "{ 0.10 0.10 0.10 }"\n')
        self.stub('memory_pressure', '#!/bin/sh\nexit 0\n')
        self.extra_env = {}

    def stub(self, name, body):
        path = self.stubs / name
        path.write_text(body if body.startswith('#!') else '#!/bin/sh\n' + body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def write_docker(self):
        (self.stubs / 'docker.json').write_text(json.dumps(self.docker_cfg))

    def run_guardian(self, fix_with_open=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('DOCKER', 'GIT_'))}
        env.update(HOME=str(self.home), STUB_DIR=str(self.stubs), DOCKER_GUARDIAN_TEST_PATH=str(self.stubs),
                   DOCKER_GUARDIAN_STATE=str(self.state), DOCKER_GUARDIAN_LOG=str(self.log),
                   DOCKER_SOCK=str(self.sock_path), STUB_OPEN_FIXES='1' if fix_with_open else '0', **self.extra_env)
        result = subprocess.run(['/bin/bash', str(self.bin / 'docker-guardian')], env=env, cwd=self.root,
                                capture_output=True, text=True, timeout=100, stdin=subprocess.DEVNULL)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def call_lines(self, prefix=''):
        return [line for line in self.calls.read_text().splitlines() if line.startswith(prefix)]

    def log_text(self):
        return self.log.read_text() if self.log.exists() else ''

    def set_state(self, name, value):
        (self.state / name).write_text(str(value) + '\n')

    def get_state(self, name):
        path = self.state / name
        return path.read_text().strip() if path.exists() else None

    def mark_down(self):
        (self.stubs / 'up').unlink()

    def restarts(self):
        path = self.state / 'restarts'
        return [int(x) for x in path.read_text().split()] if path.exists() else []


class HealthCheckTests(GuardianCase):
    def test_health_uses_socket_info_endpoint_and_docker_ps(self):
        self.run_guardian()
        curl = self.call_lines('curl')
        self.assertTrue(curl and f'--unix-socket {self.sock_path}' in curl[0] and curl[0].endswith('http://localhost/info'), curl)
        self.assertIn('docker ps -q', self.call_lines('docker'))
        self.assertEqual(self.get_state('fails'), '0')
        self.assertEqual(self.call_lines('open'), [])

    def test_failing_info_probe_counts_a_failure_without_restart_below_three(self):
        self.mark_down()
        self.run_guardian()
        self.assertEqual(self.get_state('fails'), '1')
        self.assertIn('unhealthy x1', self.log_text())
        self.assertNotIn('docker ps -q', self.call_lines('docker'))  # ps only after /info answered
        self.assertEqual(self.call_lines('open'), [])
        self.assertEqual(self.restarts(), [])

    def test_info_ok_but_docker_ps_failing_is_unhealthy(self):
        self.docker_cfg['ps_rc'] = 1
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.get_state('fails'), '1')
        self.assertIn('docker ps -q', self.call_lines('docker'))
        self.assertEqual(self.call_lines('open'), [])

    def test_recovery_resets_failure_counter(self):
        self.set_state('fails', 2)
        self.run_guardian()
        self.assertEqual(self.get_state('fails'), '0')
        self.assertEqual(self.call_lines('open'), [])

    def test_docker_not_running_is_started_unless_paused(self):
        (self.stubs / 'running').unlink()
        (self.state / 'paused').touch()
        self.run_guardian()
        self.assertEqual(self.call_lines('open'), [])
        (self.state / 'paused').unlink()
        self.run_guardian()
        self.assertEqual(self.call_lines('open'), ['open -a Docker'])
        self.assertIn('docker not running -> starting', self.log_text())


class RestartBudgetTests(GuardianCase):
    def setUp(self):
        super().setUp()
        self.mark_down()
        self.set_state('fails', 2)  # this run is the third consecutive failure

    def opens(self):
        return self.call_lines('open')

    def test_third_failure_restarts_docker_and_records_it(self):
        before = int(time.time())
        self.run_guardian()
        self.assertEqual(self.opens(), ['open -a Docker'])
        self.assertEqual(len(self.restarts()), 1)
        self.assertGreaterEqual(self.restarts()[0], before)
        self.assertEqual(self.get_state('fails'), '0')
        self.assertTrue(any('quit app' in c for c in self.call_lines('osascript')))
        self.assertTrue(any(c.startswith('pkill') for c in self.call_lines()))
        self.assertIn('restarting Docker Desktop', self.log_text())
        self.assertIn('docker up after', self.log_text())

    def test_one_restart_per_twenty_minutes(self):
        recent = int(time.time()) - 600
        (self.state / 'restarts').write_text(f'{recent}\n')
        self.run_guardian()
        self.assertEqual(self.opens(), [])
        self.assertEqual(self.restarts(), [recent])
        self.assertIn('restart budget exhausted', self.log_text())
        self.assertTrue(self.get_state('alerted'))
        self.assertTrue(any('display notification' in c for c in self.call_lines('osascript')))

    def test_restart_allowed_after_twenty_minutes(self):
        now = int(time.time())
        (self.state / 'restarts').write_text(f'{now - 1300}\n')
        self.run_guardian()
        self.assertEqual(self.opens(), ['open -a Docker'])
        self.assertEqual(len(self.restarts()), 2)

    def test_three_restarts_in_two_hours_block_a_fourth(self):
        now = int(time.time())
        (self.state / 'restarts').write_text(''.join(f'{now - a}\n' for a in (6000, 3000, 1300)))
        self.run_guardian()
        self.assertEqual(self.opens(), [])
        self.assertEqual(len(self.restarts()), 3)
        self.assertIn('restart budget exhausted (3 in 2h)', self.log_text())

    def test_two_restarts_in_two_hours_still_allow_one_and_old_ones_expire(self):
        now = int(time.time())
        (self.state / 'restarts').write_text(''.join(f'{now - a}\n' for a in (6000, 1300)))
        self.run_guardian()
        self.assertEqual(self.opens(), ['open -a Docker'])
        for name in ('restarts', 'alerted'):
            (self.state / name).unlink(missing_ok=True)
        self.calls.write_text('')
        self.mark_down()
        self.set_state('fails', 2)
        (self.state / 'restarts').write_text(''.join(f'{now - a}\n' for a in (20000, 15000, 10000)))
        self.run_guardian()
        self.assertEqual(self.opens(), ['open -a Docker'])

    def test_budget_is_enforced_across_runs(self):
        self.run_guardian(fix_with_open=False)  # restart that does not heal Docker
        self.assertEqual(len(self.opens()), 1)
        self.assertEqual(self.get_state('fails'), '0')
        for expected in ('1', '2', '3'):
            self.run_guardian(fix_with_open=False)
            self.assertEqual(self.get_state('fails'), expected)
        self.assertEqual(len(self.opens()), 1)  # third failure after the restart hit the budget
        self.assertEqual(len(self.restarts()), 1)
        self.assertIn('restart budget exhausted', self.log_text())
        alerted = self.get_state('alerted')
        self.run_guardian(fix_with_open=False)
        self.assertEqual(self.get_state('alerted'), alerted)  # alert not repeated within the hour
        self.assertEqual(len(self.opens()), 1)

    def test_paused_stops_restarts_and_failure_counting(self):
        (self.state / 'paused').touch()
        self.run_guardian()
        self.assertEqual(self.opens(), [])
        self.assertEqual(self.restarts(), [])
        self.assertEqual(self.get_state('fails'), '2')
        self.assertIn('unhealthy but paused', self.log_text())
        self.assertFalse(any(c.startswith(('pkill', 'osascript')) for c in self.call_lines()))


def old_stamp(minutes):
    when = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)
    return when.strftime('%Y-%m-%dT%H:%M:%S.123456789Z')


class CleanupTests(GuardianCase):
    def setUp(self):
        super().setUp()
        self.set_state('last-doctor', int(time.time()))  # keep the doctor out of the picture
        self.set_state('last-gc', 0)

    def test_only_exited_containers_older_than_twenty_minutes_are_removed(self):
        self.docker_cfg['containers'] = [
            dict(id='a' * 12, status='exited', finished=old_stamp(60), image=image_id('1')),
            dict(id='b' * 12, status='exited', finished=old_stamp(5), image=image_id('1')),
            dict(id='d' * 12, status='dead', finished=old_stamp(180), image=image_id('1')),
            dict(id='e' * 12, status='running', finished='0001-01-01T00:00:00Z', image=image_id('1')),
        ]
        self.write_docker()
        self.run_guardian()
        removed = [c for c in self.call_lines('docker rm')]
        self.assertEqual(sorted(removed), ['docker rm ' + 'a' * 12, 'docker rm ' + 'd' * 12])
        self.assertIn('gc: removed 2 containers', self.log_text())
        self.assertGreater(int(self.get_state('last-gc')), int(time.time()) - 60)

    def test_gc_never_force_prunes_images_or_everything(self):
        self.run_guardian()
        docker = self.call_lines('docker')
        self.assertIn('docker network prune -f --filter until=30m', docker)
        self.assertIn('docker volume prune -f', docker)
        self.assertFalse([c for c in docker if c.startswith(('docker system', 'docker image prune', 'docker rmi'))], docker)
        self.assertFalse([c for c in docker if ' -a' in c and 'ps -aq' not in c], docker)

    def test_gc_is_rate_limited_to_fifteen_minutes_and_skipped_when_unhealthy(self):
        self.set_state('last-gc', int(time.time()) - 300)
        self.run_guardian()
        self.assertEqual([c for c in self.call_lines('docker') if 'prune' in c], [])
        self.set_state('last-gc', 0)
        self.mark_down()
        self.run_guardian()
        self.assertEqual([c for c in self.call_lines('docker') if 'prune' in c], [])

    def install_phase_stub(self, text='pi-phase: no active phases\n'):
        phase = self.home / '.pi/agent/bin/pi-phase'
        phase.parent.mkdir(parents=True)
        phase.write_text('#!/bin/sh\ncat <<EOF\n' + text + 'EOF\n')
        phase.chmod(0o755)

    def image(self, char, tags, hours=48, **extra):
        created = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)).isoformat()
        image = dict(Id=image_id(char), RepoTags=tags, RepoDigests=[], Created=created)
        image.update(extra)
        return image

    def image_scenario(self):
        self.install_phase_stub()
        self.docker_cfg['images'] = [
            self.image('1', ['acme/app:1.0.0']),
            self.image('2', ['acme/app:1.1.0']),
            self.image('3', ['acme/app:1.2.0']),
            self.image('4', ['acme/pinned:1.0.0']),
            self.image('5', ['acme/pinned:1.1.0']),
            self.image('6', ['acme/pinned:1.2.0']),
            self.image('7', ['acme/used:1.0.0']),
            self.image('8', ['acme/used:1.1.0']),
            self.image('9', ['acme/used:1.2.0']),
            self.image('a', ['acme/new:1.0.0'], hours=1),
            self.image('b', ['acme/new:1.1.0', 'acme/new:latest'], hours=1),
            self.image('c', ['acme/new:1.2.0'], hours=1),
            self.image('d', ['acme/float:1.0.0', 'acme/float:latest']),
            self.image('e', ['acme/float:1.1.0']),
            self.image('f', ['acme/float:1.2.0']),
        ]
        self.docker_cfg['containers'] = [dict(id='f' * 12, status='running', finished='', image=image_id('7'))]
        self.write_docker()
        (self.state / 'pinned.txt').write_text('# integration images\nacme/pinned:1.0.0\n')

    def test_superseded_images_only_pinned_used_recent_and_floating_stay(self):
        self.image_scenario()
        self.run_guardian()
        removed = sorted(c for c in self.call_lines('docker rmi'))
        self.assertEqual(removed, ['docker rmi acme/app:1.0.0'])
        self.assertIn('images: removed acme/app:1.0.0', self.log_text())
        docker = self.call_lines('docker')
        self.assertFalse([c for c in docker if c.startswith(('docker system', 'docker image prune'))], docker)
        self.assertFalse([c for c in docker if c.startswith('docker rmi') and ' -' in c], docker)

    def test_local_build_tags_require_twenty_four_hours(self):
        self.image_scenario()
        self.docker_cfg['containers'] = []
        self.docker_cfg['images'] = [
            self.image('1', ['acme/app:feature-local'], hours=25),
            self.image('2', ['acme/app:recent-local'], hours=20),
            self.image('3', ['acme/app:stage-train-x'], hours=25),
            self.image('4', ['acme/app:ci'], hours=25),
            self.image('5', ['acme/app:feature-train-x'], hours=25),
        ]
        self.write_docker()
        self.run_guardian()
        refs = ['feature-local', 'stage-train-x', 'ci', 'feature-train-x']
        self.assertEqual(sorted(self.call_lines('docker rmi')),
                         sorted('docker rmi acme/app:' + ref for ref in refs))
        self.assertIn('images: removed acme/app:feature-local (' + image_id('1') + ')', self.log_text())

    def test_pulled_images_skip_local_patterns_but_keep_semver_cleanup(self):
        self.image_scenario()
        self.docker_cfg['containers'] = []
        digest = ['registry/app@sha256:' + 'a' * 64]
        self.docker_cfg['images'] = [
            self.image('1', ['mcr.microsoft.com/mssql/server:2022-latest'], hours=25, RepoDigests=digest),
            self.image('2', ['mcr.microsoft.com/mssql/server:2019-latest'], hours=25, RepoDigests=digest),
            self.image('3', ['cratis/chronicle:5230-structural'], hours=25),
            self.image('4', ['acme/app:feature-local'], hours=25, RepoDigests=digest),
            self.image('5', ['acme/app:1.0.0-local'], hours=25, RepoDigests=digest),
            self.image('6', ['acme/app:1.1.0-local'], hours=25, RepoDigests=digest),
            self.image('7', ['acme/app:1.2.0-local'], hours=25, RepoDigests=digest),
        ]
        self.write_docker()
        self.run_guardian()
        self.assertEqual(sorted(self.call_lines('docker rmi')), [
            'docker rmi acme/app:1.0.0-local', 'docker rmi cratis/chronicle:5230-structural'])

    def test_custom_patterns_also_exclude_pulled_images(self):
        self.image_scenario()
        (self.state / 'local-tags.txt').write_text('*:*\n')
        digest = ['registry/app@sha256:' + 'a' * 64]
        self.docker_cfg['images'] = [
            self.image('1', ['mcr.microsoft.com/mssql/server:2022-latest'], hours=25, RepoDigests=digest),
            self.image('2', ['acme/app:feature-local'], hours=25, RepoDigests=digest),
            self.image('3', ['cratis/chronicle:5230-structural'], hours=25),
        ]
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), ['docker rmi cratis/chronicle:5230-structural'])

    def test_local_versioned_matches_use_age_policy_instead_of_keep_two(self):
        self.image_scenario()
        (self.state / 'local-tags.txt').write_text('*:1.*\n')
        self.docker_cfg['containers'] = []
        self.docker_cfg['images'] = []
        chars = iter('123456')
        for repo, hours in [('old', 25), ('recent', 20)]:
            for version in ['1.0.0', '1.1.0', '1.2.0']:
                self.docker_cfg['images'].append(
                    self.image(next(chars), [f'acme/{repo}:{version}'], hours=hours))
        self.write_docker()
        self.run_guardian()
        self.assertEqual(sorted(self.call_lines('docker rmi')), [
            'docker rmi acme/old:1.0.0', 'docker rmi acme/old:1.1.0', 'docker rmi acme/old:1.2.0'])

    def test_local_tags_preserve_used_pinned_and_floating_images(self):
        self.image_scenario()
        self.docker_cfg['images'] = [
            self.image('7', ['acme/app:used-local']),
            self.image('1', ['acme/app:pinned-local']),
            self.image('2', ['acme/app:id-local']),
            self.image('3', ['acme/app:digest-local'], RepoDigests=['acme/app@sha256:' + 'a' * 64]),
            self.image('4', ['acme/app:alias-local', 'acme/app:latest-development']),
            self.image('5', ['acme/app:plain-local', 'acme/app:development']),
            self.image('6', ['acme/app:unknown-local', 'acme/app:l44-5322-development']),
            self.image('8', ['acme/app:other-local', 'acme/app:local-feature']),
        ]
        (self.state / 'pinned.txt').write_text(
            '# tag, id and digest pins\nacme/app:pinned-*\n' + image_id('2') + '\nacme/app@sha256:*\n')
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])

    def test_custom_local_tag_patterns_replace_defaults_and_match_only_tag(self):
        self.image_scenario()
        (self.state / 'local-tags.txt').write_text('  # custom tags\n\n  nightly-*  \n acme/custom:build-* \n')
        self.docker_cfg['images'] = [
            self.image('1', ['acme/app:nightly-feature']),
            self.image('2', ['acme/app:feature-local']),
            self.image('3', ['acme/app:stage-train-x']),
            self.image('4', ['acme/app:feature-train-x']),
            self.image('5', ['acme/app:ci']),
            self.image('6', ['nightly-repo/app:feature']),
            self.image('8', ['acme/custom:build-feature']),
            self.image('9', ['acme/other:build-feature']),
            self.image('a', ['chronicle-cand:17ed55808e']),
            self.image('b', ['cratis/chronicle:5230-structural']),
        ]
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [
            'docker rmi acme/app:nightly-feature', 'docker rmi acme/custom:build-feature'])

    def test_lane_and_issue_tags_age_out_without_matching_semver(self):
        self.image_scenario()
        self.docker_cfg['containers'] = []
        self.docker_cfg['images'] = [
            self.image('1', ['chronicle-cand:17ed55808e'], hours=25),
            self.image('2', ['chronicle-main:eff4670e99'], hours=25),
            self.image('3', ['cratis/chronicle:5230-structural'], hours=25),
            self.image('4', ['cratis/chronicle:123-structural'], hours=25),
            self.image('5', ['cratis/chronicle:12345-structural'], hours=25),
            self.image('6', ['cratis/chronicle:19.99.1-development'], hours=25),
            self.image('7', ['chronicle-cand:recent'], hours=20),
            self.image('8', ['chronicle-main:recent'], hours=20),
            self.image('9', ['cratis/chronicle:5322-recent'], hours=20),
            self.image('a', ['cratis/short-issue:12-structural']),
            self.image('b', ['cratis/long-issue:123456-structural']),
            self.image('c', ['cratis/uppercase-issue:5322-Structural']),
        ]
        self.write_docker()
        self.run_guardian()
        self.assertEqual(sorted(self.call_lines('docker rmi')), sorted([
            'docker rmi chronicle-cand:17ed55808e', 'docker rmi chronicle-main:eff4670e99',
            'docker rmi cratis/chronicle:5230-structural', 'docker rmi cratis/chronicle:123-structural',
            'docker rmi cratis/chronicle:12345-structural']))

    def test_lane_and_issue_tags_preserve_used_pinned_and_floating_images(self):
        self.image_scenario()
        self.docker_cfg['images'] = [
            self.image('7', ['chronicle-cand:17ed55808e']),
            self.image('1', ['chronicle-main:eff4670e99']),
            self.image('2', ['cratis/chronicle:5230-structural']),
            self.image('3', ['chronicle-cand:l44-5322-development']),
            self.image('4', ['cratis/chronicle:5322-structural', 'cratis/chronicle:latest-development']),
        ]
        (self.state / 'pinned.txt').write_text('chronicle-main:*\ncratis/chronicle:5230-*\n')
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])

    def test_empty_local_tag_file_disables_defaults(self):
        self.image_scenario()
        (self.state / 'local-tags.txt').write_text('# no local tag pruning\n\n')
        self.docker_cfg['images'] = [self.image('1', ['acme/app:feature-local'])]
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])

    def test_versioned_development_tags_keep_two_and_require_twenty_four_hours(self):
        self.image_scenario()
        self.docker_cfg['containers'] = []
        self.docker_cfg['images'] = []
        chars = iter('123456789abc')
        for repo, hours in [('old', 25), ('recent', 10)]:
            for suffix in ['-development', '-development-slim']:
                for version in ['19.85.1', '19.99.1', '20.0.0']:
                    self.docker_cfg['images'].append(
                        self.image(next(chars), [f'acme/{repo}:{version}{suffix}'], hours=hours))
        self.write_docker()
        self.run_guardian()
        self.assertEqual(sorted(self.call_lines('docker rmi')), [
            'docker rmi acme/old:19.85.1-development',
            'docker rmi acme/old:19.85.1-development-slim',
        ])

    def test_last_tag_time_overrides_epoch_created_for_all_age_limits(self):
        self.image_scenario()
        self.docker_cfg['containers'] = []
        self.docker_cfg['images'] = [
            self.image('1', ['acme/app:feature-local'], Metadata={'LastTagTime': old_stamp(20 * 60)}),
            self.image('2', ['acme/app:1.0.0'], Metadata={'LastTagTime': old_stamp(60)}),
            self.image('3', ['acme/app:1.1.0']),
            self.image('4', ['acme/app:1.2.0']),
            self.image('5', None, dangling=True, Metadata={'LastTagTime': old_stamp(20 * 60)}),
            self.image('6', ['acme/app:old-local'], Metadata={'LastTagTime': old_stamp(25 * 60)}),
            self.image('7', ['acme/dev:1.0.0-development'], Metadata={'LastTagTime': old_stamp(10 * 60)}),
            self.image('8', ['acme/dev:1.1.0-development']),
            self.image('9', ['acme/dev:1.2.0-development']),
        ]
        for image in self.docker_cfg['images']:
            image['Created'] = '1970-01-01T00:00:00Z'
        self.write_docker()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), ['docker rmi acme/app:old-local'])

    def test_invalid_or_zero_last_tag_time_falls_back_to_created(self):
        self.image_scenario()
        self.docker_cfg['images'] = [
            self.image('1', ['acme/app:invalid-local'], hours=25, Metadata={'LastTagTime': 'invalid'}),
            self.image('2', ['acme/app:zero-local'], hours=25,
                       Metadata={'LastTagTime': '0001-01-01T00:00:00.000000000Z'}),
            self.image('3', ['acme/app:recent-local'], hours=20, Metadata={'LastTagTime': 'invalid'}),
        ]
        self.write_docker()
        self.run_guardian()
        self.assertEqual(sorted(self.call_lines('docker rmi')), [
            'docker rmi acme/app:invalid-local', 'docker rmi acme/app:zero-local'])

    def test_images_are_left_alone_with_switch_or_busy_integration_phase(self):
        self.image_scenario()
        (self.state / 'no-image-prune').touch()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])
        (self.state / 'no-image-prune').unlink()
        self.set_state('last-gc', 0)
        (self.home / '.pi/agent/bin/pi-phase').write_text(
            '#!/bin/sh\necho "pi-phase: integration x pid=1 cwd=/x elapsed=5s running"\n')
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])
        self.assertIn('images: skipped (integration running or phase state unknown)', self.log_text())

    def test_suffixed_status_lines_are_understood(self):
        # Current pi-phase appends " fast policy=<p> source=<s>"; a busy integration phase must still block.
        self.image_scenario()
        stub = self.home / '.pi/agent/bin/pi-phase'
        stub.write_text('#!/bin/sh\necho "pi-phase: integration x pid=1 cwd=/x elapsed=5s running policy=queued source=default"\n')
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])
        self.assertIn('images: skipped (integration running or phase state unknown)', self.log_text())
        stub.write_text('#!/bin/sh\necho "pi-phase: build x pid=1 cwd=/x elapsed=5s running fast policy=direct source=cli"\n')
        self.set_state('last-gc', 0)
        self.run_guardian()
        self.assertNotEqual(self.call_lines('docker rmi'), [], self.log_text())

    def test_unparseable_active_line_is_unknown_not_idle(self):
        self.image_scenario()
        (self.home / '.pi/agent/bin/pi-phase').write_text(
            '#!/bin/sh\necho "pi-phase: integration x pid=1 cwd=/x elapsed=5s running surprise=1"\n'
            'echo "pi-phase: no active phases"\n')
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])
        self.assertIn('images: skipped (integration running or phase state unknown)', self.log_text())

    def test_images_skipped_when_phase_state_is_unknown(self):
        self.image_scenario()
        (self.home / '.pi/agent/bin/pi-phase').unlink()
        self.run_guardian()
        self.assertEqual(self.call_lines('docker rmi'), [])
        self.assertIn('images: skipped (integration running or phase state unknown)', self.log_text())


if __name__ == '__main__':
    unittest.main()
