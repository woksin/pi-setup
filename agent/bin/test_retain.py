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
from unittest import mock
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


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        parent = Path.cwd() / '.ai-work/discovery-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(dir=parent)).resolve()
        self.root = self.tmp / 'repos'
        self.root.mkdir()
        self.cache = self.tmp / 'discovery-cache.json'
        cache = patch.object(cleanup, 'DISCOVERY_CACHE', str(self.cache))
        cache.start()
        self.addCleanup(cache.stop)

    def checkout(self, relative):
        path = self.root / relative
        (path / '.git').mkdir(parents=True)
        return str(path)

    def test_heavy_directories_are_pruned_but_worktree_containers_are_searched(self):
        for name in cleanup.DISCOVERY_PRUNE_DIRS:
            self.checkout(f'{name}/hidden')
        visible = {self.checkout('main'), self.checkout('.worktrees/linked'),
                   self.checkout('.ai-work/checkout')}
        # A .git directory itself must still be printed and pruned.
        self.checkout('main/.git/hidden')
        notes = []
        self.assertEqual(cleanup.discover_paths([str(self.root)], notes), visible)
        self.assertEqual(notes, [])
        self.assertEqual(json.loads(self.cache.read_text()), {str(self.root): sorted(visible)})

    def test_timeout_preserves_incrementally_collected_stdout_only_when_requested(self):
        for output in (b'/repos/early/.git\n', '/repos/early/.git\n'):
            with self.subTest(output=output):
                error = cleanup.subprocess.TimeoutExpired(['find'], 110, output=output)
                with patch.object(cleanup.subprocess, 'run', side_effect=error):
                    self.assertEqual(cleanup.run(['find'], keep_partial=True),
                                     (124, '/repos/early/.git\n', 'timeout'))
                    self.assertEqual(cleanup.run(['find']), (124, '', 'timeout'))

    def test_timeout_unions_partial_paths_with_existing_cached_paths(self):
        cached = self.checkout('cached')
        early = self.checkout('early')
        self.cache.write_text(json.dumps({str(self.root): [cached]}))
        notes = []
        with patch.object(cleanup, 'run', return_value=(124, early + '/.git\n', 'timeout')) as run:
            self.assertEqual(cleanup.discover_paths([str(self.root)], notes), {cached, early})
        self.assertEqual(run.call_args.kwargs, {'timeout': 110, 'keep_partial': True})
        self.assertEqual(notes, [f'discovery timed out under {self.root}; results incomplete'])
        self.assertEqual(json.loads(self.cache.read_text())[str(self.root)], sorted([cached, early]))

    def test_disappeared_cache_entries_are_dropped_on_timeout(self):
        existing = self.checkout('existing')
        no_git = self.root / 'no-git'
        no_git.mkdir()
        missing = str(self.root / 'missing')
        self.cache.write_text(json.dumps({str(self.root): [existing, str(no_git), missing]}))
        with patch.object(cleanup, 'run', return_value=(124, '', 'timeout')):
            self.assertEqual(cleanup.discover_paths([str(self.root)], []), {existing})
        self.assertEqual(json.loads(self.cache.read_text()), {str(self.root): [existing]})

    def test_cache_does_not_expand_requested_roots(self):
        outside = self.tmp / 'outside'
        (outside / '.git').mkdir(parents=True)
        self.cache.write_text(json.dumps({str(self.root): [str(outside)], str(outside): [str(outside)]}))
        with patch.object(cleanup, 'run', return_value=(124, '', 'timeout')):
            self.assertEqual(cleanup.discover_paths([str(self.root)], []), set())

    def test_completed_walk_replaces_cached_entries(self):
        cached = self.checkout('cached')
        self.cache.write_text(json.dumps({str(self.root): [cached]}))
        with patch.object(cleanup, 'run', return_value=(0, '', '')):
            self.assertEqual(cleanup.discover_paths([str(self.root)], []), set())
        self.assertEqual(json.loads(self.cache.read_text()), {str(self.root): []})

    def test_corrupt_cache_does_not_block_discovery(self):
        for data in ('{', '[]', '{"relative": [], "/absolute": "invalid"}'):
            with self.subTest(data=data):
                self.cache.write_text(data)
                with patch.object(cleanup, 'run', return_value=(124, '', 'timeout')):
                    self.assertEqual(cleanup.discover_paths([str(self.root)], []), set())


