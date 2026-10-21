"""Synthetic bounded subprocess tests: no builds, network, Docker or CI."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
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

    def patched_phase(self, patch, *, queue="2"):
        marker = self.root / "must-not-run"
        command = [sys.executable, "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).touch()", str(marker)]
        entry = ("import sys; sys.path.insert(0, sys.argv[1]); import pi_phase\n"
                 + patch + "\nsys.exit(pi_phase.main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))")
        child = subprocess.Popen([sys.executable, "-B", "-c", entry, str(HERE), str(self.state),
                                  str(self.config), "run", "--kind", "test", "--label", "patched",
                                  "--timeout", "3", "--queue-timeout", queue, "--", *command],
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

    def waiter(self, label, priority="normal", kind="build"):
        self.state.mkdir(exist_ok=True)
        args = SimpleNamespace(priority=priority, kind=kind, label=label)
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

    def test_performance_config_defaults_and_auto(self):
        settings = pi_phase.config(self.config)
        self.assertEqual(settings, (2, 1))
        self.assertEqual(settings.options, dict(msbuild_max_cpu=0, container_test_detection="hint",
                                                cold_worktree_hint=True))
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
                         dict(msbuild_max_cpu="auto", container_test_detection="promote", cold_worktree_hint=False))

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
                expected = [*prefix, subcommand, "-m:3", "a b", "", "--no-build"]
                self.assertEqual(result.stdout.splitlines(), [f"<{arg}>" for arg in expected])
        cases = [["test", flag] for flag in ("-m", "-M:2", "/m", "/M:4", "-maxcpucount",
                 "-MaxCpuCount:8", "/MAXCPUCOUNT:2", "--maxcpucount=6")]
        cases += [[], ["--info"], ["run", "build"], ["app.dll"], ["--version"], ["TEST", "x"]]
        for args in cases:
            with self.subTest(args=args):
                result = subprocess.run([str(shim / "dotnet"), *args], env=env,
                                        capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = [f"<{arg}>" for arg in args] if args else ["<>"]
                self.assertEqual(result.stdout.splitlines(), expected)
        nested = self.root / "nested-shim"
        nested.mkdir()
        with patch.dict(os.environ, env):
            nested_env = pi_phase.shim_environment(nested, 2)
        result = subprocess.run([str(nested / "dotnet"), "build"], env=nested_env,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["<build>", "<-m:2>"])
        env["PI_PHASE_ORIGINAL_PATH"] = str(alias)
        result = subprocess.run([str(shim / "dotnet"), "build"], env=env,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 127, result.stderr)

    def test_shim_reaches_script_dotnet_and_is_phase_private(self):
        self.configure(msbuild_max_cpu=4, container_test_detection="off")
        self.executable(self.fake_bin / "dotnet", "#!/bin/sh\nprintf '<%s>\\n' \"$@\"\n")
        code, out = self.done(self.run_phase(kind="build", command=["sh", "-c", "dotnet build 'a b'"]))
        self.assertEqual(code, 0, out)
        self.assertIn("msbuild cap -m:4 (msbuild_max_cpu)", out)
        self.assertIn("<build>\n<-m:4>\n<a b>", out)
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
            job = self.run_phase(command=command)
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
                job, marker = self.patched_phase(setup + interleave)
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
        code, out = self.done(self.run_phase(extra=("--priority", "high")))
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
        job, marker = self.patched_phase("pi_phase.config = lambda path: (_ for _ in ()).throw(ValueError('broken config'))")
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
        self.assertEqual(self.done(self.start("status"))[1].strip(), "pi-phase: no active phases")

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
        self.assertEqual(self.done(self.start("status"))[1].strip(), "pi-phase: no active phases")

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
        self.assertEqual(self.done(self.start("status"))[1].strip(), "pi-phase: no active phases")
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
        self.wait_for(lambda: self.done(self.start("status"))[1].strip() == "pi-phase: no active phases", seconds=4)
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


if __name__ == "__main__":
    unittest.main()
