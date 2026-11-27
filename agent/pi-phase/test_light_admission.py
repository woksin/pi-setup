"""Host-budget admission with private state, synthetic host readings and harmless producers."""
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

import memory_guard
import pi_phase
from phase_test_support import held_job
from test_queue_order import Harness


HERE = Path(__file__).resolve().parent
ENTRY = '''import sys
sys.path.insert(0, sys.argv[1])
import pi_phase
from pathlib import Path
root = Path(sys.argv[2]).parent
real_monotonic = pi_phase.time.monotonic
pi_phase.time.monotonic = lambda: real_monotonic() + float((root / 'clock').read_text())
def unavailable(timeout):
    raise ValueError('no injected pressure sample')
class CachedPressure(pi_phase.HostPressure):
    def __init__(self, settings, state):
        super().__init__(settings, state, probe=unavailable)
pi_phase.HostPressure = CachedPressure
orphans = root / 'groups'
if orphans.exists():
    pi_phase.live_groups = lambda timeout: set(map(int, orphans.read_text().split()))
pi_phase.read_host_memory = lambda deadline: (float((root / 'free').read_text()), 5000)
pi_phase.os.getloadavg = lambda: (float((root / 'load').read_text()), 0, 0)
sys.exit(pi_phase.main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))
'''


class HostBudgetAdmissionTests(Harness):
    def setUp(self):
        super().setUp()
        self.cwd = self.root / 'checkout'
        self.cwd.mkdir()
        home = self.root / 'home'
        home.mkdir()
        self.guard_dir = home / '.pi' / 'agent' / 'state'
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('PI_', 'GIT_'))}
        self.env.update(HOME=str(home), PI_MEM_GUARD_STATE=str(self.guard_dir), PYTHONDONTWRITEBYTECODE='1')
        self.state.mkdir()
        self.configure(container_test_detection='off', cold_worktree_hint=False, msbuild_max_cpu=0,
                       memory_guard=dict(mode='observe'), host_pressure=dict(mode='enforce', sample_ttl_s=60),
                       cpu_budget=dict(mode='enforce', max_units=8),
                       memory_admission=dict(min_free_percent=15, min_swap_free_mb=0))
        (self.root / 'clock').write_text('0')
        (self.root / 'free').write_text('60')
        (self.root / 'load').write_text('0')
        # The fake node handles only the literal test file and never executes its contents.
        self.executable(self.fake_bin / 'node', '#!/bin/sh\n'
                        'touch "$2.started"\nwhile [ -f "$2.hold" ]; do sleep .02; done\n')
        self.executable(self.fake_bin / 'dotnet', '#!/bin/sh\ntouch dotnet.started\n')
        self.pressure()

    def pressure(self, level=2, pl=2, *, stale=False, compressor=10, **fields):
        memory_guard.write_state(self.guard_dir, dict(level=level, pl=pl, t=time.time() - 500 * stale,
                                                     reasons=['injected pressure']))
        pi_phase.save(self.state / 'host-sample.json', dict(t=time.time(), pl=pl, hist=[], cmpPct=compressor, **fields))

    def advance(self, seconds):
        clock = self.root / 'clock'
        temporary = clock.with_suffix('.tmp')
        temporary.write_text(str(seconds))
        temporary.replace(clock)

    def start(self, *args, cwd=None):
        child = subprocess.Popen([sys.executable, '-B', '-c', ENTRY, str(HERE), str(self.state), str(self.config), *args],
                                 cwd=cwd or self.cwd, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True)
        self.children.append(child)
        return child

    def job(self, label, command, *, policy='direct', kind='test', queue='3', cwd=None):
        return self.start('run', '--kind', kind, '--policy', policy, '--label', label, '--timeout', '50',
                          '--queue-timeout', queue, '--rerun', '--', *command, cwd=cwd)

    def node(self, name, duration=5, *, cwd=None, outcome='passed'):
        cwd = cwd or self.cwd
        (cwd / name).touch()
        command = ['node', '--test', name]
        if duration is not None:
            self.seed_timing(cwd, command, duration, outcome)
        return command

    def seed_timing(self, cwd, command, duration, outcome):
        now = datetime.now(timezone.utc).isoformat()
        pi_phase.append_ledger(self.state, dict(v=1, ts=now, kind='test', stack='node', startedAt=now, waitS=0,
                                               runS=duration, outcome=outcome,
                                               fingerprint=pi_phase.test_fingerprint(str(cwd), command)))

    def status_text(self):
        code, text = self.done(self.start('status'))
        self.assertEqual(code, 0, text)
        return text

    def test_warning_allows_exactly_one_light_direct_at_normal_cost(self):
        path = self.state / 'heavy-0.lock'
        fd = pi_phase.lock_file(path)
        self.addCleanup(os.close, fd)
        pi_phase.save(path.with_suffix('.json'), dict(token='heavy', label='running build', kind='build', workers=7))
        other_cwd = self.root / 'other'
        other_cwd.mkdir()
        for cwd in (self.cwd, other_cwd):
            subprocess.run(['git', 'init', '-q'], cwd=cwd, env=self.env, check=True)
        first = self.node('first.js')
        second = self.node('second.js', cwd=other_cwd)
        hold = self.cwd / 'first.js.hold'
        hold.touch()
        active = self.job('first', first)
        self.wait_for(lambda: (self.cwd / 'first.js.started').exists())
        status = self.status_text()
        self.assertIn('8/8 units', status)
        self.assertIn('light=1/1', status)
        code, output = self.done(self.job('second-blocked', second, queue='1', cwd=other_cwd))
        self.assertEqual(code, 75, output)
        self.assertIn('light direct cap', output)
        self.assertIn('use CI', output)
        self.assertFalse((other_cwd / 'second.js.started').exists())
        hold.unlink()
        code, output = self.done(active)
        self.assertEqual(code, 0, output)
        self.assertIn('light=0/1', self.status_text())
        code, output = self.done(self.job('second-after-release', second, cwd=other_cwd))
        self.assertEqual(code, 0, output)
        self.assertTrue((other_cwd / 'second.js.started').exists())

    def test_live_orphan_keeps_light_slot_and_cpu_charge_until_group_is_gone(self):
        groups = self.root / 'groups'
        groups.write_text('4321')
        slot = self.state / pi_phase.LIGHT_SLOT
        slot.touch()
        pi_phase.save(slot.with_suffix('.json'), dict(token='previous', pgid=4321, label='orphaned light', kind='test'))
        command = self.node('recover.js')
        status = self.status_text()
        self.assertIn('orphan-group', status)
        self.assertIn('1/8 units', status)
        self.assertIn('light=1/1', status)
        self.assertEqual(self.done(self.job('blocked-by-orphan', command, queue='.7'))[0], 75)
        self.assertFalse((self.cwd / 'recover.js.started').exists())
        groups.write_text('')
        status = self.status_text()
        self.assertIn('0/8 units', status)
        self.assertIn('light=0/1', status)
        self.assertEqual(self.done(self.job('after-orphan', command))[0], 0)
        self.assertTrue((self.cwd / 'recover.js.started').exists())

    def test_light_execution_stops_at_thirty_seconds(self):
        command = self.node('overrun.js')
        (self.cwd / 'overrun.js.hold').touch()
        job = self.job('overrun', command)
        self.wait_for((self.cwd / 'overrun.js.started').exists)
        self.advance(31)
        code, output = self.done(job)
        self.assertEqual(code, 124, output)
        self.assertEqual(self.ledger_records()[-1]['outcome'], 'timeout')
        self.assertIn('light=0/1', self.status_text())

    def test_short_queue_budget_includes_worktree_wait(self):
        first = self.node('first.js')
        second = self.node('second.js')
        hold = self.cwd / 'first.js.hold'
        hold.touch()
        active = self.job('holds-worktree', first)
        self.wait_for((self.cwd / 'first.js.started').exists)
        waiting = self.job('waiting-for-worktree', second, queue='30')
        self.wait_for(lambda: 'label=waiting-for-worktree' in self.status_text())
        self.advance(6)
        self.assertEqual(self.done(waiting)[0], 75)
        self.assertFalse((self.cwd / 'second.js.started').exists())
        self.assertEqual(self.ledger_records()[-1]['worktreeLock'], 'timeout')
        hold.unlink()
        self.assertEqual(self.done(active)[0], 0)

    def test_stop_blocks_ordinary_commands_and_unproven_or_disallowed_tests_on_idle_host(self):
        ordinary = [sys.executable, '-c', 'from pathlib import Path; Path("ordinary.started").touch()']
        container = self.node('container.js')
        family = self.node('family.js')
        fingerprint = pi_phase.test_fingerprint(str(self.cwd), container)
        identity = pi_phase.work_identity(str(self.cwd), family, 'test')
        pi_phase.save(self.state / 'container-tests.json', {fingerprint: True, f'family:{identity.family_key}': True})
        slow = self.node('slow.js', duration=5)
        self.seed_timing(self.cwd, slow, 31, 'failed')
        cases = (
            ('dotnet', 'direct', 'build', ['dotnet', 'build']),
            ('integration', 'direct', 'integration', ordinary),
            ('shell', 'direct', 'test', ['sh', '-c', 'touch shell.started']),
            ('unknown', 'direct', 'test', self.node('unknown.js', duration=None)),
            ('slow', 'direct', 'test', slow),
            ('only-failed', 'direct', 'test', self.node('failed.js', outcome='failed')),
            ('container', 'direct', 'test', container),
            ('family', 'direct', 'test', family),
            ('fast', 'fast', 'test', self.node('fast.js')),
            ('queued', 'queued', 'build', ordinary),
            ('extra-flag', 'direct', 'test', [*self.node('extra.js'), '--test-only']),
        )
        for label, policy, kind, command in cases:
            with self.subTest(label=label):
                code, output = self.done(self.job(label, command, queue='.6', policy=policy, kind=kind))
                self.assertEqual(code, 75, output)
                self.assertIsNone(self.ledger_records()[-1]['startedAt'])
                self.assertFalse(list(self.cwd.glob('*.started')))

    def test_light_respects_independent_safety_vetoes_on_an_idle_host(self):
        command = self.node('short.js')
        for changes, free, load, expected in (
            (dict(level=4, pl=4), 60, 0, 'guard level 4'),
            (dict(pl=4), 60, 0, 'critical memory pressure'),
            (dict(compressor=32), 60, 0, 'compressor'),
            (dict(swapGrowth=500), 60, 0, 'swap growth'),
            ({}, 10, 0, 'memory free'),
            ({}, 60, 10**6, 'cpu:load'),
        ):
            with self.subTest(expected=expected):
                self.pressure(**changes)
                (self.root / 'free').write_text(str(free))
                (self.root / 'load').write_text(str(load))
                code, output = self.done(self.job('short', command, queue='.7'))
                self.assertEqual(code, 75, output)
                self.assertIn(expected, output)
                self.assertIn('use CI', output)
                self.assertFalse((self.cwd / 'short.js.started').exists())

    def test_status_reports_direct_hold_then_recovery_without_ranking_the_waiter(self):
        job = self.job('held-direct', held_job(self.cwd, 'recovered'), queue='12')
        ready = self.cwd / 'recovered.started'
        self.wait_for(lambda: any('guard level 2' in p.read_text() for p in (self.state / 'waiting-direct').glob('*.json')))
        status = self.status_text()
        line = next(line for line in status.splitlines() if 'label=held-direct' in line)
        self.assertIn('injected pressure', line)
        self.assertNotIn('rank=', line)
        self.assertFalse(ready.exists())
        self.pressure(level=1, pl=1)
        self.wait_for(ready.exists, seconds=5)
        self.assertNotIn('label=held-direct', self.status_text())
        (self.cwd / 'recovered.release').touch()
        code, output = self.done(job)
        self.assertEqual(code, 0, output)