class ScheduledDeadlineTests(unittest.TestCase):
    def setUp(self):
        parent = Path.cwd() / '.ai-work/deadline-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(dir=parent)).resolve()
        self.clock = [0.0]
        for patcher in (mock.patch.object(cleanup, "STATE_DIR", str(self.root / "state")),
                        mock.patch.object(cleanup.time, "monotonic", side_effect=lambda: self.clock[0])):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_deadline_finishes_item_then_reports_once(self):
        notes, done = [], []
        deadline = cleanup.StepDeadline("build", 5, notes)
        for item in deadline.items(range(3)):
            done.append(item)
            self.clock[0] = 6
            done.append("finished")
        self.assertEqual(done, [0, "finished"])
        self.assertFalse(deadline.ready())
        self.assertEqual(notes, ["step build stopped at deadline after 1 items; continues next run"])

    def test_rotation_advances_and_handles_corrupt_missing_or_stale_state(self):
        items = ["c", "a", "b"]
        self.assertEqual(cleanup.rotation_order("build", items), ["a", "b", "c"])
        cleanup.rotation_advance("build", "a", [])
        self.assertEqual(cleanup.rotation_order("build", items), ["b", "c", "a"])
        state = self.root / "state" / "build.json"
        for corrupt in ("{broken", "[]", "null"):
            state.write_text(corrupt)
            self.assertEqual(cleanup.rotation_order("build", items), ["a", "b", "c"])
        cleanup.rotation_advance("build", "bb", [])
        self.assertEqual(cleanup.rotation_order("build", items), ["c", "a", "b"])
        self.assertEqual(list(state.parent.glob("*.tmp")), [])

    def test_build_rotates_and_next_step_gets_a_fresh_deadline(self):
        args = cleanup.parse_args(["--scheduled", "--only", "build,docker", "--build-step-seconds", "5"])
        ctx = cleanup.Ctx(args)
        ctx.args.steps = ["build", "docker"]
        checkouts = [cleanup.Checkout(str(self.root / name), "main") for name in ("a", "b")]
        deleted, docker_started = [], []

        def plan(_ctx, checkout, _queued):
            return {"path": checkout.path, "skip": None,
                    "dirs": [{"path": checkout.path + "/" + name, "action": "delete", "size": 0}
                             for name in ("bin", "obj")]}

        def remove(path, _remover):
            deleted.append(path)
            self.clock[0] += 6

        def docker(_ctx, _plan):
            docker_started.append(_ctx.ready())

        with mock.patch.object(cleanup, "plan_root_build", side_effect=plan), \
             mock.patch.object(cleanup, "take_snapshot"), \
             mock.patch.object(ctx, "active_reason", return_value=None), \
             mock.patch.object(cleanup, "held_inside", return_value=None), \
             mock.patch.object(cleanup, "delete_candidate", side_effect=remove), \
             mock.patch.object(cleanup, "plan_docker", return_value={}), \
             mock.patch.object(cleanup, "apply_docker", side_effect=docker):
            for _ in range(2):
                notes = []
                cleanup.scheduled_steps(ctx, checkouts, notes, {"steps": {}, "errors": []})
                self.assertTrue(any(note.startswith("step build stopped at deadline after") for note in notes))
        self.assertEqual(deleted, [checkouts[0].path + "/bin", checkouts[1].path + "/bin"])
        self.assertEqual(docker_started, [True, True])

    def test_bins_check_deadline_between_deletions_and_restore_callback(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.deadline = cleanup.StepDeadline("bins", 5, [])
        namespace = cleanup.BIN_SWEEP["sweep"].__globals__
        original = namespace["delete_candidate"]
        removed = []
        for name in ("first", "second"):
            (self.root / name).mkdir()

        def sweep(_roots, _probe, _apply, budget):
            for path in (self.root / "first", self.root / "second"):
                namespace["delete_candidate"](path, remove)
            return []

        def remove(path):
            removed.append(path)
            self.clock[0] += 6

        with mock.patch.dict(cleanup.BIN_SWEEP, {"sweep": mock.Mock(side_effect=sweep, __globals__=namespace)}):
            rows = cleanup.scheduled_bins(ctx, [mock.Mock(path=str(self.root), exists=True)], mock.Mock())
        self.assertEqual(removed, [self.root / "first"])
        self.assertIn("step deadline", rows[0]["reason"])
        self.assertIs(namespace["delete_candidate"], original)

    def test_deadline_flags_defaults_and_validation(self):
        args = cleanup.parse_args([])
        for step, seconds in cleanup.STEP_SECONDS.items():
            self.assertEqual(getattr(args, step + "_step_seconds"), seconds)
        self.assertEqual(cleanup.parse_args(["--build-step-seconds", "0"]).build_step_seconds, 0)
        for value in ("-1", "nan", "inf"):
            with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
                cleanup.parse_args(["--build-step-seconds", value])

    def test_deadline_note_is_written_to_scheduled_log(self):
        note = "step caches stopped at deadline after 7 items; continues next run"
        rep = {"exit": 0, "runtime_s": 1, "notes": [note]}
        with mock.patch.object(cleanup, "LOG_DIR", str(self.root)), \
             mock.patch.object(cleanup, "LOG_FILE", str(self.root / "cleanup.log")), \
             mock.patch.object(cleanup, "build_summary_lines", return_value=[]), \
             mock.patch.object(cleanup, "trim_log"):
            cleanup.write_log(rep)
        self.assertIn(note, (self.root / "cleanup.log").read_text())


class DockerDetectionTests(unittest.TestCase):
    def test_timeout_then_success(self):
        with mock.patch.object(cleanup, "run", side_effect=[(124, "", "timeout"), (0, "27.0\n", "")]) as probe:
            notes = []
            self.assertTrue(cleanup.docker_running(notes))
        self.assertEqual([call.kwargs["timeout"] for call in probe.call_args_list], [20, 45])
        self.assertEqual(notes, [])

    def test_twice_timeout_reports_unresponsive_not_not_running(self):
        with mock.patch.object(cleanup, "run", return_value=(124, "", "timeout")) as probe:
            notes = []
            self.assertFalse(cleanup.docker_running(notes))
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(notes, ["docker unresponsive (timed out twice): docker step skipped"])
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.docker_up, ctx.docker_unresponsive = False, True
        self.assertEqual(cleanup.plan_docker(ctx)["skip"], notes[0])

    def test_not_running_does_not_retry(self):
        with mock.patch.object(cleanup, "run", return_value=(1, "", "Cannot connect to the Docker daemon")) as probe:
            notes = []
            self.assertFalse(cleanup.docker_running(notes))
        probe.assert_called_once()
        self.assertEqual(notes, [])


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

    def keep_marker(self, marker='KEEP-PERF'):
        (self.root / '.git').write_text('gitdir: /git/worktrees/lane\n')
        path = self.root / marker
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        return 'KEEP marker: ' + marker

    def assert_marker_protected(self, reason):
        for root in (self.root, self.output.parent):
            self.assertEqual(self.build_plan(root)['skip'], reason)
            self.assertEqual(self.bin_plan(root)['reason'], reason)
        self.assertEqual(retain.retained_reason(self.output, now=self.now + 10 ** 9), reason)

    def test_keep_perf_skips_root_and_nested_build_and_bins_without_expiry(self):
        self.assert_marker_protected(self.keep_marker())

    def test_ai_work_keep_skips_root_and_nested_build_and_bins(self):
        self.assert_marker_protected(self.keep_marker('.ai-work/KEEP'))

    def test_checkout_without_marker_preserves_build_and_bins_behaviour(self):
        (self.root / '.git').mkdir()
        self.assert_unprotected(self.root)
        self.assert_unprotected(self.output.parent)

    def test_marker_lookup_stops_at_nearest_checkout(self):
        self.keep_marker()
        nested = self.root / 'nested'
        (nested / '.git').mkdir(parents=True)
        self.assertIsNone(retain.retained_reason(nested / 'project/bin'))

    def test_marker_outside_checkout_does_not_protect_it(self):
        (self.tmp / 'KEEP-PERF').touch()
        (self.root / '.git').mkdir()
        self.assertIsNone(retain.retained_reason(self.output))

    def test_symlinked_markers_count_without_following_targets(self):
        for marker in ('KEEP-PERF', '.ai-work/KEEP'):
            with self.subTest(marker=marker):
                root = self.tmp / marker.replace('/', '-')
                (root / '.git').mkdir(parents=True)
                path = root / marker
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(self.tmp / 'missing-outside')
                self.assertEqual(retain.retained_reason(root / 'project/bin'), 'KEEP marker: ' + marker)

    def test_symlinked_ai_work_is_not_traversed(self):
        (self.root / '.git').mkdir()
        outside = self.tmp / 'outside'
        outside.mkdir()
        (outside / 'KEEP').touch()
        (self.root / '.ai-work').symlink_to(outside, target_is_directory=True)
        self.assertIsNone(retain.retained_reason(self.output))

    def test_marker_created_after_planning_blocks_final_deletion(self):
        self.assert_unprotected(self.root)
        reason = self.keep_marker()
        for delete_candidate in (cleanup.delete_candidate, bins.delete_candidate):
            delete = Mock()
            self.assertEqual(delete_candidate(self.output, delete), reason)
            delete.assert_not_called()

    def test_marker_blocks_worktree_plan_and_removal_recheck(self):
        reason = self.keep_marker()
        checkout = cleanup.Checkout(str(self.root), 'linked', gitdir='/git/worktrees/lane', parent=str(self.tmp))
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'worktrees']))
        rows = cleanup.plan_worktrees(ctx, [checkout], [])
        self.assertEqual(rows[0]['action'], 'keep')
        self.assertIn(reason, rows[0]['blockers'])
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])):
            self.assertEqual(cleanup.fresh_recheck(ctx, checkout, {}), reason)
        self.assertEqual(cleanup.worktree_report(rows)['summary']['blockers'], {'kept (KEEP marker)': 1})
        out = []
        cleanup.render_worktrees(rows, False, out)
        self.assertIn('kept (KEEP marker)', '\n'.join(out))

    def test_marker_is_reported_in_build_and_bins_summary(self):
        self.keep_marker()
        rows = [self.build_plan(self.root)]
        summary = cleanup.summarize_build(rows, False)
        self.assertEqual(summary['skip_reasons'], {'kept (KEEP marker)': 1})
        out = []
        cleanup.render_build(rows, False, out)
        self.assertIn('kept (KEEP marker)', '\n'.join(out))
        rep = {'apply': False, 'steps': {'build': {'summary': summary},
                                       'bins': {'rows': [self.bin_plan(self.root)]}}, 'df': [], 'notes': [], 'errors': []}
        self.assertIn('bins: ' + str(self.root) + ': kept (KEEP marker)',
                      '\n'.join(cleanup.build_summary_lines(rep)))

    def test_marker_protects_other_deletion_steps_inside_checkout(self):
        reason = self.keep_marker()
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'caches']))
        self.assertEqual(cleanup.tmp_state(str(self.output), self.now)[1], reason)
        self.assertEqual(cleanup.gzip_session(ctx, {'path': str(self.root / 'session.jsonl')}), 'skipped: ' + reason)
        items = [dict(name='cache', action='run', paths=[str(self.output)])]
        cleanup.protect_cache_items(items)
        self.assertTrue(all(item['action'] == 'skip' and item['reason'] == reason for item in items))

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


