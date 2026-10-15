"""Synthetic bounded subprocess tests: no builds, network, Docker or CI."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
AI_WORK = HERE.parent / ".ai-work"
ENTRY = "import sys; sys.path.insert(0, sys.argv[1]); from pi_phase import main; sys.exit(main(sys.argv[4:], state=sys.argv[2], configuration=sys.argv[3]))"


class PhaseTests(unittest.TestCase):
    def setUp(self):
        AI_WORK.mkdir(exist_ok=True)
        self.owned = tempfile.TemporaryDirectory(prefix="pi-phase-test-", dir=AI_WORK)
        self.addCleanup(self.owned.cleanup)
        self.root = Path(self.owned.name)
        self.state = self.root / "state"
        self.config = self.root / "config.json"
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
        self.assertTrue(any(sum(start <= instant < end for start, end in intervals) == 2
                            for instant in (start + .3 for start, _ in intervals)), intervals)
        self.assertLess(max(sum(start <= instant < end for start, end in intervals)
                            for instant in (start + .3 for start, _ in intervals)), 3)

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
