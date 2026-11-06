"""Guard the source-only lean policy without starting sessions or changing installed files."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COORDINATION = (
    "agent/AGENTS.md",
    "agent/templates/brief.md",
    "agent/templates/repo-orchestrator-brief.md",
    "installer/lanes/templates/coordinator.md",
    "installer/lanes/templates/rules.md",
    "installer/lanes/templates/WATCHES.md",
)
PLANNING = COORDINATION[:-1]
SCHEDULING = (
    "agent/AGENTS.md",
    "agent/profiles/lean/routing.md",
    "agent/templates/repo-orchestrator-brief.md",
    "installer/lanes/templates/coordinator.md",
)


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


class UsagePolicy(unittest.TestCase):
    def test_coordination_is_actionable_and_keeps_targeted_safety_alerts(self):
        for path in COORDINATION:
            with self.subTest(path=path):
                text = source(path)
                for phrase in ("deliveries, blocker changes, questions/decisions",
                               "new relevant safety holds", "No unchanged status, ACK-of-ACK or cc",
                               "ALL is reserved for truly global safety holds",
                               "keep targeted critical alerts", "lease expiry", "explicit request"):
                    self.assertIn(phrase, text)
                self.assertIn("re-arm", text)
                self.assertIn("silently", text)
        self.assertNotIn('post "still waiting on <dep>"', source("agent/AGENTS.md"))
        self.assertIn("Re-arm the watch on every wake", source("agent/AGENTS.md"))
        self.assertIn('Keep one watch:', source("installer/lanes/templates/rules.md"))

    def test_planning_counts_implementation_not_tests_and_docs(self):
        for path in PLANNING:
            with self.subTest(path=path):
                text = source(path)
                for phrase in ("more than three implementation files", "cross-repository dependencies",
                               "unresolved design/behaviour question", "Tests and docs do not inflate",
                               "Reuse", "never pair", "requirements take precedence"):
                    self.assertIn(phrase, text)
        for path in sorted((ROOT / "agent/profiles").glob("*/routing.md")):
            with self.subTest(profile=path.parent.name):
                text = path.read_text(encoding="utf-8")
                self.assertIn("more than three implementation files", text)
                self.assertIn("Reuse a still-valid plan", text)
                self.assertIn("never pair `planner` with `Plan`", text)
                self.assertIn("Stronger user/repository planning requirements take precedence", text)

    def test_scheduling_documents_primary_launch_enforcement_boundary(self):
        for path in SCHEDULING:
            with self.subTest(path=path):
                text = source(path)
                for phrase in ("six active worker lanes plus two orchestration sessions globally",
                               "across repositories, not per repository",
                               "Primary launches enforce the six-worker/two-orchestration admission boundary",
                               "SDK fan-out and manual launches remain outside it",
                               "Parked live sessions still count against their pool",
                               "Sonnet 5.5 medium", "Opus 5.5 medium"):
                    self.assertIn(phrase, text)
                self.assertNotIn("admission and parking come later", text)

    def test_context_prose_and_rollout_preserve_local_safety_state(self):
        for path in PLANNING:
            with self.subTest(path=path):
                text = source(path)
                for value in ("150k", "220k", "400k"):
                    self.assertIn(value, text)
        rollout = source("docs/lean-rollout.md")
        for phrase in ("resumeChecks", "every other unrelated key", "unchanged copy",
                       "security coverage (also for config/tests/docs)", "Astra verification semantics",
                       "Do not cancel inbox watches", "pi-profile use balanced",
                       "Activation is a separate parent/operator step"):
            self.assertIn(phrase, rollout)

    def test_default_managed_routing_matches_balanced_source(self):
        managed = source("agent/AGENTS.md").split("<!-- pi-profile:routing:start", 1)[1]
        managed = managed.split("\n", 1)[1].split("<!-- pi-profile:routing:end", 1)[0]
        self.assertEqual(managed.strip(), source("agent/profiles/balanced/routing.md").strip())

    def test_lean_changes_only_intended_balanced_agent_frontmatter(self):
        changed = {"planner", "Plan", "ops", "scout"}
        balanced = ROOT / "agent/profiles/balanced/agents"
        lean = ROOT / "agent/profiles/lean/agents"
        for path in sorted(balanced.glob("*.md")):
            if path.stem not in changed:
                with self.subTest(agent=path.stem):
                    self.assertEqual(path.read_bytes(), (lean / path.name).read_bytes())
        for profile in ("balanced", "balanced-openai", "lean"):
            with self.subTest(profile=profile):
                self.assertNotIn("kimi", source(f"agent/profiles/{profile}/routing.md").lower())


if __name__ == "__main__":
    unittest.main()