class PlanRmiPinTests(unittest.TestCase):
    OLD = '2020-01-01T00:00:00Z'

    def plan(self, images, pins_text):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(tmp, ignore_errors=True))
        if pins_text is not None:
            (tmp / 'pinned.txt').write_text(pins_text)
        inspect = ''.join(f"{i}|{self.OLD}|{json.dumps(t)}|100|{json.dumps(d)}\n" for i, t, d in images)

        def run(cmd, timeout=None):
            if cmd[:3] == ['docker', 'image', 'ls']:
                return 0, ''.join(i + '\n' for i, _, _ in images), ''
            if cmd[:2] == ['docker', 'ps']:
                return 0, '', ''
            if cmd[:3] == ['docker', 'image', 'inspect']:
                return 0, inspect, ''
            raise AssertionError(cmd)
        with patch.dict(os.environ, DOCKER_GUARDIAN_STATE=str(tmp)), patch.object(cleanup, 'run', side_effect=run):
            return cleanup.plan_rmi(30)

    def test_pinned_tag_kept(self):
        cands, kept, err = self.plan([('sha256:a', ['mongo:8.2'], []), ('sha256:b', ['old:1'], [])],
                                     '# c\n\nmongo:*\n')
        self.assertIsNone(err)
        self.assertEqual([c['id'] for c in cands], ['sha256:b'])
        self.assertEqual([(k['id'], k['reason']) for k in kept], [('sha256:a', 'pinned: mongo:*')])

    def test_digest_suffixed_tag_kept(self):
        cands, kept, _ = self.plan([('sha256:a', ['testcontainers/ryuk:0.14.0@sha256:' + 'f' * 64], [])],
                                   'testcontainers/ryuk:0.14.0\n')
        self.assertEqual(cands, [])
        self.assertEqual(kept[0]['reason'], 'pinned: testcontainers/ryuk:0.14.0')

    def test_none_tag_with_pinned_repo_digest_kept(self):
        cands, kept, _ = self.plan([('sha256:a', [], ['mongo@sha256:' + 'e' * 64])], 'mongo@*\n')
        self.assertEqual(cands, [])
        self.assertEqual(len(kept), 1)

    def test_missing_pin_file_means_no_pins(self):
        cands, kept, err = self.plan([('sha256:a', ['mongo:8.2'], [])], None)
        self.assertIsNone(err)
        self.assertEqual([c['id'] for c in cands], ['sha256:a'])
        self.assertEqual(kept, [])


    def test_unreadable_pin_file_fails_closed(self):
        with patch.object(cleanup, 'run', side_effect=AssertionError('no docker calls expected')), \
             patch('builtins.open', side_effect=PermissionError('denied')):
            cands, kept, err = cleanup.plan_rmi(30)
        self.assertEqual((cands, kept), ([], []))
        self.assertIn('cannot read docker pin file', err)

    def test_apply_recompute_refuses_when_pin_file_unreadable(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.args.image_age_days = 30
        d = {'prunes': [], 'rmi': [], 'rmi_kept': [], 'error': None}
        calls = []
        with patch.object(cleanup, 'run', side_effect=lambda cmd, **k: calls.append(cmd) or (0, '', '')), \
             patch('builtins.open', side_effect=PermissionError('denied')):
            cleanup.apply_docker(ctx, d)
        self.assertEqual(d['rmi'], [])
        self.assertIn('cannot read docker pin file', d['error'])
        self.assertFalse([c for c in calls if c[:2] == ['docker', 'rmi']])


class NugetTrimTests(unittest.TestCase):
    DAY = 86400

    def setUp(self):
        parent = Path(os.environ.get('PI_RETAIN_TEST_TMP', str(Path.cwd() / '.ai-work/retain-tests')))
        parent.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(dir=parent)).resolve()
        self.real = self.tmp / 'real-packages'
        self.real.mkdir()
        self.link = self.tmp / 'packages'
        self.link.symlink_to(self.real)
        p = patch.object(cleanup, 'NUGET_PACKAGES', str(self.link))
        p.start()
        self.addCleanup(p.stop)
        self.ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'caches']))
        # ctime cannot be backdated, so move "now" 40 days ahead: every fixture's ctime is
        # then 40 days old and atime/mtime are set relative to this shifted clock.
        self.ctx.now += 40 * self.DAY

    def version(self, pid, ver, age_days=30, source='https://api.nuget.org/v3/index.json'):
        vd = self.real / pid / ver
        vd.mkdir(parents=True)
        (vd / '.nupkg.metadata').write_text(json.dumps({'source': source}))
        (vd / 'lib').mkdir()
        f = vd / 'lib' / 'a.dll'
        f.write_bytes(b'x' * 10)
        self.age(vd, age_days)
        return str(self.link / pid / ver)

    def age(self, vd, days):
        t = self.ctx.now - days * self.DAY
        for dp, dns, fns in os.walk(vd):
            for n in dns + fns:
                os.utime(os.path.join(dp, n), (t, t), follow_symlinks=False)
            os.utime(dp, (t, t))

    def plan(self):
        return cleanup.plan_nuget_trim(self.ctx)

    def test_scheduled_trim_rotates_versions_and_never_removes_newest(self):
        for name in ("alpha", "beta"):
            self.version(name, "1.0.0")
            self.version(name, "2.0.0")
        clock, deleted = [0.0], []
        self.ctx.args.nuget_keep_versions = 1

        def remove(path, _cutoff):
            deleted.append(path)
            clock[0] += 6
            return "deleted"

        with mock.patch.object(cleanup, "STATE_DIR", str(self.tmp / "state")), \
             mock.patch.object(cleanup.time, "monotonic", side_effect=lambda: clock[0]), \
             mock.patch.object(cleanup, "trash_remove", side_effect=remove), \
             mock.patch.object(cleanup, "which", side_effect=lambda tool: tool == "dotnet"), \
             mock.patch.object(cleanup, "procs_running", return_value=[]), \
             mock.patch.object(cleanup, "take_snapshot", return_value=cleanup.PathSet([])), \
             mock.patch.object(cleanup, "run", return_value=(0, "", "")), \
             mock.patch.object(cleanup, "plan_session_gzip", return_value=([], 0)):
            for _ in range(2):
                notes = []
                self.ctx.deadline = cleanup.StepDeadline("caches", 5, notes)
                plan = cleanup.plan_caches(self.ctx, [], include_tmp=False,
                                           consume=lambda batch: cleanup.apply_caches(self.ctx, batch))
                item = next(it for it in plan["items"] if it["name"] == "nuget packages trim")
                self.assertEqual(item["result"]["deleted"], 1)
                self.assertTrue(any(note.startswith("step caches stopped at deadline after") for note in notes))
        self.assertEqual(deleted, [str(self.link / name / "1.0.0") for name in ("alpha", "beta")])

    def test_defaults(self):
        self.assertEqual(self.ctx.args.nuget_age_days, 7)
        self.assertEqual(self.ctx.args.nuget_keep_versions, 3)

    def test_old_atime_eligible_recent_atime_kept(self):
        old = [self.version('p', f'1.0.{i}') for i in range(4)]
        recent = self.version('p', '0.9.0')  # oldest by semver, but recently read
        os.utime(Path(recent) / 'lib' / 'a.dll', (self.ctx.now, self.ctx.now - 30 * self.DAY))
        cands, *_ = self.plan()
        self.assertEqual(cands, [old[0]])  # 1.0.1-1.0.3 newest three; 0.9.0 used recently

    def test_newest_three_kept_by_semver(self):
        for v in ('1.2.0', '1.10.0', '1.9.0', '2.0.0-beta.2', '2.0.0-beta.10', '1.0.0'):
            self.version('p', v)
        cands, *_ = self.plan()
        self.assertEqual(sorted(os.path.basename(c) for c in cands), ['1.0.0', '1.2.0', '1.9.0'])

    def test_single_version_kept(self):
        self.version('p', '1.0.0')
        self.assertEqual(self.plan()[0], [])
        self.ctx.args.nuget_keep_versions = 0
        self.assertEqual(self.plan()[0], [])

    def test_stray_entries_ignored_for_ranking_and_never_deleted(self):
        vs = [self.version('p', f'1.0.{i}') for i in range(5)]
        stray_dir = self.real / 'p' / 'not-a-version'
        stray_dir.mkdir()
        nometa = self.real / 'p' / '9.9.9'  # parses, but has no .nupkg.metadata
        nometa.mkdir()
        (self.real / 'p' / 'stray.txt').write_text('x')
        (self.real / 'p' / 'link').symlink_to(self.real / 'p' / '1.0.0')
        cands, *_ = self.plan()
        self.assertEqual(sorted(cands), sorted(vs[:2]))
        self.ctx.args.nuget_keep_versions = 0
        self.assertEqual(len(self.plan()[0]), 4)  # never the only (newest) real version

    def test_only_real_version_kept_amid_strays(self):
        self.version('p', '1.0.0')
        (self.real / 'p' / 'junk').mkdir()
        self.ctx.args.nuget_keep_versions = 0
        self.assertEqual(self.plan()[0], [])

    def test_walk_or_stat_error_fails_closed(self):
        vs = [self.version('p', f'1.0.{i}') for i in range(4)]
        self.assertEqual(self.plan()[0], [vs[0]])
        real_lstat = os.lstat
        def bad(path, *a, **k):
            if str(path).endswith('a.dll') and '1.0.0' in str(path):
                raise PermissionError('denied')
            return real_lstat(path, *a, **k)
        with patch.object(cleanup.os, 'lstat', side_effect=bad):
            self.assertEqual(self.plan()[0], [])
        real_scandir = os.scandir
        def bad_scandir(path):
            if str(path).endswith('lib') and '1.0.0' in str(path):
                raise PermissionError('denied')
            return real_scandir(path)
        with patch.object(cleanup.os, 'scandir', side_effect=bad_scandir):
            self.assertEqual(self.plan()[0], [])

    def test_timestamps_captured_before_metadata_is_read(self):
        vs = [self.version('p', f'1.0.{i}') for i in range(4)]
        events = []
        real_usage, real_open = cleanup.tree_usage, open
        def usage(*a, **k):
            events.append('walk')
            return real_usage(*a, **k)
        def spy_open(path, *a, **k):
            if str(path).endswith('.nupkg.metadata'):
                events.append('read')
            return real_open(path, *a, **k)
        with patch.object(cleanup, 'tree_usage', side_effect=usage), \
             patch('builtins.open', side_effect=spy_open):
            cleanup.nuget_check(vs[0], self.ctx.now - 7 * self.DAY, os.path.realpath(str(self.link)))
        self.assertEqual(events, ['walk', 'read'])

    def test_fresh_metadata_atime_makes_version_ineligible(self):
        vs = [self.version('p', f'1.0.{i}') for i in range(4)]
        os.utime(Path(vs[0]) / '.nupkg.metadata', (self.ctx.now, self.ctx.now - 30 * self.DAY))
        self.assertEqual(self.plan()[0], [])

    def test_plan_does_not_refresh_metadata_atime(self):
        vs = [self.version('p', f'1.0.{i}') for i in range(4)]
        meta = Path(vs[0]) / '.nupkg.metadata'
        before = os.lstat(meta)
        self.assertEqual(self.plan()[0], [vs[0]])
        after = os.lstat(meta)
        self.assertEqual((after.st_atime_ns, after.st_mtime_ns), (before.st_atime_ns, before.st_mtime_ns))

    def test_old_atimes_without_clock_shift(self):
        # real clock: only atime/mtime are backdated; ctime is "now", so nothing may be eligible
        self.ctx.now -= 40 * self.DAY
        vs = [self.version('p', f'1.0.{i}') for i in range(4)]
        self.ctx.now += 40 * self.DAY
        self.assertEqual(self.plan()[0], [vs[0]])
        self.ctx.now = time.time()
        self.assertEqual(self.plan()[0], [])  # ctime is fresh at the real clock

    def test_recheck_before_rename_skips_newly_used(self):
        vd = self.version('p', '1.0.0')
        cutoff = self.ctx.now - 7 * self.DAY
        self.assertEqual(cleanup.trash_remove(vd, time.time() - 7 * self.DAY), 'skipped')  # fresh ctime
        self.assertTrue(os.path.isdir(vd))
        self.assertEqual(cleanup.trash_remove(vd, cutoff), 'deleted')

    def test_leftover_trash_of_dead_pid_recovered(self):
        import subprocess
        p = subprocess.Popen(['true']); p.wait()
        dead = p.pid
        self.version('p', '1.0.0')
        (self.real / 'p' / f'.1.0.1.pi-cleanup-trash-{dead}' / 'lib').mkdir(parents=True)
        (self.real / 'p' / f'.1.0.2.pi-cleanup-trash-{os.getpid()}').mkdir()  # live pid
        (self.real / 'p' / f'.1.0.3.pi-cleanup-trash-{dead}x').mkdir()  # bad name
        outside = self.tmp / 'outside'; outside.mkdir()
        (self.real / 'p' / f'.1.0.4.pi-cleanup-trash-{dead}').symlink_to(outside)
        found = cleanup.find_nuget_trash(os.path.realpath(str(self.link)))
        self.assertEqual([os.path.basename(f) for f in found], [f'.1.0.1.pi-cleanup-trash-{dead}'])
        item = dict(name='nuget packages trim', action='run', paths=[])
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
             patch.object(cleanup, 'protect_cache_items'):
            cleanup.apply_caches(self.ctx, dict(items=[item]))
        self.assertEqual(item['result']['recovered'], 1)
        self.assertTrue(outside.is_dir())
        self.assertFalse(found[0] and os.path.exists(found[0]))

    def test_local_sourced_kept_and_sized(self):
        local = [self.version('p', f'1.0.{i}', source='/Users/x/local-feed') for i in range(5)]
        cands, kept, local_bytes, _ = self.plan()
        self.assertEqual(cands, [])
        self.assertEqual(kept, 5)
        self.assertGreater(local_bytes, 0)

    def test_rename_then_delete(self):
        vd = self.version('p', '1.0.0')
        renames = []
        real_rename = os.rename
        def spy(a, b):
            renames.append((a, b))
            self.assertTrue(os.path.exists(a))
            real_rename(a, b)
        with patch.object(cleanup.os, 'rename', side_effect=spy):
            self.assertEqual(cleanup.trash_remove(vd), 'deleted')
        self.assertEqual(len(renames), 1)
        self.assertEqual(os.path.basename(renames[0][1]), f'.1.0.0.pi-cleanup-trash-{os.getpid()}')
        self.assertEqual(os.listdir(self.real / 'p'), [])

    def test_rename_failure_skips(self):
        vd = self.version('p', '1.0.0')
        with patch.object(cleanup.os, 'rename', side_effect=OSError('nope')), \
             patch.object(cleanup.shutil, 'rmtree', side_effect=AssertionError('no delete')):
            self.assertEqual(cleanup.trash_remove(vd), 'skipped')
        self.assertTrue(os.path.isdir(vd))

    def test_symlinked_root_plans_and_apply_runs_with_dotnet_running(self):
        paths = [self.version('p', f'1.0.{i}') for i in range(5)]
        cands, kept, _, size = self.plan()
        self.assertEqual(sorted(cands), sorted(paths[:2]))
        self.assertGreater(size, 0)
        item = dict(name='nuget packages trim', action='run', paths=cands)
        with patch.object(cleanup, 'procs_running', return_value=['dotnet']), \
             patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
             patch.object(cleanup, 'protect_cache_items'):
            cleanup.apply_caches(self.ctx, dict(items=[item]))
        self.assertEqual(item['result']['deleted'], 2)
        self.assertEqual(sorted(os.listdir(self.real / 'p')), ['1.0.2', '1.0.3', '1.0.4'])

    def test_recent_use_between_plan_and_apply_is_respected(self):
        vd = self.version('p', '1.0.0')
        self.version('p', '1.0.1'); self.version('p', '1.0.2'); self.version('p', '1.0.3')
        cands, *_ = self.plan()
        self.assertEqual(cands, [vd])
        os.utime(Path(vd) / 'lib' / 'a.dll', (self.ctx.now, self.ctx.now))
        item = dict(name='nuget packages trim', action='run', paths=cands)
        with patch.object(cleanup, 'take_snapshot', return_value=cleanup.PathSet([])), \
             patch.object(cleanup, 'protect_cache_items'):
            cleanup.apply_caches(self.ctx, dict(items=[item]))
        self.assertTrue(os.path.isdir(vd))
        self.assertEqual(item['result']['skipped'], 1)

    def test_sizing_follows_symlink(self):
        self.version('p', '1.0.0')
        self.assertGreater(cleanup.du_bytes(os.path.realpath(str(self.link)), 5), 0)


if __name__ == '__main__':
    unittest.main()
