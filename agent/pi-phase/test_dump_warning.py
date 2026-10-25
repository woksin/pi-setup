"""Advisory dump checks, using sparse files and synthetic phases only."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
from itertools import product
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import pi_phase


AI_WORK = Path(__file__).resolve().parents[2] / ".ai-work"
DUMP_FLAGS = (
    ("--blame-hang", "--blame-hang-dump-type", "add --blame-hang-dump-type none"),
    ("--blame-crash", "--blame-crash-dump-type", "omit dump options"),
    ("--blame", "--blame-crash-dump-type", "omit dump options"),
    ("--hangdump", "--hangdump-type", "omit dump options"),
    ("--crashdump", "--crashdump-type", "omit dump options"),
)


class DumpFlagTests(unittest.TestCase):
    def warnings(self, command, diagnose_hang=False):
        output = io.StringIO()
        with redirect_stdout(output):
            pi_phase.warn_full_dumps(command, diagnose_hang)
        return output.getvalue()

    def test_missing_type_warns_without_changing_command(self):
        for (flag, dump_type, advice), diagnose in product(DUMP_FLAGS, (False, True)):
            with self.subTest(flag=flag, diagnose=diagnose):
                command = ["dotnet", "test", flag]
                original = command[:]
                output = self.warnings(command, diagnose)
                self.assertIn(f"{flag} without {dump_type} writes full dumps (GBs); {advice}", output)
                self.assertIn("--diagnose-hang", output)
                self.assertEqual(command, original)

    def test_explicit_full_is_case_insensitive_and_accepts_equals(self):
        cases = product(DUMP_FLAGS, ("full", "Full", "FULL"), (False, True))
        for (flag, dump_type, advice), value, diagnose in cases:
            for suffix in ([dump_type, value], [f"{dump_type}={value}"]):
                with self.subTest(flag=flag, suffix=suffix, diagnose=diagnose):
                    output = self.warnings(["dotnet", "test", flag, *suffix], diagnose)
                    self.assertEqual(output.count("pi-phase: warning:"), 1)
                    self.assertIn(advice, output)

    def test_mini_requires_diagnosis_but_none_is_silent(self):
        cases = product(DUMP_FLAGS, ("mini", "Mini", "none", "None"), (False, True))
        for (flag, dump_type, _), value, diagnose in cases:
            for suffix in ([dump_type, value], [f"{dump_type}={value}"]):
                with self.subTest(flag=flag, suffix=suffix, diagnose=diagnose):
                    output = self.warnings(["dotnet", "test", flag, *suffix], diagnose)
                    self.assertEqual(bool(output), value.lower() == "mini" and not diagnose)

    def test_mini_type_alone_warns_once_and_suggests_no_dump_or_diagnosis(self):
        output = self.warnings(["dotnet", "test", "--blame-crash-dump-type", "Mini"])
        self.assertEqual(output.count("pi-phase: warning:"), 1)
        self.assertIn("--diagnose-hang", output)
        output = self.warnings(["dotnet", "test", "--blame-hang-dump-type", "mini"])
        self.assertIn("--blame-hang-dump-type none", output)

    def test_full_type_alone_warns_once_for_shared_crash_type(self):
        output = self.warnings(["dotnet", "test", "--blame-crash-dump-type", "full"])
        self.assertEqual(output.count("pi-phase: warning:"), 1)

    def test_unrelated_and_similar_flags_do_not_warn(self):
        self.assertEqual(self.warnings(["dotnet", "test", "--blame-hang-timeout", "5m"]), "")
        self.assertEqual(self.warnings(["dotnet", "test", "--hangdump-type", "Mini"], True), "")

    def test_simple_shell_wrapper_is_inspected_without_execution(self):
        self.assertIn("--hangdump without", self.warnings(["sh", "-c", "dotnet test --hangdump"]))

    def test_shell_chains_warn_without_execution_or_mutation(self):
        for separator in ("&&", "||", ";", "|", "&", "\n"):
            for flag, _, _ in DUMP_FLAGS:
                with self.subTest(separator=separator, flag=flag):
                    command = ["sh", "-c", f"cd tests {separator} dotnet test {flag}"]
                    original = command[:]
                    with patch.object(pi_phase.subprocess, "Popen") as execute:
                        self.assertIn(f"{flag} without", self.warnings(command))
                    execute.assert_not_called()
                    self.assertEqual(command, original)

    def test_shell_chain_mini_requires_diagnosis_but_none_is_exempt(self):
        cases = product(DUMP_FLAGS, ("mini", "Mini", "none", "None"), (False, True))
        for (flag, dump_type, _), value, diagnose in cases:
            with self.subTest(flag=flag, value=value, diagnose=diagnose):
                script = f"cd tests && dotnet test {flag} {dump_type}={value}; echo done"
                output = self.warnings(["bash", "-c", script], diagnose)
                self.assertEqual(bool(output), value.lower() == "mini" and not diagnose)

    def test_dump_types_do_not_leak_between_shell_segments(self):
        cases = product(("&&", "||", ";", "|", "&", "\n"), DUMP_FLAGS, ("mini", "none", "full"))
        for separator, (flag, dump_type, _), value in cases:
            safe = f"dotnet test {flag} {dump_type} {value}"
            unsafe = f"dotnet test {flag}"
            for script in (f"{safe} {separator} {unsafe}", f"{unsafe} {separator} {safe}"):
                with self.subTest(script=script):
                    self.assertIn(f"{flag} without", self.warnings(["sh", "-c", script]))

    def test_wrapped_and_nested_shell_chains_are_inspected(self):
        command = ["env", "MODE=test", "nice", "-n", "5", "bash", "-c",
                   "cd tests && sh -c 'dotnet test --hangdump; echo done'"]
        self.assertIn("--hangdump without", self.warnings(command))

    def test_quoted_escaped_and_commented_separators_are_not_boundaries(self):
        for literal in ("'&&'", '";"', r"\&\&"):
            script = f"dotnet test --hangdump --filter {literal} --hangdump-type Mini"
            self.assertEqual(self.warnings(["sh", "-c", script], True), "")
            self.assertEqual(self.warnings(["sh", "-c", script]).count("pi-phase: warning:"), 1)
        self.assertEqual(self.warnings(["sh", "-c", "echo ok # ; --hangdump\necho done"]), "")

    def test_shell_continuations_preserve_dump_flags_and_chains(self):
        continuation = "\\\n"
        for prefix in ("", "cd tests && "):
            for flag, _, _ in DUMP_FLAGS:
                with self.subTest(prefix=prefix, flag=flag):
                    script = f"{prefix}dotnet test {flag} {continuation} --logger trx"
                    self.assertIn(f"{flag} without", self.warnings(["sh", "-c", script]))
                    script += f" && dotnet test --hangdump-type {continuation} Mini"
                    self.assertIn(f"{flag} without", self.warnings(["sh", "-c", script]))

    def test_shell_continued_mini_and_none_are_exempt_when_diagnosing(self):
        continuation = "\\\n"
        for (flag, dump_type, _), value in product(DUMP_FLAGS, ("mini", "none")):
            for prefix in ("", "cd tests && "):
                with self.subTest(flag=flag, value=value, prefix=prefix):
                    script = f"{prefix}dotnet test {flag} {continuation} {dump_type} {continuation} {value}"
                    self.assertEqual(self.warnings(["sh", "-c", script], True), "")

    def test_shell_continuations_respect_quote_context(self):
        continuation = "\\\n"
        script = f'dotnet test --blame-{continuation}hang --logger "t{continuation}rx"'
        self.assertEqual(list(pi_phase.dump_shell_segments(script)),
                         [["dotnet", "test", "--blame-hang", "--logger", "trx"]])
        self.assertIn("--blame-hang without", self.warnings(["sh", "-c", script]))
        script = f"dotnet test '--blame-{continuation}hang'"
        self.assertEqual(list(pi_phase.dump_shell_segments(script)),
                         [["dotnet", "test", f"--blame-{continuation}hang"]])
        self.assertEqual(self.warnings(["sh", "-c", script]), "")

    def test_shell_full_type_warns(self):
        output = self.warnings(["sh", "-c", "cd tests && dotnet test --hangdump-type FULL"])
        self.assertIn("--hangdump-type full writes full dumps", output)

    def test_warning_output_failure_is_ignored(self):
        with patch.object(pi_phase, "note", side_effect=BrokenPipeError):
            pi_phase.warn_full_dumps(["dotnet", "test", "--hangdump"])


class DumpInjectionTests(unittest.TestCase):
    def prepare(self, command, diagnose_hang=False):
        output, errors = io.StringIO(), io.StringIO()
        original = command[:]
        with redirect_stdout(output), redirect_stderr(errors):
            prepared = pi_phase.prepare_dump_command(command, diagnose_hang)
        self.assertEqual(command, original)
        return prepared, output.getvalue(), errors.getvalue()

    def test_vstest_missing_type_injects_none_with_one_stderr_line(self):
        for suffix in (["--blame-hang"], ["--blame-hang-timeout", "5m"], ["--blame-hang-timeout=5m"]):
            with self.subTest(suffix=suffix):
                command = ["dotnet", "test", *suffix]
                prepared, warnings, errors = self.prepare(command)
                self.assertEqual(prepared, command + ["--blame-hang-dump-type", "none"])
                self.assertEqual(warnings, "")
                self.assertEqual(errors, "pi-phase: injected --blame-hang-dump-type none "
                                 "(no dump type given; pass --diagnose-hang or an explicit type to keep a dump)\n")

    def test_explicit_types_are_never_changed(self):
        for flag, dump_type in (("--blame-hang", "--blame-hang-dump-type"), ("--hangdump", "--hangdump-type")):
            for value in ("mini", "Mini", "full", "none", "custom"):
                for suffix in ([dump_type, value], [f"{dump_type}={value}"]):
                    with self.subTest(flag=flag, suffix=suffix):
                        command = ["dotnet", "test", flag, *suffix]
                        prepared, warnings, errors = self.prepare(command)
                        self.assertEqual(prepared, command)
                        self.assertEqual(bool(warnings), value.lower() in ("mini", "full"))
                        self.assertEqual(errors, "")

    def test_diagnosis_disables_injection_but_keeps_full_and_missing_type_warnings(self):
        for flag, dump_type in (("--blame-hang", "--blame-hang-dump-type"), ("--hangdump", "--hangdump-type")):
            for suffix in ([], [dump_type, "full"], [dump_type, "Mini"]):
                with self.subTest(flag=flag, suffix=suffix):
                    command = ["dotnet", "test", flag, *suffix]
                    prepared, warnings, errors = self.prepare(command, True)
                    self.assertEqual(prepared, command)
                    self.assertEqual(bool(warnings), suffix != [dump_type, "Mini"])
                    self.assertEqual(errors, "")

    def test_mtp_missing_type_injects_smallest_dump_without_double_warning(self):
        command = ["dotnet", "test", "--hangdump"]
        prepared, warnings, errors = self.prepare(command)
        self.assertEqual(prepared, command + ["--hangdump-type", "Mini"])
        self.assertEqual(warnings, "")
        self.assertEqual(len(errors.splitlines()), 1)
        self.assertIn("injected --hangdump-type Mini", errors)

    def test_shell_strings_are_warning_only_even_through_wrappers(self):
        for shell in ("bash", "sh"):
            for prefix in ([], ["env", "MODE=test", "nice", "-n", "5"]):
                with self.subTest(shell=shell, prefix=prefix):
                    command = [*prefix, shell, "-c", "cd tests && dotnet test --hangdump"]
                    prepared, warnings, errors = self.prepare(command)
                    self.assertEqual(prepared, command)
                    self.assertIn("--hangdump without", warnings)
                    self.assertEqual(errors, "")

    def test_direct_env_and_nice_wrappers_allow_injection(self):
        command = ["env", "MODE=test", "nice", "-n", "5", "dotnet", "test", "--blame-hang"]
        prepared, warnings, errors = self.prepare(command)
        self.assertEqual(prepared, command + ["--blame-hang-dump-type", "none"])
        self.assertEqual(warnings, "")
        self.assertEqual(len(errors.splitlines()), 1)

    def test_injection_keeps_unrelated_explicit_full_warning(self):
        command = ["dotnet", "test", "--hangdump", "--blame-crash-dump-type", "Full"]
        _, warnings, errors = self.prepare(command)
        self.assertEqual(warnings.count("pi-phase: warning:"), 1)
        self.assertIn("--blame-crash-dump-type full", warnings)
        self.assertEqual(len(errors.splitlines()), 1)

    def test_both_runners_get_defaults_in_a_single_stderr_line(self):
        command = ["dotnet", "test", "--blame-hang", "--hangdump"]
        prepared, warnings, errors = self.prepare(command)
        self.assertEqual(prepared, command + ["--blame-hang-dump-type", "none", "--hangdump-type", "Mini"])
        self.assertEqual(warnings, "")
        self.assertEqual(len(errors.splitlines()), 1)

    def test_unrelated_command_is_unchanged(self):
        command = ["dotnet", "test", "--filter", "SomeTest"]
        self.assertEqual(self.prepare(command), (command, "", ""))


class DumpWorkspace(unittest.TestCase):
    def setUp(self):
        AI_WORK.mkdir(exist_ok=True)
        workspace = tempfile.TemporaryDirectory(prefix="dump-warning-", dir=AI_WORK)
        self.addCleanup(workspace.cleanup)
        self.root = Path(workspace.name)

    def dump(self, name, size=1 << 30):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as stream:
            stream.truncate(size)  # Sparse: no real GB allocation.
        return path

    def scan_output(self):
        output = io.StringIO()
        with redirect_stdout(output):
            pi_phase.warn_large_dumps(self.root)
        return output.getvalue()


class DumpScanTests(DumpWorkspace):
    def test_sparse_dump_at_threshold_warns_and_is_not_deleted(self):
        path = self.dump("TestResults/hang.dmp")
        output = self.scan_output()
        self.assertIn("pi-phase: warning: dump file(s) over 1 GiB left behind: "
                      "TestResults/hang.dmp (1.00 GiB)", output)
        self.assertIn("delete them once you have the stack (dotnet-dump analyze → clrstack -all)", output)
        self.assertEqual(path.stat().st_size, 1 << 30)

    def test_empty_small_and_other_extensions_do_not_warn(self):
        self.assertEqual(self.scan_output(), "")
        self.dump("small.dmp", (1 << 30) - 1)
        self.dump("not-a-dump.txt")
        self.assertEqual(self.scan_output(), "")

    def test_excluded_directories_and_symlinks_are_not_followed(self):
        for name in ("node_modules", ".git", "obj", "bin"):
            self.dump(f"{name}/large.dmp")
        (self.root / "link.dmp").symlink_to(self.root / "bin/large.dmp")
        (self.root / "linked").symlink_to(self.root / "bin", target_is_directory=True)
        self.assertEqual(self.scan_output(), "")

    def test_depth_six_is_included_but_seven_is_not(self):
        self.dump("a/b/c/d/e/f/deep.dmp")
        self.assertEqual(self.scan_output(), "")
        self.dump("a/b/c/d/e/edge.dmp")
        output = self.scan_output()
        self.assertIn("a/b/c/d/e/edge.dmp", output)
        self.assertNotIn("deep.dmp", output)

    def test_at_most_five_dumps_are_listed(self):
        for index in range(8):
            self.dump(f"{index}.dmp")
        self.assertEqual(self.scan_output().count("(1.00 GiB)"), 5)

    def test_entry_budget_stops_at_twenty_thousand(self):
        entry = Mock(name="entry")
        entry.name = "ordinary.txt"
        entry.is_dir.return_value = False
        entries = Mock()
        entries.__enter__ = Mock(return_value=iter([entry] * 20001))
        entries.__exit__ = Mock(return_value=False)
        with patch.object(pi_phase.os, "scandir", return_value=entries):
            self.assertEqual(list(pi_phase.large_dump_files(self.root, time.monotonic() + 2)), [])
        self.assertEqual(entry.is_dir.call_count, 20000)

    def test_deadline_prevents_starting_another_directory(self):
        with patch.object(pi_phase.time, "monotonic", return_value=2), \
                patch.object(pi_phase.os, "scandir") as scan:
            self.assertEqual(list(pi_phase.large_dump_files(self.root, 2)), [])
        scan.assert_not_called()

    def test_deadline_stops_mid_directory(self):
        entry = Mock(name="entry")
        entry.name = "ordinary.txt"
        entry.is_dir.return_value = False
        entries = Mock()
        entries.__enter__ = Mock(return_value=iter([entry] * 3))
        entries.__exit__ = Mock(return_value=False)
        with patch.object(pi_phase.time, "monotonic", side_effect=[0, 0, 2]), \
                patch.object(pi_phase.os, "scandir", return_value=entries):
            self.assertEqual(list(pi_phase.large_dump_files(self.root, 2)), [])
        self.assertEqual(entry.is_dir.call_count, 1)

    def test_stalled_filesystem_does_not_delay_completion_past_budget(self):
        release = threading.Event()
        finished = threading.Event()

        def stalled_scan(*_):
            try:
                release.wait(5)
                return []
            finally:
                finished.set()

        started = time.monotonic()
        try:
            with patch.object(pi_phase, "large_dump_files", side_effect=stalled_scan):
                self.assertEqual(self.scan_output(), "")
            self.assertLess(time.monotonic() - started, 2.5)
        finally:
            release.set()
            self.assertTrue(finished.wait(1))

    def test_scan_and_output_errors_are_ignored(self):
        with patch.object(pi_phase.os, "scandir", side_effect=PermissionError):
            self.assertEqual(self.scan_output(), "")
        self.dump("large.dmp")
        with patch.object(pi_phase, "note", side_effect=BrokenPipeError):
            pi_phase.warn_large_dumps(self.root)

    def test_unreadable_entry_does_not_hide_other_dumps(self):
        broken = Mock(name="broken")
        broken.name = "gone.dmp"
        broken.is_dir.side_effect = FileNotFoundError
        broken.is_file.side_effect = FileNotFoundError
        self.dump("visible.dmp")
        with os.scandir(self.root) as real_entries:
            entries = Mock()
            entries.__enter__ = Mock(return_value=iter([broken, *real_entries]))
            entries.__exit__ = Mock(return_value=False)
            with patch.object(pi_phase.os, "scandir", return_value=entries):
                self.assertIn("visible.dmp", self.scan_output())


class DumpPhaseTests(DumpWorkspace):
    def setUp(self):
        super().setUp()
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps(dict(heavy_slots=1, integration_slots=1,
                                              container_test_detection="off", cold_worktree_hint=False,
                                              msbuild_max_cpu=0, phase_nice=0)))
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def phase(self, kind, command, extra=()):
        output, self.errors = io.StringIO(), io.StringIO()
        with patch.object(pi_phase, "PhaseLedger", return_value=None), redirect_stdout(output), redirect_stderr(self.errors):
            result = pi_phase.main(["run", "--kind", kind, "--label", "dump case", "--timeout", "4",
                                    "--queue-timeout", "4", "--policy", "direct", *extra, "--", *command],
                                   state=self.root / "state", configuration=self.config)
        return result, output.getvalue()

    def test_injection_preserves_success_failure_and_leftover_warnings(self):
        self.dump("leftover.dmp")
        for kind in ("test", "integration"):
            for code in (0, 7):
                with self.subTest(kind=kind, code=code):
                    command = [sys.executable, "-c", f"import sys; sys.exit({code})", "--hangdump"]
                    original = command[:]
                    result, output = self.phase(kind, command)
                    self.assertEqual(result, code)
                    self.assertNotIn("--hangdump without", output)
                    self.assertIn("injected --hangdump-type Mini", self.errors.getvalue())
                    self.assertEqual(len(self.errors.getvalue().splitlines()), 1)
                    self.assertIn("leftover.dmp (1.00 GiB)", output)
                    self.assertLess(output.index("finished kind="), output.index("leftover.dmp"))
                    self.assertEqual(command, original)

    def test_diagnose_hang_flag_silences_mini_but_not_full(self):
        for value, diagnose in product(("mini", "full"), (False, True)):
            with self.subTest(value=value, diagnose=diagnose):
                command = [sys.executable, "-c", "pass", "--blame-hang-dump-type", value]
                result, output = self.phase("test", command, ["--diagnose-hang"] if diagnose else [])
                self.assertEqual(result, 0)
                self.assertEqual("pi-phase: warning:" in output, value == "full" or not diagnose)

    def test_build_does_not_run_either_check(self):
        with patch.object(pi_phase, "warn_full_dumps") as before, \
                patch.object(pi_phase, "warn_large_dumps") as after:
            result, _ = self.phase("build", [sys.executable, "-c", "pass", "--hangdump"])
        self.assertEqual(result, 0)
        before.assert_not_called()
        after.assert_not_called()

    def test_preset_checks_user_command_before_injecting_no_dump_flags(self):
        executable = self.root / "dotnet"
        arguments = self.root / "arguments"
        executable.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shlex.quote(str(arguments)) + "\nexit 7\n")
        executable.chmod(0o700)
        extra = ["--vstest-confirmed", "--vstest-hang-minutes", "1"]
        inspected = []
        original_warning = pi_phase.warn_full_dumps

        def inspect(command, diagnose_hang=False, ignored_types=()):
            inspected.append(command[:])
            original_warning(command, diagnose_hang, ignored_types)

        with patch.object(pi_phase, "warn_full_dumps", side_effect=inspect):
            result, output = self.phase("test", [str(executable), "test"], extra)
        self.assertEqual(result, 7)
        self.assertNotIn("pi-phase: warning:", output)
        self.assertIn("--blame-hang-dump-type\nnone", arguments.read_text())
        self.assertEqual(inspected, [[str(executable), "test"]])
        self.assertEqual(self.errors.getvalue(), "")
        result, output = self.phase("test", [str(executable), "test", "--blame-hang"], extra)
        self.assertEqual(result, 7)
        self.assertNotIn("pi-phase: warning:", output)
        self.assertIn("injected --blame-hang-dump-type none", self.errors.getvalue())

    def test_executed_argv_and_ledger_hash_include_injection_but_fingerprint_does_not(self):
        for flag, dump_type, value in (("--blame-hang", "--blame-hang-dump-type", "none"),
                                      ("--hangdump", "--hangdump-type", "Mini")):
            with self.subTest(flag=flag):
                arguments = self.root / "arguments.json"
                script = f"import json, sys; open({str(arguments)!r}, 'w').write(json.dumps(sys.argv[1:]))"
                command = [sys.executable, "-c", script, flag]
                state = self.root / flag
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    result = pi_phase.main(["run", "--kind", "test", "--policy", "direct", "--rerun",
                                            "--label", "argv", "--timeout", "4", "--", *command],
                                           state=state, configuration=self.config)
                self.assertEqual(result, 0)
                self.assertEqual(json.loads(arguments.read_text()), [flag, dump_type, value])
                records, skipped = pi_phase.read_ledger(state)
                self.assertEqual(skipped, 0)
                self.assertEqual(len(records), 1)
                executed = command + [dump_type, value]
                expected_hash = hashlib.sha256(os.fsencode("\0".join(executed))).hexdigest()
                self.assertEqual(records[0]["argvHash"], expected_hash)
                self.assertEqual(records[0]["fingerprint"], pi_phase.test_fingerprint(str(self.root), command))


if __name__ == "__main__":
    unittest.main()
