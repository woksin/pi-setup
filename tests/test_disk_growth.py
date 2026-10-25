"""Isolated specs for the disk-growth sampler and bounded probe."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import runpy
import tempfile
import time
import unittest
from unittest.mock import patch

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
        self.assertIn('partial: 1 of 2 units', text)
        self.assertIn('- 6.0 GiB  ~/repo  (dumps 6.0)  procs: dotnet', text)
        self.assertTrue(text.endswith('Next notice after 30 min unless free space drops another 5 GiB.\n'))
        self.assertEqual(text, dg.format_notice(1000, info, writers, coverage, self.cfg))
        self.assertIn('docker system df', dg.format_notice(1000, info, [], coverage, self.cfg))
        second = self.home / 'second'
        second.mkdir()
        dg.post_notice(text, [self.messages, second, self.home / 'absent'], 1000)
        for directory in (self.messages, second):
            files = list(directory.iterdir())
            self.assertEqual(len(files), 1)
            self.assertRegex(files[0].name, r'^ALL-disk-growth-\d{4}\.md$')
            self.assertEqual(files[0].read_text(), text)

    def test_run_state_log_dry_run_and_timeout_notice(self):
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
        notice = self.messages / f"ALL-disk-growth-{dg.clock(1240, '%H%M')}.md"
        self.assertIn('probe timed out/partial', notice.read_text())

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
        class HugeDirectory:
            visited = 0

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def __iter__(self):
                for _ in range(1000000):
                    self.visited += 1
                    yield unittest.mock.Mock(is_symlink=lambda: False, is_dir=lambda **kw: False,
                                             is_file=lambda **kw: True)

        directory = HugeDirectory()
        budget = probe['Budget'](time.monotonic() + 5, cap=10)
        with patch.object(os, 'scandir', return_value=directory):
            probe['units'](self.home, None, budget=budget)
        self.assertTrue(budget.partial)
        self.assertLessEqual(directory.visited, 11)
        self.assertEqual(probe['parse_cwds']('p12\ncdotnet\nn/tmp/repo\np13\nctesthost\nn/tmp/repo\n'),
                         {'/tmp/repo': {'dotnet', 'testhost'}})

    def test_plist(self):
        with (ROOT / 'agent/launchd/com.example.disk-growth.plist').open('rb') as stream:
            value = plistlib.load(stream)
        self.assertEqual(value['Label'], 'com.example.disk-growth')
        self.assertEqual(value['ProgramArguments'], ['__HOME__/.pi/agent/bin/disk-growth'])
        self.assertEqual(value['StartInterval'], 60)
        self.assertEqual(value['ProcessType'], 'Background')
        self.assertTrue(value['LowPriorityIO'])
        self.assertTrue(value['RunAtLoad'])
        self.assertEqual(value['EnvironmentVariables']['PYTHONDONTWRITEBYTECODE'], '1')


if __name__ == '__main__':
    unittest.main()
