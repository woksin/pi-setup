"""Synthetic cleanup diagnostics only: no real producers, signals or ps calls."""
from contextlib import ExitStack, redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

import pi_phase

PID = 2147483647
SECRET = "ARGV_ENV_STDERR_SENTINEL"
COLUMNS = "pid=,ppid=,pgid=,uid=,stat="


class CleanupDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, PI_PHASE_WORKTREE_LOCK="0"))
        # Disabled worktree locking still resolves the git root; keep that probe out of observer counts.
        self.stack.enter_context(patch.object(pi_phase, "worktree_root", return_value=os.getcwd()))
        self.output = io.StringIO()
        self.stack.enter_context(redirect_stdout(self.output))
        # main's pre-existing final exception print is not a diagnostic write.
        self.stack.enter_context(redirect_stderr(io.StringIO()))
        self.ps = self.stack.enter_context(patch.object(pi_phase.subprocess, "run"))
        self.ps.return_value = SimpleNamespace(returncode=0, stdout=f"{PID} 1 {PID} 501 S\n", stderr=SECRET)
        self.producer = Mock(pid=PID, returncode=None)
        self.popen = self.stack.enter_context(patch.object(pi_phase.subprocess, "Popen", return_value=self.producer))
        self.denied = PermissionError(1, SECRET)
        self.killpg = self.stack.enter_context(patch.object(pi_phase.os, "killpg", side_effect=self.denied))
        self.kill = self.stack.enter_context(patch.object(pi_phase.os, "kill", side_effect=AssertionError("real kill")))
        self.handlers = self.stack.enter_context(patch.object(pi_phase.signal, "signal"))
        self.stack.enter_context(patch.object(pi_phase.time, "sleep"))
        self.waitid = self.stack.enter_context(patch.object(pi_phase.os, "waitid", create=True))
        for name, default in (("P_PID", 1), ("WEXITED", 4), ("WNOHANG", 1), ("WNOWAIT", 16777216),
                              ("CLD_EXITED", 1), ("CLD_KILLED", 2), ("CLD_DUMPED", 3)):
            self.stack.enter_context(patch.object(pi_phase.os, name, getattr(os, name, default), create=True))
        self.waitid.return_value = SimpleNamespace(si_code=os.CLD_EXITED, si_status=0)

    def diagnostic(self, observation=("waitid_wnowait", 0)):
        pi_phase.cleanup_snapshot(PID, signal.SIGTERM, observation)
        output = self.output.getvalue()
        self.assertNotIn(SECRET, output)
        self.assertLessEqual(len(output.encode()), 8192)
        return output

    def supervisor_observation(self, observation):
        if observation == "fallback":
            del pi_phase.os.waitid
            self.stack.enter_context(patch.object(pi_phase, "zombie_unreaped", return_value=True))
        if isinstance(observation, Exception):
            self.waitid.side_effect = observation
        if observation == "timeout":
            self.waitid.return_value = None
            self.stack.enter_context(patch.object(pi_phase.time, "monotonic", side_effect=range(0, 300, 3)))
        if observation == "cancel":
            def cancelled(*_):
                self.handlers.call_args_list[0].args[1](signal.SIGTERM, None)
                return None
            self.waitid.side_effect = cancelled

    def supervise(self, *, live=True, observation="waitid"):
        root = Path(__file__).resolve().parents[2] / ".ai-work"
        owned = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="cleanup-synthetic-", dir=root))
        state = Path(owned) / "state"
        configuration = Path(owned) / "config.json"
        configuration.write_text(json.dumps(dict(msbuild_max_cpu=0, phase_nice=0,
                                                 cold_worktree_hint=False, container_test_detection="off")))
        identity = pi_phase.work_identity(os.getcwd(), ["synthetic"], "test")
        self.ps.reset_mock()  # Exclude the mocked identity/git probe from snapshot counts.
        for name, value in (("PhaseLedger", None), ("work_identity", identity), ("test_fingerprint", "synthetic")):
            self.stack.enter_context(patch.object(pi_phase, name, return_value=value))
        self.stack.enter_context(patch.object(pi_phase.os, "write", return_value=1))
        self.stack.enter_context(patch.object(pi_phase, "group_liveness", return_value=live))
        self.stack.enter_context(patch.object(pi_phase, "group_alive", return_value=True))
        release = self.stack.enter_context(patch.object(pi_phase, "release", wraps=pi_phase.release))
        captured = []
        original = pi_phase.run

        def capture(*args, **kwargs):
            try:
                return original(*args, **kwargs)
            except Exception as exc:
                captured.append(exc)
                raise

        self.stack.enter_context(patch.object(pi_phase, "run", side_effect=capture))
        self.supervisor_observation(observation)
        result = pi_phase.main(["run", "--kind", "test", "--label", "diagnostic", "--policy", "direct",
                                "--timeout", "2", "--", "synthetic"], state=state, configuration=configuration)
        self.assertEqual(result, 125)
        expected = observation if isinstance(observation, Exception) else self.denied
        self.assertIs(captured[0], expected)
        self.producer.wait.assert_not_called()
        self.producer.poll.assert_not_called()
        self.producer.communicate.assert_not_called()
        self.assertFalse(release.call_args.args[-1])
        self.assertTrue(list(state.glob("direct-*.json")))
        self.assertEqual(self.handlers.call_count, 4)
        self.assertLessEqual(self.ps.call_count, 2)
        self.assertNotIn(SECRET, self.output.getvalue())
        return self.output.getvalue()

    def test_candidate_module_identity(self):
        self.assertEqual(Path(pi_phase.__file__).resolve(), Path(__file__).with_name("pi_phase.py").resolve())

    def test_known_non_z_leader_still_fails_closed(self):
        output = self.supervise()
        self.assertIn("leader_observation=waitid_wnowait producer_exit=0", output)
        self.assertIn(f"pid={PID} ppid=1 pgid={PID} uid=501 state=S", output)
        self.assertIn("wrapper exit=125", output)
        self.assertEqual(self.ps.call_count, 2)
        self.waitid.assert_called_once_with(os.P_PID, PID, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        self.assertEqual(self.killpg.call_args_list, [call(PID, signal.SIGTERM)] * 2)

    def test_live_child_with_different_uid_is_not_exited_leader(self):
        self.ps.return_value.stdout += f"42 {PID} {PID} 502 R\n"
        output = self.supervise()
        self.assertIn(f"pid=42 ppid={PID} pgid={PID} uid=502 state=R", output)
        self.assertIn("liveness=live", output)

    def test_waitid_failure_never_claims_exit(self):
        output = self.supervise(observation=OSError(5, SECRET))
        self.assertIn("leader_observation=unknown producer_exit=unknown", output)
        self.assertEqual(self.ps.call_count, 1)

    def test_timeout_never_claims_exit(self):
        output = self.supervise(observation="timeout")
        self.assertIn("leader_observation=unknown producer_exit=unknown", output)

    def test_cancel_never_claims_exit(self):
        output = self.supervise(observation="cancel")
        self.assertIn("leader_observation=unknown producer_exit=unknown", output)

    def test_ps_zombie_fallback_is_not_waitid_proof(self):
        output = self.supervise(observation="fallback")
        self.assertIn("leader_observation=ps_zombie producer_exit=unknown", output)
        self.assertNotIn("leader_observation=waitid_wnowait", output)

    def test_waitid_none_does_not_set_exit_status(self):
        self.waitid.return_value = None
        status = [None]
        self.assertFalse(pi_phase.exited_unreaped(PID, status))
        self.assertEqual(status, [None])

    def test_zombie_fallback_observation_without_waitid(self):
        del pi_phase.os.waitid
        self.ps.return_value.stdout = "Z+\n"
        status = [None]
        self.assertTrue(pi_phase.exited_unreaped(PID, status))
        self.assertEqual(status, [None])
        self.ps.assert_called_once_with(["ps", "-o", "stat=", "-p", str(PID)],
                                        capture_output=True, text=True, timeout=0.5)

    def test_unknown_liveness_still_fails_closed(self):
        self.assertIn("liveness=unknown", self.supervise(live=None))

    def test_zombie_empty_and_unrelated_groups_preserve_stop_success(self):
        for listing in (f"{PID} 1 {PID} 501 Z\n", "", "12 1 12 501 S\n"):
            with self.subTest(listing=listing), patch.object(pi_phase, "group_liveness", return_value=False):
                self.ps.return_value.stdout = listing
                self.ps.reset_mock()
                pi_phase.stop_group(PID)
                self.assertEqual(self.ps.call_count, 1)
        self.assertNotIn("cleanup_snapshot pid=12 ", self.output.getvalue())
        self.assertIn("leader_presence=absent_at_snapshot", self.output.getvalue())

    def test_observer_failures_are_explicit_and_sanitized(self):
        for failure, expected in ((subprocess.TimeoutExpired(SECRET, 1, output=SECRET, stderr=SECRET), "failure=timeout"),
                                  (PermissionError(1, SECRET), "failure=oserror errno=1"),
                                  (OSError(5, SECRET), "failure=oserror errno=5"),
                                  (ValueError(SECRET), "failure=observer_error")):
            with self.subTest(expected=expected):
                self.ps.side_effect = failure
                self.assertIn(expected, self.diagnostic())

    def test_nonzero_does_not_log_raw_stdout_or_stderr(self):
        self.ps.return_value = SimpleNamespace(returncode=7, stdout=SECRET, stderr=SECRET)
        self.assertIn("completeness=unknown failure=nonzero returncode=7", self.diagnostic())

    def test_malformed_fields_are_incomplete_not_absence(self):
        for line in (f"{PID} nope {PID} 501 S", f"{PID} 1 {PID} root S", f"{PID} 1 {PID} 501 {SECRET}",
                     f"{PID} 1 {PID} 501 S {SECRET}", f"99999999999 1 {PID} 501 S"):
            with self.subTest(line=line):
                self.ps.return_value.stdout = line
                output = self.diagnostic()
                self.assertIn("completeness=incomplete", output)
                self.assertIn("malformed=1", output)
                self.assertIn("leader_presence=unknown", output)

    def test_oversized_text_is_explicitly_unknown(self):
        self.ps.return_value.stdout = SECRET * 30000
        self.assertIn("completeness=oversized", self.diagnostic())
        self.assertNotIn("absent_at_snapshot", self.output.getvalue())

    def test_row_and_output_bounds(self):
        self.ps.return_value.stdout = "".join(f"{pid} 1 {PID} 4294967295 S\n" for pid in range(100))
        output = self.diagnostic()
        self.assertEqual(output.count("cleanup_snapshot pid="), 32)
        self.assertIn("completeness=incomplete matched=100 omitted=68", output)

    def test_observer_command_and_budget(self):
        self.diagnostic()
        self.ps.assert_called_once_with(["ps", "-A", "-o", COLUMNS], capture_output=True,
                                        text=True, timeout=1, check=False)

    def test_liveness_retry_schedule_is_unchanged(self):
        def observe(argv, **kwargs):
            if argv[-1] == COLUMNS:
                return SimpleNamespace(returncode=0, stdout="")
            raise subprocess.TimeoutExpired(SECRET, kwargs["timeout"])
        self.ps.side_effect = observe
        with self.assertRaises(PermissionError) as error:
            pi_phase.stop_group(PID)
        self.assertIs(error.exception, self.denied)
        self.assertEqual([entry.kwargs["timeout"] for entry in self.ps.call_args_list], [1, 2, 5, 10])

    def test_sigkill_denial_preserves_original_error(self):
        self.killpg.side_effect = [None, self.denied]
        with patch.object(pi_phase, "group_liveness", return_value=True), self.assertRaises(PermissionError) as error:
            pi_phase.stop_group(PID)
        self.assertIs(error.exception, self.denied)
        self.assertIn("signal=SIGKILL", self.output.getvalue())
        self.assertEqual(self.ps.call_count, 1)

    def test_observer_failure_does_not_replace_denial_or_skip_finalization(self):
        self.ps.side_effect = PermissionError(1, SECRET)
        self.supervise()

    def test_output_write_failure_preserves_primary_and_guard(self):
        original = self.output.write
        def write(text):
            if "cleanup_snapshot" in text:
                raise BrokenPipeError(32, SECRET)
            return original(text)
        self.stack.enter_context(patch.object(self.output, "write", side_effect=write))
        self.supervise()

    def test_output_flush_failure_preserves_primary_and_guard(self):
        def flush():
            if "cleanup_snapshot" in self.output.getvalue():
                raise BrokenPipeError(32, SECRET)
        self.stack.enter_context(patch.object(self.output, "flush", side_effect=flush))
        self.supervise()


if __name__ == "__main__":
    unittest.main()
