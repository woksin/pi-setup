"""Non-reaping supervision on Python builds without os.waitid."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import pi_phase


class WaitidFallbackTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2] / ".ai-work"
        root.mkdir(exist_ok=True)
        owned = tempfile.TemporaryDirectory(prefix="waitid-fallback-", dir=root)
        self.addCleanup(owned.cleanup)
        self.root = Path(owned.name)

    def hide_waitid(self):
        # Works both when waitid exists and on macOS Python 3.9 where it doesn't.
        saved = patch.dict(os.__dict__)
        saved.start()
        self.addCleanup(saved.stop)
        os.__dict__.pop("waitid", None)

    def child(self, source):
        proc = subprocess.Popen([sys.executable, "-c", source])
        self.addCleanup(self.finish_child, proc)
        return proc

    @staticmethod
    def finish_child(proc):
        if proc.returncode is None:
            proc.kill()
            proc.wait(timeout=5)

    def test_exited_child_remains_unreaped_and_exit_status_unknown(self):
        self.hide_waitid()
        proc = self.child("raise SystemExit(9)")
        producer_exit = [None]
        deadline = time.monotonic() + 10
        while not pi_phase.exited_unreaped(proc.pid, producer_exit):
            self.assertLess(time.monotonic(), deadline, "child exit not detected")
            time.sleep(0.02)
        self.assertIsNone(producer_exit[0])
        # WNOHANG returns this PID only if our observation left it a zombie.
        pid, status = os.waitpid(proc.pid, os.WNOHANG)
        self.assertEqual(pid, proc.pid)
        self.assertTrue(os.WIFEXITED(status))
        self.assertEqual(os.WEXITSTATUS(status), 9)
        proc.returncode = 9

    def test_running_child_is_not_exited(self):
        self.hide_waitid()
        proc = self.child("import time; time.sleep(60)")
        producer_exit = [None]
        self.assertFalse(pi_phase.exited_unreaped(proc.pid, producer_exit))
        self.assertIsNone(producer_exit[0])
        self.assertEqual(os.waitpid(proc.pid, os.WNOHANG), (0, 0))

    def test_probe_failure_is_not_an_exit(self):
        self.hide_waitid()
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("ps", 0.5)):
            with self.subTest(error=type(error).__name__), patch.object(pi_phase.subprocess, "run", side_effect=error):
                producer_exit = [None]
                self.assertFalse(pi_phase.exited_unreaped(123, producer_exit))
                self.assertIsNone(producer_exit[0])

    def test_real_exit_codes_reach_main_and_ledger(self):
        self.hide_waitid()
        config = self.root / "config.json"
        config.write_text(json.dumps(dict(msbuild_max_cpu=0, phase_nice=0,
                                          cold_worktree_hint=False, container_test_detection="off")))
        cases = [("raise SystemExit(9)", 9, "failed"),
                 ("import os, signal; os.kill(os.getpid(), signal.SIGTERM)",
                  128 + signal.SIGTERM, "cancelled")]
        for index, (source, expected, outcome) in enumerate(cases):
            with self.subTest(expected=expected):
                state = self.root / str(index)
                code = pi_phase.main(["run", "--kind", "test", "--policy", "direct",
                                      "--label", "waitid fallback", "--timeout", "30", "--",
                                      sys.executable, "-c", source],
                                     state=state, configuration=config)
                self.assertEqual(code, expected)
                records = [json.loads(line) for path in (state / "ledger").glob("*.jsonl")
                           for line in path.read_text().splitlines()]
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0]["exit"], expected)
                self.assertEqual(records[0]["outcome"], outcome)


if __name__ == "__main__":
    unittest.main()
