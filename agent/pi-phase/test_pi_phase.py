"""Synthetic bounded subprocess tests: no builds, network, Docker or CI."""
import json
import hashlib
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone, timedelta
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import pi_phase

HERE = Path(__file__).resolve().parent
AI_WORK = HERE.parent.parent / ".ai-work"
ENTRY = "import sys; sys.path.insert(0, sys.argv[1]); from pi_phase import main; sys.exit(main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))"


class PhaseTests(unittest.TestCase):
    def setUp(self):
        AI_WORK.mkdir(exist_ok=True)
        self.owned = tempfile.TemporaryDirectory(prefix="pi-phase-test-", dir=AI_WORK)
        self.addCleanup(self.owned.cleanup)
        self.root = Path(self.owned.name)
        self.state = self.root / "state"
        self.config = self.root / "config.json"
        # Default hint probes must never reach the host's Docker daemon.
        self.fake_bin = self.root / "fake-bin"
        self.fake_bin.mkdir()
        self.executable(self.fake_bin / "docker", "#!/bin/sh\nexit 1\n")
        # Existing admission tests assume the swap floor is enforced (it is skipped on macOS by design).
        swap_floor = patch.object(pi_phase, "SWAP_FLOOR_ENFORCED", True)
        swap_floor.start()
        self.addCleanup(swap_floor.stop)
        environment = patch.dict(os.environ, PATH=str(self.fake_bin) + os.pathsep + os.environ["PATH"])
        environment.start()
        self.addCleanup(environment.stop)
        self.children = []
        self.addCleanup(self.finish_children)

    def finish_children(self):
        for child in self.children:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.communicate(timeout=4)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate(timeout=4)
            else:
                child.communicate()

    def cli(self, *args):
        return [sys.executable, "-B", "-c", ENTRY, str(HERE), str(self.state), str(self.config), *args]

    def start(self, *args):
        child = subprocess.Popen(self.cli(*args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def patched_phase(self, patch, *, queue="2", extra=()):
        marker = self.root / "must-not-run"
        command = [sys.executable, "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).touch()", str(marker)]
        entry = ("import sys; sys.path.insert(0, sys.argv[1]); import pi_phase\n"
                 + patch + "\nsys.exit(pi_phase.main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))")
        child = subprocess.Popen([sys.executable, "-B", "-c", entry, str(HERE), str(self.state),
                                  str(self.config), "run", "--kind", "test", "--label", "patched",
                                  "--timeout", "3", "--queue-timeout", queue, *extra, "--", *command],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child, marker

    def orphan_slots(self):
        self.config.write_text('{"heavy_slots": 32, "integration_slots": 1}')
        owner = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(3)"],
                                 start_new_session=True, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        self.children.append(owner)
        for index in range(32):
            self.state.mkdir(exist_ok=True)
            (self.state / f"heavy-{index}.json").write_text(json.dumps({"pgid": owner.pid,
                                                                           "token": "orphan"}))
        return owner.pid

    def done(self, child, timeout=8):
        stdout, stderr = child.communicate(timeout=timeout)
        return child.returncode, stdout + stderr

    def run_phase(self, kind="test", label="case", timeout="4", queue="5", command=None, extra=()):
        if command is None:
            command = [sys.executable, "-c", "pass"]
        return self.start("run", "--kind", kind, "--label", label, "--timeout", timeout,
                          "--queue-timeout", queue, *extra, "--", *command)

    def wait_for(self, predicate, seconds=3):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.04)
        self.fail("expected bounded test condition never occurred")

    def marker_job(self, name, seconds=.6):
        marker = self.root / f"{name}.json"
        script = ("import json,time,sys; p=sys.argv[1]; "
                  "start=time.monotonic(); time.sleep(float(sys.argv[2])); "
                  "open(p,'w').write(json.dumps([start,time.monotonic()]))")
        return [sys.executable, "-c", script, str(marker), str(seconds)]

    def intervals(self, *names):
        return [json.loads((self.root / f"{name}.json").read_text()) for name in names]

    def waiter(self, label, priority="normal", kind="build", fast=False):
        self.state.mkdir(exist_ok=True)
        args = SimpleNamespace(priority=priority, kind=kind, label=label, fast=fast)
        ready, fd = pi_phase.register_waiter(self.state, args, label)
        self.assertTrue(ready)
        self.addCleanup(os.close, fd)
        return label

    def admit(self, token, kind="build", heavy=1, integration=1):
        held = pi_phase.claim(self.state, pi_phase.slot_paths(self.state, kind, heavy, integration, ()),
                              time.monotonic() + 1, lambda: False, token, (heavy, integration))
        if held:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def executable(self, path, content):
        path.write_text(content)
        path.chmod(0o700)
        return path

    def configure(self, **options):
        self.config.write_text(json.dumps(dict(heavy_slots=2, integration_slots=1, **options)))

    def fake_docker(self, created):
        stamp = datetime.fromtimestamp(created, timezone.utc).strftime("%Y-%m-%d %H:%M:%S %z UTC")
        self.executable(self.fake_bin / "docker", "#!/bin/sh\nprintf '%s\\n' 'container " + stamp + "'\n")

    def ledger_records(self):
        return [json.loads(line) for path in sorted((self.state / "ledger").glob("*.jsonl"))
                for line in path.read_text().splitlines()]

    def ledger_command(self, *extra, command=None):
        command = command or ["python3", "-c", "pass", "secret-argument"]
        result = subprocess.run(self.cli("run", "--kind", "test", "--label", "ledger",
                                "--timeout", "3", "--queue-timeout", "2", *extra, "--", *command),
                                cwd=self.root, env=dict(os.environ, GIT_CEILING_DIRECTORIES=str(self.root.parent)),
                                capture_output=True, text=True, timeout=8)
        return result, command

    def passed_state(self, **changes):
        args = SimpleNamespace(kind="test", label="repeat", priority="normal", command=["true"])
        record = pi_phase.PhaseLedger(args).record
        record.update(ts=pi_phase.utc_stamp(), outcome="passed", verified=True, head="a" * 40, dirty="clean",
                      startedAt=pi_phase.utc_stamp(), waitS=1, runS=2)
        record.update(changes)
        pi_phase.append_ledger(self.state, record)
        return record

    def repeat_state(self, *extra, kind="test", snapshot=("a" * 40, "clean")):
        flags = ["run", "--kind", kind, "--label", "repeat", *extra]
        if kind == "ci":
            flags += ["--repo", "repo", "--pr", "1", "--commit", "commit"]
        with patch.object(pi_phase, "git_state", return_value=snapshot), \
                patch.object(pi_phase, "register_waiter", side_effect=ValueError("registered")) as register, \
                patch.object(sys, "stdout", new_callable=io.StringIO) as output, \
                patch.object(sys, "stderr", new_callable=io.StringIO):
            code = pi_phase.main([*flags, "--", "true"], state=self.state, configuration=self.config)
        return code, output.getvalue(), register

    def git_repo(self):
        repo = self.root / "repo"
        repo.mkdir()
        for command in (["init", "-q"], ["config", "user.name", "Test"],
                        ["config", "user.email", "test@example.invalid"]):
            subprocess.run(["git", *command], cwd=repo, check=True, capture_output=True)
        (repo / "tracked").write_text("initial")
        subprocess.run(["git", "add", "tracked"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=repo, check=True, capture_output=True)
        return repo

    def test_untracked_file_content_changes_dirty_without_status_changes(self):
        repo = self.git_repo()
        untracked = repo / "new-file"
        untracked.write_bytes(b"before")
        before = pi_phase.git_state(repo, timeout=3)
        status = subprocess.run(["git", "status", "--porcelain"], cwd=repo,
                                check=True, capture_output=True).stdout
        untracked.write_bytes(b"after!")
        after = pi_phase.git_state(repo, timeout=3)
        self.assertEqual(before[0], after[0])
        self.assertIsNotNone(before[1])
        self.assertIsNotNone(after[1])
        self.assertNotEqual(before[1], after[1])
        self.assertEqual(status, subprocess.run(["git", "status", "--porcelain"], cwd=repo,
                                               check=True, capture_output=True).stdout)

    def test_untracked_file_count_bytes_and_read_errors_disable_dirty(self):
        repo = self.git_repo()
        for i in range(2001):
            (repo / f"untracked-{i}").touch()
        self.assertIsNone(pi_phase.git_state(repo, timeout=3)[1])
        for i in range(2001):
            (repo / f"untracked-{i}").unlink()
        with (repo / "large").open("wb") as stream:
            stream.truncate(200_000_001)
        self.assertIsNone(pi_phase.git_state(repo, timeout=3)[1])
        (repo / "large").unlink()
        (repo / "broken-link").symlink_to("missing-target")
        self.assertIsNone(pi_phase.git_state(repo, timeout=3)[1])

    def test_untracked_hash_is_sorted_and_counts_bytes_across_files(self):
        repo = self.git_repo()
        (repo / "a").write_bytes(b"123")
        (repo / "b").write_bytes(b"456")
        expected = b"a\0" + hashlib.sha256(b"123").digest() + b"b\0" + hashlib.sha256(b"456").digest()
        self.assertEqual(pi_phase.untracked_state(repo, [b"b", b"a"], 2, 6), expected)
        with self.assertRaises(ValueError):
            pi_phase.untracked_state(repo, [b"a", b"b"], 2, 5)

    def test_untracked_hash_timeout_leaves_dirty_null(self):
        replies = [SimpleNamespace(stdout="head"), SimpleNamespace(stdout=b"?? untracked\0"),
                   SimpleNamespace(stdout=b"diff"), SimpleNamespace(stdout=b"untracked\0"),
                   subprocess.TimeoutExpired("hash", 3)]
        with patch.object(pi_phase.subprocess, "run", side_effect=replies):
            self.assertEqual(pi_phase.git_state(self.root, timeout=3), ("head", None))

    def test_unverified_and_legacy_passes_are_never_skip_eligible(self):
        self.passed_state(verified=False)
        self.assertEqual(self.repeat_state()[0], 125)
        record = self.passed_state()
        for path in (self.state / "ledger").glob("*.jsonl"):
            path.write_text("")
        record.pop("verified")
        pi_phase.append_ledger(self.state, record)
        self.assertEqual(self.repeat_state()[0], 125)

    def test_environment_hash_changes_skip_key_and_excludes_secrets(self):
        names = ["PI_PHASE_TEST", "DOTNET_TEST", "NUGET_TEST", "MSBUILD_TEST", "NODE_TEST",
                 "NPM_TEST", "YARN_TEST", "VITE_TEST", "CONFIGURATION", "ASPNETCORE_TEST", "CI"]
        with patch.dict(os.environ, {name: "before" for name in names}, clear=True):
            self.passed_state()
            original = pi_phase.env_hash()
            self.assertEqual(self.repeat_state()[0], 0)
            for name in names:
                with self.subTest(name=name), patch.dict(os.environ, {name: "after"}):
                    self.assertNotEqual(pi_phase.env_hash(), original)
                    self.assertEqual(self.repeat_state()[0], 125)
            # Names are built at runtime so the publish secret scan does not read them as credentials.
            excluded = {prefix + suffix: "hidden" for prefix, suffix in (
                ("DOTNET_", "TOKEN"), ("NUGET_", "SECRET"), ("NPM_", "PASS" + "WORD"), ("NODE_API_", "KEY"))}
            with patch.dict(os.environ, {**excluded, "UNRELATED": "other"}):
                self.assertEqual(pi_phase.env_hash(), original)
            expected = hashlib.sha256("\0".join(sorted(f"{n}=before" for n in names)).encode()).hexdigest()
            self.assertEqual(original, expected)

    def test_edit_during_run_is_unverified_and_never_skipped(self):
        repo = self.git_repo()
        counter = self.root / "runs"
        command = [sys.executable, "-c",
                   "import pathlib,sys;pathlib.Path('tracked').write_text('after');"
                   "p=pathlib.Path(sys.argv[1]);p.write_text(p.read_text()+'x' if p.exists() else 'x')",
                   str(counter)]
        flags = self.cli("run", "--kind", "test", "--label", "editing", "--", *command)
        for _ in range(2):
            (repo / "tracked").write_text("dirty before")
            result = subprocess.run(flags, cwd=repo, check=True, capture_output=True, text=True, timeout=8)
            self.assertNotIn("skipped:", result.stdout)
            self.assertFalse(self.ledger_records()[-1]["verified"])
        self.assertEqual(counter.read_text(), "xx")

    def test_unchanged_untracked_state_verifies_and_skips(self):
        repo = self.git_repo()
        (repo / "untracked").write_text("unchanged")
        flags = self.cli("run", "--kind", "test", "--label", "unchanged", "--", "true")
        first = subprocess.run(flags, cwd=repo, check=True, capture_output=True, text=True, timeout=8)
        self.assertNotIn("skipped:", first.stdout)
        self.assertTrue(self.ledger_records()[-1]["verified"])
        second = subprocess.run(flags, cwd=repo, check=True, capture_output=True, text=True, timeout=8)
        self.assertIn("skipped:", second.stdout)
        self.assertEqual(self.ledger_records()[-1]["outcome"], "skipped")

    def test_verification_snapshot_is_after_release_and_not_in_runtime(self):
        calls = []
        def snapshot(cwd, timeout=None):
            if calls:
                self.assertTrue(any(self.state.glob("heavy-*.lock")))
                self.assertFalse(any(pi_phase.readonly_busy(p) for p in self.state.glob("heavy-*.lock")))
            calls.append(timeout)
            return "head", "clean"
        with patch.object(pi_phase, "git_state", side_effect=snapshot):
            code = pi_phase.main(["run", "--kind", "test", "--label", "verify", "--", "true"],
                                 state=self.state, configuration=self.config)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [3, 3])
        self.assertTrue(self.ledger_records()[-1]["verified"])

    def test_end_snapshot_null_timeout_or_environment_change_is_unverified(self):
        args = SimpleNamespace(kind="test", label="verify", priority="normal", command=["true"])
        for end in [("head", None), (None, None), ("different", "clean"),
                    subprocess.TimeoutExpired("git", 3), ("head", "clean")]:
            with self.subTest(end=end):
                ledger = pi_phase.PhaseLedger(args)
                with patch.object(pi_phase, "git_state", side_effect=[("head", "clean"), end]):
                    ledger.prepare_snapshot()
                    ledger.enqueue()
                    ledger.start()
                    if end == ("head", "clean"):
                        with patch.dict(os.environ, DOTNET_TEST="changed"):
                            ledger.finish(self.state, 0)
                    else:
                        ledger.finish(self.state, 0)
                self.assertFalse(ledger.record["verified"])
                self.assertEqual(ledger.record["outcome"], "passed")

    def test_high_downgrade_note_does_not_hold_coordinator(self):
        pi_phase.grant_priority(self.state, 10, None)
        def note(message):
            fd = pi_phase.lock_file(self.state / "coordinator.lock")
            self.assertIsNotNone(fd, message)
            pi_phase.unlock(fd)
        with patch.object(pi_phase, "high_count", return_value=3), patch.object(pi_phase, "note", side_effect=note):
            self.waiter("downgraded", "high")

    def test_config_errors_restore_signal_handlers(self):
        original = signal.getsignal(signal.SIGTERM)
        handlers = []
        def configuration(*args, **kwargs):
            handlers.append(signal.getsignal(signal.SIGTERM))
            raise ValueError("configuration failed")
        with patch.object(pi_phase, "config", side_effect=configuration), \
                patch.object(sys, "stderr", new_callable=io.StringIO):
            code = pi_phase.main(["run", "--kind", "test", "--label", "config", "--", "true"],
                                 state=self.state, configuration=self.config)
        self.assertEqual(code, 125)
        self.assertNotEqual(handlers, [original])
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)

    def test_exact_passed_state_skips_before_registration_and_records_zero_times(self):
        passed = self.passed_state()
        code, output, register = self.repeat_state()
        self.assertEqual(code, 0)
        register.assert_not_called()
        self.assertIn(f"skipped: this exact state already passed at {passed['ts']}", output)
        self.assertIn("kind=test label=repeat head=aaaaaaa run=2s", output)
        self.assertIn("pass --rerun to run again", output)
        record = self.ledger_records()[-1]
        self.assertEqual((record["outcome"], record["waitS"], record["runS"], record["exit"]),
                         ("skipped", 0, 0, 0))
        self.assertIsNone(record["startedAt"])
        self.assertEqual((record["head"], record["dirty"]), (passed["head"], passed["dirty"]))
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            pi_phase.stats(self.state, 14, None, True)
        total = next(r for r in json.loads(stdout.getvalue())["rows"] if r["day"] == "total")
        self.assertEqual((total["skipped"], total["failures"], total["started"]), (1, 0, 1))

    def test_passed_state_differences_never_skip(self):
        for key, value in [("head", "b" * 40), ("dirty", "changed"), ("dirty", None),
                           ("label", "different"), ("argvHash", "different"),
                           ("cwd", "/different"), ("kind", "build"), ("stack", "node"),
                           ("outcome", "skipped"),
                           ("ts", (datetime.now(timezone.utc) - timedelta(days=15)).isoformat())]:
            with self.subTest(key=key, value=value):
                self.passed_state(**{key: value})
                code, _, register = self.repeat_state()
                self.assertEqual(code, 125)
                register.assert_called_once()
        self.passed_state()
        code, _, register = self.repeat_state(snapshot=("a" * 40, None))
        self.assertEqual(code, 125)
        register.assert_called_once()

    def test_passed_state_rerun_environment_and_kind_policies(self):
        self.passed_state()
        code, _, register = self.repeat_state("--rerun")
        self.assertEqual(code, 125)
        register.assert_called_once()
        with patch.dict(os.environ, PI_PHASE_NO_SKIP="1"):
            self.assertEqual(self.repeat_state()[0], 125)
        for kind in ("ci", "integration"):
            self.passed_state(kind=kind)
            self.assertEqual(self.repeat_state(kind=kind)[0], 125)
        self.configure(skip_passed_integration=True)
        self.assertEqual(self.repeat_state(kind="integration")[0], 0)
        self.assertEqual(self.repeat_state(kind="ci")[0], 125)

    def test_sync_snapshot_is_before_queue_and_reused(self):
        self.state.mkdir()
        args = SimpleNamespace(kind="test", label="repeat", priority="normal", command=["true"])
        ledger = pi_phase.PhaseLedger(args)
        with patch.object(pi_phase, "git_state", return_value=("head", "clean")) as snapshot:
            ledger.prepare_snapshot()
            snapshot.assert_called_once_with(ledger.record["cwd"], timeout=3)
            ledger.enqueue()
            self.assertIsNone(ledger.snapshot_thread)
            ledger.finish(self.state, 75)
        self.assertEqual((ledger.record["head"], ledger.record["dirty"]), ("head", "clean"))

    def test_sync_snapshot_timeout_falls_back_to_post_registration_thread(self):
        args = SimpleNamespace(kind="test", label="repeat", priority="normal", command=["true"])
        ledger = pi_phase.PhaseLedger(args)
        with patch.object(pi_phase, "git_state", side_effect=[subprocess.TimeoutExpired("git", 3),
                                                             ("fallback", "clean")]) as snapshot:
            ledger.prepare_snapshot()
            ledger.enqueue()
            ledger.snapshot_thread.join(timeout=1)
            ledger.finish(self.state, 75)
        self.assertEqual(snapshot.call_count, 2)
        self.assertEqual((ledger.record["head"], ledger.record["dirty"]), ("fallback", "clean"))

    def test_sync_git_snapshot_uses_one_total_three_second_deadline(self):
        replies = [SimpleNamespace(stdout="head"), SimpleNamespace(stdout=b"dirty"),
                   subprocess.TimeoutExpired("git", .2)]
        with patch.object(pi_phase.time, "monotonic", side_effect=[0, .2, .5, 1, 2.5, 2.8]), \
                patch.object(pi_phase.subprocess, "run", side_effect=replies) as probe:
            self.assertEqual(pi_phase.git_state(self.root, timeout=3), ("head", None))
        self.assertEqual(probe.call_count, 3)
        for call in probe.call_args_list:
            self.assertEqual(call.args[0][:2], ["git", "--no-optional-locks"])
            self.assertEqual(call.kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")
        self.assertAlmostEqual(probe.call_args.kwargs["timeout"], .2)

    def test_successful_sync_snapshot_precedes_registration_with_full_queue_budget(self):
        calls = []
        def snapshot(cwd, timeout=None):
            calls.append(("snapshot", timeout))
            return "head", "clean"
        original = pi_phase.register_waiter
        def register(*args):
            calls.append(("register", None))
            return original(*args)
        with patch.object(pi_phase, "git_state", side_effect=snapshot), \
                patch.object(pi_phase, "register_waiter", side_effect=register):
            code = pi_phase.main(["run", "--kind", "build", "--label", "sync", "--", "true"],
                                 state=self.state, configuration=self.config)
        self.assertEqual(code, 0)
        self.assertEqual(calls, [("snapshot", 3), ("register", None), ("snapshot", 3)])
        self.assertEqual(self.ledger_records()[0]["head"], "head")

    def test_queue_budget_accepts_7200_but_execution_still_needs_approval(self):
        self.assertEqual(pi_phase.bounded(7200, "queue-timeout", False), 7200)
        with self.assertRaises(ValueError):
            pi_phase.bounded(7201, "queue-timeout", False)
        self.assertEqual(pi_phase.bounded(7201, "queue-timeout", True), 7201)
        with self.assertRaisesRegex(ValueError, "600s without --approved-long-timeout"):
            pi_phase.bounded(601, "timeout", False)
        self.assertEqual(pi_phase.bounded(601, "timeout", True), 601)

    def test_fourth_high_is_normal_without_consuming_grant(self):
        pi_phase.grant_priority(self.state, 10, None)
        for i in range(3):
            self.waiter(f"high-{i}", "high")
        grant = (self.state / "priority-grant.json").read_bytes()
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.waiter("fourth", "high")
        self.assertIn("pi-phase: high-priority cap (3) reached; queued as normal", stdout.getvalue())
        self.assertEqual((self.state / "priority-grant.json").read_bytes(), grant)
        self.assertEqual(pi_phase.metadata(self.state / "waiters/fourth.json")["priority"], "normal")
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            pi_phase.status(self.state)
        self.assertIn("high=3/3", stdout.getvalue())

    def test_fourth_high_runs_successfully_as_normal_when_three_are_running(self):
        self.config.write_text('{"heavy_slots": 4, "container_test_detection": "off"}')
        self.assertEqual(self.done(self.start("grant-priority", "--uses", "10"))[0], 0)
        running = []
        for i in range(3):
            marker = self.root / f"running-{i}"
            command = [sys.executable, "-c",
                       "import pathlib,sys,time;pathlib.Path(sys.argv[1]).touch();time.sleep(3)",
                       str(marker)]
            job = self.run_phase(label=f"high-{i}", command=command, extra=("--priority", "high"))
            running.append(job)
            self.wait_for(marker.exists)
        grant = (self.state / "priority-grant.json").read_bytes()
        code, output = self.done(self.run_phase(extra=("--priority", "high")))
        self.assertEqual(code, 0, output)
        self.assertIn("high-priority cap (3) reached; queued as normal", output)
        self.assertEqual((self.state / "priority-grant.json").read_bytes(), grant)
        self.assertEqual(self.ledger_records()[0]["priority"], "normal")
        for job in running:
            self.assertEqual(self.done(job)[0], 0)

    def test_high_cap_config_and_running_reservation(self):
        for value in (1, 3, 10, 0, 11, True, "3"):
            with self.subTest(value=value):
                self.configure(max_high=value)
                expected = value if type(value) is int and 1 <= value <= 10 else 3
                self.assertEqual(pi_phase.config(self.config).options["max_high"], expected)
        pi_phase.grant_priority(self.state, 10, None)
        self.waiter("reserved", "high")
        held = self.admit("reserved")
        grant = (self.state / "priority-grant.json").read_bytes()
        args = SimpleNamespace(kind="build", label="next", priority="high", max_high=1)
        ready, fd = pi_phase.register_waiter(self.state, args, "next")
        self.addCleanup(os.close, fd)
        self.assertTrue(ready)
        self.assertEqual(args.priority, "normal")
        self.assertEqual((self.state / "priority-grant.json").read_bytes(), grant)
        self.assertIsNotNone(held)

    def test_ledger_passed_failed_timeout_and_fields(self):
        with patch.dict(os.environ, PI_SESSION_ID="session", PI_ORCH_ID="lane"):
            passed, command = self.ledger_command()
        failed, _ = self.ledger_command(command=[sys.executable, "-c", "raise SystemExit(9)"])
        timed_out, _ = self.ledger_command("--timeout", ".1",
                                          command=[sys.executable, "-c", "import time;time.sleep(5)"])
        self.assertEqual([passed.returncode, failed.returncode, timed_out.returncode], [0, 9, 124])
        records = self.ledger_records()
        self.assertEqual([r["outcome"] for r in records], ["passed", "failed", "timeout"])
        self.assertEqual([r["exit"] for r in records], [0, 9, 124])
        record = records[0]
        self.assertEqual(set(record), {"v", "ts", "session", "lane", "cwd", "kind", "label", "priority",
                                      "queuedAt", "startedAt", "endedAt", "waitS", "runS", "exit", "outcome",
                                      "head", "dirty", "argvHash", "stack", "envHash", "verified", "fingerprint", "fast"})
        self.assertEqual((record["v"], record["session"], record["lane"]), (1, "session", "lane"))
        self.assertEqual((record["cwd"], record["kind"], record["label"], record["priority"]),
                         (str(self.root), "test", "ledger", "normal"))
        self.assertEqual(record["stack"], "python")
        self.assertIsNone(record["head"])
        self.assertIsNone(record["dirty"])
        self.assertEqual(record["argvHash"], hashlib.sha256("\0".join(command).encode()).hexdigest())
        self.assertNotIn("secret-argument", json.dumps(records))
        for record in records:
            self.assertEqual(record["ts"], record["endedAt"])
            self.assertLessEqual(record["queuedAt"], record["startedAt"])
            self.assertLessEqual(record["startedAt"], record["endedAt"])
            self.assertGreaterEqual(record["waitS"], 0)
            self.assertGreater(record["runS"], 0)

    def test_ledger_queue_timeout_cancelled_and_rejected(self):
        self.config.write_text('{"heavy_slots": 1}')
        owner = self.run_phase(command=[sys.executable, "-c", "import time;time.sleep(5)"])
        self.wait_for(lambda: (self.state / "heavy-0.json").exists())
        queued = self.run_phase(queue=".15")
        self.assertEqual(self.done(queued)[0], 75)
        cancelled = self.run_phase()
        self.wait_for(lambda: bool(list((self.state / "waiters").glob("*.json"))))
        cancelled.send_signal(signal.SIGTERM)
        self.assertEqual(self.done(cancelled)[0], 143)
        owner.send_signal(signal.SIGTERM)
        self.assertEqual(self.done(owner)[0], 143)
        rejected, _ = self.ledger_command("--queue-timeout", "7201")
        self.assertEqual(rejected.returncode, 125)
        parse_rejected, _ = self.ledger_command("--tail", "-1")
        self.assertEqual(parse_rejected.returncode, 2)
        records = self.ledger_records()
        self.assertEqual([r["outcome"] for r in records],
                         ["queue-timeout", "cancelled", "cancelled", "rejected", "rejected"])
        self.assertEqual([r["exit"] for r in records], [75, 143, 143, 125, 2])
        for record in records[:2] + records[3:]:
            self.assertIsNone(record["startedAt"])
            self.assertEqual(record["runS"], 0)

    def test_ledger_producer_reserved_exit_is_failed_not_timeout(self):
        result, _ = self.ledger_command(command=[sys.executable, "-c", "raise SystemExit(124)"])
        self.assertEqual(result.returncode, 124)
        self.assertEqual(self.ledger_records()[0]["outcome"], "failed")

    def test_ledger_failure_preserves_exit_and_output(self):
        self.state.mkdir()
        (self.state / "ledger").write_text("not a directory")
        result, _ = self.ledger_command(command=[sys.executable, "-c", "print('producer');raise SystemExit(7)"])
        self.assertEqual(result.returncode, 7)
        self.assertIn("producer", result.stdout)
        self.assertEqual(result.stderr.count("pi-phase: ledger write failed:"), 1)

    def test_ledger_pruning_and_atomic_bounded_append(self):
        ledger = self.state / "ledger"
        ledger.mkdir(parents=True)
        today = datetime.now(timezone.utc).date()
        old = ledger / f"{today - timedelta(days=61)}.jsonl"
        boundary = ledger / f"{today - timedelta(days=60)}.jsonl"
        old.touch()
        boundary.touch()
        (ledger / "keep.txt").touch()
        with patch.dict(os.environ, PI_SESSION_ID="é" * 5000):
            result, _ = self.ledger_command()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(old.exists())
        self.assertTrue(boundary.exists())
        self.assertTrue((ledger / "keep.txt").exists())
        line = (ledger / f"{today}.jsonl").read_bytes()
        self.assertLess(len(line), 4096)
        self.assertEqual(len(line.splitlines()), 1)

    def seed_ledger(self):
        today = datetime.now(timezone.utc).date().isoformat()
        records = [dict(v=1, ts=today + "T12:00:00Z", kind="build", stack="dotnet", startedAt="yes",
                        waitS=n, runS=n * 10, outcome="passed") for n in range(1, 11)]
        records.append(dict(v=1, ts=today + "T12:00:00Z", kind="build", stack="dotnet", startedAt=None,
                            waitS=11, runS=0, outcome="queue-timeout"))
        records.append(dict(v=1, ts=today + "T12:00:00Z", kind="test", stack="python", startedAt="yes",
                            waitS=5, runS=4, outcome="failed"))
        ledger = self.state / "ledger"
        ledger.mkdir(parents=True)
        (ledger / f"{today}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records)
                                               + "broken\n{}\n")
        return today

    def test_stats_percentiles_json_filters_and_malformed(self):
        today = self.seed_ledger()
        result = subprocess.run(self.cli("stats", "--json"), capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["skipped"], 2)
        row = next(r for r in data["rows"] if r["kind"] == "build" and r["day"] == today)
        self.assertEqual((row["count"], row["started"], row["queueTimeouts"], row["failures"]), (11, 10, 1, 0))
        self.assertEqual(row["waitS"], dict(p50=6, p90=10))
        self.assertEqual(row["runS"], dict(p50=50, p90=90))
        total = next(r for r in data["rows"] if r["kind"] == "build" and r["day"] == "total")
        self.assertEqual({k: v for k, v in total.items() if k != "day"},
                         {k: v for k, v in row.items() if k != "day"})
        result = subprocess.run(self.cli("stats", "--kind", "test", "--days", "1"),
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("total", result.stdout)
        self.assertIn("skipped 2 malformed", result.stdout)
        self.assertNotIn("build", result.stdout)

    def test_wait_eta_unknown_and_read_only(self):
        result = subprocess.run(self.cli("wait", "--eta"), capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "eta unknown (no ledger data)")
        self.assertFalse(self.state.exists())

    def test_wait_eta_free_slots_and_priority_queue(self):
        self.seed_ledger()
        self.config.write_text('{"heavy_slots": 1}')
        with patch.object(pi_phase, "consume_priority"):
            self.waiter("ahead", priority="high")
        self.waiter("behind", priority="low")
        stale = self.state / "waiters" / "stale.json"
        stale.write_text("{}")
        before = {p.relative_to(self.state): p.read_bytes() for p in self.state.rglob("*") if p.is_file()}
        result = subprocess.run(self.cli("wait", "--eta"), capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "eta ~1m (ahead=1 running=0 p50run=50s, basis=10 runs)")
        after = {p.relative_to(self.state): p.read_bytes() for p in self.state.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    def test_git_state_clean_dirty_and_probe_timeouts(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=self.root, capture_output=True,
                                  check=True, timeout=3).stdout
        git("init")
        source = self.root / "source.txt"
        source.write_text("before\n")
        git("add", ".")
        git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
        head = git("rev-parse", "HEAD").decode().strip()
        self.assertEqual(pi_phase.git_state(self.root), (head, "clean"))
        source.write_text("changed\n")
        (self.root / "untracked.txt").write_text("untracked")
        expected = hashlib.sha256(git("status", "--porcelain=v1", "-z", "--untracked-files=normal")
                                  + git("diff", "HEAD", "--binary")
                                  + b"untracked.txt\0" + hashlib.sha256(b"untracked").digest()).hexdigest()
        self.assertEqual(pi_phase.git_state(self.root), (head, expected))
        with patch.object(pi_phase.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 2)):
            self.assertEqual(pi_phase.git_state(self.root), (None, None))
        with patch.object(pi_phase.subprocess, "run", side_effect=[
                SimpleNamespace(stdout=head), SimpleNamespace(stdout=b"dirty"),
                subprocess.TimeoutExpired("git", 5)]) as probe:
            self.assertEqual(pi_phase.git_state(self.root), (head, None))
            self.assertLessEqual(probe.call_args.kwargs["timeout"], 5)

    def test_ledger_sync_snapshots_before_registration_and_after_execution(self):
        calls = self.root / "git-calls.jsonl"
        patch = ("import json,threading\n"
                 f"calls=pi_phase.Path({str(calls)!r})\n"
                 "registered=False\n"
                 "original_register=pi_phase.register_waiter\n"
                 "def register(*args):\n"
                 "    global registered\n"
                 "    result=original_register(*args)\n"
                 "    registered=result[0]\n"
                 "    return result\n"
                 "pi_phase.register_waiter=register\n"
                 "def snapshot(cwd, timeout=None):\n"
                 "    with calls.open('a') as f: f.write(json.dumps([registered,threading.current_thread().daemon])+'\\n')\n"
                 "    return ('queued-head','queued-dirty')\n"
                 "pi_phase.git_state=snapshot")
        child, _ = self.patched_phase(patch)
        code, output = self.done(child)
        self.assertEqual(code, 0, output)
        self.assertEqual(calls.read_text().splitlines(), ["[false, false]", "[true, false]"])
        record = self.ledger_records()[0]
        self.assertEqual((record["head"], record["dirty"]), ("queued-head", "queued-dirty"))

    def test_ledger_slow_fallback_snapshot_never_blocks_registration_or_claim(self):
        registered = self.root / "registered"
        attempted = self.root / "claim-attempted"
        patch = ("import time\n"
                 "original_register=pi_phase.register_waiter\n"
                 "def register(*args):\n"
                 "    result=original_register(*args)\n"
                 f"    if result[0]: pi_phase.Path({str(registered)!r}).touch()\n"
                 "    return result\n"
                 "pi_phase.register_waiter=register\n"
                 "def snapshot(cwd, timeout=None):\n"
                 "    if timeout is not None: raise pi_phase.subprocess.TimeoutExpired('git', timeout)\n"
                 "    time.sleep(5)\n"
                 "    return ('too-late','too-late')\n"
                 "pi_phase.git_state=snapshot\n"
                 "def claim(*args,**kwargs):\n"
                 f"    pi_phase.Path({str(attempted)!r}).touch()\n"
                 "    return None\n"
                 "pi_phase.claim=claim")
        started = time.monotonic()
        child, _ = self.patched_phase(patch, queue=".2")
        self.wait_for(registered.exists, seconds=1.5)
        self.wait_for(attempted.exists, seconds=1.5)
        code, output = self.done(child, timeout=3)
        self.assertEqual(code, 75, output)
        self.assertLess(time.monotonic() - started, 3)
        record = self.ledger_records()[0]
        self.assertEqual((record["head"], record["dirty"]), (None, None))

    def test_ledger_snapshot_join_is_bounded_and_cannot_change_finished_record(self):
        ledger = pi_phase.PhaseLedger(SimpleNamespace(kind="test", label="slow", priority="normal", command=[]))
        ready, release = threading.Event(), threading.Event()
        def snapshot(cwd):
            ready.set()
            release.wait(3)
            return "late-head", "late-dirty"
        with patch.object(pi_phase, "git_state", side_effect=snapshot):
            started = time.monotonic()
            ledger.enqueue()
            try:
                self.assertLess(time.monotonic() - started, 1)
                self.assertTrue(ready.wait(1))
                self.assertTrue(ledger.snapshot_thread.daemon)
                with patch.object(ledger.snapshot_thread, "join", wraps=ledger.snapshot_thread.join) as join:
                    ledger.finish(self.state, 75)
                join.assert_called_once_with(timeout=1)
                self.assertEqual((ledger.record["head"], ledger.record["dirty"]), (None, None))
            finally:
                release.set()
                ledger.snapshot_thread.join(timeout=1)
        self.assertEqual((ledger.record["head"], ledger.record["dirty"]), (None, None))

    def test_ledger_snapshot_thread_unavailable_keeps_metadata_optional(self):
        ledger = pi_phase.PhaseLedger(SimpleNamespace(kind="test", label="no-thread", priority="normal", command=[]))
        with patch.object(threading.Thread, "start", side_effect=RuntimeError("no threads available")):
            ledger.enqueue()
        ledger.start()
        ledger.finish(self.state, 0)
        record = self.ledger_records()[0]
        self.assertEqual((record["outcome"], record["exit"], record["head"], record["dirty"]),
                         ("passed", 0, None, None))

    def test_ledger_git_probes_disable_optional_locks(self):
        replies = [SimpleNamespace(stdout="head\n"), SimpleNamespace(stdout=b"dirty"),
                   SimpleNamespace(stdout=b"diff"), SimpleNamespace(stdout=b"")]
        with patch.dict(os.environ, GIT_OPTIONAL_LOCKS="1"), \
                patch.object(pi_phase.subprocess, "run", side_effect=replies) as probe:
            self.assertEqual(pi_phase.git_state(self.root), ("head", hashlib.sha256(b"dirtydiff").hexdigest()))
        self.assertEqual(probe.call_count, 4)
        for call in probe.call_args_list:
            self.assertEqual(call.args[0][:2], ["git", "--no-optional-locks"])
            self.assertEqual(call.kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")

    def test_wait_eta_probes_slots_under_shared_coordinator(self):
        self.seed_ledger()
        self.config.write_text('{"heavy_slots": 1}')
        for name in ("coordinator.lock", "heavy-0.lock"):
            (self.state / name).touch()
        original_probe = pi_phase.readonly_busy
        def probe(path):
            with patch.object(pi_phase, "lock_file", wraps=pi_phase.lock_file) as lock:
                held = pi_phase.claim(self.state, [[path]], time.monotonic() + 1, lambda: False)
                if held:
                    self.addCleanup(lambda: [os.close(fd) for _, fd in held])
                self.assertIsNone(held, "ETA must protect its probes with the coordinator")
                self.assertNotIn(path, [call.args[0] for call in lock.call_args_list])
            with patch.object(pi_phase.fcntl, "flock", wraps=pi_phase.fcntl.flock) as flock:
                result = original_probe(path)
            self.assertEqual(flock.call_args.args[1], pi_phase.fcntl.LOCK_SH | pi_phase.fcntl.LOCK_NB)
            return result
        with patch.object(pi_phase, "readonly_busy", side_effect=probe) as busy, \
                patch.object(pi_phase, "live_groups", return_value=set()), \
                patch.object(sys, "stdout", new_callable=io.StringIO):
            self.assertEqual(pi_phase.wait_eta(self.state, self.config, "build"), 0)
        busy.assert_called_once()
        held = pi_phase.claim(self.state, [[self.state / "heavy-0.lock"]], time.monotonic() + 1, lambda: False)
        self.assertIsNotNone(held)
        for _, fd in held:
            self.addCleanup(os.close, fd)

    def test_ledger_deleted_cwd_preserves_run_and_parse_exit_codes(self):
        entry = ("import os,sys;sys.path.insert(0,sys.argv[1]);import pi_phase;"
                 "os.chdir(sys.argv[4]);os.rmdir(sys.argv[4]);"
                 "sys.exit(pi_phase.main(sys.argv[5:],state=sys.argv[2],configuration=sys.argv[3]))")
        for timeout, expected in (("3", 125), ("nan", 125), ("invalid", 2)):
            deleted = self.root / "deleted-cwd"
            deleted.mkdir()
            result = subprocess.run([sys.executable, "-B", "-c", entry, str(HERE), str(self.state),
                                     str(self.config), str(deleted), "run", "--kind", "test", "--label", "deleted",
                                     "--timeout", timeout, "--", sys.executable, "-c", "pass"],
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            record = self.ledger_records()[-1]
            self.assertIsNone(record["cwd"])
            self.assertEqual(record["exit"], expected)
        self.assertEqual(len(self.ledger_records()), 3)

    def test_ledger_internal_claim_and_popen_errors_are_not_rejections(self):
        for target in ("pi_phase.claim", "pi_phase.subprocess.Popen"):
            with self.subTest(target=target):
                child, marker = self.patched_phase("def broken(*args,**kwargs): raise OSError('internal failure')\n"
                                                   + target + "=broken")
                code, output = self.done(child)
                self.assertEqual(code, 125, output)
                self.assertNotIn("Traceback", output)
                self.assertFalse(marker.exists())
                record = self.ledger_records()[-1]
                self.assertEqual(record["outcome"], "error")
                self.assertIsNone(record["startedAt"])
                self.assertFalse(list((self.state / "waiters").glob("*.json")))
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(pi_phase.stats(self.state, 7, None, True), 0)
        self.assertTrue(all(r["failures"] == 2 for r in json.loads(stdout.getvalue())["rows"]))

    def test_ledger_argparse_rejection_after_kind_known(self):
        result = subprocess.run(self.cli("run", "--kind", "test", "--label", "bad", "--timeout", "invalid"),
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid float value", result.stderr)
        records = self.ledger_records()
        self.assertEqual(len(records), 1)
        self.assertEqual((records[0]["outcome"], records[0]["exit"]), ("rejected", 2))

    def test_ledger_single_write_and_io_failure(self):
        record = pi_phase.PhaseLedger(SimpleNamespace(kind="build", label="atomic", priority="normal",
                                                       command=["secret"])).record
        record["ts"] = pi_phase.utc_stamp()
        original_write = os.write
        with patch.object(pi_phase.os, "write", wraps=original_write) as write:
            pi_phase.append_ledger(self.state, record)
        write.assert_called_once()
        self.assertLess(len(write.call_args.args[1]), 4096)
        with patch.object(pi_phase.os, "write", side_effect=OSError("disk full")), \
                patch.object(sys, "stderr", new_callable=io.StringIO) as stderr:
            pi_phase.append_ledger(self.state, record)
        self.assertEqual(stderr.getvalue(), "pi-phase: ledger write failed: disk full\n")

    def test_stats_utc_day_window_and_totals(self):
        today = self.seed_ledger()
        ledger = self.state / "ledger"
        yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        older = (datetime.now(timezone.utc).date() - timedelta(days=8)).isoformat()
        for day in (yesterday, older):
            (ledger / f"{day}.jsonl").write_text(json.dumps(dict(v=1, ts=day + "T12:00:00Z", kind="build", stack="dotnet",
                              startedAt="yes", waitS=100, runS=200, outcome="timeout")) + "\n")
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(pi_phase.stats(self.state, 2, "build", True), 0)
        rows = json.loads(stdout.getvalue())["rows"]
        self.assertEqual({r["day"] for r in rows}, {today, yesterday, "total"})
        total = next(r for r in rows if r["day"] == "total")
        self.assertEqual((total["count"], total["started"], total["failures"]), (12, 11, 1))
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(pi_phase.stats(self.state, 1, "build", True), 0)
        self.assertEqual(len(json.loads(stdout.getvalue())["rows"]), 2)

    def test_wait_eta_running_and_integration_backfill(self):
        self.seed_ledger()
        self.config.write_text('{"heavy_slots": 2, "integration_slots": 1}')
        self.waiter("blocked-integration", kind="integration")
        self.waiter("normal-build", kind="build")
        held = pi_phase.claim(self.state, [[self.state / "heavy-0.lock", self.state / "integration-0.lock"]],
                              time.monotonic() + 1, lambda: False)
        self.assertIsNotNone(held)
        for _, fd in held:
            self.addCleanup(os.close, fd)
        pi_phase.publish(held, dict(token="running", kind="integration", started=time.time()))
        # Integration is blocked, so the queued build uses the free heavy slot first.
        with patch.object(pi_phase, "live_groups", return_value=set()), \
                patch.object(pi_phase.time, "time", return_value=time.time()), \
                patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(pi_phase.wait_eta(self.state, self.config, "build"), 0)
        self.assertIn("eta ~1m (ahead=2 running=1 p50run=50s, basis=10 runs)", stdout.getvalue())
        # With no queue, one free heavy slot admits a new build immediately.
        for path in (self.state / "waiters").glob("*.json"):
            path.unlink()
        with patch.object(pi_phase, "live_groups", return_value=set()), \
                patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(pi_phase.wait_eta(self.state, self.config, "build"), 0)
        self.assertIn("eta ~0m (ahead=0 running=1", stdout.getvalue())

    def test_command_stack_basenames_and_simple_wrappers(self):
        cases = {
            "dotnet": ["dotnet"],
            "node": "node npm npx yarn pnpm corepack tsc tsgo vite vitest jest playwright eslint prettier turbo nx".split(),
            "python": ["python", "python3", "pytest"], "docker": ["docker", "docker-compose"],
            "rust": ["cargo"], "go": ["go"], "other": ["make", "custom-runner"]}
        for stack, executables in cases.items():
            for executable in executables:
                with self.subTest(executable=executable):
                    self.assertEqual(pi_phase.command_stack(["/a path/" + executable, "argument"]), stack)
        for command, expected in [
                (["env", "MODE=prod", "npm", "test"], "node"),
                (["/usr/bin/env", "-i", "--", "/usr/bin/dotnet", "test"], "dotnet"),
                (["nice", "-n", "10", "yarn", "test"], "node"),
                (["nice", "--adjustment=10", "cargo", "test"], "rust"),
                (["nice", "-10", "env", "FOO=bar", "python3", "tests.py"], "python"),
                (["bash", "-c", "env MODE=prod nice -n 10 npm test"], "node"),
                (["/bin/sh", "-c", "'/a path/pnpm' test"], "node"),
                (["bash", "-c", "npm test && docker run image"], "other"),
                (["bash", "-c", "'unterminated"], "other"),
                (["env"], "other"), ([], "other")]:
            with self.subTest(command=command):
                self.assertEqual(pi_phase.command_stack(command), expected)

    def test_ledger_stack_override_and_rejection(self):
        result, _ = self.ledger_command("--stack", "frontend-ci")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ledger_records()[0]["stack"], "frontend-ci")
        for invalid in ("Node", "", "a_b", "a" * 21):
            with self.subTest(stack=invalid):
                result, _ = self.ledger_command("--stack", invalid)
                self.assertEqual(result.returncode, 2)
                self.assertIn("stack must match", result.stderr)
        records = self.ledger_records()
        self.assertEqual(len(records), 5)
        self.assertTrue(all(r["outcome"] == "rejected" and r["stack"] == "python" for r in records[1:]))

    def test_stats_stack_filter_grouping_and_legacy_records(self):
        today = self.seed_ledger()
        path = self.state / "ledger" / f"{today}.jsonl"
        record = dict(v=1, ts=today + "T13:00:00Z", kind="build", startedAt="yes",
                      waitS=99, runS=200, outcome="passed")
        with path.open("a") as stream:
            stream.write(json.dumps(dict(record, stack="node")) + "\n")
            stream.write(json.dumps(record) + "\n")
        result = subprocess.run(self.cli("stats", "--kind", "build", "--stack", "node", "--json"),
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = json.loads(result.stdout)["rows"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["stack"] == "node" and r["count"] == 1 for r in rows))
        result = subprocess.run(self.cli("stats", "--kind", "build", "--json"),
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = json.loads(result.stdout)["rows"]
        self.assertEqual({r["stack"] for r in rows}, {"dotnet", "node", "other"})
        self.assertEqual(len(rows), 6)

    def test_stats_never_started_records_have_no_runtime_percentiles(self):
        today = datetime.now(timezone.utc).date().isoformat()
        ledger = self.state / "ledger"
        ledger.mkdir(parents=True)
        (ledger / f"{today}.jsonl").write_text(json.dumps(dict(v=1, ts=today + "T00:00:00Z",
               kind="test", stack="node", startedAt=None, waitS=10, runS=0, outcome="queue-timeout")) + "\n")
        with patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(pi_phase.stats(self.state, 7, None, True), 0)
        for row in json.loads(stdout.getvalue())["rows"]:
            self.assertEqual(row["started"], 0)
            self.assertEqual(row["runS"], dict(p50=None, p90=None))
            self.assertEqual(row["waitS"], dict(p50=10, p90=10))

    def test_ledger_priority_rejection_and_lane_fallback(self):
        with patch.dict(os.environ, PI_SESSION_ID="", PI_ORCH_ID="", PI_LANE_ID="fallback"):
            result, _ = self.ledger_command("--priority", "high")
        self.assertEqual(result.returncode, 125)
        record = self.ledger_records()[0]
        self.assertEqual(record["outcome"], "rejected")
        self.assertIsNone(record["session"])
        self.assertEqual(record["lane"], "fallback")
        self.assertIsNone(record["startedAt"])

    def test_performance_config_defaults_and_auto(self):
        settings = pi_phase.config(self.config)
        self.assertEqual(settings, (2, 1))
        self.assertEqual(settings.options, dict(msbuild_max_cpu=0, container_test_detection="hint",
                                                cold_worktree_hint=True, memory_admission=False, phase_nice=0,
                                                rss_cap_mb=12288, skip_passed_integration=False, max_high=3,
                                                fast_lane=dict(slots=2, max_expected_s=90, kinds=["build", "test"])))
        for cores, slots, expected in ((12, 2, 6), (12, 4, 3), (1, 4, 2), (None, 2, 2)):
            with self.subTest(cores=cores, slots=slots), patch.object(pi_phase.os, "cpu_count", return_value=cores):
                self.assertEqual(pi_phase.msbuild_cap("auto", slots), expected)
        self.assertEqual(pi_phase.msbuild_cap(7, 2), 7)
        self.assertEqual(pi_phase.msbuild_cap(0, 2), 0)

    def test_config_invalid_values_and_unknown_keys_fall_back(self):
        for value in (-1, True, "bad", 2.5, None, [], {}):
            with self.subTest(value=value):
                self.config.write_text(json.dumps(dict(heavy_slots=0, integration_slots="1",
                     msbuild_max_cpu=value, container_test_detection=value, cold_worktree_hint=value, unknown=4)))
                with patch.object(pi_phase, "note") as note:
                    settings = pi_phase.config(self.config)
                self.assertEqual(settings, (2, 1))
                self.assertEqual(settings.options["msbuild_max_cpu"], 0)
                self.assertEqual(settings.options["container_test_detection"], "hint")
                self.assertEqual(settings.options["cold_worktree_hint"], value if type(value) is bool else True)
                self.assertTrue(note.called)
        for text in ("[1]", "null", "{"):
            self.config.write_text(text)
            with patch.object(pi_phase, "note") as note:
                self.assertEqual(pi_phase.config(self.config), (2, 1))
                note.assert_called_once()
        self.configure(msbuild_max_cpu="auto", container_test_detection="promote", cold_worktree_hint=False)
        self.assertEqual(pi_phase.config(self.config).options,
                         dict(msbuild_max_cpu="auto", container_test_detection="promote", cold_worktree_hint=False, memory_admission=False, phase_nice=0,
                              rss_cap_mb=12288, skip_passed_integration=False, max_high=3,
                              fast_lane=dict(slots=2, max_expected_s=90, kinds=["build", "test"])))

    def test_dotnet_shim_insertion_and_passthrough(self):
        # Real shell execution, including spaces, empty arguments and a shim PATH alias.
        real = self.root / "real bin"
        real.mkdir()
        self.executable(real / "dotnet", "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n")
        shim = self.root / "shim"
        shim.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(shim, target_is_directory=True)
        original = str(alias) + os.pathsep + str(real) + os.pathsep + os.environ["PATH"]
        with patch.dict(os.environ, PATH=original):
            env = pi_phase.shim_environment(shim, 3)
        for subcommand in ("build", "test", "publish", "pack", "msbuild", "restore"):
            for prefix in ([], ["--diagnostics"]):
                args = [*prefix, subcommand, "a b", "", "--no-build"]
                result = subprocess.run([str(shim / "dotnet"), *args], env=env,
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = [*prefix, subcommand, "-m:3", "-p:UseSharedCompilation=false", "-nodeReuse:false",
                            "a b", "", "--no-build"]
                self.assertEqual(result.stdout.splitlines(), [f"<{arg}>" for arg in expected])
        cases = [["test", flag] for flag in ("-m", "-M:2", "/m", "/M:4", "-maxcpucount",
                 "-MaxCpuCount:8", "/MAXCPUCOUNT:2", "--maxcpucount=6")]
        cases += [[], ["--info"], ["run", "build"], ["app.dll"], ["--version"], ["TEST", "x"]]
        for args in cases:
            with self.subTest(args=args):
                result = subprocess.run([str(shim / "dotnet"), *args], env=env,
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                lifetime = ["-p:UseSharedCompilation=false", "-nodeReuse:false"] if args[:1] == ["test"] else []
                shown = [*args[:1], *lifetime, *args[1:]]
                expected = [f"<{arg}>" for arg in shown] if args else ["<>"]
                self.assertEqual(result.stdout.splitlines(), expected)
        nested = self.root / "nested-shim"
        nested.mkdir()
        with patch.dict(os.environ, env):
            nested_env = pi_phase.shim_environment(nested, 2)
        result = subprocess.run([str(nested / "dotnet"), "build"], env=nested_env,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(),
                         ["<build>", "<-m:2>", "<-p:UseSharedCompilation=false>", "<-nodeReuse:false>"])
        env["PI_PHASE_ORIGINAL_PATH"] = str(alias)
        result = subprocess.run([str(shim / "dotnet"), "build"], env=env,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 127, result.stderr)

    def test_memory_ceiling_config_defaults_and_validation(self):
        options = pi_phase.config(self.config).options
        self.assertEqual(options["rss_cap_mb"], 12288)
        self.assertNotIn("dotnet_gc_heap_hard_limit_mb", options)
        for key in ("rss_cap_mb",):
            for value, expected in ((0, 0), (500, 500)):
                self.configure(**{key: value})
                self.assertEqual(pi_phase.config(self.config).options[key], expected)
            for value in (-1, True, "10", 1.5, None):
                self.configure(**{key: value})
                with patch.object(pi_phase, "note"):
                    self.assertEqual(pi_phase.config(self.config).options[key], pi_phase.config(self.root / "none").options[key])

    def test_admission_swap_floor_defaults_to_2gb_and_refuses_below(self):
        self.configure(memory_admission=True)
        admission = pi_phase.MemoryAdmission(pi_phase.config(self.config).options["memory_admission"])
        with patch.object(pi_phase, "SWAP_FLOOR_ENFORCED", True), \
                patch.object(pi_phase, "read_host_memory", return_value=(80, 2047)):
            self.assertEqual(admission.reason(time.monotonic() + 1), "swap free 2047 MB < 2048 MB")
        admission = pi_phase.MemoryAdmission(pi_phase.config(self.config).options["memory_admission"])
        with patch.object(pi_phase, "SWAP_FLOOR_ENFORCED", True), \
                patch.object(pi_phase, "read_host_memory", return_value=(80, 2048)):
            self.assertIsNone(admission.reason(time.monotonic() + 1))

    def test_admission_ignores_free_swap_on_macos_but_still_uses_memory_percent(self):
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=2048))
        with patch.object(pi_phase, "SWAP_FLOOR_ENFORCED", False), \
                patch.object(pi_phase, "read_host_memory", return_value=(72, 1200)):
            self.assertIsNone(admission.reason(time.monotonic() + 1))
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=2048))
        with patch.object(pi_phase, "SWAP_FLOOR_ENFORCED", False), \
                patch.object(pi_phase, "read_host_memory", return_value=(20, 1200)):
            self.assertEqual(admission.reason(time.monotonic() + 1), "memory free 20% < 30%")

    def test_sample_tree_includes_group_and_descendants(self):
        child = subprocess.Popen([sys.executable, "-c", "import subprocess,sys,time;"
                                  "subprocess.Popen([sys.executable,'-c','import time;time.sleep(5)']);time.sleep(5)"],
                                 start_new_session=True)
        self.addCleanup(lambda: (child.kill(), child.wait()))
        self.wait_for(lambda: len(pi_phase.sample_tree(child.pid)) >= 2)
        pids = [item[0] for item in pi_phase.sample_tree(child.pid)]
        self.assertIn(child.pid, pids)
        self.assertNotIn(os.getpid(), pids)

    def test_running_memory_offender_needs_sustained_samples_of_same_process(self):
        running = pi_phase.RunningMemory(1000, 0, False)
        big = [(1, 900.0, "a", "t1"), (3, 2500.0, "c", "t3")]
        with patch.object(pi_phase, "sample_tree", return_value=big):
            self.assertIsNone(running.offender(1))
            self.assertIsNone(running.offender(1))
            self.assertEqual(running.offender(1)[:3], (3, 2500.0, "c"))
        # transient spike: over, over, under (reset), over, over -> no kill
        running = pi_phase.RunningMemory(1000, 0, False)
        for rss in (2000.0, 2000.0, 500.0, 2000.0, 2000.0):
            with patch.object(pi_phase, "sample_tree", return_value=[(3, rss, "c", "t3")]):
                self.assertIsNone(running.offender(1))
        # a failed sample breaks the streak: over, error, over, error, over -> no kill
        running = pi_phase.RunningMemory(1000, 0, False)
        for outcome in ("over", "err", "over", "err", "over"):
            effect = OSError("ps failed") if outcome == "err" else None
            with patch.object(pi_phase, "sample_tree", return_value=[(3, 2000.0, "c", "t3")], side_effect=effect):
                self.assertIsNone(running.offender(1))
        # pid reuse / different start time resets the streak
        running = pi_phase.RunningMemory(1000, 0, False)
        for start in ("t1", "t1", "t2", "t2"):
            with patch.object(pi_phase, "sample_tree", return_value=[(3, 2000.0, "c", start)]):
                self.assertIsNone(running.offender(1))
        with patch.object(pi_phase, "sample_tree", return_value=[(3, 2000.0, "c", "t2")]):
            self.assertIsNotNone(running.offender(1))
        with patch.object(pi_phase, "sample_tree", return_value=[(1, 1000.0, "a", "t")]):
            self.assertIsNone(pi_phase.RunningMemory(1000, 0, False).offender(1))
        with patch.object(pi_phase, "sample_tree", side_effect=subprocess.TimeoutExpired("ps", 5)):
            self.assertIsNone(pi_phase.RunningMemory(1000, 0, False).offender(1))
        with patch.object(pi_phase, "sample_tree", return_value=[(1, 99999.0, "a", "t")]):
            running = pi_phase.RunningMemory(0, 0, False)
            for _ in range(4):
                self.assertIsNone(running.offender(1))

    def sampled_phase(self, patch_code, command, kind="test"):
        entry = ("import sys; sys.path.insert(0, sys.argv[1]); import pi_phase\n"
                 + patch_code + "\nsys.exit(pi_phase.main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))")
        child = subprocess.Popen([sys.executable, "-B", "-c", entry, str(HERE), str(self.state), str(self.config),
                                  "run", "--kind", kind, "--label", "sampled", "--timeout", "20",
                                  "--queue-timeout", "5", "--", *command],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        return child

    def test_rss_cap_kills_phase_with_distinct_status(self):
        self.configure(container_test_detection="off", rss_cap_mb=12288)
        marker = self.root / "survived"
        command = [sys.executable, "-c", "import time,pathlib,sys;time.sleep(8);pathlib.Path(sys.argv[1]).touch()", str(marker)]
        child = self.sampled_phase("pi_phase.MEMORY_SAMPLE_INTERVAL = 0.3\n"
                                   "pi_phase.sample_tree = lambda pid: [(pid, 100.0, 'small', 'T'), (pid + 1, 20000.0, 'fake-giant --flag', 'T')]",
                                   command)
        started = time.monotonic()
        code, out = self.done(child, timeout=15)
        self.assertEqual(code, pi_phase.EXIT_RSS_CAP, out)
        self.assertEqual(pi_phase.EXIT_RSS_CAP, 76)
        self.assertLess(time.monotonic() - started, 7)
        self.assertRegex(out, r"rss cap exceeded: pid=\d+ rss=20000MB > rss_cap_mb=12288MB command=fake-giant --flag")
        self.assertIn("exit=76", out)
        self.assertFalse(marker.exists())

    def test_rss_below_cap_or_disabled_is_not_killed(self):
        for cap, rss in ((12288, 1000.0), (0, 99999.0)):
            with self.subTest(cap=cap):
                self.configure(container_test_detection="off", rss_cap_mb=cap)
                child = self.sampled_phase("pi_phase.MEMORY_SAMPLE_INTERVAL = 0.2\n"
                                           f"pi_phase.sample_tree = lambda pid: [(pid, {rss}, 'x', 'T')]",
                                           [sys.executable, "-c", "import time;time.sleep(1)"])
                code, out = self.done(child, timeout=15)
                self.assertEqual(code, 0, out)
                self.assertNotIn("rss cap", out)

    def test_low_swap_while_running_warns_without_killing(self):
        self.configure(container_test_detection="off", rss_cap_mb=0, memory_admission=dict(min_free_percent=0))
        child = self.sampled_phase("pi_phase.MEMORY_SAMPLE_INTERVAL = 0.2\n"
                                   "pi_phase.low_memory_reason = lambda floor: 'memory available 5% < 15%'",
                                   [sys.executable, "-c", "import time;time.sleep(1)"])
        code, out = self.done(child, timeout=15)
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("warning: memory available 5% < 15% while phase is running (no action taken)"), 1, out)

    def test_shim_never_exports_gc_heap_limit(self):
        self.assertNotIn("GCHeapHardLimit", (HERE / "dotnet-shim.sh").read_text())
        env = pi_phase.shim_environment(self.root, 3)
        self.assertFalse([k for k in env if "GC_HEAP" in k])

    def test_phase_nice_lowers_producer_priority_for_heavy_kinds_only(self):
        probe = [sys.executable, "-c", "import os; print('prio=%d env=%s' % (os.getpriority(os.PRIO_PROCESS, 0), 'PI_PHASE_NICE' in os.environ))"]
        base = os.getpriority(os.PRIO_PROCESS, 0)
        self.configure(phase_nice=7, container_test_detection="off")
        for kind in ("build", "test", "integration"):
            with self.subTest(kind=kind):
                code, out = self.done(self.run_phase(kind=kind, label=f"nice-{kind}", command=probe))
                self.assertEqual(code, 0, out)
                self.assertIn("nice 7 (phase_nice)", out)
                self.assertIn(f"prio={max(base, 7)} env=False", out)
        self.configure(container_test_detection="off")
        code, out = self.done(self.run_phase(kind="build", label="nice-off", command=probe))
        self.assertEqual(code, 0, out)
        self.assertNotIn("phase_nice", out)
        self.assertIn(f"prio={base} env=False", out)

    def test_phase_nice_config_validation(self):
        for value, expected in ((10, 10), (0, 0), (19, 19), (20, 0), (-1, 0), (True, 0), ("10", 0), (2.5, 0)):
            with self.subTest(value=value):
                self.config.write_text(json.dumps(dict(phase_nice=value)))
                with patch.object(pi_phase, "note"):
                    self.assertEqual(pi_phase.config(self.config).options["phase_nice"], expected)

    def test_apply_nice_never_raises_priority_and_tolerates_bad_values(self):
        with patch.object(pi_phase.os, "getpriority", return_value=12), patch.object(pi_phase.os, "setpriority") as setp:
            pi_phase.apply_nice("5")
            pi_phase.apply_nice(None)
            setp.assert_not_called()
            pi_phase.apply_nice("15")
            setp.assert_called_once_with(pi_phase.os.PRIO_PROCESS, 0, 15)
        with patch.object(pi_phase.os, "setpriority", side_effect=PermissionError("no")), patch.object(pi_phase.os, "getpriority", return_value=0):
            pi_phase.apply_nice("10")
        pi_phase.apply_nice("junk")

    def test_shim_reaches_script_dotnet_and_is_phase_private(self):
        self.configure(msbuild_max_cpu=4, container_test_detection="off")
        self.executable(self.fake_bin / "dotnet", "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n")
        code, out = self.done(self.run_phase(kind="build", command=["sh", "-c", "dotnet build 'a b'"]))
        self.assertEqual(code, 0, out)
        self.assertIn("msbuild cap -m:4 (msbuild_max_cpu)", out)
        self.assertIn("<build>\n<-m:4>\n<-p:UseSharedCompilation=false>\n<-nodeReuse:false>\n<a b>", out)
        self.assertEqual(list(self.state.glob("dotnet-shim-*")), [])
        for kind in ("test", "integration", "ci"):
            extra = ("--repo", "repo", "--pr", "1", "--commit", "abc") if kind == "ci" else ()
            code, out = self.done(self.run_phase(kind=kind, command=["dotnet", "test"], extra=extra))
            self.assertEqual(code, 0, out)
            self.assertEqual("msbuild cap" in out, kind != "ci")
            self.assertEqual("<-m:4>" in out, kind != "ci")
        self.configure(msbuild_max_cpu=0, container_test_detection="off")
        code, out = self.done(self.run_phase(command=["dotnet", "test"]))
        self.assertEqual(code, 0, out)
        self.assertNotIn("msbuild cap", out)
        self.assertNotIn("<-m:", out)

    def test_container_hint_records_fingerprint_once_using_fake_docker(self):
        self.configure(container_test_detection="hint", cold_worktree_hint=False)
        self.fake_docker(time.time() + 2)
        command = [sys.executable, "-c", "import time;time.sleep(.4)"]
        code, out = self.done(self.run_phase(command=command))
        self.assertEqual(code, 0, out)
        self.assertEqual(out.count("hint: this test phase started Testcontainers containers"), 1)
        fingerprint = pi_phase.test_fingerprint(os.getcwd(), command)
        self.assertEqual(json.loads((self.state / "container-tests.json").read_text()), {fingerprint: True})
        alias = self.root / "cwd-alias"
        alias.symlink_to(Path.cwd(), target_is_directory=True)
        self.assertEqual(pi_phase.test_fingerprint(alias, command), fingerprint)
        self.assertNotEqual(pi_phase.test_fingerprint(os.getcwd(), [*command, "different"]), fingerprint)

    def test_container_detection_off_old_missing_failed_and_timeout(self):
        self.state.mkdir()
        self.fake_docker(time.time() - 60)
        stopped = threading.Event()
        # One probe, then stop without waiting 15 seconds.
        with patch.object(stopped, "wait", return_value=True) as wait, patch.object(pi_phase, "note") as note:
            pi_phase.container_test_poller(self.state, "old", time.time(), stopped)
            wait.assert_called_once_with(15)
            note.assert_not_called()
        for error in (FileNotFoundError(), subprocess.CalledProcessError(1, "docker"),
                      subprocess.TimeoutExpired("docker", 5)):
            with patch.object(pi_phase.subprocess, "run", side_effect=error) as run, \
                    patch.object(stopped, "wait", return_value=True), patch.object(pi_phase, "note") as note:
                pi_phase.container_test_poller(self.state, "failed", time.time(), stopped)
                self.assertEqual(run.call_args.kwargs["timeout"], 5)
                note.assert_not_called()
        self.configure(container_test_detection="off")
        self.fake_docker(time.time() + 2)
        code, out = self.done(self.run_phase())
        self.assertEqual(code, 0, out)
        self.assertNotIn("Testcontainers", out)
        self.assertFalse((self.state / "container-tests.json").exists())

    def test_recorded_test_promotes_and_claims_both_permits_atomically(self):
        self.configure(container_test_detection="promote", cold_worktree_hint=False)
        self.fake_docker(time.time() + 2)
        command = [sys.executable, "-c", "import time;time.sleep(.4)"]
        code, out = self.done(self.run_phase(command=command))
        self.assertEqual(code, 0, out)
        self.assertNotIn("also claiming", out)  # First discovery only hints.
        self.assertTrue((self.state / "container-tests.json").exists())
        blocker = pi_phase.lock_file(self.state / "integration-0.lock")
        try:
            job = self.run_phase(command=command, extra=("--rerun",))
            self.wait_for(lambda: bool(list((self.state / "waiters").glob("*.json"))))
            waiter = json.loads(next((self.state / "waiters").glob("*.json")).read_text())
            self.assertEqual(waiter["kind"], "integration")
            for index in range(2):
                fd = pi_phase.lock_file(self.state / f"heavy-{index}.lock")
                self.assertIsNotNone(fd)  # No heavy lease held while integration is blocked.
                pi_phase.unlock(fd)
        finally:
            pi_phase.unlock(blocker)
        self.wait_for(lambda: (self.state / "integration-0.json").exists())
        owners = [json.loads(path.read_text()) for path in self.state.glob("heavy-*.json")]
        integration = json.loads((self.state / "integration-0.json").read_text())
        self.assertTrue(any(owner["token"] == integration["token"] for owner in owners))
        code, out = self.done(job)
        self.assertEqual(code, 0, out)
        self.assertIn("also claiming an integration permit", out)

    def test_cold_worktree_hint_bounded_depth_and_skips(self):
        top = self.root / "worktree"
        top.mkdir()
        (top / ".git").write_text("gitdir: /unused")
        child = top / "one" / "two"
        child.mkdir(parents=True)
        self.assertTrue(pi_phase.cold_worktree(child))
        ignored = top / "node_modules" / "obj"
        ignored.mkdir(parents=True)
        (top / "external").symlink_to(ignored, target_is_directory=True)
        self.assertTrue(pi_phase.cold_worktree(child))
        deep = child / "three" / "obj"
        deep.mkdir(parents=True)
        self.assertTrue(pi_phase.cold_worktree(child))  # Depth four is not scanned.
        (child / "obj").mkdir()
        self.assertFalse(pi_phase.cold_worktree(child))
        (child / "obj").rmdir()
        self.configure(container_test_detection="off")
        with patch.object(pi_phase, "cold_worktree", return_value=True), patch.object(pi_phase, "note") as note:
            code = pi_phase.main(["run", "--kind", "build", "--label", "cold", "--", sys.executable, "-c", "pass"],
                                 state=self.state, configuration=self.config)
        self.assertEqual(code, 0)
        self.assertTrue(any("warm lane worktree" in str(call) for call in note.call_args_list))
        (top / ".git").unlink()
        (top / ".git").mkdir()
        self.assertFalse(pi_phase.cold_worktree(child))
        self.configure(cold_worktree_hint=False, container_test_detection="off")
        with patch.object(pi_phase, "cold_worktree") as cold:
            self.assertEqual(pi_phase.main(["run", "--kind", "test", "--label", "disabled", "--",
                                           sys.executable, "-c", "pass"],
                                          state=self.state, configuration=self.config), 0)
            cold.assert_not_called()

    def test_long_queue_hint_once_without_waiting_ten_minutes(self):
        self.configure(container_test_detection="off")
        args = SimpleNamespace(label="queue", timeout=1, queue_timeout=900, approved_long_timeout=True,
            kind="build", priority="normal", repo=None, pr=None, commit=None,
            command=[sys.executable, "-c", "pass"], vstest_hang_minutes=None, vstest_confirmed=False)
        # Queue starts at zero, then ticks past 600 twice and finally times out.
        with patch.object(pi_phase.time, "monotonic", side_effect=[0, 601, 601, 601, 601, 602, 602, 602, 901]), \
                patch.object(pi_phase.time, "sleep"), patch.object(pi_phase, "claim", return_value=None), \
                patch.object(pi_phase, "note") as note:
            self.assertEqual(pi_phase.run(args, self.state, self.config), 75)
        hints = [call.args[0] for call in note.call_args_list if call.args[0].startswith("long queue")]
        self.assertEqual(hints, ["long queue (601s): run dev-doctor to look for contention"])

    def test_memory_admission_config_defaults_validation_and_overrides(self):
        self.assertIs(pi_phase.config(self.config).options["memory_admission"], False)
        for value, expected in ((True, dict(min_free_percent=30, min_swap_free_mb=2048)),
                ({}, dict(min_free_percent=30, min_swap_free_mb=2048)),
                (dict(min_free_percent=20), dict(min_free_percent=20, min_swap_free_mb=2048)),
                (dict(min_free_percent=0, min_swap_free_mb=0), dict(min_free_percent=0, min_swap_free_mb=0))):
            with self.subTest(value=value):
                self.configure(memory_admission=value)
                self.assertEqual(pi_phase.config(self.config).options["memory_admission"], expected)
        for value in (None, 1, "true", [], dict(min_free_percent=-1), dict(min_free_percent=101),
                      dict(min_free_percent=True), dict(min_swap_free_mb="500"),
                      dict(min_swap_free_mb=-1), dict(min_swap_free_mb=float("inf"))):
            with self.subTest(value=value):
                self.configure(memory_admission=value)
                with patch.object(pi_phase, "note") as note:
                    self.assertIs(pi_phase.config(self.config).options["memory_admission"], False)
                note.assert_called_once_with("invalid memory_admission; using default False")
        self.configure(memory_admission=dict(unknown=1))
        with patch.object(pi_phase, "note") as note:
            self.assertEqual(pi_phase.config(self.config).options["memory_admission"]["min_free_percent"], 30)
            note.assert_called_once_with("unknown memory_admission key unknown; ignored")

    def test_memory_parsers_for_macos_and_linux(self):
        pressure = "System-wide memory free percentage: 25%\n"
        for free, expected in (("512.00M", 512), ("1.50G", 1536), ("2048K", 2), ("0.5T", 524288)):
            with self.subTest(free=free):
                self.assertEqual(pi_phase.parse_macos_memory(pressure,
                    f"total = 6144.00M  used = 4096.00M  free = {free} (encrypted)"), (25, expected))
        meminfo = "MemTotal: 1000000 kB\nMemAvailable: 400000 kB\nSwapFree: 1024000 kB\nIgnored: 3 kB\n"
        self.assertEqual(pi_phase.parse_linux_memory(meminfo), (40, 1000))
        for text in ("", "MemTotal: 0 kB\nMemAvailable: 0 kB\nSwapFree: 0 kB",
                     meminfo.replace("MemAvailable: 400000 kB", "MemAvailable: 400000 MB")):
            with self.subTest(text=text), self.assertRaises((ValueError, KeyError)):
                pi_phase.parse_linux_memory(text)
        for pressure, swap in (("bad", "bad"), ("System-wide memory free percentage: 101%", "free = 0M")):
            with self.assertRaises(ValueError):
                pi_phase.parse_macos_memory(pressure, swap)

    def test_host_memory_readers_are_bounded_and_select_platform(self):
        outputs = [SimpleNamespace(stdout="System-wide memory free percentage: 31%"),
                   SimpleNamespace(stdout="total = 2G used = 1G free = 1G")]
        with patch.object(pi_phase.sys, "platform", "darwin"), \
                patch.object(pi_phase.subprocess, "run", side_effect=outputs) as run:
            self.assertEqual(pi_phase.read_host_memory(time.monotonic() + 3), (31, 1024))
            self.assertEqual([call.args[0] for call in run.call_args_list],
                             [["memory_pressure", "-Q"], ["sysctl", "-n", "vm.swapusage"]])
            for call in run.call_args_list:
                self.assertLessEqual(call.kwargs["timeout"], 1)
                self.assertTrue(call.kwargs["check"])
        text = "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapFree: 1024 kB\n"
        from unittest.mock import mock_open
        with patch.object(pi_phase.sys, "platform", "linux"), patch("builtins.open", mock_open(read_data=text)) as stream:
            self.assertEqual(pi_phase.read_host_memory(time.monotonic() + 1), (50, 1))
            stream.assert_called_once_with("/proc/meminfo")
            stream().read.assert_called_once_with(65536)

    def test_memory_admission_cache_thresholds_and_fail_open(self):
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        with patch.object(pi_phase.time, "monotonic", side_effect=[0, 4.99, 5, 10]), \
                patch.object(pi_phase, "read_host_memory", side_effect=[(20, 1000), (30, 499), (30, 500)]) as read:
            self.assertEqual(admission.reason(100), "memory free 20% < 30%")
            self.assertEqual(admission.reason(100), "memory free 20% < 30%")
            self.assertEqual(read.call_count, 1)
            self.assertEqual(admission.reason(100), "swap free 499 MB < 500 MB")
            self.assertIsNone(admission.reason(100))
            self.assertEqual(read.call_count, 3)
        for error in (OSError("unavailable"), ValueError("bad output"), KeyError("MemAvailable"),
                      subprocess.TimeoutExpired("memory_pressure", 1)):
            with self.subTest(error=error):
                admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
                with patch.object(pi_phase, "read_host_memory", side_effect=error), patch.object(pi_phase, "note") as note:
                    self.assertIsNone(admission.reason(time.monotonic() + 1))
                    self.assertIsNone(admission.reason(time.monotonic() + 1))
                    note.assert_called_once()
                    self.assertIn("admitting (fail-open)", note.call_args.args[0])

    def memory_claim(self, kind="build", admission=None, cleanup=True):
        self.state.mkdir(exist_ok=True)
        held = pi_phase.claim(self.state, pi_phase.slot_paths(self.state, kind, 2, 1, ("repo", "1", "sha")),
                              time.monotonic() + 2, lambda: False, admission=admission)
        if held and cleanup:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def test_memory_guard_defers_without_holding_permits_and_prints_once(self):
        self.state.mkdir()
        running = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, running)
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        def sample(_deadline):
            coordinator = pi_phase.lock_file(self.state / "coordinator.lock")
            self.assertIsNotNone(coordinator)  # Never measure under the coordinator.
            pi_phase.unlock(coordinator)
            return 20, 1000
        with patch.object(pi_phase, "read_host_memory", side_effect=sample), patch.object(pi_phase, "note") as note:
            self.assertIsNone(self.memory_claim(admission=admission))
            self.assertIsNone(self.memory_claim(kind="integration", admission=admission))
            note.assert_called_once_with("waiting: memory free 20% < 30%")
        for name in ("heavy-1.lock", "integration-0.lock"):
            fd = pi_phase.lock_file(self.state / name)
            self.assertIsNotNone(fd)
            pi_phase.unlock(fd)
        admission.checked = None
        with patch.object(pi_phase, "read_host_memory", return_value=(50, 1000)):
            self.assertTrue(self.memory_claim(admission=admission))

    def test_memory_starvation_guard_accounts_for_ci_and_orphan_phases(self):
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        with patch.object(pi_phase, "read_host_memory", return_value=(10, 0)):
            held = self.memory_claim(admission=admission, cleanup=False)  # Idle host still starts one phase.
        self.assertTrue(held)
        for _, fd in held:
            os.close(fd)
        ci = pi_phase.lock_file(self.state / "ci-running.lock")
        try:
            with patch.object(pi_phase, "read_host_memory", return_value=(10, 0)):
                self.assertIsNone(self.memory_claim(admission=admission))
                # CI watchers never acquire heavy permits or invoke memory probes.
                with patch.object(pi_phase, "read_host_memory") as read:
                    held = self.memory_claim(kind="ci", admission=admission, cleanup=False)
                    self.assertTrue(held)
                    for _, fd in held:
                        os.close(fd)
                    read.assert_not_called()
        finally:
            pi_phase.unlock(ci)
        orphan = self.state / "heavy-9.json"  # Includes slots outside a lowered ceiling.
        orphan.write_text(json.dumps(dict(pgid=4242, token="orphan")))
        (self.state / "heavy-9.lock").touch()
        with patch.object(pi_phase, "live_groups", return_value={4242}):
            self.assertIsNone(self.memory_claim(admission=admission))
        with patch.object(pi_phase, "live_groups", return_value=set()):
            self.assertTrue(self.memory_claim(admission=admission))

    def test_memory_measurement_failure_admits_even_with_another_phase(self):
        self.state.mkdir()
        running = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, running)
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        with patch.object(pi_phase, "read_host_memory", side_effect=OSError("failed")), patch.object(pi_phase, "note") as note:
            self.assertTrue(self.memory_claim(admission=admission))
            self.assertIn("fail-open", note.call_args.args[0])

    def test_macos_without_swap_skips_swap_threshold_but_linux_does_not(self):
        reading = pi_phase.parse_macos_memory("System-wide memory free percentage: 80%",
                                              "total = 0.00M used = 0.00M free = 0.00M")
        self.assertEqual(reading, (80, None))
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        with patch.object(pi_phase, "read_host_memory", return_value=reading):
            self.assertIsNone(admission.reason(time.monotonic() + 2))
        admission.checked = None
        with patch.object(pi_phase, "read_host_memory", return_value=(80, 0)):
            self.assertEqual(admission.reason(time.monotonic() + 2), "swap free 0 MB < 500 MB")

    def test_config_and_memory_failure_notes_are_deduplicated_for_a_phase(self):
        self.config.write_text('{"heavy_slots": 0, "memory_admission": "bad"}')
        notes = set()
        with patch.object(pi_phase, "note") as note:
            for _ in range(3):
                pi_phase.config(self.config, notes=notes)
            self.assertEqual(note.call_count, 2)
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        with patch.object(pi_phase.time, "monotonic", side_effect=[0, 6, 12]), \
                patch.object(pi_phase, "read_host_memory", side_effect=OSError("failed")) as read, \
                patch.object(pi_phase, "note") as note:
            for _ in range(3):
                self.assertIsNone(admission.reason(100))
            self.assertEqual(read.call_count, 3)
            note.assert_called_once()

    def test_missing_or_unreadable_shim_runs_uncapped(self):
        self.configure(msbuild_max_cpu=4, container_test_detection="off")
        for error in (FileNotFoundError("shim missing"), PermissionError("shim unreadable")):
            with self.subTest(error=error), patch.object(pi_phase, "shim_environment", side_effect=error), \
                    patch.object(pi_phase, "note") as note:
                self.assertEqual(pi_phase.main(["run", "--kind", "build", "--label", "fallback", "--rerun", "--",
                                               sys.executable, "-c", "pass"],
                                              state=self.state, configuration=self.config), 0)
                warnings = [call.args[0] for call in note.call_args_list if "running uncapped" in call.args[0]]
                self.assertEqual(len(warnings), 1)
        self.assertEqual(list(self.state.glob("dotnet-shim-*")), [])

    def test_attribution_rejects_existing_and_short_lived_test_peers(self):
        self.state.mkdir()
        peer_lock = self.state / "heavy-1.lock"
        peer = pi_phase.lock_file(peer_lock)
        try:
            pi_phase.save(peer_lock.with_suffix(".json"), dict(kind="integration", token="peer"))
            self.assertIsNone(pi_phase.begin_test_attribution(self.state, "own"))
        finally:
            pi_phase.unlock(peer)
            peer_lock.with_suffix(".json").unlink()
        attribution = pi_phase.begin_test_attribution(self.state, "own")
        self.assertEqual(attribution, "own")
        # A peer begins and ends entirely between the owner's Docker polls.
        pi_phase.begin_test_attribution(self.state, "short-peer")
        self.fake_docker(time.time() + 2)
        with patch.object(pi_phase, "note") as note:
            pi_phase.container_test_poller(self.state, "fingerprint", time.time(), threading.Event(), attribution)
            note.assert_called_once()
        self.assertFalse((self.state / "container-tests.json").exists())
        attribution = pi_phase.begin_test_attribution(self.state, "solo")
        pi_phase.record_container_test(self.state, "solo-fingerprint", attribution)
        self.assertEqual(pi_phase.metadata(self.state / "container-tests.json"), {"solo-fingerprint": True})

    def test_test_shim_skips_assemblies_and_nearest_testing_platform_config(self):
        self.executable(self.fake_bin / "dotnet", "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n")
        shim = self.root / "safe-shim"
        shim.mkdir()
        env = pi_phase.shim_environment(shim, 3)
        child = self.root / "nested"
        child.mkdir()
        def invoke(args, capped):
            result = subprocess.run([str(shim / "dotnet"), *args], cwd=child, env=env,
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual("<-m:3>" in result.stdout, capped, result.stdout)
        for args, capped in ((["test", "assembly.dll"], False), (["test", "ASSEMBLY.EXE"], False),
                             (["build", "assembly.dll"], True), (["test", "--flag.dll"], True),
                             (["test", "project.csproj"], True)):
            invoke(args, capped)
        (self.root / "global.json").write_text('{"test":{"runner":"Microsoft.Testing.Platform"}}')
        invoke(["test", "project.csproj"], False)
        (child / "global.json").write_text('{"sdk":{"version":"10.0.100"}}')
        invoke(["test", "project.csproj"], True)
        (child / "global.json").write_text('{')
        invoke(["test", "project.csproj"], False)

    def test_integration_burst_config_is_opt_in_and_validated(self):
        self.configure(memory_admission=True)
        self.assertNotIn("integration_burst", pi_phase.config(self.config).options["memory_admission"])
        self.configure(memory_admission=dict(integration_burst={}))
        expected = dict(slots=2, min_free_percent=50, max_load_per_core=1.5, max_docker_mem_percent=70)
        self.assertEqual(pi_phase.config(self.config).options["memory_admission"]["integration_burst"], expected)
        for value in (True, [], dict(slots=0), dict(slots=33), dict(slots=True), dict(min_free_percent=101),
                      dict(max_load_per_core=-1), dict(max_docker_mem_percent=float("nan")),
                      dict(max_docker_mem_percent=101)):
            with self.subTest(value=value):
                self.configure(memory_admission=dict(integration_burst=value))
                with patch.object(pi_phase, "note") as note:
                    options = pi_phase.config(self.config).options["memory_admission"]
                    self.assertNotIn("integration_burst", options)
                    self.assertEqual(options["min_free_percent"], 30)
                    note.assert_called_once_with("invalid integration_burst; burst disabled")

    def test_docker_burst_reader_sums_percentages_and_is_bounded(self):
        with patch.object(pi_phase.subprocess, "run", return_value=SimpleNamespace(stdout="20.0%\n 30.5%\n")) as run:
            self.assertEqual(pi_phase.read_docker_memory_percent(time.monotonic() + 10), 50.5)
            self.assertEqual(run.call_args.args[0], ["docker", "stats", "--no-stream", "--format", "{{.MemPerc}}"])
            self.assertLessEqual(run.call_args.kwargs["timeout"], 5)
            self.assertTrue(run.call_args.kwargs["check"])
        for text in ("bad", "NaN%", "-2%", "inf%"):
            with self.subTest(text=text), patch.object(pi_phase.subprocess, "run", return_value=SimpleNamespace(stdout=text)):
                with self.assertRaises(ValueError):
                    pi_phase.read_docker_memory_percent(time.monotonic() + 10)

    def integration_burst(self, sample=(60, 1000)):
        return pi_phase.IntegrationBurst(SimpleNamespace(reading=lambda deadline: sample),
            dict(slots=2, min_free_percent=50, max_load_per_core=1.5, max_docker_mem_percent=70))

    def test_burst_requires_all_three_thresholds_and_uses_five_minute_load(self):
        for free, load, docker, expected in ((50, 12, 69.9, 2), (49.9, 0, 0, 1),
                                           (80, 12.1, 0, 1), (80, 0, 70, 1), (80, 0, 99, 1)):
            with self.subTest(free=free, load=load, docker=docker), \
                    patch.object(pi_phase.os, "getloadavg", return_value=(999, load, 999)), \
                    patch.object(pi_phase.os, "cpu_count", return_value=8), \
                    patch.object(pi_phase, "read_docker_memory_percent", return_value=docker):
                self.assertEqual(self.integration_burst((free, None)).effective(1, 1000), expected)
        with patch.object(pi_phase.os, "getloadavg", return_value=(0, 1.5, 0)), \
                patch.object(pi_phase.os, "cpu_count", return_value=None), \
                patch.object(pi_phase, "read_docker_memory_percent", return_value=0):
            self.assertEqual(self.integration_burst().effective(1, 1000), 2)

    def test_burst_fails_closed_and_caches_docker_for_thirty_seconds(self):
        with patch.object(pi_phase.os, "getloadavg", return_value=(0, 0, 0)):
            self.assertEqual(self.integration_burst(None).effective(1, 1000), 1)
            for error in (OSError("missing Docker"), ValueError("bad stats"), subprocess.TimeoutExpired("docker", 5)):
                burst = self.integration_burst()
                with patch.object(pi_phase.time, "monotonic", side_effect=[0, 29.99, 30]), \
                        patch.object(pi_phase, "read_docker_memory_percent", side_effect=[error, 20]) as read:
                    self.assertEqual(burst.effective(1, 1000), 1)
                    self.assertEqual(burst.effective(1, 1000), 1)
                    self.assertEqual(read.call_count, 1)
                    self.assertEqual(burst.effective(1, 1000), 2)
                    self.assertEqual(read.call_count, 2)
            burst = self.integration_burst()
            with patch.object(pi_phase.time, "monotonic", side_effect=[0, 29.99, 30]), \
                    patch.object(pi_phase, "read_docker_memory_percent", side_effect=[20, 80]) as read:
                self.assertEqual(burst.effective(1, 1000), 2)
                self.assertEqual(burst.effective(1, 1000), 2)
                self.assertEqual(burst.effective(1, 1000), 1)
                self.assertEqual(read.call_count, 2)
        with patch.object(pi_phase.os, "getloadavg", side_effect=OSError("no load average")):
            self.assertEqual(self.integration_burst().effective(1, 1000), 1)

    def test_burst_reduction_counts_running_overflow_without_preemption(self):
        self.state.mkdir()
        owners = []
        def acquire(ceiling, kind="integration"):
            held = pi_phase.claim(self.state, pi_phase.slot_paths(self.state, kind, 2, ceiling, ()),
                                  time.monotonic() + 2, lambda: False, integration_ceiling=ceiling)
            if held:
                owners.extend(held)
            return held
        def close(held):
            for path, fd in held:
                os.close(fd)
                owners.remove((path, fd))
        try:
            first, second = acquire(2), acquire(2)
            self.assertTrue(first)
            self.assertTrue(second)
            close(first)
            self.assertIsNone(acquire(1))  # integration-0 is free, but overflow still consumes the ceiling.
            self.assertIsNone(pi_phase.lock_file(self.state / "integration-1.lock"))
            build = acquire(1, "build")  # Pressure reduction does not block ordinary heavy work.
            self.assertTrue(build)
            close(build)
            close(second)
            self.assertTrue(acquire(1))
        finally:
            close(owners[:])

    def test_burst_reduction_counts_orphan_integration_leases(self):
        self.state.mkdir()
        (self.state / "integration-1.lock").touch()
        pi_phase.save(self.state / "integration-1.json", dict(pgid=4242, kind="integration"))
        candidates = pi_phase.slot_paths(self.state, "integration", 2, 1, ())
        with patch.object(pi_phase, "live_groups", return_value={4242}):
            self.assertIsNone(pi_phase.claim(self.state, candidates, time.monotonic() + 2, lambda: False,
                                            integration_ceiling=1))
        with patch.object(pi_phase, "live_groups", return_value=set()):
            held = pi_phase.claim(self.state, candidates, time.monotonic() + 2, lambda: False, integration_ceiling=1)
            self.assertTrue(held)
            for _, fd in held:
                os.close(fd)

    def test_run_uses_burst_ceiling_and_existing_atomic_integration_admission(self):
        self.configure(memory_admission=dict(integration_burst={}), container_test_detection="off")
        with patch.object(pi_phase, "read_host_memory", return_value=(80, None)), \
                patch.object(pi_phase.os, "getloadavg", return_value=(0, 0, 0)), \
                patch.object(pi_phase, "read_docker_memory_percent", return_value=0), \
                patch.object(pi_phase, "claim", wraps=pi_phase.claim) as claim:
            self.assertEqual(pi_phase.main(["run", "--kind", "integration", "--label", "burst", "--",
                                           sys.executable, "-c", "pass"],
                                          state=self.state, configuration=self.config), 0)
            self.assertEqual(claim.call_args.args[-1], 2)
            self.assertEqual(claim.call_args.args[-3], (2, 2))

    def fast_records(self, durations, **fields):
        now = datetime.now(timezone.utc)
        records = [dict(v=1, ts=now.isoformat(), kind="build", stack="other", startedAt=now.isoformat(),
                        waitS=0, runS=n, outcome="passed", fingerprint="fingerprint") for n in durations]
        for record in records:
            record.update(fields)
            pi_phase.append_ledger(self.state, record)

    def fast_args(self, **fields):
        return SimpleNamespace(**dict(dict(kind="build", expect_fast=False), **fields))

    def fast_settings(self):
        return pi_phase.config(self.config).options["fast_lane"]

    def fast_admit(self, token, **fields):
        settings = pi_phase.config(self.config)
        held = pi_phase.claim(self.state, pi_phase.slot_paths(self.state, "build", 1, 1, ()),
                              time.monotonic() + 2, lambda: False, token,
                              pi_phase.PhaseConfig(1, 1, settings.options), **fields)
        if held:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def hold_fast_slot(self, name="fast-0"):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / f"{name}.lock")
        self.addCleanup(os.close, fd)
        return fd

    def test_fast_config_defaults_overrides_disabled_invalid(self):
        self.assertEqual(self.fast_settings(), dict(slots=2, max_expected_s=90, kinds=["build", "test"]))
        self.configure(fast_lane=dict(slots=1, max_expected_s=12.5, kinds=["test"]))
        self.assertEqual(self.fast_settings(), dict(slots=1, max_expected_s=12.5, kinds=["test"]))
        self.configure(fast_lane=False)
        self.assertIs(self.fast_settings(), False)
        self.configure(fast_lane=dict(slots=True, max_expected_s=float("inf"), kinds=["integration"], typo=1))
        with patch.object(pi_phase, "note") as note:
            self.assertEqual(self.fast_settings(), dict(slots=2, max_expected_s=90, kinds=["build", "test"]))
            self.assertEqual(note.call_count, 4)
        self.configure(fast_lane=None)
        with patch.object(pi_phase, "note"):
            self.assertEqual(self.fast_settings()["slots"], 2)

    def test_fast_history_requires_three_runs_and_p90_at_boundary(self):
        args, settings = self.fast_args(), self.fast_settings()
        self.fast_records([1, 2])
        self.assertFalse(pi_phase.fast_phase(self.state, args, settings, "fingerprint"))
        self.fast_records([90])
        self.assertTrue(pi_phase.fast_phase(self.state, args, settings, "fingerprint"))
        self.fast_records([91])
        self.assertFalse(pi_phase.fast_phase(self.state, args, settings, "fingerprint"))

    def test_fast_hint_unknown_sparse_and_known_slow(self):
        args, settings = self.fast_args(expect_fast=True), self.fast_settings()
        self.assertTrue(pi_phase.fast_phase(self.state, args, settings, "unknown"))
        self.fast_records([1])
        self.assertTrue(pi_phase.fast_phase(self.state, args, settings, "fingerprint"))
        self.fast_records([91])
        with patch.object(pi_phase, "note") as note:
            self.assertFalse(pi_phase.fast_phase(self.state, args, settings, "fingerprint"))
            self.assertIn("history says", note.call_args.args[0])

    def test_fast_history_ignores_old_malformed_unstarted_and_other_fingerprints(self):
        self.fast_records([1, 2, 3], fingerprint="other")
        self.fast_records([1, 2, 3], ts=(datetime.now(timezone.utc) - timedelta(days=8)).isoformat())
        self.fast_records([1, 2, 3], startedAt=None)
        self.fast_records([1, 2, 3], outcome="cancelled")
        self.fast_records([1, 2, 3], runS="invalid")
        self.assertFalse(pi_phase.fast_phase(self.state, self.fast_args(), self.fast_settings(), "fingerprint"))
        self.assertTrue(pi_phase.fast_phase(self.state, self.fast_args(expect_fast=True), self.fast_settings(), "fingerprint"))

    def test_fast_fingerprint_realpath_exact_command_and_additive_ledger(self):
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        command = [sys.executable, "-c", "pass"]
        fp = pi_phase.test_fingerprint(self.root, command)
        self.assertEqual(fp, pi_phase.test_fingerprint(alias, command))
        self.assertNotEqual(fp, pi_phase.test_fingerprint(self.root, command + ["arg"]))
        self.assertNotEqual(fp, pi_phase.test_fingerprint(self.state, command))
        args = SimpleNamespace(kind="build", label="fingerprint", priority="normal", command=command)
        with patch.object(pi_phase.os, "getcwd", return_value=str(alias)):
            ledger = pi_phase.PhaseLedger(args)
        self.assertEqual(ledger.record["fingerprint"], fp)
        self.assertEqual(ledger.record["v"], 1)

    def test_fast_never_integration_ci_or_disabled_kind(self):
        for kind in ("integration", "ci"):
            self.assertFalse(pi_phase.fast_phase(self.state, self.fast_args(kind=kind, expect_fast=True),
                                                 self.fast_settings(), "unknown"))
        self.assertFalse(pi_phase.fast_phase(self.state, self.fast_args(expect_fast=True), False, "unknown"))
        self.configure(fast_lane=dict(kinds=["test"]))
        self.assertFalse(pi_phase.fast_phase(self.state, self.fast_args(expect_fast=True), self.fast_settings(), "unknown"))

    def test_fast_preferred_even_with_older_heavy_and_no_heavy_leases(self):
        self.waiter("heavy")
        fast = self.waiter("fast", fast=True)
        held = self.fast_admit(fast)
        self.assertEqual([path.name for path, _ in held], ["fast-0.lock"])
        fd = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.assertIsNotNone(fd)
        pi_phase.unlock(fd)
        self.assertFalse((self.state / "fast-waiters" / f"{fast}.json").exists())

    def test_fast_with_heavy_full_and_heavy_cannot_take_fast(self):
        self.hold_fast_slot("heavy-0")
        fast = self.waiter("fast", fast=True)
        self.assertEqual(self.fast_admit(fast)[0][0].name, "fast-0.lock")
        heavy = self.waiter("heavy")
        self.assertIsNone(self.fast_admit(heavy))

    def test_fast_falls_back_to_heavy_with_normal_fifo(self):
        self.configure(fast_lane=dict(slots=1))
        self.hold_fast_slot()
        older = self.waiter("older")
        later = self.waiter("later", fast=True)
        self.assertIsNone(self.fast_admit(later))
        self.assertEqual(self.fast_admit(older)[0][0].name, "heavy-0.lock")

    def test_fast_fallback_obeys_priority_and_can_take_heavy(self):
        self.configure(fast_lane=dict(slots=1))
        self.hold_fast_slot()
        self.waiter("low", priority="low")
        fast = self.waiter("fast", fast=True)
        self.assertEqual(self.fast_admit(fast)[0][0].name, "heavy-0.lock")

    def test_fast_waiters_invisible_to_old_heavy_scan_and_stale_cleaned(self):
        fast = self.waiter("fast", fast=True)
        heavy = self.waiter("heavy")
        self.assertEqual([w["token"] for w in pi_phase.live_waiters(self.state)], [heavy])
        stale = self.state / "fast-waiters" / "stale.json"
        stale.write_text(json.dumps(dict(token="stale", kind="build", priority="high", enqueued=0, seq=0)))
        self.assertEqual({w["token"] for w in pi_phase.all_waiters(self.state)}, {fast, heavy})
        self.assertFalse(stale.exists())
        args = SimpleNamespace(kind="build", label="cancel", priority="normal", fast=True)
        _, fd = pi_phase.register_waiter(self.state, args, "cancel")
        pi_phase.deregister_waiter(self.state, "cancel", fd)
        self.assertFalse((self.state / "fast-waiters" / "cancel.json").exists())

    def test_fast_high_count_queued_running_deduplicated_and_cap(self):
        self.configure(max_high=1)
        self.assertEqual(self.done(self.start("grant-priority"))[0], 0)
        high = self.waiter("high", priority="high", fast=True)
        held = self.fast_admit(high)
        pi_phase.publish(held, dict(token=high, priority="high", fast=True))
        self.assertEqual(pi_phase.high_count(self.state), 1)
        self.assertEqual(self.done(self.start("grant-priority"))[0], 0)
        args = SimpleNamespace(kind="build", label="downgraded", priority="high", fast=True, max_high=1)
        _, fd = pi_phase.register_waiter(self.state, args, "downgraded")
        self.addCleanup(os.close, fd)
        data = pi_phase.metadata(self.state / "fast-waiters" / "downgraded.json")
        self.assertEqual(data["priority"], "normal")
        self.assertEqual(pi_phase.high_count(self.state), 1)

    def test_fast_memory_gate_and_starvation_counts_fast_owners(self):
        self.configure(fast_lane=dict(slots=1))
        self.hold_fast_slot()
        fast = self.waiter("fast", fast=True)
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=500))
        with patch.object(pi_phase, "read_host_memory", return_value=(10, 0)):
            self.assertIsNone(self.fast_admit(fast, admission=admission))
        admission.checked = None
        with patch.object(pi_phase, "read_host_memory", return_value=(80, 1000)):
            self.assertEqual(self.fast_admit(fast, admission=admission)[0][0].name, "heavy-0.lock")

    def test_fast_orphan_counts_as_running_and_blocks_reuse(self):
        self.configure(fast_lane=dict(slots=1))
        self.hold_fast_slot("heavy-0")
        (self.state / "fast-0.lock").touch()
        pi_phase.save(self.state / "fast-0.json", dict(token="orphan", pgid=4242))
        fast = self.waiter("fast", fast=True)
        with patch.object(pi_phase, "live_groups", return_value={4242}):
            self.assertIsNone(self.fast_admit(fast))
        with patch.object(pi_phase, "live_groups", return_value=set()):
            self.assertEqual(self.fast_admit(fast)[0][0].name, "fast-0.lock")

    def test_fast_activity_does_not_consume_integration_burst_permits(self):
        self.hold_fast_slot()
        self.configure(memory_admission=dict(integration_burst={}))
        options = pi_phase.config(self.config).options["memory_admission"]
        burst = pi_phase.IntegrationBurst(pi_phase.MemoryAdmission(options), options["integration_burst"])
        with patch.object(pi_phase, "live_groups", return_value=set()), \
                patch.object(pi_phase, "read_host_memory", return_value=(80, None)), \
                patch.object(pi_phase.os, "getloadavg", return_value=(0, 0, 0)), \
                patch.object(pi_phase, "read_docker_memory_percent", return_value=0):
            ceiling = burst.effective(1, time.monotonic() + 2)
        self.assertEqual(ceiling, 2)
        self.hold_fast_slot("integration-0")
        candidates = pi_phase.slot_paths(self.state, "integration", 2, ceiling, ())
        held = pi_phase.claim(self.state, candidates, time.monotonic() + 2, lambda: False,
                              integration_ceiling=ceiling)
        self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        self.assertEqual(held[1][0].name, "integration-1.lock")
        self.assertTrue(pi_phase.phases_running(self.state, {}, {}, set()))

    def test_fast_status_and_eta_include_fast_queue_and_occupancy(self):
        self.seed_ledger()
        self.configure(fast_lane=dict(slots=1))
        high = self.waiter("fast", fast=True)
        held = self.fast_admit(high)
        pi_phase.publish(held, dict(token=high, kind="build", label="fast", priority="normal", fast=True, started=time.time()))
        self.waiter("queued-fast", fast=True)
        code, out = self.done(self.start("status"))
        self.assertEqual(code, 0, out)
        self.assertIn("fast=1/1 queued=1", out)
        self.assertIn("queued priority=normal kind=build", out)
        with patch("builtins.print") as output:
            pi_phase.wait_eta(self.state, self.config, "build")
        self.assertIn("ahead=1 running=1", output.call_args.args[0])

    def test_fast_budget_limit_and_timeout_demotes_fingerprint(self):
        self.assertEqual(pi_phase.fast_budget(self.fast_settings()), 270)
        self.assertEqual(pi_phase.fast_budget(dict(max_expected_s=1)), 120)
        command = [sys.executable, "-c", "import time; time.sleep(2)"]
        with patch.object(pi_phase, "fast_budget", return_value=.15), patch.object(pi_phase, "note") as note:
            code = pi_phase.main(["run", "--kind", "build", "--label", "overrun", "--expect-fast",
                                  "--timeout", "2", "--", *command], state=self.state, configuration=self.config)
        self.assertEqual(code, 124)
        self.assertTrue(any("rerun without --expect-fast" in call.args[0] for call in note.call_args_list))
        record = self.ledger_records()[0]
        self.assertTrue(record["fastBudgetExceeded"])
        self.assertEqual(record["outcome"], "timeout")
        self.assertFalse(pi_phase.fast_phase(self.state, self.fast_args(expect_fast=True),
                                             self.fast_settings(), pi_phase.test_fingerprint(os.getcwd(), command)))

    def test_fast_shorter_user_timeout_and_producer_124_do_not_demote(self):
        with patch.object(pi_phase, "note"):
            code = pi_phase.main(["run", "--kind", "build", "--label", "timeout", "--expect-fast",
                                  "--timeout", ".1", "--", sys.executable, "-c", "import time;time.sleep(2)"],
                                 state=self.state, configuration=self.config)
        self.assertEqual(code, 124)
        self.assertNotIn("fastBudgetExceeded", self.ledger_records()[0])
        job = self.run_phase(extra=("--expect-fast",), command=[sys.executable, "-c", "raise SystemExit(124)"])
        code, out = self.done(job)
        self.assertEqual(code, 124, out)
        self.assertFalse(any(r.get("fastBudgetExceeded") for r in self.ledger_records()))

    def test_fast_disabled_run_ignores_hint_and_uses_heavy(self):
        self.configure(fast_lane=False)
        job = self.run_phase(extra=("--expect-fast",), command=[sys.executable, "-c", "import time;time.sleep(.4)"])
        self.wait_for(lambda: (self.state / "heavy-0.json").exists())
        self.assertFalse(list(self.state.glob("fast-*.json")))
        code, out = self.done(job)
        self.assertEqual(code, 0, out)
        self.assertNotIn("fast lane (budget", out)
        self.assertFalse(self.ledger_records()[0]["fast"])

    def test_fast_ledger_additions_and_legacy_records_tolerated(self):
        self.seed_ledger()
        self.fast_records([1, 2, 3])
        records, skipped = pi_phase.read_ledger(self.state)
        self.assertEqual((len(records), skipped), (15, 2))
        self.assertEqual(len(pi_phase.fast_history(self.state, "fingerprint")), 3)
        self.assertTrue(pi_phase.fast_phase(self.state, self.fast_args(), self.fast_settings(), "fingerprint"))

    def test_fast_auto_run_and_promoted_test_never_fast(self):
        command = [sys.executable, "-c", "pass"]
        fingerprint = pi_phase.test_fingerprint(os.getcwd(), command)
        self.fast_records([1, 2, 3], fingerprint=fingerprint)
        with patch.object(pi_phase, "note"):
            self.assertEqual(pi_phase.main(["run", "--kind", "build", "--label", "auto", "--", *command],
                                          state=self.state, configuration=self.config), 0)
        self.assertTrue(self.ledger_records()[-1]["fast"])
        pi_phase.save(self.state / "container-tests.json", {fingerprint: True})
        self.configure(container_test_detection="promote")
        with patch.object(pi_phase, "note"):
            self.assertEqual(pi_phase.main(["run", "--kind", "test", "--label", "promoted", "--expect-fast",
                                           "--", *command], state=self.state, configuration=self.config), 0)
        self.assertFalse(self.ledger_records()[-1]["fast"])

    def test_fast_starts_while_real_heavy_process_holds_only_slot(self):
        self.config.write_text('{"heavy_slots":1}')
        active = self.run_phase(timeout="4", command=self.marker_job("heavy", 1.5))
        self.wait_for(lambda: (self.state / "heavy-0.json").exists())
        code, out = self.done(self.run_phase(extra=("--expect-fast",), command=self.marker_job("fast", .1)))
        self.assertEqual(code, 0, out)
        self.assertIsNone(active.poll())
        self.assertEqual(self.done(active)[0], 0)
        heavy, fast = self.intervals("heavy", "fast")
        self.assertLess(fast[1], heavy[1])

    def test_fast_rss_cap_uses_existing_process_group_cleanup(self):
        self.configure(rss_cap_mb=100)
        with patch.object(pi_phase.RunningMemory, "offender", return_value=(1, 200, "producer")), \
                patch.object(pi_phase, "MEMORY_SAMPLE_INTERVAL", .02), patch.object(pi_phase, "note"):
            code = pi_phase.main(["run", "--kind", "build", "--label", "rss", "--expect-fast", "--",
                                  sys.executable, "-c", "import time;time.sleep(2)"],
                                 state=self.state, configuration=self.config)
        self.assertEqual(code, pi_phase.EXIT_RSS_CAP)
        self.assertFalse(list(self.state.glob("fast-*.json")))

    def test_fast_run_preserves_nice_msbuild_rss_and_cancellation_cleanup(self):
        self.configure(phase_nice=10, msbuild_max_cpu=1, rss_cap_mb=100)
        job = self.run_phase(extra=("--expect-fast",), command=[sys.executable, "-c", "import time;time.sleep(5)"])
        self.wait_for(lambda: (self.state / "fast-0.json").exists())
        job.send_signal(signal.SIGTERM)
        code, out = self.done(job)
        self.assertEqual(code, 143, out)
        self.assertIn("msbuild cap -m:1", out)
        self.assertIn("nice 10", out)
        self.assertFalse(list(self.state.glob("fast-*.json")))
        self.assertFalse(list((self.state / "fast-waiters").glob("*.json")))

    def test_fifo_including_equal_timestamps_and_sequence(self):
        with patch.object(pi_phase.time, "time", return_value=100):
            first = self.waiter("first")
            second = self.waiter("second")
        self.assertIsNone(self.admit(second))
        held = self.admit(first)
        self.assertTrue(held)
        self.assertFalse((self.state / "waiters" / "first.json").exists())

    def test_high_before_earlier_normal_and_normal_before_low(self):
        normal = self.waiter("normal")
        self.assertEqual(self.done(self.start("grant-priority"))[0], 0)
        high = self.waiter("high", "high")
        low = self.waiter("low", "low")
        self.assertIsNone(self.admit(normal))
        self.assertIsNone(self.admit(low))
        self.assertTrue(self.admit(high))

    def test_later_normal_before_earlier_low(self):
        low = self.waiter("low", "low")
        normal = self.waiter("normal")
        self.assertIsNone(self.admit(low))
        self.assertTrue(self.admit(normal))

    def test_unsatisfiable_integration_waiter_does_not_block_build(self):
        integration = self.waiter("integration", kind="integration")
        build = self.waiter("build")
        fd = pi_phase.lock_file(self.state / "integration-0.lock")
        self.addCleanup(os.close, fd)
        self.assertIsNone(self.admit(integration, kind="integration"))
        self.assertTrue(self.admit(build))

    def test_satisfiable_integration_reserves_both_permits(self):
        self.waiter("integration", kind="integration")
        build = self.waiter("build")
        self.assertIsNone(self.admit(build))
        self.assertTrue(self.admit(build, heavy=2))

    def test_stale_unlocked_waiter_is_removed_regardless_of_pid(self):
        mine = self.waiter("mine")
        path = self.state / "waiters" / "stale.json"
        path.write_text(json.dumps(dict(token="stale", pid=os.getpid(), priority="high",
                                       kind="build", enqueued=0, seq=0)))
        self.assertTrue(self.admit(mine))
        self.assertFalse(path.exists())

    def test_locked_waiter_is_live_regardless_of_pid(self):
        first = self.waiter("first")
        path = self.state / "waiters" / f"{first}.json"
        data = json.loads(path.read_text())
        data["pid"] = 2147483647
        path.write_text(json.dumps(data))
        second = self.waiter("second")
        self.assertIsNone(self.admit(second))
        self.assertTrue(self.admit(first))

    def test_waiter_scan_survives_unlink_during_open_or_trylock(self):
        for when in ("before_open", "after_trylock"):
            with self.subTest(when=when):
                token = self.waiter(when)
                path = self.state / "waiters" / f"{token}.json"
                raced = self.root / f"race-{when}"
                setup = ("import pathlib,os\n"
                         f"victim = pathlib.Path({str(path)!r})\n"
                         f"raced = pathlib.Path({str(raced)!r})\n")
                if when == "before_open":
                    interleave = ("original = pi_phase.os.open\n"
                                  "def racing_open(path, *args, **kwargs):\n"
                                  "    if pathlib.Path(path) == victim and victim.exists():\n"
                                  "        victim.unlink()\n"
                                  "        raced.touch()\n"
                                  "    return original(path, *args, **kwargs)\n"
                                  "pi_phase.os.open = racing_open")
                else:
                    interleave = (f"inode = {path.stat().st_ino}\n"
                                  "original = pi_phase.fcntl.flock\n"
                                  "def racing_flock(fd, operation):\n"
                                  "    try:\n"
                                  "        return original(fd, operation)\n"
                                  "    except BlockingIOError:\n"
                                  "        if os.fstat(fd).st_ino == inode:\n"
                                  "            victim.unlink(missing_ok=True)\n"
                                  "            raced.touch()\n"
                                  "        raise\n"
                                  "pi_phase.fcntl.flock = racing_flock")
                job, marker = self.patched_phase(setup + interleave, extra=("--rerun",))
                code, out = self.done(job)
                self.assertEqual(code, 0, out)
                self.assertTrue(raced.exists())
                self.assertTrue(marker.exists())
                self.assertNotIn("unreadable live waiter", out)

    def test_deregister_unlinks_and_releases_waiter_under_coordinator(self):
        self.state.mkdir()
        args = SimpleNamespace(priority="normal", kind="build", label="deregister")
        ready, fd = pi_phase.register_waiter(self.state, args, "deregister")
        self.assertTrue(ready)
        path = self.state / "waiters" / "deregister.json"
        original_unlink = Path.unlink
        original_unlock = pi_phase.unlock
        events = []

        def assert_coordinator_held(event):
            probe = pi_phase.lock_file(self.state / "coordinator.lock")
            if probe is not None:
                original_unlock(probe)
            self.assertIsNone(probe, event)
            events.append(event)

        def unlink_waiter(target, *args, **kwargs):
            if target == path:
                assert_coordinator_held("unlink")
            return original_unlink(target, *args, **kwargs)

        def unlock_waiter(target):
            if target == fd:
                assert_coordinator_held("unlock")
            return original_unlock(target)

        try:
            with patch.object(Path, "unlink", unlink_waiter), patch.object(pi_phase, "unlock", unlock_waiter):
                pi_phase.deregister_waiter(self.state, "deregister", fd)
            self.assertEqual(events, ["unlink", "unlock"])
            self.assertFalse(path.exists())
        finally:
            try:
                os.fstat(fd)
            except OSError:
                pass
            else:
                os.close(fd)

    def test_high_missing_grant_fails_before_queueing(self):
        code, out = self.done(self.run_phase(extra=("--priority", "high")))
        self.assertEqual(code, 125, out)
        self.assertIn("pi-phase: " + pi_phase.APPROVAL_REQUIRED, out)
        self.assertFalse((self.state / "waiters").exists())

    def test_single_use_grant_is_consumed_atomically(self):
        code, out = self.done(self.start("grant-priority"))
        self.assertEqual(code, 0, out)
        jobs = [self.run_phase(extra=("--priority", "high")) for _ in range(2)]
        self.assertEqual(sorted(self.done(job)[0] for job in jobs), [0, 125])
        self.assertFalse((self.state / "priority-grant.json").exists())

    def test_unlimited_grant_remains_until_expiry(self):
        self.assertEqual(self.done(self.start("grant-priority", "--minutes", "30"))[0], 0)
        path = self.state / "priority-grant.json"
        data = json.loads(path.read_text())
        self.assertIsNone(data["uses"])
        for _ in range(2):
            code, out = self.done(self.run_phase(extra=("--priority=high",)))
            self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(path.read_text()), data)
        data["expires"] = time.time() - 1
        path.write_text(json.dumps(data))
        code, out = self.done(self.run_phase(extra=("--priority", "high", "--rerun")))
        self.assertEqual(code, 125, out)
        self.assertFalse(path.exists())

    def test_invalid_and_exhausted_grants_are_removed(self):
        self.state.mkdir()
        path = self.state / "priority-grant.json"
        for uses in (0, -1, True, "1", 21):
            path.write_text(json.dumps(dict(expires=time.time() + 60, created=time.time(),
                                           granted_by="user", uses=uses)))
            code, out = self.done(self.run_phase(extra=("--priority", "high")))
            self.assertEqual(code, 125, out)
            self.assertFalse(path.exists())

    def test_grant_bounds_revoke_and_status(self):
        for option, invalid in (("--uses", "0"), ("--uses", "21"), ("--minutes", "0"), ("--minutes", "481")):
            self.assertEqual(self.done(self.start("grant-priority", option, invalid))[0], 125)
        self.assertEqual(self.done(self.start("grant-priority", "--uses", "20"))[0], 0)
        data = json.loads((self.state / "priority-grant.json").read_text())
        self.assertEqual(data["uses"], 20)
        self.assertAlmostEqual(data["expires"] - data["created"], 3600)
        self.waiter("normal")
        self.waiter("high", "high")
        code, out = self.done(self.start("status"))
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r"priority=high kind=build label=high waited=\d+s rank=1")
        self.assertRegex(out, r"priority=normal kind=build label=normal waited=\d+s rank=2")
        self.assertIn("19 use(s) remaining", out)
        self.assertRegex(out, r"expires in \d+s at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")
        self.assertIn(time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(data["expires"])), out)
        self.assertNotIn("e+", out)
        self.assertEqual(self.done(self.start("revoke-priority"))[0], 0)
        self.assertFalse((self.state / "priority-grant.json").exists())

    def test_waiter_removed_on_queue_timeout_cancel_and_exception(self):
        self.state.mkdir()
        fd = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, fd)
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        job = self.run_phase(queue=".3")
        self.wait_for(lambda: bool(list((self.state / "waiters").glob("*.json"))))
        self.assertEqual(self.done(job)[0], 75)
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])
        job = self.run_phase(queue="4")
        self.wait_for(lambda: bool(list((self.state / "waiters").glob("*.json"))))
        job.send_signal(signal.SIGTERM)
        self.assertEqual(self.done(job)[0], 143)
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])
        job, marker = self.patched_phase("pi_phase.config = lambda path, **kwargs: (_ for _ in ()).throw(ValueError('broken config'))")
        code, out = self.done(job)
        self.assertEqual(code, 125, out)
        self.assertFalse(marker.exists())
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])

    def test_queue_order_across_processes(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        self.state.mkdir()
        blocker = pi_phase.lock_file(self.state / "heavy-0.lock")
        try:
            jobs = []
            for label in ("first", "second", "third"):
                jobs.append(self.run_phase(label=label, queue="8", command=self.marker_job(label, .1)))
                self.wait_for(lambda: len(list((self.state / "waiters").glob("*.json"))) == len(jobs))
        finally:
            os.close(blocker)
        for job in jobs:
            code, out = self.done(job)
            self.assertEqual(code, 0, out)
        first, second, third = self.intervals("first", "second", "third")
        self.assertLess(first[0], second[0])
        self.assertLess(second[0], third[0])
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])

    def test_crashed_waiter_is_reaped_by_status(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        self.state.mkdir()
        blocker = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, blocker)
        job = self.run_phase(queue="5")
        self.wait_for(lambda: bool(list((self.state / "waiters").glob("*.json"))))
        job.kill()
        job.communicate(timeout=3)
        code, out = self.done(self.start("status"))
        self.assertEqual(code, 0, out)
        self.assertNotIn("queued priority=", out)
        self.assertEqual(list((self.state / "waiters").glob("*.json")), [])

    def test_old_caller_without_registry_still_claims(self):
        self.waiter("queued")
        held = pi_phase.claim(self.state, pi_phase.slot_paths(self.state, "build", 1, 1, ()),
                              time.monotonic() + 1, lambda: False)
        self.assertTrue(held)
        for _, fd in held:
            os.close(fd)

    def test_exact_exit_and_no_secret_in_status(self):
        secret = "TOP_SECRET_COMMAND_ARGUMENT"
        marker = self.root / "active"
        script = "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(.7); sys.exit(37)"
        job = self.run_phase(label="safe", command=[sys.executable, "-c", script, str(marker), secret])
        self.wait_for(marker.exists)
        code, status = self.done(self.start("status"))
        self.assertEqual(code, 0, status)
        self.assertIn("safe pid=", status)
        self.assertIn(str(Path.cwd()), status)
        self.assertNotIn(secret, status)
        self.assertNotIn(secret, (self.state / "heavy-0.json").read_text())
        self.assertEqual(self.done(job)[0], 37)

    def test_log_preserves_exit_full_output_and_tail(self):
        for exit_code in (0, 37):
            with self.subTest(exit_code=exit_code):
                log = self.root / "nested" / f"exit-{exit_code}.log"
                log.parent.mkdir(exist_ok=True)
                log.write_text("old contents\n")
                script = ("import sys; print('first', flush=True); "
                          "print('stderr', file=sys.stderr, flush=True); "
                          "print('last', flush=True); sys.exit(int(sys.argv[1]))")
                code, out = self.done(self.run_phase(
                    command=[sys.executable, "-c", script, str(exit_code)],
                    extra=("--log", str(log), "--tail", "2")))
                self.assertEqual(code, exit_code, out)
                self.assertEqual(log.read_bytes(), b"first\nstderr\nlast\n")
                self.assertNotIn("first\n", out)
                self.assertTrue(out.endswith(
                    f"stderr\nlast\npi-phase: log={log.resolve()} exit={exit_code} lines=3\n"), out)

    def test_log_default_tail_and_parent_creation(self):
        log = self.root / "new" / "nested" / "default.log"
        script = "for i in range(65): print(f'line-{i}')"
        code, out = self.done(self.run_phase(
            command=[sys.executable, "-c", script], extra=("--log", str(log))))
        self.assertEqual(code, 0, out)
        self.assertEqual(log.read_text(), "".join(f"line-{i}\n" for i in range(65)))
        self.assertNotIn("line-4\n", out)
        self.assertTrue(out.endswith("".join(f"line-{i}\n" for i in range(5, 65)) +
                                     f"pi-phase: log={log.resolve()} exit=0 lines=65\n"), out)

    def test_log_zero_tail_preserves_binary_and_partial_line(self):
        log = self.root / "binary.log"
        script = "import sys; sys.stdout.buffer.write(b'first\\n\\xfflast')"
        code, out = self.done(self.run_phase(
            command=[sys.executable, "-c", script],
            extra=("--log", str(log), "--tail", "0")))
        self.assertEqual(code, 0, out)
        self.assertEqual(log.read_bytes(), b"first\n\xfflast")
        self.assertNotIn("first\n", out)
        self.assertTrue(out.endswith(f"pi-phase: log={log.resolve()} exit=0 lines=2\n"), out)

    def test_tail_requires_log_and_nonnegative_count(self):
        code, out = self.done(self.run_phase(extra=("--tail", "2")))
        self.assertEqual(code, 2, out)
        self.assertIn("--tail requires --log", out)
        log = self.root / "invalid.log"
        code, out = self.done(self.run_phase(extra=("--log", str(log), "--tail", "-1")))
        self.assertEqual(code, 2, out)
        self.assertIn("--tail must be nonnegative", out)
        self.assertFalse(log.exists())

    def test_timeout_with_log_preserves_output_and_summary(self):
        log = self.root / "timeout.log"
        script = "import time; print('before timeout', flush=True); time.sleep(10)"
        code, out = self.done(self.run_phase(
            timeout=".5", command=[sys.executable, "-c", script],
            extra=("--log", str(log))))
        self.assertEqual(code, 124, out)
        self.assertEqual(log.read_text(), "before timeout\n")
        self.assertIn("timed out", out)
        self.assertTrue(out.endswith(
            f"before timeout\npi-phase: log={log.resolve()} exit=124 lines=1\n"), out)

    def test_queue_timeout_with_log_prints_empty_summary(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        active = self.run_phase(command=self.marker_job("hold", .8))
        self.wait_for(lambda: (self.state / "heavy-0.json").exists())
        log = self.root / "queued.log"
        code, out = self.done(self.run_phase(queue=".25", extra=("--log", str(log))))
        self.assertEqual(code, 75, out)
        self.assertEqual(log.read_bytes(), b"")
        self.assertTrue(out.endswith(f"pi-phase: log={log.resolve()} exit=75 lines=0\n"), out)
        self.assertEqual(self.done(active)[0], 0)

    def test_cancel_with_log_preserves_output_and_summary(self):
        log = self.root / "cancel.log"
        script = "import time; print('before cancel', flush=True); time.sleep(10)"
        job = self.run_phase(command=[sys.executable, "-c", script], extra=("--log", str(log)))
        self.wait_for(lambda: log.exists() and log.read_bytes() == b"before cancel\n")
        job.send_signal(signal.SIGTERM)
        code, out = self.done(job)
        self.assertEqual(code, 143, out)
        self.assertEqual(log.read_text(), "before cancel\n")
        self.assertEqual(out.count("before cancel\n"), 1)
        self.assertTrue(out.endswith(
            f"before cancel\npi-phase: log={log.resolve()} exit=143 lines=1\n"), out)

    def test_wrapper_failure_with_log_prints_summary(self):
        log = self.root / "failure.log"
        code, out = self.done(self.run_phase(timeout="nan", extra=("--log", str(log))))
        self.assertEqual(code, 125, out)
        self.assertEqual(log.read_bytes(), b"")
        self.assertIn(f"pi-phase: log={log.resolve()} exit=125 lines=0\n", out)

    def test_two_slots_across_processes_and_queue_vs_run_timer(self):
        jobs = [self.run_phase(label=name, timeout="1.8", queue="5", command=self.marker_job(name))
                for name in ("a", "b", "c")]
        for job in jobs:
            code, out = self.done(job)
            self.assertEqual(code, 0, out)
        intervals = self.intervals("a", "b", "c")
        concurrency = [sum(start <= instant < end for start, end in intervals)
                       for instant, _ in intervals]
        self.assertIn(2, concurrency, intervals)
        self.assertLess(max(concurrency), 3, intervals)

    def test_integration_exclusivity_and_no_deadlock(self):
        jobs = [self.run_phase(kind=kind, label=name, command=self.marker_job(name, .45))
                for name, kind in (("i1", "integration"), ("i2", "integration"),
                                   ("h", "build"))]
        for job in jobs:
            code, out = self.done(job)
            self.assertEqual(code, 0, out)
        i1, i2, h = self.intervals("i1", "i2", "h")
        self.assertTrue(i1[1] <= i2[0] or i2[1] <= i1[0], (i1, i2))
        self.assertTrue(h[1] > h[0])

    def test_cancel_after_admission_never_launches_producer(self):
        patch = ("import os,signal\n"
                 "original = pi_phase.claim\n"
                 "def cancelled_claim(*args):\n"
                 "    held = original(*args)\n"
                 "    if held: os.kill(os.getpid(), signal.SIGTERM)\n"
                 "    return held\n"
                 "pi_phase.claim = cancelled_claim")
        job, marker = self.patched_phase(patch)
        code, output = self.done(job)
        self.assertEqual(code, 143, output)
        self.assertIn("cancelled during admission", output)
        self.assertFalse(marker.exists())
        self.assertEqual(self.done(self.start("status"))[1].strip(),
                         "pi-phase: no active phases\npi-phase: fast=0/2 queued=0\npi-phase: high=0/3")

    def test_cancel_after_metadata_before_gate_never_executes(self):
        patch = ("import os,signal\n"
                 "original = pi_phase.publish\n"
                 "def cancelled_publish(*args):\n"
                 "    original(*args)\n"
                 "    os.kill(os.getpid(), signal.SIGTERM)\n"
                 "pi_phase.publish = cancelled_publish")
        job, marker = self.patched_phase(patch)
        code, output = self.done(job)
        self.assertEqual(code, 143, output)
        self.assertIn("cancelled before execution", output)
        self.assertFalse(marker.exists())
        self.assertEqual(self.done(self.start("status"))[1].strip(),
                         "pi-phase: no active phases\npi-phase: fast=0/2 queued=0\npi-phase: high=0/3")

    def test_many_orphans_use_one_bounded_snapshot_per_scan(self):
        pgid = self.orphan_slots()
        calls = self.root / "probe-count"
        patch = ("import time\n"
                 "def snapshot(timeout):\n"
                 f"    with open({str(calls)!r}, 'a') as log: log.write('x')\n"
                 "    time.sleep(min(timeout, .2))\n"
                 f"    return {{{pgid}}}\n"
                 "pi_phase.live_groups = snapshot")
        start = time.monotonic()
        job, marker = self.patched_phase(patch, queue=".4")
        code, output = self.done(job)
        self.assertEqual(code, 75, output)
        self.assertIn("queue timeout", output)
        self.assertLess(time.monotonic() - start, 1.3)
        self.assertFalse(marker.exists())
        self.assertLessEqual(len(calls.read_text()), 2)

    def test_owner_changed_after_snapshot_cannot_claim_stale_negative(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        self.state.mkdir(exist_ok=True)
        owner = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(3)"],
                                 start_new_session=True, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        self.children.append(owner)
        slot = self.state / "heavy-0.json"
        slot.write_text(json.dumps({"pgid": 999999999, "token": "old"}))
        patch = ("import pathlib,json\n"
                 f"slot = pathlib.Path({str(slot)!r})\n"
                 "def snapshot(timeout):\n"
                 "    if json.loads(slot.read_text())['token'] == 'old':\n"
                 f"        slot.write_text(json.dumps({{'pgid': {owner.pid}, 'token': 'new'}}))\n"
                 "        return set()\n"
                 f"    return {{{owner.pid}}}\n"
                 "pi_phase.live_groups = snapshot")
        job, marker = self.patched_phase(patch, queue=".35")
        code, output = self.done(job)
        self.assertEqual(code, 75, output)
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(slot.read_text())["token"], "new")

    def test_cancel_during_orphan_probe_ends_without_command(self):
        pgid = self.orphan_slots()
        patch = ("import os,signal,time\n"
                 "def snapshot(timeout):\n"
                 "    os.kill(os.getpid(), signal.SIGTERM)\n"
                 "    time.sleep(min(timeout, .1))\n"
                 f"    return {{{pgid}}}\n"
                 "pi_phase.live_groups = snapshot")
        start = time.monotonic()
        job, marker = self.patched_phase(patch, queue="1")
        code, output = self.done(job)
        self.assertEqual(code, 143, output)
        self.assertIn("cancelled during admission", output)
        self.assertLess(time.monotonic() - start, 2.5)
        self.assertFalse(marker.exists())

    def test_queue_timeout_does_not_start_command(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        active = self.run_phase(command=self.marker_job("hold", .8))
        self.wait_for(lambda: (self.state / "heavy-0.json").exists())
        queued = self.run_phase(label="queued", queue=".25", command=self.marker_job("never"))
        code, out = self.done(queued)
        self.assertEqual(code, 75, out)
        self.assertIn("queue timeout", out)
        self.assertFalse((self.root / "never.json").exists())
        self.assertEqual(self.done(active)[0], 0)

    def test_timeout_and_term_resistant_descendant_cleanup(self):
        pidfile = self.root / "descendant-pid"
        script = ("import subprocess,sys,pathlib,time; "
                  "child=subprocess.Popen([sys.executable,'-c',"
                  "'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(10)']); "
                  "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(10)")
        job = self.run_phase(timeout="2", command=[sys.executable, "-c", script, str(pidfile)])
        self.wait_for(pidfile.exists, seconds=4)
        code, out = self.done(job)
        self.assertEqual(code, 124, out)
        self.assertIn("timed out", out)
        self.assertEqual(self.done(self.start("status"))[1].strip(),
                         "pi-phase: no active phases\npi-phase: fast=0/2 queued=0\npi-phase: high=0/3")
        # ps distinguishes a reparented zombie from a still-running descendant.
        pid = int(pidfile.read_text())
        info = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
        self.assertTrue(info.returncode != 0 or info.stdout.strip().startswith("Z"), info.stdout)

    def test_parent_exit_cleans_term_resistant_child(self):
        marker = self.root / "descendant-pid"
        child_script = ("import signal,time,pathlib,sys; "
                        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                        "pathlib.Path(sys.argv[1]).write_text(str(__import__('os').getpid())); time.sleep(10)")
        parent_script = ("import subprocess,sys,time,pathlib; "
                         "subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]]); "
                         "p=pathlib.Path(sys.argv[1]); "
                         "deadline=time.monotonic()+2; "
                         "\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.02)\n")
        job = self.run_phase(command=[sys.executable, "-c", parent_script, str(marker), child_script])
        code, out = self.done(job)
        self.assertEqual(code, 0, out)
        self.assertTrue(marker.exists())
        pid = int(marker.read_text())
        info = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
        self.assertTrue(info.returncode != 0 or info.stdout.strip().startswith("Z"), info.stdout)

    def test_cancel_stops_only_owned_group(self):
        marker = self.root / "started"
        script = ("import subprocess,sys,pathlib,time; "
                  "child=subprocess.Popen([sys.executable,'-c',"
                  "'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(10)']); "
                  "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(10)")
        job = self.run_phase(command=[sys.executable, "-c", script, str(marker)])
        self.wait_for(marker.exists)
        job.send_signal(signal.SIGTERM)
        code, out = self.done(job)
        self.assertEqual(code, 143, out)
        self.assertIn("cancelled", out)
        pid = int(marker.read_text())
        info = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
        self.assertTrue(info.returncode != 0 or info.stdout.strip().startswith("Z"), info.stdout)
        self.assertEqual(self.done(self.run_phase())[0], 0)

    def test_crashed_supervisor_keeps_orphan_group_guard(self):
        self.config.write_text('{"heavy_slots": 1, "integration_slots": 1}')
        marker = self.root / "orphan"
        # Direct producer exits, child closes inherited FDs and stays in group.
        script = ("import subprocess,sys,pathlib; "
                  "p=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGTERM, signal.SIG_IGN);time.sleep(2)'],close_fds=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
                  "pathlib.Path(sys.argv[1]).touch(); import time; time.sleep(.5)")
        job = self.run_phase(command=[sys.executable, "-c", script, str(marker)])
        self.wait_for(marker.exists)
        job.kill()  # Supervisor dies without releasing a lease or killing the group.
        job.communicate(timeout=3)
        orphan_status = self.done(self.start("status"))[1]
        self.assertIn("orphan-group", orphan_status, orphan_status)
        blocked = self.run_phase(queue=".25", command=self.marker_job("blocked"))
        code, out = self.done(blocked)
        self.assertEqual(code, 75, out)
        self.assertFalse((self.root / "blocked.json").exists())
        self.wait_for(lambda: self.done(self.start("status"))[1].strip() ==
                      "pi-phase: no active phases\npi-phase: fast=0/2 queued=0\npi-phase: high=0/3", seconds=4)
        self.assertEqual(self.done(self.run_phase())[0], 0)

    def test_ci_rejects_non_normal_priority_without_touching_grant(self):
        self.assertEqual(self.done(self.start("grant-priority"))[0], 0)
        grant = self.state / "priority-grant.json"
        before = grant.read_bytes()
        options = ("--repo", "org/repo", "--pr", "42", "--commit", "abc123")
        for priority in ("low", "high"):
            code, out = self.done(self.run_phase(kind="ci", extra=(*options, "--priority", priority)))
            self.assertEqual(code, 125, out)
            self.assertIn("ci does not queue; --priority must be normal", out)
            self.assertEqual(grant.read_bytes(), before)
            self.assertFalse((self.state / "waiters").exists())
        code, out = self.done(self.run_phase(kind="ci", extra=(*options, "--priority", "normal")))
        self.assertEqual(code, 0, out)
        self.assertEqual(grant.read_bytes(), before)

    def test_ci_duplicate_does_not_spawn_or_consume_build_slots(self):
        opts = ("--repo", "org/repo", "--pr", "42", "--commit", "abc123")
        marker = self.root / "watch"
        watcher = self.run_phase(kind="ci", label="watch", command=[sys.executable, "-c",
                               "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(1)",
                               str(marker)], extra=opts)
        self.wait_for(marker.exists)
        duplicate = self.run_phase(kind="ci", label="duplicate", command=self.marker_job("duplicate"), extra=opts)
        code, out = self.done(duplicate)
        self.assertEqual(code, 75, out)
        self.assertIn("already watching", out)
        self.assertFalse((self.root / "duplicate.json").exists())
        self.assertEqual(self.done(self.run_phase(kind="build"))[0], 0)
        self.assertEqual(self.done(watcher)[0], 0)

    def test_limits_and_vstest_preset_reject_unconfirmed(self):
        self.assertEqual(self.done(self.run_phase(timeout="601"))[0], 125)
        self.assertEqual(self.done(self.run_phase(timeout="nan"))[0], 125)
        self.assertEqual(self.done(self.run_phase(queue="inf", extra=("--approved-long-timeout",)))[0], 125)
        job = self.run_phase(extra=("--vstest-hang-minutes", "2"))
        self.assertEqual(self.done(job)[0], 125)


class DotnetShimTests(unittest.TestCase):
    """Compiler/node lifetime controls, independently of phase scheduling."""

    def setUp(self):
        self.owned = tempfile.TemporaryDirectory(prefix="dotnet-shim-test-", dir=AI_WORK)
        self.addCleanup(self.owned.cleanup)
        self.root = Path(self.owned.name)
        self.real = self.root / "real"
        self.real.mkdir()
        dotnet = self.real / "dotnet"
        dotnet.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
        dotnet.chmod(0o755)
        self.shim = self.root / "shim"
        self.shim.mkdir()
        self.env = pi_phase.shim_environment(self.shim, 3)
        self.env["PI_PHASE_ORIGINAL_PATH"] = str(self.real) + os.pathsep + os.environ["PATH"]
        self.env.pop("PI_PHASE_SHARED_COMPILATION", None)

    def invoke(self, *args, escape=False):
        env = dict(self.env)
        if escape:
            env["PI_PHASE_SHARED_COMPILATION"] = "1"
        result = subprocess.run([str(self.shim / "dotnet"), *args], env=env, cwd=self.root,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def test_build_subcommands_disable_shared_compilers_and_node_reuse(self):
        for command in ("build", "test", "publish", "pack", "msbuild", "restore"):
            with self.subTest(command=command):
                self.assertEqual(self.invoke(command, "a.csproj"),
                                 [command, "-m:3", "-p:UseSharedCompilation=false",
                                  "-nodeReuse:false", "a.csproj"])

    def test_explicit_cpu_cap_does_not_disable_lifetime_controls(self):
        self.assertEqual(self.invoke("build", "-m:1"),
                         ["build", "-p:UseSharedCompilation=false", "-nodeReuse:false", "-m:1"])

    def test_caller_property_overrides_in_all_msbuild_spellings(self):
        for arg in ("-p:UseSharedCompilation=true", "/P:USESHAREDCOMPILATION=false",
                    "--property:UseSharedCompilation=true", "-property:UseSharedCompilation=true",
                    "/property:Other=1;UseSharedCompilation=true", "--property:Other=1,UseSharedCompilation=true"):
            with self.subTest(arg=arg):
                self.assertEqual(self.invoke("build", arg), ["build", "-m:3", "-nodeReuse:false", arg])
        self.assertEqual(self.invoke("build", "--property", "UseSharedCompilation=true"),
                         ["build", "-m:3", "-nodeReuse:false", "--property", "UseSharedCompilation=true"])
        self.assertEqual(self.invoke("build", "-p:NotUseSharedCompilation=true"),
                         ["build", "-m:3", "-p:UseSharedCompilation=false", "-nodeReuse:false",
                          "-p:NotUseSharedCompilation=true"])
        self.assertEqual(self.invoke("build", "/P:UseSharedCompilation=true", "/NR:true"),
                         ["build", "-m:3", "/P:UseSharedCompilation=true", "/NR:true"])

    def test_caller_node_reuse_overrides(self):
        for arg in ("-nodeReuse:true", "/NODEREUSE:false", "--nodereuse:true", "-nr:true", "/NR:false", "-nr"):
            with self.subTest(arg=arg):
                self.assertEqual(self.invoke("build", arg), ["build", "-m:3", "-p:UseSharedCompilation=false", arg])

    def test_escape_hatch_leaves_cpu_cap_and_run_is_untouched(self):
        self.assertEqual(self.invoke("build", "a.csproj", escape=True), ["build", "-m:3", "a.csproj"])
        self.assertEqual(self.invoke("run", "--project", "a.csproj"), ["run", "--project", "a.csproj"])
        self.assertEqual(self.invoke("--info"), ["--info"])

    def test_non_msbuild_test_runners_are_untouched(self):
        self.assertEqual(self.invoke("test", "a.dll"), ["test", "a.dll"])
        (self.root / "global.json").write_text('{"test":{"runner":"Microsoft.Testing.Platform"}}')
        self.assertEqual(self.invoke("test", "a.csproj"), ["test", "a.csproj"])


if __name__ == "__main__":
    unittest.main()
