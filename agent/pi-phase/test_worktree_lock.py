"""Real subprocess coverage for worktree admission and descriptor-backed nesting."""
import fcntl
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import time
from unittest.mock import patch

import pi_phase
from test_queue_order import GIT, HERE, Harness, git_repo


class WorktreeLockTests(Harness):
    def setUp(self):
        Harness.setUp(self)
        environment = patch.dict(os.environ, PI_PHASE_WORKTREE_LOCK="1", PI_PHASE_NO_SKIP="1")
        environment.start()
        self.addCleanup(environment.stop)
        self.configure(msbuild_max_cpu=0, phase_nice=0, cold_worktree_hint=False,
                       container_test_detection="off")
        self.repo = git_repo(self.root / "repo")

    def start_in(self, cwd, *args, env=None, pass_fds=()):
        environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(self.root.parent))
        environment.update(env or {})
        child = subprocess.Popen(self.cli(*args), cwd=cwd, env=environment, pass_fds=pass_fds,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def phase(self, label, policy="direct", **options):
        cwd = options.pop("cwd", self.repo)
        command = options.pop("command", None) or self.job(label)
        extra = options.pop("extra", ())
        kind = options.pop("kind", "test")
        return self.start_in(cwd, "run", "--kind", kind, "--label", label,
                             "--policy", policy, "--timeout", "8", "--queue-timeout", "5",
                             *extra, "--", *command, **options)

    def job(self, label, seconds=.8):
        script = ("import pathlib,time,json,sys; p=pathlib.Path(sys.argv[1]); start=time.time(); "
                  "p.with_suffix('.started').touch(); time.sleep(float(sys.argv[2])); "
                  "p.write_text(json.dumps([start,time.time()]))")
        return [sys.executable, "-c", script, str(self.root / (label + ".json")), str(seconds)]

    def started(self, label):
        self.wait_for(lambda: (self.root / (label + ".started")).exists(), seconds=5)

    def waiting(self):
        return list((self.state / "worktrees" / "waiting").glob("*.json"))

    def holder(self):
        return pi_phase.metadata(pi_phase.worktree_paths(self.state, os.path.realpath(self.repo))[1])

    def hold(self, **metadata):
        path, info, _ = pi_phase.worktree_paths(self.state, os.path.realpath(self.repo))
        fd = pi_phase.lock_file(path)
        self.assertIsNotNone(fd)
        self.addCleanup(os.close, fd)
        pi_phase.save(info, dict(token="external", label="external", pid=os.getpid(),
                                 root=os.path.realpath(self.repo), kind="test", acquired=time.time(), **metadata))
        return path, fd

    def test_serialises_policies_subdirectory_wait_message_and_ledger(self):
        sub = self.repo / "sub"
        sub.mkdir()
        a = self.phase("A")
        self.started("A")
        b = self.phase("B", "queued", cwd=sub)
        self.wait_for(lambda: len(self.waiting()) == 1)
        c = self.phase("C", "fast", extra=("--expect-fast",))
        self.assertEqual(self.done(a)[0], 0)
        code, output = self.done(b)
        self.assertEqual(code, 0, output)
        self.assertIn(f"waiting for worktree lock (held by A pid {a.pid})", output)
        self.assertEqual(self.done(c)[0], 0)
        ai, bi, ci = self.intervals("A", "B", "C")
        self.assertLessEqual(ai[1], bi[0])
        self.assertLessEqual(bi[1], ci[0])
        record = next(r for r in self.ledger_records() if r["label"] == "B")
        self.assertEqual(record["worktreeLock"], "held")
        self.assertGreater(record["worktreeWaitS"], 0)
        self.assertEqual(record["worktreeRoot"], os.path.realpath(self.repo))

    def test_build_and_integration_share_worktree_lock(self):
        a = self.phase("A", kind="build")
        self.started("A")
        b = self.phase("B", "queued", kind="integration")
        self.assertEqual(self.done(a)[0], 0)
        code, output = self.done(b)
        self.assertEqual(code, 0, output)
        ai, bi = self.intervals("A", "B")
        self.assertLessEqual(ai[1], bi[0])

    def linked(self):
        sibling = self.root / "linked"
        subprocess.run([*GIT, "-C", str(self.repo), "worktree", "add", "-q", str(sibling), "-b", "other"],
                       check=True)
        return sibling

    def test_linked_worktree_runs_concurrently_and_roots_are_canonical(self):
        sibling = self.linked()
        a = self.phase("A")
        self.started("A")
        b = self.phase("B", cwd=sibling)
        self.assertEqual(self.done(a)[0], 0)
        self.assertEqual(self.done(b)[0], 0)
        ai, bi = self.intervals("A", "B")
        self.assertLess(bi[0], ai[1])
        sub = self.repo / "sub"
        sub.mkdir()
        self.assertEqual(pi_phase.worktree_root(sub), os.path.realpath(self.repo))
        self.assertEqual(pi_phase.worktree_root(sibling), os.path.realpath(sibling))
        with patch.dict(os.environ, GIT_CEILING_DIRECTORIES=str(self.root.parent)):
            self.assertEqual(pi_phase.worktree_root(self.root), os.path.realpath(self.root))

    def test_opt_out_overlaps_but_build_rejects_it(self):
        a = self.phase("A")
        self.started("A")
        b = self.phase("B", extra=("--no-worktree-lock",))
        rejected = self.start_in(self.repo, "run", "--kind", "build", "--label", "bad",
                                 "--no-worktree-lock", "--", "true")
        code, output = self.done(rejected)
        self.assertEqual(code, 125, output)
        self.assertIn("build writes the worktree", output)
        self.assertEqual(self.done(a)[0], 0)
        self.assertEqual(self.done(b)[0], 0)
        ai, bi = self.intervals("A", "B")
        self.assertLess(bi[0], ai[1])

    def test_timeout_holds_no_global_capacity(self):
        self.hold()
        b = self.phase("B", extra=("--queue-timeout", "1"))
        self.wait_for(lambda: bool(self.waiting()))
        self.assertFalse(list((self.state / "waiters").glob("*.json")))
        self.assertFalse(list(self.state.glob("direct-*.lock")))
        code, output = self.done(b)
        self.assertEqual(code, 75, output)
        self.assertIn("queue timeout (1s)", output)
        self.assertFalse((self.root / "B.started").exists())
        self.assertEqual(self.waiting(), [])

    def test_cancel_waiter_cleans_registration(self):
        self.hold()
        b = self.phase("B")
        self.wait_for(lambda: bool(self.waiting()))
        b.send_signal(signal.SIGTERM)
        code, output = self.done(b)
        self.assertEqual(code, 143, output)
        self.assertEqual(self.waiting(), [])

    def test_stale_holder_recovered(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"], start_new_session=True)
        dead.wait(timeout=3)
        _, info, _ = pi_phase.worktree_paths(self.state, os.path.realpath(self.repo))
        pi_phase.save(info, dict(token="stale", pid=dead.pid, pgid=dead.pid, label="old"))
        code, output = self.done(self.phase("B", command=self.job("B", .01)))
        self.assertEqual(code, 0, output)
        self.assertIn("recovered stale worktree lock", output)

    def test_live_orphan_group_blocks_even_without_descriptor(self):
        owner = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(8)"], start_new_session=True)
        self.children.append(owner)
        _, info, _ = pi_phase.worktree_paths(self.state, os.path.realpath(self.repo))
        pi_phase.save(info, dict(token="orphan", pid=owner.pid, pgid=owner.pid, label="orphan"))
        code, output = self.done(self.phase("B", extra=("--queue-timeout", "1")))
        self.assertEqual(code, 75, output)
        self.assertFalse((self.root / "B.started").exists())

    def test_supervisor_crash_retains_producer_lock_and_recovers_waiter(self):
        a = self.phase("A")
        self.started("A")
        b = self.phase("B")
        self.wait_for(lambda: bool(self.waiting()))
        a.kill()
        self.assertEqual(self.done(a)[0], -signal.SIGKILL)
        code, output = self.done(b)
        self.assertEqual(code, 0, output)
        ai, bi = self.intervals("A", "B")
        self.assertLessEqual(ai[1], bi[0])
        self.assertEqual(self.waiting(), [])

    def test_crashed_waiter_does_not_block_next_waiter(self):
        a = self.phase("A")
        self.started("A")
        b = self.phase("B")
        self.wait_for(lambda: bool(self.waiting()))
        b.kill()
        self.assertEqual(self.done(b)[0], -signal.SIGKILL)
        c = self.phase("C")
        self.assertEqual(self.done(a)[0], 0)
        code, output = self.done(c)
        self.assertEqual(code, 0, output)
        self.assertEqual(self.waiting(), [])
        self.assertFalse((self.root / "B.started").exists())

    def test_normal_completion_does_not_unlock_escaped_descriptor_holder(self):
        script = ("import os,json,subprocess,sys,time,pathlib; "
                  "fd=json.loads(os.environ['PI_PHASE_WORKTREE_HELD'])['fd']; "
                  "subprocess.Popen(sys.argv[2:],pass_fds=(fd,),start_new_session=True,"
                  "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
                  "p=pathlib.Path(sys.argv[1]); "
                  "exec('while not p.exists(): time.sleep(.01)')")
        command = [sys.executable, "-c", script, str(self.root / "escaped.started"), *self.job("escaped")]
        a = self.phase("A", command=command)
        self.started("escaped")
        self.assertEqual(self.done(a)[0], 0)
        code, output = self.done(self.phase("B"))
        self.assertEqual(code, 0, output)
        escaped, bi = self.intervals("escaped", "B")
        self.assertLessEqual(escaped[1], bi[0])

    def test_status_preserves_phase_status_parser(self):
        a = self.phase("A")
        self.started("A")
        b = self.phase("B")
        self.wait_for(lambda: bool(self.waiting()))
        code, output = self.done(self.start_in(self.repo, "status"))
        self.assertEqual(code, 0, output)
        self.assertIn(f"worktree-lock root={os.path.realpath(self.repo)} holder=A pid={a.pid}", output)
        self.assertIn(f"worktree-wait root={os.path.realpath(self.repo)} label=B", output)
        active = runpy.run_path(str(HERE.parent / "bin" / "phase_status.py"))["active_phases"]
        self.assertIsNotNone(active(output))
        self.assertEqual(self.done(a)[0], 0)
        self.assertEqual(self.done(b)[0], 0)

    def test_nested_inherits_and_forwards_descriptor(self):
        inner = self.cli("run", "--kind", "test", "--label", "inner", "--policy", "direct",
                         "--timeout", "3", "--queue-timeout", "1", "--", *self.job("inner", .01))
        middle = self.cli("run", "--kind", "test", "--label", "middle", "--policy", "direct",
                          "--timeout", "5", "--queue-timeout", "1", "--", *inner)
        code, output = self.done(self.phase("outer", command=middle))
        self.assertEqual(code, 0, output)
        self.assertEqual(output.count("worktree lock inherited"), 2)
        self.assertNotIn("waiting for worktree lock", output)

    def descriptor_hints(self, path, fd):
        data = self.holder()
        return {pi_phase.WORKTREE_HELD_ENV: json.dumps(dict(fd=fd, root=os.path.realpath(self.repo),
                state=os.path.realpath(self.state), token=data["token"]))}

    def assert_independent_waits(self, hints, pass_fds=()):
        b = self.phase("B", env=hints, pass_fds=pass_fds, extra=("--queue-timeout", "1"))
        code, output = self.done(b)
        self.assertEqual(code, 75, output)
        self.assertNotIn("worktree lock inherited", output)
        self.assertFalse((self.root / "B.started").exists())

    def test_copied_environment_without_descriptor_cannot_inherit(self):
        path, fd = self.hold()
        self.assert_independent_waits(self.descriptor_hints(path, fd))

    def test_reused_descriptor_wrong_inode_cannot_inherit(self):
        path, _ = self.hold()
        wrong = os.open(self.root / "wrong", os.O_CREAT | os.O_RDWR, 0o600)
        self.addCleanup(os.close, wrong)
        self.assert_independent_waits(self.descriptor_hints(path, wrong), (wrong,))

    def test_separate_open_same_inode_cannot_inherit(self):
        path, _ = self.hold()
        separate = os.open(path, os.O_RDWR)
        self.addCleanup(os.close, separate)
        self.assert_independent_waits(self.descriptor_hints(path, separate), (separate,))

    def test_inherited_close_does_not_unlock_parent(self):
        path, fd = self.hold()
        b = self.phase("B", env=self.descriptor_hints(path, fd), pass_fds=(fd,), command=self.job("B", .01))
        code, output = self.done(b)
        self.assertEqual(code, 0, output)
        self.assertIn("worktree lock inherited", output)
        self.assertTrue(pi_phase.readonly_busy(path))
        self.assertEqual(self.holder()["token"], "external")
