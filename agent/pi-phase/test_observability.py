"""Trial observability (#92): ledger fields, worker-aware pricing inputs, observe verdicts, shim calls, report."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import pi_phase
from test_queue_order import Harness

CPUS = os.cpu_count() or 1


def settings_for(**options):
    base = dict(msbuild_max_cpu=3, phase_nice=0, memory_admission=False, skip_cross_worktree=False,
                host_pressure=dict(mode="observe"), cpu_budget=dict(mode="observe"), hang_timeout=dict(mode="off"),
                reap_build_servers=dict(mode="observe"), queue_order=dict(mode="shortest-first"),
                fast_lane=dict(slots=3, max_expected_s=120))
    base.update(options)
    return pi_phase.PhaseConfig(5, 1, base)


class LedgerSizeTests(unittest.TestCase):
    def test_worst_case_record_stays_below_the_bound_and_parses(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state = Path(tmp.name)
        args = pi_phase.argparse.Namespace(kind="test", label="L" * 120, priority="normal", command=["x"],
                                           retry_reason="r" * 120)
        ledger = pi_phase.PhaseLedger(args)
        trial = dict(name="n" * 64, arm="a" * 32, started="2026-11-03T08:00:00.123456Z")
        digest, summary = pi_phase.config_fields(settings_for(trial=trial))
        ledger.record.update(cwd="/" + "d" * 3999, session="s" * 4000, lane="l" * 400, configHash=digest,
                             configSummary=summary, profileApplied=True,
                             profileProps=list(pi_phase.ITERATE_PROPERTIES), hangTimeout="not-direct-test",
                             workers=99, workersSource="sdk-default", msbuildCalls=dict(capped=99, explicit=99, maxNodes=99),
                             waitObserve=dict(host=dict(s=99999.999, n=99999), cpu=dict(s=99999.999, n=99999)),
                             admitObserve=["cpu", "host"], reaper=dict(mode="enforce", due=99, ageS=99999),
                             retryOf="2026-01-01T00:00:00.000000+00:00", outcome="passed", startedAt="2026-01-01T00:00:00Z",
                             ts=pi_phase.utc_stamp(), head="h" * 40, dirty="d" * 64,
                             trial=trial, warm=True, hangKill=True, childCpuS=999999.9,
                             fastShadow=dict(v=1, basis="family-warm", n=20, predS=99999.9, p90S=99999.9,
                                             fails=20, would=False, limS=99999.9),
                             failure=dict(category="hang", log="/" + "l" * 239, offset=9999999,
                                          excerpt="e" * 160, hang=9999999))
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            pi_phase.append_ledger(state, ledger.record)
        self.assertNotIn("ledger write failed", stderr.getvalue())
        (path,) = (state / "ledger").glob("*.jsonl")
        line = path.read_bytes()
        self.assertLess(len(line), 4096)
        records, skipped = pi_phase.read_ledger(state, days=10000)
        self.assertEqual((len(records), skipped), (1, 0))
        self.assertEqual(records[0]["obsV"], 1)
        self.assertEqual(records[0]["configHash"], digest)
        for key in ("trial", "warm", "hangKill", "childCpuS", "fastShadow", "failure"):
            self.assertEqual(records[0][key], ledger.record[key])

    def test_non_string_values_never_break_truncation(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        record = dict(v=1, ts=pi_phase.utc_stamp(), session=None, lane=None, cwd="c" * 5000, label="x", priority="normal")
        pi_phase.append_ledger(Path(tmp.name), record)
        self.assertLess(len(next((Path(tmp.name) / "ledger").glob("*.jsonl")).read_bytes()), 4096)


class ConfigFieldTests(unittest.TestCase):
    def test_hash_depends_on_values_not_key_order(self):
        one = pi_phase.config_fields(settings_for())
        other = pi_phase.config_fields(settings_for(fast_lane=dict(slots=4, max_expected_s=120)))
        self.assertNotEqual(one[0], other[0])
        reordered = dict(reversed(list(settings_for().options.items())))
        self.assertEqual(pi_phase.config_fields(pi_phase.PhaseConfig(5, 1, reordered))[0], one[0])
        self.assertEqual(one[1], dict(heavySlots=5, integrationSlots=1, fastSlots=3, fastMaxS=120, msbuildMaxCpu=3,
                                      phaseNice=0, memoryAdmission=False, hostPressure="observe",
                                      cpuBudget="observe", hangTimeout="off", reapBuildServers="observe",
                                      skipCrossWorktree=False, queueOrder="shortest-first"))

    def test_local_overlay_changes_the_hash(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "config.json"
        path.write_text(json.dumps(dict(heavy_slots=2)))
        before = pi_phase.config_fields(pi_phase.config(path))
        path.with_name("config.local.json").write_text(json.dumps(dict(cpu_budget=dict(mode="observe"))))
        after = pi_phase.config_fields(pi_phase.config(path))
        self.assertNotEqual(before[0], after[0])
        self.assertEqual((before[1]["cpuBudget"], after[1]["cpuBudget"]), ("off", "observe"))


class PhaseWorkersTests(unittest.TestCase):
    def workers(self, command, kind="build", cap=3):
        return pi_phase.phase_workers(command, kind, cap, "/nonexistent", CPUS)

    def test_estimates_mirror_the_shim(self):
        self.assertEqual(self.workers(["dotnet", "build"]), (3, "shim"))
        for flag in ("-m:5", "/m:5", "-maxcpucount:5", "--maxcpucount=5"):
            self.assertEqual(self.workers(["dotnet", "build", flag]), (5, "explicit"), flag)
        for flag in ("-m", "-maxcpucount"):
            self.assertEqual(self.workers(["dotnet", "build", flag]), (CPUS, "explicit"), flag)
        self.assertEqual(self.workers(["dotnet", "build"], cap=0), (CPUS, "sdk-default"))
        for command in (["dotnet", "test", "x.dll"], ["sh", "-c", "dotnet build"], ["python3", "x.py"], ["dotnet", "run"]):
            self.assertEqual(self.workers(command, "test"), (None, "pool"), command)
        self.assertEqual(self.workers(["dotnet", "build"], "ci"), (None, None))
        self.assertEqual(self.workers(["env", "A=1", "nice", "dotnet", "build"]), (3, "shim"))

    def test_explicit_paths_bypass_the_shim(self):
        for executable in ("/usr/local/share/dotnet/dotnet", "./dotnet"):
            self.assertEqual(self.workers([executable, "build"]), (CPUS, "bypass"))
            self.assertEqual(self.workers([executable, "build", "-m:5"]), (5, "explicit"))
            self.assertEqual(self.workers([executable, "build"], cap=0), (CPUS, "sdk-default"))

    def test_mtp_global_json_keeps_the_pool_price(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        Path(tmp.name, "global.json").write_text(json.dumps({"test": {"runner": "Microsoft.Testing.Platform"}}))
        self.assertEqual(pi_phase.phase_workers(["dotnet", "test"], "test", 3, tmp.name, CPUS), (None, "pool"))


class WorkerPricingTests(Harness):
    def budget(self, workers=None, mode="observe", max_units=6, cpus=4):
        config = pi_phase.cpu_budget_config(dict(mode=mode, max_units=max_units))
        return pi_phase.CpuBudget(config, 3, cpus=cpus, loadavg=lambda: (0.0, 0, 0), workers=workers)

    def test_candidate_costs(self):
        path = lambda name: self.state / name
        self.assertEqual(self.budget(3).cost(path("fast-0.lock")), 3)
        self.assertEqual(self.budget(3).cost(path("direct-x.lock")), 3)
        self.assertEqual(self.budget(None).cost(path("fast-0.lock")), 1)
        self.assertEqual(self.budget(3).cost(path("integration-0.lock")), 2)
        self.assertEqual(self.budget(3).cost(path("ci-x.lock")), 0)
        self.assertEqual(self.budget(3).reason(0, [path("heavy-0.lock"), path("integration-0.lock")], None), None)
        self.assertEqual(self.budget(3, max_units=4).reason(0, [path("heavy-0.lock"), path("integration-0.lock")], None),
                         "cpu:5/4")

    def test_running_lease_metadata_prices_the_lease(self):
        budget = self.budget(3)
        path = self.state / "heavy-0.lock"
        self.assertEqual(budget.cost(path, {"workers": 5}), 5)
        for bad in ({}, {"workers": "5"}, {"workers": 0}, {"workers": True}, {"workers": 2.5}):
            self.assertEqual(budget.cost(path, bad), 3, bad)  # pool cost (msbuild cap 3)

    def test_observe_reports_a_hold_that_pool_pricing_would_miss(self):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / "heavy-0.lock")
        self.addCleanup(os.close, fd)
        for workers, expected in ((None, None), (3, "cpu:6/5")):
            scan = {}
            held = pi_phase.claim(self.state, [[self.state / "direct-abc.lock"]], time.monotonic() + 2, lambda: False,
                                  scan=scan, cpu=self.budget(workers, max_units=5))
            self.assertTrue(held)
            for _, held_fd in held:
                os.close(held_fd)
            self.assertEqual(scan.get("wouldHold"), expected)


class ClaimObserveTests(Harness):
    """Independent verdicts; held/reason/wouldHold keep their meaning."""

    def hold(self, name):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / name)
        self.addCleanup(os.close, fd)

    def claim(self, scan, pressure=None, cpu=None, admission=None, candidates=None):
        self.state.mkdir(exist_ok=True)
        candidates = candidates or [[self.state / "direct-abc.lock"]]
        held = pi_phase.claim(self.state, candidates, time.monotonic() + 2, lambda: False, admission=admission,
                              scan=scan, pressure=pressure, cpu=cpu)
        if held:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def pressure(self, mode="observe"):
        config = pi_phase.host_pressure_config(dict(mode=mode))
        return pi_phase.HostPressure(config, self.state, lambda t: dict(swapMb=100.0, cmpPct=5.0, pl=4, level=54.0),
                                     lambda: 1000.0)

    def cpu(self, mode="observe", max_units=1):
        config = pi_phase.cpu_budget_config(dict(mode=mode, max_units=max_units))
        return pi_phase.CpuBudget(config, 3, cpus=4, loadavg=lambda: (0.0, 0, 0))

    def test_host_observe_survives_a_memory_hold(self):
        self.hold("heavy-0.lock")
        scan = {}
        admission = pi_phase.MemoryAdmission(dict(min_free_percent=30, min_swap_free_mb=0))
        with patch.object(admission, "reason", return_value="memory low"), patch.object(pi_phase, "note"):
            self.assertIsNone(self.claim(scan, pressure=self.pressure(), admission=admission))
        self.assertEqual(scan["reason"], "memory")
        self.assertIn("host", scan["observe"])
        self.assertNotIn("wouldHold", scan)

    def test_host_and_cpu_both_observed_and_wouldhold_stays_host(self):
        self.hold("heavy-0.lock")
        scan = {}
        self.assertTrue(self.claim(scan, pressure=self.pressure(), cpu=self.cpu()))
        self.assertTrue(scan["wouldHold"].startswith("host:"))
        self.assertEqual(sorted(scan["observe"]), ["cpu", "host"])
        self.assertTrue(scan["observe"]["cpu"].startswith("cpu:"))

    def test_cpu_observed_without_a_free_slot(self):
        self.hold("heavy-0.lock")
        self.hold("direct-abc.lock")
        scan = {}
        self.assertIsNone(self.claim(scan, cpu=self.cpu()))
        self.assertEqual(scan["reason"], "slots")
        self.assertTrue(scan["observe"]["cpu"].startswith("cpu:"))
        self.assertNotIn("wouldHold", scan)

    def test_enforce_cpu_hold_is_observed(self):
        self.hold("heavy-0.lock")
        scan = {}
        self.assertIsNone(self.claim(scan, cpu=self.cpu("enforce")))
        self.assertEqual(scan["reason"], "cpu")
        self.assertIn("cpu", scan["observe"])

    def test_idle_host_and_missing_keys_observe_nothing(self):
        scan = {}
        self.assertTrue(self.claim(scan, pressure=self.pressure(), cpu=self.cpu()))
        self.assertNotIn("observe", scan)
        self.hold("heavy-0.lock")
        scan = {}
        self.assertTrue(self.claim(scan, candidates=[[self.state / "direct-other.lock"]]))
        self.assertNotIn("observe", scan)


class TelemetryTests(unittest.TestCase):
    def test_wait_observe_counts_time_and_scans_per_kind(self):
        telemetry = pi_phase.WaitTelemetry(0, clock=iter([1, 4, 8]).__next__)
        with patch.object(pi_phase.os, "getloadavg", return_value=(1, 1, 1)):
            telemetry.record(dict(reason="slots", observe=dict(host="h")))
            telemetry.record(dict(reason="slots", observe=dict(host="h", cpu="c")))
            telemetry.record(dict(reason="slots"))
        telemetry.close(10)
        fields = telemetry.fields()
        self.assertEqual(fields["waitObserve"], dict(host=dict(s=7, n=2), cpu=dict(s=4, n=1)))
        self.assertNotIn("waitWouldHold", fields)
        plain = pi_phase.WaitTelemetry(0, clock=lambda: 1)
        plain.record(dict(reason="slots"))
        self.assertNotIn("waitObserve", plain.fields())

    def test_admit_observe_is_sorted_and_wouldhold_is_unchanged(self):
        ledger = pi_phase.PhaseLedger(pi_phase.argparse.Namespace(kind="build", label="x", priority="normal", command=["x"]))
        ledger.admitted_with_would_hold(dict(wouldHold="host:level", observe=dict(host="h", cpu="c")))
        self.assertEqual((ledger.record["admitObserve"], ledger.record["wouldHoldAtAdmit"]), (["cpu", "host"], "host"))
        other = pi_phase.PhaseLedger(pi_phase.argparse.Namespace(kind="build", label="x", priority="normal", command=["x"]))
        other.admitted_with_would_hold({})
        self.assertNotIn("admitObserve", other.record)
        self.assertNotIn("wouldHoldAtAdmit", other.record)


class ShimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(os.path.realpath(self.tmp.name))
        real = self.root / "real"
        real.mkdir()
        dotnet = real / "dotnet"
        dotnet.write_text('#!/bin/sh\nfor a; do printf "<%s>\\n" "$a"; done\nexit 3\n')
        dotnet.chmod(0o700)
        self.shim = self.root / "shim"
        self.shim.mkdir()
        with patch.dict(os.environ, PATH=str(real) + os.pathsep + os.environ["PATH"]):
            self.env = pi_phase.shim_environment(self.shim, 3)

    def call(self, *args):
        return subprocess.run([str(self.shim / "dotnet"), *args], env=self.env, capture_output=True, text=True, timeout=10)

    def calls(self):
        path = self.shim / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def test_msbuild_calls_are_appended(self):
        self.call("build")
        self.call("test", "-m:2")
        self.assertEqual(self.calls(), ["capped 3", "explicit -m:2"])

    def test_non_msbuild_calls_append_nothing(self):
        for args in (["--info"], ["run"], ["test", "a.dll"]):
            self.call(*args)
        self.assertEqual(self.calls(), [])

    def test_unwritable_directory_changes_nothing(self):
        expected = self.call("build")
        (self.shim / "calls").unlink(missing_ok=True)
        self.shim.chmod(0o500)
        self.addCleanup(self.shim.chmod, 0o700)
        if os.access(self.shim, os.W_OK):
            self.skipTest("directory permissions are not enforced")
        result = self.call("build")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (expected.returncode, expected.stdout, ""))
        self.assertEqual(result.returncode, 3)

    def test_parse_calls(self):
        self.assertEqual(pi_phase.parse_msbuild_calls("capped 4\nexplicit -m:6\nexplicit -m\n"),
                         dict(capped=1, explicit=2, maxNodes=max(6, CPUS)))
        self.assertIsNone(pi_phase.parse_msbuild_calls(""))


class RunBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(os.path.realpath(self.tmp.name))
        self.state = self.root / "state"
        self.config = self.root / "config.json"
        self.write_config()
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def write_config(self, **extra):
        data = dict(heavy_slots=1, integration_slots=1, container_test_detection="off", cold_worktree_hint=False,
                    msbuild_max_cpu=0, phase_nice=0)
        data.update(extra)
        self.config.write_text(json.dumps(data))

    def run_phase(self, command, *flags, kind="build", label="obs"):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            code = pi_phase.main(["run", "--kind", kind, "--label", label, "--policy", "direct", "--rerun",
                                  "--timeout", "20", *flags, "--", *command],
                                 state=self.state, configuration=self.config)
        return code, output.getvalue(), errors.getvalue()

    def records(self):
        return [json.loads(line) for path in sorted((self.state / "ledger").glob("*.jsonl"))
                for line in path.read_text().splitlines()]


class RunRecordTests(RunBase):
    def test_record_carries_config_profile_workers_and_version(self):
        self.write_config(msbuild_max_cpu=2, cpu_budget=dict(mode="observe"))
        self.assertEqual(self.run_phase(["true"])[0], 0)
        (record,) = self.records()
        self.assertEqual(record["obsV"], 1)
        self.assertEqual(len(record["configHash"]), 64)
        self.assertEqual(record["configSummary"]["cpuBudget"], "observe")
        self.assertEqual(record["workersSource"], "pool")
        self.assertNotIn("workers", record)
        self.assertNotIn("profileApplied", record)
        self.assertEqual(record["hangTimeout"], "off")

    def test_iterate_profile_fields(self):
        stub = self.root / "dotnet"
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o700)
        self.run_phase([str(stub), "build", "X.csproj"], "--profile", "iterate")
        self.run_phase(["sh", "-c", "dotnet build"], "--profile", "iterate")
        self.run_phase([str(stub), "build"], "--profile", "full")
        direct, shell, full = self.records()
        self.assertEqual((direct["profileApplied"], direct["profileProps"]),
                         (True, ["RunAnalyzers=false", "EnforceCodeStyleInBuild=false"]))
        self.assertEqual((shell["profileApplied"], shell["profileProps"]), (False, []))
        self.assertNotIn("profileApplied", full)
        self.assertEqual((direct["workers"], direct["workersSource"]), (CPUS, "sdk-default"))

    def test_hang_timeout_codes(self):
        settings = dict(mode="on", seconds=60, kinds=["build", "test"], paths=[])
        args = lambda **kw: pi_phase.argparse.Namespace(**dict(dict(kind="test", no_hang_timeout=False, diagnose_hang=False,
                                                                    vstest_hang_minutes=None, timeout=300), **kw))
        decide = lambda command, a, s=settings: pi_phase.hang_timeout_decision(command, a, s, "/nonexistent")[0]
        self.assertEqual(decide(["dotnet", "test"], args()), "applied")
        self.assertEqual(decide(["dotnet", "test"], args(), dict(mode="off")), "off")
        self.assertEqual(decide(["dotnet", "build"], args(kind="integration")), "kind")
        self.assertEqual(decide(["dotnet", "test"], args(no_hang_timeout=True)), "opt-out")
        self.assertEqual(decide(["npm", "test"], args()), "not-direct-test")
        self.assertEqual(decide(["dotnet", "test", "--blame"], args()), "blame-args")
        self.assertEqual(decide(["dotnet", "test"], args(), dict(settings, paths=["/other/*"])), "path")
        self.assertEqual(decide(["dotnet", "test"], args(timeout=70)), "margin")
        self.assertIsNone(pi_phase.hang_timeout_skip_reason(["dotnet", "test"], args(), settings, "/nonexistent"))
        ledger = pi_phase.PhaseLedger(args(label="x", priority="normal", command=["x"]))
        pi_phase.apply_hang_timeout(["dotnet", "test"], args(ledger=ledger), settings, "/nonexistent")
        self.assertEqual((ledger.record["hangTimeout"], ledger.record["hangTimeoutS"]), ("applied", 60))
        ci = pi_phase.PhaseLedger(args(kind="ci", label="x", priority="normal", command=["x"]))
        pi_phase.apply_hang_timeout(["gh"], args(kind="ci", ledger=ci), settings, "/nonexistent")
        self.assertNotIn("hangTimeout", ci.record)

    def test_observed_msbuild_calls_from_the_shim(self):
        real = self.root / "bin"
        real.mkdir()
        dotnet = real / "dotnet"
        dotnet.write_text("#!/bin/sh\nexit 0\n")
        dotnet.chmod(0o700)
        script = self.root / "gate.sh"
        script.write_text("#!/bin/sh\ndotnet build\ndotnet build -m:6\n")
        script.chmod(0o700)
        self.write_config(msbuild_max_cpu=4)
        with patch.dict(os.environ, PATH=str(real) + os.pathsep + os.environ["PATH"]):
            code, _, _ = self.run_phase([str(script)])
        self.assertEqual(code, 0)
        (record,) = self.records()
        self.assertEqual(record["msbuildCalls"], dict(capped=1, explicit=1, maxNodes=6))

    def test_workers_follow_the_msbuild_cap(self):
        self.write_config(msbuild_max_cpu=2)
        stub = self.root / "dotnet"
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o700)
        self.run_phase([str(stub), "build"])
        (record,) = self.records()
        self.assertEqual((record["workers"], record["workersSource"]), (os.cpu_count() or 1, "bypass"))
        with patch.dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"]):
            self.assertEqual(self.run_phase(["dotnet", "build"])[0], 0)
        record = self.records()[-1]
        self.assertEqual((record["workers"], record["workersSource"]), (2, "shim"))


class RetryTests(RunBase):
    def run_state(self, command, label="gate", dirty="dirtyhash", *flags):
        with patch.object(pi_phase, "git_state", return_value=("head", dirty)):
            return self.run_phase(command, *flags, label=label)

    def test_retry_marker_needs_same_label_and_state_and_a_failed_predecessor(self):
        self.assertEqual(self.run_state(["sh", "-c", "exit 1"])[0], 1)
        first = self.records()[0]
        self.assertNotIn("retryOf", first)
        self.run_state(["sh", "-c", "exit 1"])
        second = self.records()[1]
        self.assertEqual(second["retryOf"], first["ts"])
        self.run_state(["sh", "-c", "exit 1"], label="other")
        self.run_state(["sh", "-c", "exit 1"], dirty="changed")
        self.assertNotIn("retryOf", self.records()[2])
        self.assertNotIn("retryOf", self.records()[3])
        self.run_state(["true"])  # passes (and retries the failure)
        self.run_state(["true"])  # predecessor passed: no marker
        self.assertNotIn("retryOf", self.records()[5])

    def test_timeout_counts_as_a_failed_predecessor(self):
        ledger = pi_phase.PhaseLedger(pi_phase.argparse.Namespace(kind="build", label="a", priority="normal", command=["x"]))
        ledger.record.update(cwd="c", head="h", dirty="d")
        ledger.records = [dict(label="a", cwd="c", kind="build", head="h", dirty="d", profile="full",
                               outcome="timeout", ts="T")]
        self.assertEqual(ledger.retry_of(), "T")
        ledger.record["profile"] = "iterate"
        self.assertIsNone(ledger.retry_of())

    def test_retry_reason_is_recorded_validated_and_silent(self):
        plain = self.run_state(["true"], "gate", "dirtyhash")
        flagged = self.run_state(["true"], "gate", "dirtyhash", "--retry-reason", "flaky docker")
        strip = lambda text: re.sub(r"\d+", "N", text)
        self.assertEqual(strip(flagged[1]), strip(plain[1]))  # no new console output
        self.assertEqual(self.records()[1]["retryReason"], "flaky docker")
        self.assertNotIn("retryReason", self.records()[0])
        for bad in ("x" * 121, "a\nb"):
            with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
                self.run_state(["true"], "gate", "dirtyhash", "--retry-reason", bad)
            self.assertEqual(raised.exception.code, 2)

    def test_rejected_ledger_accepts_the_valued_option(self):
        ledger = pi_phase.rejected_ledger(["run", "--kind", "build", "--label", "l", "--retry-reason", "why", "--bogus",
                                           "--", "true"])
        self.assertEqual(ledger.record["retryReason"], "why")
        self.assertEqual(ledger.command, ["true"])


class ReaperContextTests(RunBase):
    def ledger(self):
        ledger = pi_phase.PhaseLedger(pi_phase.argparse.Namespace(kind="build", label="x", priority="normal", command=["x"]))
        ledger.state = self.state
        return ledger

    def test_start_reads_the_cache_only(self):
        self.state.mkdir()
        (self.state / "reaper-last.json").write_text(json.dumps(
            dict(v=1, at=int(time.time()) - 30, mode="observe", candidates=2, due=1, acted=0)))
        ledger = self.ledger()
        with patch.object(pi_phase.subprocess, "run", side_effect=AssertionError("no probes")):
            ledger.start()
        self.assertEqual(ledger.record["reaper"]["mode"], "observe")
        self.assertEqual(ledger.record["reaper"]["due"], 1)
        self.assertIn(ledger.record["reaper"]["ageS"], range(29, 40))

    def test_missing_or_corrupt_cache_sets_nothing(self):
        ledger = self.ledger()
        ledger.start()
        self.state.mkdir()
        (self.state / "reaper-last.json").write_text("{not json")
        other = self.ledger()
        other.start()
        self.assertNotIn("reaper", ledger.record)
        self.assertNotIn("reaper", other.record)


class ReportTests(RunBase):
    def seed(self, **fields):
        now = pi_phase.utc_stamp()
        record = dict(v=1, ts=now, kind="build", stack="other", startedAt=now, waitS=0, runS=1, outcome="passed",
                      session=None, lane=None, cwd="/x", label="l", priority="normal")
        record.update(fields)
        pi_phase.append_ledger(self.state, record)

    def report(self, *flags):
        output = io.StringIO()
        with redirect_stdout(output):
            code = pi_phase.main(["report", *flags], state=self.state, configuration=self.config)
        return code, output.getvalue()

    def test_empty_state_works_and_creates_nothing(self):
        code, text = self.report("--days", "7")
        self.assertEqual(code, 0)
        self.assertFalse(self.state.exists())
        code, text = self.report("--json")
        data = json.loads(text)
        self.assertEqual((data["records"], data["obsRecords"], data["configs"]), (0, 0, []))

    def test_legacy_only_counts_as_unknown(self):
        self.seed()
        self.seed(kind="test")
        data = json.loads(self.report("--json")[1])
        self.assertEqual((data["records"], data["obsRecords"], data["unknownConfig"], data["configs"]), (2, 0, 2, []))
        self.assertEqual(data["profile"], dict(iterate=0, iterateApplied=0, full=2))
        self.assertEqual(self.report()[0], 0)
        self.assertEqual(pi_phase.main(["stats", "--failures"], state=self.state, configuration=self.config), 0)

    def test_mixed_records(self):
        self.seed()
        self.seed(obsV=1, configHash="a" * 64, configSummary=dict(cpuBudget="observe"), profile="iterate",
                  profileApplied=True, workers=3, workersSource="shim",
                  msbuildCalls=dict(capped=2, explicit=1, maxNodes=6), waitObserve=dict(host=dict(s=7, n=2)),
                  admitObserve=["host"], wouldHoldAtAdmit="host", reaper=dict(mode="observe", due=1, ageS=3),
                  retryOf="T", retryReason="why")
        self.seed(obsV=1, kind="test", configHash="a" * 64, configSummary=dict(cpuBudget="observe"),
                  hangTimeout="applied", retryReason="only", workers=5, workersSource="explicit")
        with open(next((self.state / "ledger").glob("*.jsonl")), "ab") as stream:
            stream.write(b"garbage\n")
        data = json.loads(self.report("--json")[1])
        self.assertEqual((data["records"], data["obsRecords"], data["skipped"], data["unknownConfig"]), (3, 2, 1, 1))
        self.assertEqual(data["configs"], [dict(hash="a" * 64, count=2, summary=dict(cpuBudget="observe"))])
        self.assertEqual(data["profile"], dict(iterate=1, iterateApplied=1, full=2))
        self.assertEqual(data["hangTimeout"], dict(applied=1))
        self.assertEqual(data["workers"], dict(shim=1, explicit=1))
        self.assertEqual(data["msbuildCalls"], dict(phases=1, capped=2, explicit=1, maxNodes=6))
        self.assertEqual(data["observe"]["host"], dict(phases=1, waitS=7))
        self.assertEqual((data["admitObserve"], data["wouldHoldAtAdmit"]), (dict(host=1, cpu=0), dict(host=1, cpu=0)))
        self.assertEqual(data["reaper"], dict(phasesWithDue=1))
        self.assertEqual(data["retries"], dict(retryOf=1, withReason=1, reasonOnly=1))
        self.assertEqual(data["cpuBudgetMeanWorkers"], dict(build=3, test=5))
        self.assertIn("config aaaaaaaaaaaa count=2", self.report()[1])

    def test_days_must_be_positive(self):
        with self.assertRaises(SystemExit) as raised, redirect_stderr(io.StringIO()):
            self.report("--days", "0")
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
