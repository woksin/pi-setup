"""Passive failure diagnostics: bounded logs, stable phase results and legacy readers."""
import argparse
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pi_phase


FIXTURES = Path(__file__).parent / "testdata" / "failure-logs"


class FailureCategoryTests(unittest.TestCase):
    def classify(self, text, code=1, outcome="failed", expect_red=False):
        return pi_phase.classify_failure(text.encode(), code, outcome, expect_red)

    def test_synthetic_fixtures(self):
        cases = {
            "msbuild-CS.log": ("compile", ["CS1002"], None),
            "analyzer-IDE-CA.log": ("analyzer", ["IDE0005", "CA1822"], None),
            "NU1101.log": ("restore", None, None),
            "MSB3027.log": ("infrastructure", None, None),
            "MSB4166.log": ("infrastructure", None, None),
            "vstest.log": ("assertion", None, 3),
            "mtp.log": ("assertion", None, 2),
            "vitest.log": ("assertion", None, 2),
            "noise.log": ("unknown", None, None),
        }
        for name, (category, codes, count) in cases.items():
            with self.subTest(name=name):
                tail = (FIXTURES / name).read_bytes()
                self.assertLess(len(tail), 4096)
                result = pi_phase.classify_failure(tail, 1, "failed", False)
                self.assertEqual(result["category"], category)
                self.assertEqual(result.get("codes"), codes)
                self.assertEqual(result.get("failedTests"), count)
        hang = (FIXTURES / "blame-hang.log").read_bytes()
        self.assertEqual(pi_phase.classify_failure(hang, 124, "timeout", True)["detail"], "hang")

    def test_rule_precedence_and_exit_only_classification(self):
        text = "error NU1101: missing\nerror CS1002: compile\nFailed: 3\n"
        for code, outcome, red, category, detail in (
            (76, "timeout", True, "timeout", None),
            (76, "failed", True, "infrastructure", "rss-cap"),
            (137, "failed", True, "infrastructure", "killed"),
            (143, "failed", True, "infrastructure", "killed"),
            (1, "failed", True, "expected-red", None),
            (1, "failed", False, "restore", None),
        ):
            with self.subTest(code=code, outcome=outcome, red=red):
                result = self.classify(text, code, outcome, red)
                self.assertEqual(result["category"], category)
                self.assertEqual(result.get("detail"), detail)
        self.assertEqual(self.classify("", 1), {"category": "unknown"})
        self.assertEqual(self.classify("", 124, "timeout"), {"category": "timeout"})

    def test_restore_and_infrastructure_patterns(self):
        for text in ("NETSDK1004: assets missing", "Unable to load the service index"):
            self.assertEqual(self.classify(text)["category"], "restore")
        for text in ("MSB3021", "MSB3026", "MSB4018", "No space left on device",
                     "Cannot connect to the Docker daemon", "address already in use",
                     "OutOfMemoryException", "Test host process crashed"):
            with self.subTest(text=text):
                self.assertEqual(self.classify(text)["category"], "infrastructure")
        self.assertEqual(self.classify("Test host process crashed\nFailed: 3")["category"], "assertion")
        self.assertEqual(self.classify("error CS1002: x\nMSB4166")["category"], "infrastructure")

    def test_compile_prefixes_and_bounded_unique_codes(self):
        for prefix in ("CS", "BC", "FS", "RZ", "TS", "MSB"):
            self.assertEqual(self.classify(f"error {prefix}1234: x")["category"], "compile")
        for prefix in ("CA", "IDE", "SA", "xUnit", "Custom"):
            self.assertEqual(self.classify(f"error {prefix}1234: x")["category"], "analyzer")
        text = "\n".join(f"error CA{n:04}: x" for n in range(8))
        result = self.classify(text + "\nerror CS1002: x\nerror CA0000: x")
        self.assertEqual(result["category"], "compile")
        self.assertEqual(result["codes"], [f"CA{n:04}" for n in range(5)])
        self.assertTrue(all(len(code) <= 12 for code in result["codes"]))

    def test_summaries_and_zero_failure_noise(self):
        for text in ("Tests: 2 failed, 4 passed, 6 total", "  2 failing", "Failed: 2"):
            self.assertEqual(self.classify(text)["failedTests"], 2)
        for text in ("Failed! - Failed: 0", "Tests  0 failed", "0 failing", "error CS1002 missing colon"):
            self.assertEqual(self.classify(text)["category"], "unknown")

    def test_offset_is_first_matched_line_in_bytes_not_characters(self):
        prefix = "noise é\n".encode()
        result = pi_phase.classify_failure(prefix + b"file: error CS1002: x\nerror CS1002: again\n", 1, "failed", False)
        self.assertEqual(result["offset"], len(prefix))
        self.assertEqual(result["codes"], ["CS1002"])
        second = self.classify("noise\nerror CS1002: x")
        self.assertEqual(second["offset"], 6)


class LedgerDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2] / ".ai-work"
        root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="pi-phase-failure-", dir=root)
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.ledger = pi_phase.PhaseLedger(argparse.Namespace(
            kind="test", label="diagnostic", priority="normal", command=["true"]))
        self.log = self.state / "phase.log"

    def test_bounded_tail_and_absolute_offset(self):
        prefix = b"x" * (300 * 1024) + b"\n"
        self.log.write_bytes(prefix + b"noise\xff\nerror CS1002: x\n")
        self.ledger.record_failure(str(self.log), 1, False)
        failure = self.ledger.record["failure"]
        self.assertEqual(failure["offset"], len(prefix) + 7)
        self.assertEqual(failure["log"], str(self.log))
        self.assertEqual(failure["category"], "compile")

    def test_one_bounded_read_after_seek(self):
        stream = io.BytesIO(b"x" * (300 * 1024))
        with patch("builtins.open") as opened:
            opened.return_value.__enter__.return_value = stream
            with patch.object(stream, "read", wraps=stream.read) as read:
                self.ledger.record_failure("phase.log", 1, False)
                read.assert_called_once_with(256 * 1024)

    def test_success_disabled_and_broken_diagnostics_do_not_read_or_escape(self):
        with patch("builtins.open", side_effect=RuntimeError("broken log")) as opened:
            self.ledger.record_failure("phase.log", 0, False)
            opened.assert_not_called()
            self.ledger.failure_categories = False
            self.ledger.record_failure("phase.log", 1, False)
            opened.assert_not_called()
            self.ledger.failure_categories = True
            self.ledger.record_failure("phase.log", 1, False)
        self.assertNotIn("failure", self.ledger.record)
        self.ledger.record_failure(None, 76, False)
        self.assertEqual(self.ledger.record["failure"], {"category": "infrastructure", "detail": "rss-cap"})

    def test_host_snapshot_and_peak_rss_without_cap(self):
        with patch.object(pi_phase.os, "getloadavg", return_value=(12.34, 0, 0)):
            self.ledger.start()
        self.assertEqual(self.ledger.record["host"], {"load1": 12.3})
        memory = pi_phase.RunningMemory(0, 0, False)
        with patch.object(pi_phase, "sample_tree", side_effect=[
                [(1, 100.8, "a"), (2, 200.5, "b")], [(1, 250.9, "a")]]):
            self.assertIsNone(memory.offender(1))
            self.assertIsNone(memory.offender(1))
        self.ledger.running_memory = memory
        with patch.object(pi_phase, "git_state", return_value=(None, None)):
            self.ledger.finish(self.state, 0)
        record = pi_phase.read_ledger(self.state)[0][0]
        self.assertEqual(record["peakRssMb"], 301)
        self.assertEqual(record["peakProcRssMb"], 250)

    def test_missing_load_does_not_prevent_start(self):
        with patch.object(pi_phase.os, "getloadavg", side_effect=OSError("missing")):
            self.ledger.start()
        self.assertIsNotNone(self.ledger.started)
        self.assertNotIn("host", self.ledger.record)

    def test_matching_state_uses_one_read_and_failure_ignores_label(self):
        self.ledger.snapshot_ready = True
        self.ledger.record.update(head="a" * 40, dirty="clean")
        passed = dict(self.ledger.record, outcome="passed", verified=True)
        failed = dict(passed, outcome="failed", label="other", failure={"category": "compile"})
        with patch.object(pi_phase, "read_ledger", return_value=([passed, failed], 0)) as read:
            self.assertEqual(self.ledger.passed_state(self.state), (passed, failed))
            read.assert_called_once()
        for changes in ({"verified": False}, {"dirty": "changed"}, {"argvHash": "other"},
                        {"cwd": "elsewhere"}, {"stack": "other-stack"}, {"envHash": "other"},
                        {"kind": "build"}, {"head": "b" * 40}, {"failure": {"category": "infrastructure"}}):
            with self.subTest(changes=changes), patch.object(pi_phase, "read_ledger", return_value=([dict(failed, **changes)], 0)):
                self.assertEqual(self.ledger.passed_state(self.state), (None, None))

    def test_maximum_new_fields_and_large_label_are_bounded(self):
        record = self.ledger.record
        record.update(ts=pi_phase.utc_stamp(), label="x" * 4096, host={"load1": 99999.9},
                      peakRssMb=999999999, peakProcRssMb=999999999,
                      failure={"category": "infrastructure", "detail": "rss-cap", "offset": 999999999,
                               "codes": ["A" * 12] * 5, "failedTests": 999999999, "log": "\uffff" * 240})
        wait = pi_phase.WaitTelemetry(0).fields()
        wait["waitBreakdown"] = dict.fromkeys(pi_phase.WAIT_REASONS, 999999.9)
        wait["waitScans"] = dict.fromkeys(pi_phase.WAIT_REASONS, 999999)
        record.update(wait)
        pi_phase.append_ledger(self.state, record)
        data = next((self.state / "ledger").glob("*.jsonl")).read_bytes()
        self.assertLess(len(data), 4096)
        self.assertEqual(json.loads(data)["failure"], record["failure"])

    def test_config_defaults_and_false(self):
        config = self.state / "config.json"
        self.assertTrue(pi_phase.config(config).options["failure_categories"])
        config.write_text('{"failure_categories": false}')
        self.assertFalse(pi_phase.config(config).options["failure_categories"])

    def test_failure_stats_are_opt_in_and_old_records_count_unknown(self):
        for category in ("compile", "compile", "assertion", None):
            record = dict(self.ledger.record, ts=pi_phase.utc_stamp(), outcome="failed")
            if category:
                record["failure"] = {"category": category}
            pi_phase.append_ledger(self.state, record)
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(pi_phase.main(["stats", "--failures", "--json"], state=self.state), 0)
        self.assertEqual(json.loads(output.getvalue())["rows"], [
            {"kind": "test", "category": "assertion", "count": 1},
            {"kind": "test", "category": "compile", "count": 2},
            {"kind": "test", "category": "unknown", "count": 1}])

    def test_partial_first_line_is_not_mistaken_for_a_complete_diagnostic(self):
        self.log.write_bytes(b"error CS1002: " + b"x" * (300 * 1024))
        self.ledger.record_failure(str(self.log), 1, False)
        self.assertEqual(self.ledger.record["failure"]["category"], "unknown")
        self.assertNotIn("offset", self.ledger.record["failure"])

    def test_main_preserves_results_and_tags_expected_red_only_on_nonzero(self):
        config = self.state / "config.json"
        config.write_text('{}')
        for code, outcome, category in ((1, "failed", "expected-red"),
                                        (0, "passed", None), (76, "failed", "infrastructure"),
                                        (137, "failed", "infrastructure"), (143, "cancelled", "infrastructure"),
                                        (124, "timeout", "timeout")):
            with self.subTest(code=code):
                def producer(args, state, configuration, output):
                    output.write(b"error CS1002: expected\n")
                    args.ledger.start()
                    args.ledger.outcome(outcome)
                    return code
                with patch.object(pi_phase, "run", side_effect=producer), \
                        patch.object(pi_phase, "git_state", return_value=(None, None)), \
                        redirect_stderr(io.StringIO()), patch.object(pi_phase, "report_log"):
                    result = pi_phase.main(["run", "--kind", "test", "--label", "red", "--expect-red",
                                            "--log", str(self.log), "--", "true"],
                                           state=self.state, configuration=config)
                self.assertEqual(result, code)
                record = pi_phase.read_ledger(self.state)[0][-1]
                self.assertEqual(record["exit"], code)
                self.assertEqual(record["outcome"], outcome)
                self.assertEqual(record.get("failure", {}).get("category"), category)

    def test_main_classification_is_after_log_close_and_is_fail_open(self):
        config = self.state / "config.json"
        config.write_text('{}')
        outputs = []
        def producer(args, state, configuration, output):
            output.write(b"error CS1002: x\n")
            outputs.append(output)
            args.ledger.start()
            return 1
        def broken_classifier(*args):
            self.assertTrue(outputs[0].closed)
            raise RuntimeError("diagnostics failed")
        with patch.object(pi_phase, "run", side_effect=producer), \
                patch.object(pi_phase, "classify_failure", side_effect=broken_classifier), \
                patch.object(pi_phase, "git_state", return_value=(None, None)), redirect_stderr(io.StringIO()), patch.object(pi_phase, "report_log"):
            self.assertEqual(pi_phase.main(["run", "--kind", "test", "--label", "broken",
                                            "--log", str(self.log), "--", "true"],
                                           state=self.state, configuration=config), 1)
        self.assertNotIn("failure", pi_phase.read_ledger(self.state)[0][-1])

    def test_rerun_and_no_skip_keep_warning_advisory_and_single_history_read(self):
        config = self.state / "config.json"
        config.write_text('{"failure_categories": false, "container_test_detection": "off"}')
        for rerun in ([], ["--rerun"]):
            with self.subTest(rerun=rerun):
                with patch.object(pi_phase, "note") as note, \
                        patch.object(pi_phase, "git_state", return_value=("a" * 40, "clean")), \
                        patch.object(pi_phase.PhaseLedger, "passed_state", return_value=(None, {"failure": {"category": "compile"}})) as read, \
                        patch.object(pi_phase.WorktreeAdmission, "acquire", return_value=17) as acquire, \
                        patch.dict(pi_phase.os.environ, {"PI_PHASE_NO_SKIP": "1"}):
                    self.assertEqual(pi_phase.main(["run", "--kind", "test", "--label", "warning", *rerun,
                                                    "--policy", "direct", "--", "true"],
                                                   state=self.state, configuration=config), 17)
                read.assert_called_once()
                acquire.assert_called_once()
                note.assert_any_call("same state previously failed (compile); change code before rerunning or inspect the previous log")
                self.assertNotIn("failure", pi_phase.read_ledger(self.state)[0][-1])

    def test_non_warning_categories_and_unreadable_history(self):
        self.ledger.snapshot_ready = True
        self.ledger.record.update(head="a" * 40, dirty="clean")
        for category in ("restore", "infrastructure", "timeout", "expected-red", "unknown"):
            record = dict(self.ledger.record, verified=True, outcome="failed", failure={"category": category})
            with self.subTest(category=category), patch.object(pi_phase, "read_ledger", return_value=([record], 0)):
                self.assertEqual(self.ledger.passed_state(self.state), (None, None))
        with patch.object(pi_phase, "read_ledger", side_effect=OSError("unavailable")):
            self.assertEqual(self.ledger.passed_state(self.state), (None, None))

    def test_ci_does_not_sample_and_empty_or_failed_samples_do_not_break_peaks(self):
        options = pi_phase.config(self.state / "config.json").options
        memory = pi_phase.phase_memory(options, "ci", self.ledger)
        with patch.object(pi_phase, "sample_tree") as sample:
            self.assertIsNone(memory.offender(1))
            sample.assert_not_called()
        self.assertIsNone(self.ledger.running_memory)
        memory = pi_phase.phase_memory(options, "test", self.ledger)
        memory.warn = False
        with patch.object(pi_phase, "sample_tree", side_effect=[[(1, 20.0, "a")], [], OSError("gone")]):
            self.assertIsNone(memory.offender(1))
            self.assertIsNone(memory.offender(1))
            self.assertIsNone(memory.offender(1))
        self.assertEqual(memory.peak_rss_mb, 20)
        self.assertEqual(memory.peak_proc_rss_mb, 20)


if __name__ == "__main__":
    unittest.main()
