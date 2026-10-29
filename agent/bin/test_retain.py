"""Non-destructive retain specs. Fixtures are left for inspection, never swept here."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

BIN = Path(__file__).resolve().parent


def load(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(BIN / filename))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(module)
    return module


retain = load('retain', 'pi-retain')
cleanup = load('cleanup', 'pi-cleanup')
bins = load('bins', 'bin_sweep.py')


class RetainTests(unittest.TestCase):
    def setUp(self):
        parent = Path(os.environ.get('PI_RETAIN_TEST_TMP', str(Path.cwd() / '.ai-work/retain-tests')))
        parent.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(dir=parent)).resolve()
        self.root = self.tmp / 'checkout'
        self.root.mkdir()
        self.output = self.root / 'project/bin'
        self.output.mkdir(parents=True)
        self.registry = self.tmp / 'registry'
        env = patch.dict(os.environ, PI_RETAIN_DIR=str(self.registry))
        env.start()
        self.addCleanup(env.stop)
        self.now = time.time()

    def cli(self, *args, now=None):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = retain.main(list(map(str, args)), now=self.now if now is None else now)
        return code, out.getvalue(), err.getvalue()

    def add(self, root=None, hours=24, owner='L71'):
        result = self.cli('add', root or self.root, '--owner', owner, '--reason', 'verification', '--hours', hours)
        self.assertEqual(result[0], 0, result)

    def build_plan(self, root):
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'build', '--idle-days', '0']))
        checkout = cleanup.Checkout(str(root), 'main')
        relative = os.path.relpath(self.output, root) + '/\0'
        with patch.object(cleanup, 'newest_mtime', return_value=self.now - 864000), \
             patch.object(cleanup, 'git', side_effect=[(0, relative, ''), (0, '', '')]):
            return cleanup.plan_root_build(ctx, checkout, set())

    def bin_plan(self, root):
        with patch.object(bins, 'guards', return_value=(([], [], []), None)), \
             patch.object(bins, 'threshold', return_value=float('inf')), \
             patch.object(bins, 'candidates', return_value=([self.output], 10, None)):
            return bins.sweep([root], lambda *args, **kwargs: '')[0]

    def assert_protected(self, root):
        self.assertEqual(self.build_plan(root)['skip'], 'retained:L71')
        self.assertEqual(self.bin_plan(root)['reason'], 'retained:L71')

    def assert_unprotected(self, root):
        row = self.build_plan(root)
        self.assertIsNone(row['skip'])
        self.assertEqual(row['dirs'][0]['action'], 'delete')
        self.assertEqual(self.bin_plan(root)['action'], 'planned')

    def test_retained_root_skipped_in_both_cleaners(self):
        self.add()
        self.assert_protected(self.root)

    def test_nested_path_skipped_in_both_cleaners(self):
        self.add()
        self.assert_protected(self.output.parent)

    def test_expired_entry_does_not_protect_either_cleaner(self):
        self.add(hours=1)
        record = json.loads(retain.marker_path(self.root).read_text())
        record.update(created=self.now - 7200, expires=self.now - 3600)
        retain.write_record(record)
        self.assert_unprotected(self.root)
        self.assertIn('"state": "expired"', self.cli('list')[1])
        self.assertTrue(retain.marker_path(self.root).exists())

    def test_release_stops_protecting_both_cleaners(self):
        self.add()
        self.assertEqual(self.cli('release', self.root, '--owner', 'L71')[0], 0)
        self.assert_unprotected(self.root)
        self.assertEqual(self.cli('status', self.root)[0], 1)

    def test_corrupt_json_fails_closed_in_both_cleaners(self):
        self.add()
        retain.marker_path(self.root).write_text('{')
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(self.build_plan(self.root)['skip'], 'retained:corrupt')
            self.assertEqual(self.bin_plan(self.root)['reason'], 'retained:corrupt')
        self.assertIn('corrupt', err.getvalue())
        self.assertNotIn('root unknown', err.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(retain.retained_reason(self.tmp / 'unrelated'))
        self.assertEqual(self.cli('release', self.root, '--owner', 'L71')[0], 2)
        self.assertEqual(self.cli('release', self.root, '--owner', 'L71', '--force')[0], 0)
        self.assert_unprotected(self.root)

    def test_long_path_marker_is_reversible_and_keeps_one_json_per_root(self):
        deep = self.root / ('deep' * 30)
        deep.mkdir()
        self.add(root=deep)
        marker = retain.marker_path(deep)
        self.assertEqual(retain.record_root(marker), str(deep))
        self.assertEqual(len(list(self.registry.rglob('*.json'))), 1)
        marker.write_text('{')
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(retain.retained_reason(deep), 'retained:corrupt')
            self.assertIsNone(retain.retained_reason(self.output))

    def test_corrupt_schema_fails_closed_for_known_root(self):
        self.add()
        file = retain.marker_path(self.root)
        record = json.loads(file.read_text())
        record['expires'] = 'invalid'
        file.write_text(json.dumps(record))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(retain.retained_reason(self.output), 'retained:corrupt')
            self.assertIsNone(retain.retained_reason(self.tmp / 'unrelated'))

    def test_oversized_timestamps_fail_closed_only_for_their_root(self):
        self.add()
        file = retain.marker_path(self.root)
        original = json.loads(file.read_text())
        unrelated = self.tmp / 'unrelated'
        output = unrelated / 'project/bin'
        output.mkdir(parents=True)
        for key in ('expires', 'created'):
            with self.subTest(key=key):
                file.write_text(json.dumps(dict(original, **{key: 10 ** 400})))
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(retain.retained_reason(self.output), 'retained:corrupt')
                    self.assertIsNone(retain.retained_reason(unrelated))
                    self.assertEqual(self.build_plan(self.root)['skip'], 'retained:corrupt')
                    self.assertEqual(self.bin_plan(self.root)['reason'], 'retained:corrupt')
                    with patch.object(self, 'output', output):
                        self.assert_unprotected(unrelated)
                self.assertEqual(self.cli('list')[0], 0)
                self.assertEqual(self.cli('status', self.root)[1].strip(), 'retained:corrupt')

    def test_registration_between_plan_and_final_check_is_respected(self):
        for name, delete_candidate in (('build', cleanup.delete_candidate), ('bins', bins.delete_candidate)):
            with self.subTest(cleaner=name):
                self.assert_unprotected(self.root)
                original_lock = delete_candidate.__globals__['registry_lock']

                def register_then_lock(timeout):
                    self.add()
                    return original_lock(timeout)

                delete = Mock()
                with patch.dict(delete_candidate.__globals__, registry_lock=register_then_lock):
                    self.assertEqual(delete_candidate(self.output, delete), 'retained:L71')
                delete.assert_not_called()
                self.assertTrue(self.output.exists())
                self.assertEqual(self.cli('release', self.root, '--owner', 'L71')[0], 0)

    def test_candidate_check_and_callback_share_the_mutation_lock(self):
        for name, delete_candidate in (('build', cleanup.delete_candidate), ('bins', bins.delete_candidate)):
            with self.subTest(cleaner=name):
                def checked_without_deleting(path):
                    self.assertEqual(path, self.output)
                    self.assertIsNone(retain.registry_lock(timeout=0))

                callback = Mock(side_effect=checked_without_deleting)
                self.assertIsNone(delete_candidate(self.output, callback))
                callback.assert_called_once_with(self.output)
                # The per-candidate lock is released before the next candidate/add.
                with retain.registry_lock(timeout=0) as lock:
                    self.assertIsNotNone(lock)
                self.assertTrue(self.output.exists())

    def test_contended_candidate_lock_times_out_without_deleting(self):
        for name, delete_candidate in (('build', cleanup.delete_candidate), ('bins', bins.delete_candidate)):
            with self.subTest(cleaner=name):
                callback = Mock()
                with retain.registry_lock():
                    start = time.monotonic()
                    self.assertEqual(delete_candidate(self.output, callback, timeout=0.02), 'retained:lock-timeout')
                    self.assertLess(time.monotonic() - start, 1)
                callback.assert_not_called()
                self.assertTrue(self.output.exists())

    def test_candidate_existence_is_revalidated_under_the_lock(self):
        for name, delete_candidate in (('build', cleanup.delete_candidate), ('bins', bins.delete_candidate)):
            with self.subTest(cleaner=name):
                def missing_under_lock(path):
                    self.assertEqual(path, self.output)
                    self.assertIsNone(retain.registry_lock(timeout=0))
                    return False

                callback = Mock()
                with patch.object(os.path, 'exists', side_effect=missing_under_lock):
                    self.assertEqual(delete_candidate(self.output, callback), 'path-missing')
                callback.assert_not_called()
                self.assertTrue(self.output.exists())

    def test_unreadable_registry_fails_closed(self):
        with patch.object(retain.os, 'scandir', side_effect=PermissionError('denied')), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(retain.retained_reason(self.root), 'retained:corrupt')

    def test_owner_mismatch_refused_and_force_supported(self):
        self.add()
        before = retain.marker_path(self.root).read_bytes()
        code, _, err = self.cli('release', self.root, '--owner', 'L62')
        self.assertEqual(code, 2)
        self.assertIn('owner mismatch', err)
        self.assertEqual(retain.marker_path(self.root).read_bytes(), before)
        self.assertEqual(self.cli('add', self.root, '--owner', 'L62', '--reason', 'takeover')[0], 2)
        self.assertEqual(self.cli('release', self.root, '--owner', 'L62', '--force')[0], 0)
        self.assert_unprotected(self.root)

    def test_default_expiry_and_maximum(self):
        self.assertEqual(self.cli('add', self.root, '--owner', 'L71', '--reason', 'verify')[0], 0)
        record = json.loads(retain.marker_path(self.root).read_text())
        self.assertEqual(record['expires'] - record['created'], 24 * 3600)
        self.add(hours=72)
        for hours in ('73', '0', '-1', 'nan', 'inf'):
            self.assertEqual(self.cli('add', self.root, '--owner', 'L71', '--reason', 'verify', '--hours', hours)[0], 2)

    def test_canonical_path_component_boundaries_and_status(self):
        alias = self.tmp / 'alias'
        alias.symlink_to(self.root)
        self.add(root=alias)
        record = json.loads(retain.marker_path(self.root).read_text())
        self.assertEqual(record['path'], str(self.root))
        self.assertEqual(self.cli('status', alias / 'project')[1].strip(), 'retained:L71')
        self.assertIsNone(retain.retained_reason(str(self.root) + '-other'))
        self.assertEqual(self.cli('status', self.tmp)[0], 1)
        self.assertEqual(retain.retained_reason(self.tmp), 'retained:L71')

    def test_retained_descendant_blocks_recursive_removal(self):
        self.add(root=self.output)
        row = self.build_plan(self.root)
        self.assertEqual(row['dirs'][0]['reason'], 'retained:L71')
        self.assertIn('retained:L71', self.bin_plan(self.root)['reason'])
        self.assertEqual(retain.retained_reason(self.root), 'retained:L71')

    def test_unretained_sibling_outputs_keep_existing_behaviour(self):
        self.add(root=self.output)
        sibling = self.root / 'other/bin'
        sibling.mkdir(parents=True)
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'build', '--idle-days', '0']))
        checkout = cleanup.Checkout(str(self.root), 'main')
        with patch.object(cleanup, 'newest_mtime', return_value=self.now - 864000), \
             patch.object(cleanup, 'git', side_effect=[(0, 'project/bin/\0other/bin/\0', ''), (0, '', '')]):
            rows = cleanup.plan_root_build(ctx, checkout, set())['dirs']
        self.assertEqual({row['path']: row['action'] for row in rows},
                         {str(self.output): 'skip', str(sibling): 'delete'})
        with patch.object(bins, 'guards', return_value=(([], [], []), None)), \
             patch.object(bins, 'threshold', return_value=float('inf')), \
             patch.object(bins, 'candidates', return_value=([self.output, sibling], 10, None)):
            row = bins.sweep([self.root], lambda *args, **kwargs: '')[0]
        self.assertEqual(row['action'], 'planned')
        self.assertEqual(row['retained'], [{'path': str(self.output), 'reason': 'retained:L71'}])

    def test_worktree_plan_and_recheck_keep_retained_root(self):
        self.add()
        checkout = cleanup.Checkout(str(self.root), 'linked', gitdir='/git/worktrees/lane', parent=str(self.tmp))
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'worktrees']))
        rows = cleanup.plan_worktrees(ctx, [checkout], [])
        self.assertEqual(rows[0]['action'], 'keep')
        self.assertIn('retained:L71', rows[0]['blockers'])
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])):
            self.assertEqual(cleanup.fresh_recheck(ctx, checkout, {}), 'retained:L71')

    def test_temporary_directory_and_session_protection(self):
        self.add()
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'caches']))
        self.assertEqual(cleanup.tmp_state(str(self.output), self.now)[1], 'retained:L71')
        self.assertEqual(cleanup.gzip_session(ctx, {'path': str(self.root / 'session.jsonl')}), 'skipped: retained:L71')

    def test_cache_plans_expose_retained_packages_sessions_and_prune(self):
        self.add()
        items = [
            dict(name='nuget packages trim', action='run', paths=[str(self.output)]),
            dict(name='pi session gzip', action='run', files=[{'path': str(self.output / 'session.jsonl')}]),
            dict(name='git worktree prune', action='run', repos=[{'repo': str(self.root)}]),
        ]
        cleanup.protect_cache_items(items)
        self.assertTrue(all(item['action'] == 'skip' for item in items))
        self.assertTrue(all(item['reason'] == 'retained:L71' for item in items))

    def test_tool_cache_roots_are_resolved_not_guessed(self):
        self.add()
        for name, command, output in (
            ('npm cache', ['npm', 'cache', 'clean', '--force'], str(self.output)),
            ('yarn cache', ['yarn', 'cache', 'clean'], str(self.output)),
            ('nuget temp', ['dotnet', 'nuget', 'locals', 'temp', '--clear'], 'temp: ' + str(self.output)),
        ):
            item = dict(name=name, action='run', cmd=command)
            with patch.object(cleanup, 'run', return_value=(0, output, '')):
                self.assertEqual(cleanup.cache_retention(item), 'retained:L71')
            with patch.object(cleanup, 'run', return_value=(0, str(self.tmp / 'unrelated'), '')):
                if name != 'nuget temp':
                    self.assertIsNone(cleanup.cache_retention(item))
        self.assertEqual(cleanup.cache_retention(dict(name='go build cache', gocache=str(self.output))), 'retained:L71')

    def test_empty_registry_leaves_cache_plan_unchanged_without_probes(self):
        items = [dict(name='npm cache', action='run', cmd=['npm', 'cache', 'clean', '--force'])]
        with patch.object(cleanup, 'run', side_effect=AssertionError('unexpected probe')):
            cleanup.protect_cache_items(items)
        self.assertEqual(items[0]['action'], 'run')


if __name__ == '__main__':
    unittest.main()
