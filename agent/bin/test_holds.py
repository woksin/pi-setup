import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import hold_register as holds

BIN = Path(__file__).resolve().parent
NOW = 1_800_000_000.0


def hold_fixture(home):
    """An isolated home and configured lane root, with no real scheduler or roster."""
    root, agent = home / "workspace", home / "agent"
    inbox = root / "messages"
    inbox.mkdir(parents=True)
    base = agent / "holds"
    agent.mkdir()
    base.mkdir(mode=0o700)
    (base / "checks").mkdir(mode=0o700)
    config = {"coordinator": {"id": "LC"}, "messages": {"dir": "${root}/messages", "broadcast": "ALL"},
              "lanes": [{"id": "L7", "group": "TEAM"}]}
    (root / "lanes.json").write_text(json.dumps(config))
    check = base / "checks" / "server-upgraded"
    check.write_text('#!/bin/sh\nexit 1\n')
    check.chmod(0o700)
    return {"HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "LANES_DIR": str(root), "INBOX_DIR": str(inbox),
            "PYTHONDONTWRITEBYTECODE": "1"}


class Holds(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        self.env = hold_fixture(self.home)
        self.context = patch.dict(os.environ, self.env, clear=True)
        self.context.start()
        self.addCleanup(self.context.stop)
        self.register = holds.Register()
        self.check = self.register.base / "checks/server-upgraded"
        self.inbox = Path(self.env["INBOX_DIR"])

    def add(self, probe="server-upgraded"):
        return self.register.add("L7", "Publish disabled", probe, NOW, scheduler=lambda _: True)

    def fresh(self, *args, code=None, lane=False):
        env = dict(self.env)
        if not lane:
            for key in ("LANES_DIR", "INBOX_DIR"):
                del env[key]
        else:
            env["PI_ORCH_ID"] = "L9"
        cmd = [str(BIN / "holds")] if code is None else ["-c", "import hold_register as h; " + code]
        return subprocess.run([sys.executable, *cmd, *args], env=env, cwd=BIN, text=True, capture_output=True, timeout=10)

    def tick(self, age, expected=0):
        proc = self.fresh(code=f"raise SystemExit(h.sweep(h.Register(), clock=lambda: {NOW + age}))")
        self.assertEqual(proc.returncode, expected, proc.stderr)
        return proc

    def roster(self, **overrides):
        exe = self.home / ".local/bin/lanes"
        exe.parent.mkdir(parents=True, exist_ok=True)
        exe.write_text('''#!/bin/sh
[ "$1" = --dir ] && [ "$2" = "$HOME/workspace" ] && [ "$3 $4" = 'who --json' ] || exit 2
[ -f "$2/lanes.json" ] || exit 2
cat "$HOME/roster.json"
''')
        exe.chmod(0o700)
        row = dict(lane="L7", pid=os.getpid(), state="idle", identity="registered",
                   sessionId="session-l7", evidence=["heartbeat(fresh)"])
        heartbeat = self.home / f".pi/orch/heartbeats/p{os.getpid()}.json"
        heartbeat.parent.mkdir(parents=True, exist_ok=True)
        heartbeat.write_text(json.dumps(dict(id="L7", pid=os.getpid(), sessionId="session-l7")))
        (self.home / "roster.json").write_text(json.dumps({"rows": [row | overrides], "sources": {
            "status-files": {"status": "missing"}, "processes": {"status": "ok"}}}))

    def alerts(self, hold_id):
        return {p.name.removeprefix("HOLD-to-").replace(f"-hold-{hold_id}", "").removesuffix(".md")
                for p in self.inbox.glob(f"HOLD-to-*-hold-{hold_id}-*.md")}

    def test_empty_is_read_only_and_does_no_external_work(self):
        absent = holds.Register(self.register.base.with_name("absent"))
        with patch.object(holds, "run_bounded", side_effect=AssertionError("unexpected child")):
            for register in (absent, self.register):
                with self.subTest(register=register.base):
                    self.assertEqual(holds.sweep(register), 0)
                    self.assertEqual(register.active(), ([], False))
        self.assertFalse(absent.base.exists())
        self.assertFalse(self.register.records.exists())
        self.assertEqual(self.fresh("list").stdout, "")
        self.assertEqual(list(self.inbox.iterdir()), [])

    def test_disabled_scheduler_refuses_to_add_but_existing_hold_remains_accessible(self):
        with self.assertRaisesRegex(holds.HoldError, "--with holds"):
            self.register.add("L7", "Publish disabled", self.check.name, NOW, scheduler=lambda _: False)
        self.assertFalse(self.register.records.exists())
        hold_id = self.add()
        self.assertIn(hold_id, self.fresh("list").stdout)
        self.assertEqual(self.fresh("lift", hold_id).returncode, 0)
        self.assertEqual(self.fresh("list").stdout, "")

    def test_invalid_or_missing_routes_cannot_be_registered(self):
        for target in ("bad/id", "ALL", "TEAM", "L8"):
            with self.subTest(target=target), self.assertRaises(holds.HoldError):
                self.register.add(target, "Publish disabled", self.check.name, NOW, scheduler=lambda _: True)
        self.inbox.rmdir()
        with self.assertRaises(holds.HoldError):
            self.add()
        self.assertFalse(self.register.records.exists())

    def test_only_private_owned_regular_executables_in_checks_are_accepted(self):
        for name in ("../server-upgraded", "/bin/true", "true; id", "server upgraded", "missing"):
            with self.subTest(name=name), self.assertRaises(holds.HoldError):
                self.add(name)
        for mode in (0o600, 0o710, 0o720, 0o702, 0o4700):
            self.check.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(holds.HoldError):
                self.add()
        self.check.chmod(0o700)
        for parent in (self.check.parent, self.register.base, self.register.base.parent, self.home):
            original = parent.stat().st_mode & 0o777
            parent.chmod(0o770)
            try:
                with self.subTest(parent=parent), self.assertRaises(holds.HoldError):
                    self.add()
            finally:
                parent.chmod(original)
        self.check.unlink()
        for kind in ("symlink", "directory", "fifo"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    self.check.symlink_to("/bin/true")
                elif kind == "directory":
                    self.check.mkdir(mode=0o700)
                else:
                    os.mkfifo(self.check, 0o700)
                with self.assertRaises(holds.HoldError):
                    self.add()
                self.check.rmdir() if kind == "directory" else self.check.unlink()

    def test_revalidates_script_at_tick(self):
        hold_id = self.add()
        self.check.write_text('#!/bin/sh\nprintf "should not run" > executed\nexit 0\n')
        self.check.chmod(0o777)
        self.tick(0)
        self.assertFalse((self.check.parent / "executed").exists())
        self.assertEqual(self.register.read(hold_id)["result"], "unknown")

    def test_times_out_one_probe_without_starving_the_next(self):
        self.check.write_text('#!/bin/sh\nsleep 60 &\nwait\n')
        hold_id = self.add()
        second = self.check.with_name("second")
        second.write_text('#!/bin/sh\nexit 1\n')
        second.chmod(0o700)
        later = self.register.add("L7", "Deploy paused", second.name, NOW + 1, scheduler=lambda _: True)
        run_bounded = holds.run_bounded
        calls = []

        def run_probe(args, *, cwd, timeout):
            calls.append(args[0])
            if args[0] == self.check:
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_bounded(args, cwd=cwd, timeout=0.1)
                raise subprocess.TimeoutExpired(args, 0.1)
            # Keep the normal production budget for a fast probe on a busy host.
            code, output = run_bounded(args, cwd=cwd, timeout=timeout)
            self.assertEqual(code, 1)
            return code, output

        with patch.object(holds, "run_bounded", side_effect=run_probe):
            self.assertEqual(holds.sweep(self.register, clock=lambda: NOW + 2), 0)
        self.assertEqual(calls, [self.check, second])
        self.assertEqual(self.register.read(hold_id)["result"], "unknown")
        self.assertEqual(self.register.read(later)["result"], "not yet")

    def test_fresh_process_notifies_once_escalates_once_and_never_lifts(self):
        add = self.fresh(lane=True, code=f"print(h.Register().add('L7', 'Publish disabled', 'server-upgraded', {NOW}, lambda _: True))")
        self.assertEqual(add.returncode, 0, add.stderr)
        hold_id = add.stdout.strip()
        self.roster()
        self.tick(0)
        self.assertEqual(self.alerts(hold_id), set())
        self.assertEqual(self.register.read(hold_id)["result"], "not yet")
        self.check.write_text('#!/bin/sh\necho probe-output\necho error-output >&2\nexit 0\n')
        for age in (300, 600):
            tick = self.tick(age)
            self.assertEqual((tick.stdout, tick.stderr), ("", ""))
        self.assertEqual(self.alerts(hold_id), {"L7-ready"})
        message = next(self.inbox.glob("*.md")).read_text()
        self.assertIn(f"holds lift {hold_id}", message)
        self.assertIn("Publish disabled", message)
        self.assertNotIn("probe-output", message)
        self.assertIsNone(self.register.read(hold_id)["lifted_at"])
        # A missing workspace still has a captured inbox path (lane config removed).
        (Path(self.env["LANES_DIR"]) / "lanes.json").unlink()
        self.tick(900)
        self.tick(1200)
        self.assertEqual(self.alerts(hold_id), {"L7-ready", "LC-escalation"})
        self.assertEqual(self.fresh("lift", hold_id, lane=True).returncode, 0)
        lifted = self.register.read(hold_id)
        self.assertEqual(lifted["lifted_by"], "L9")
        self.assertEqual(self.fresh("lift", hold_id).returncode, 0)
        self.tick(holds.DAY)
        self.assertEqual(self.register.read(hold_id), lifted)
        self.assertEqual(self.alerts(hold_id), {"L7-ready", "LC-escalation"})

    def test_24h_boundary_and_combined_reasons_with_uncertain_or_retired_owner(self):
        hold_id = self.add()
        for ready, row, target in ((False, {"evidence": ["lanes.json", "registration"]}, "LC-age"),
                                   (True, {"state": "retired"}, "LC-ready-age")):
            with self.subTest(ready=ready):
                self.roster(**row)
                self.check.write_text(f'#!/bin/sh\nexit {0 if ready else 3}\n')
                if not ready:
                    self.tick(holds.DAY - 1)
                    self.assertEqual(self.alerts(hold_id), set())
                    self.assertEqual(self.register.read(hold_id)["result"], "unknown")
                self.tick(holds.DAY)
                self.tick(holds.DAY * 3)
                self.assertEqual(self.alerts(hold_id), {target})
                self.register.lift(hold_id, NOW + holds.DAY * 3)
                hold_id = self.add()

    def test_failed_delivery_is_retried(self):
        hold_id = self.add()
        self.check.write_text('#!/bin/sh\nexit 0\n')
        self.inbox.rmdir()
        self.tick(0, expected=2)
        self.assertEqual(self.register.read(hold_id)["delivered"], {})
        self.inbox.mkdir()
        self.tick(300)
        self.tick(600)
        self.assertEqual(self.alerts(hold_id), {"LC-ready"})

    def test_lift_wins_while_probe_or_roster_is_in_flight(self):
        for stage, outcome in (("check", "ready"), ("live_owner", True)):
            with self.subTest(stage=stage):
                hold_id = self.add()
                self.check.write_text('#!/bin/sh\nexit 0\n')
                entered, release = threading.Event(), threading.Event()

                def pause(*_):
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError("lift did not finish")
                    return outcome

                with patch.object(holds, stage, side_effect=pause), ThreadPoolExecutor() as pool:
                    work = pool.submit(holds.sweep, self.register, clock=lambda: NOW + 300)
                    try:
                        self.assertTrue(entered.wait(5))
                        lifted = self.fresh("lift", hold_id, lane=True)
                        self.assertEqual(lifted.returncode, 0, lifted.stderr)
                    finally:
                        release.set()
                    self.assertEqual(work.result(timeout=5), 0)
                self.assertEqual(self.alerts(hold_id), set())
                self.assertEqual(self.register.read(hold_id)["lifted_by"], "L9")

    def test_corrupt_record_is_not_reported_as_an_empty_register(self):
        hold_id = self.add()
        self.register.save({"id": hold_id})
        out = self.fresh("list")
        self.assertEqual(out.returncode, 2)
        self.assertIn("unavailable", out.stderr)
