"""cpu_budget (#81 step 6): per-pool unit costs, load guard, observe vs enforce, config."""
import os
import time
import unittest
from unittest.mock import patch

import pi_phase
from test_queue_order import Harness


class CpuBudgetTests(Harness):
    def budget(self, mode="enforce", cpus=4, load=0.0, msbuild=3, **settings):
        config = pi_phase.cpu_budget_config(dict(mode=mode, **settings))
        return pi_phase.CpuBudget(config, msbuild, cpus=cpus, loadavg=lambda: (load, 0, 0))

    def hold(self, name):
        self.state.mkdir(exist_ok=True)
        fd = pi_phase.lock_file(self.state / name)
        self.assertIsNotNone(fd)
        self.addCleanup(os.close, fd)

    def claim(self, budget, policy="queued", kind="build", scan=None):
        self.state.mkdir(exist_ok=True)
        if policy == "direct":
            candidates = [[self.state / "direct-abc.lock"]]
        else:
            candidates = pi_phase.slot_paths(self.state, kind, 4, 1, ("repo", "1", "sha"))
        held = pi_phase.claim(self.state, candidates, time.monotonic() + 2, lambda: False, scan=scan, cpu=budget)
        if held:
            self.addCleanup(lambda: [os.close(fd) for _, fd in held])
        return held

    def test_config_defaults_and_validation(self):
        self.assertEqual(pi_phase.config(self.config).options["cpu_budget"], dict(mode="off"))
        full = pi_phase.cpu_budget_config(dict(mode="observe"))
        self.assertEqual((full["max_units"], full["max_load_per_core"]), ("auto", 4.0))
        self.assertEqual(full["costs"], dict(heavy="msbuild", fast=1, direct=1, integration=2))
        partial = pi_phase.cpu_budget_config(dict(mode="enforce", costs=dict(direct=3)))
        self.assertEqual(partial["costs"], dict(heavy="msbuild", fast=1, direct=3, integration=2))
        for bad in (False, dict(mode="x"), dict(mode="enforce", max_units=0), dict(mode="enforce", max_units="many"),
                    dict(mode="enforce", costs=dict(fast="msbuild")), dict(mode="enforce", costs=dict(ci=1)),
                    dict(mode="enforce", max_load_per_core=0), dict(mode="enforce", costs=[1])):
            warnings = []
            self.assertEqual(pi_phase.cpu_budget_config(bad, warnings.append), dict(mode="off"), bad)
            self.assertTrue(warnings)

    def test_unit_resolution(self):
        auto = self.budget(cpus=8)
        self.assertEqual((auto.max_units, auto.costs["heavy"]), (12, 3))
        self.assertEqual(self.budget(msbuild=0).costs["heavy"], 2)
        self.assertEqual(self.budget(msbuild="auto").costs["heavy"], 2)

    def test_units_count_live_leases_only(self):
        budget = self.budget()
        self.state.mkdir(exist_ok=True)
        self.hold("heavy-0.lock")
        self.hold("fast-0.lock")
        self.hold("integration-0.lock")
        self.hold("ci-x.lock")  # never counted
        (self.state / "heavy-1.lock").touch()  # stale: lock free, no metadata
        (self.state / "direct-dead.lock").touch()
        prior = {path: pi_phase.metadata(path.with_suffix(".json")) for path in self.state.glob("*.lock")}
        self.assertEqual(budget.running_units(self.state, {}, prior, set()), 3 + 1 + 2)

    def test_enforce_holds_when_units_would_exceed_the_budget_only_while_others_run(self):
        budget = self.budget(max_units=4)
        self.assertTrue(self.claim(budget), "idle host: the first phase always starts")
        for path in self.state.glob("*"):
            path.unlink()
        self.hold("heavy-0.lock")  # 3 units running; a heavy candidate needs 3 more > 4
        scan = {}
        self.assertIsNone(self.claim(budget, scan=scan))
        self.assertEqual(scan["reason"], "cpu")
        self.assertTrue(self.claim(self.budget(max_units=6)), "3 + 3 fits a budget of 6")

    def test_direct_takes_part_in_enforce_mode_only(self):
        self.hold("heavy-0.lock")
        scan = {}
        self.assertIsNone(self.claim(self.budget(max_units=3), policy="direct", scan=scan))
        self.assertEqual(scan["reason"], "cpu")
        observed = {}
        self.assertTrue(self.claim(self.budget(mode="observe", max_units=3), policy="direct", scan=observed))
        self.assertEqual(observed["wouldHold"], "cpu:4/3")
        self.assertNotIn("reason", observed)

    def test_load_guard_uses_the_injected_load_average(self):
        self.hold("heavy-0.lock")
        scan = {}
        self.assertIsNone(self.claim(self.budget(max_units=99, cpus=4, load=17.0), policy="direct", scan=scan))
        self.assertEqual(scan["reason"], "cpu")
        self.assertTrue(self.claim(self.budget(max_units=99, cpus=4, load=15.0), policy="direct"))
        with patch.object(pi_phase.os, "getloadavg", side_effect=OSError):
            broken = pi_phase.CpuBudget(pi_phase.cpu_budget_config(dict(mode="enforce")), 3, cpus=4)
            self.assertIsNone(broken.load_per_core())

    def test_load_alone_never_holds_an_idle_host(self):
        self.assertTrue(self.claim(self.budget(max_units=1, load=99.0), policy="direct"))

    def test_ci_is_never_held(self):
        self.hold("heavy-0.lock")
        budget = self.budget(max_units=1, load=99.0)
        self.assertEqual(budget.reason(3, [self.state / "ci-abc.lock"], 99.0), None)

    def test_observe_never_holds(self):
        self.hold("heavy-0.lock")
        scan = {}
        self.assertTrue(self.claim(self.budget(mode="observe", max_units=1), scan=scan))
        self.assertTrue(scan["wouldHold"].startswith("cpu:"))

    def test_without_the_key_claim_is_unchanged(self):
        self.hold("heavy-0.lock")
        scan = {}
        self.assertTrue(self.claim(None, policy="direct", scan=scan))
        self.assertNotIn("wouldHold", scan)

    def test_load_is_sampled_outside_the_coordinator_lock(self):
        def load():
            coordinator = pi_phase.lock_file(self.state / "coordinator.lock")
            self.assertIsNotNone(coordinator)
            pi_phase.unlock(coordinator)
            return (0.0, 0, 0)
        budget = pi_phase.CpuBudget(pi_phase.cpu_budget_config(dict(mode="enforce")), 3, cpus=4, loadavg=load)
        self.assertTrue(self.claim(budget))


if __name__ == "__main__":
    unittest.main()
