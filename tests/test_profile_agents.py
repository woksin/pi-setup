"""Profile agent files must carry the same body as the shared agent (only frontmatter differs)."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENTS = ROOT / "agent" / "agents"
FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


def body(path):
    return FRONTMATTER.sub("", path.read_text(encoding="utf-8"), count=1)


class ProfileAgentBodies(unittest.TestCase):
    def test_bodies_match_shared_agents(self):
        files = sorted((ROOT / "agent" / "profiles").glob("*/agents/*.md"))
        self.assertTrue(files, "no profile agent files found")
        for path in files:
            profile = path.parent.parent.name
            with self.subTest(profile=profile, file=path.name):
                shared = AGENTS / path.name
                self.assertTrue(shared.exists(), f"{profile}/{path.name}: no shared agent")
                self.assertEqual(body(path), body(shared), f"{profile}/{path.name}: body differs from agent/agents/{path.name}")


class CodeHealthNeverStops(unittest.TestCase):
    """A Code Health miss is reported; it never stops an agent before the gate and commit (#190)."""

    STOP = re.compile(r"\b(and|then|must|should|always)\s+stop\b|[;:]\s*stop\b", re.IGNORECASE)

    def test_no_agent_makes_a_code_health_miss_a_stop(self):
        files = sorted(AGENTS.glob("*.md")) + sorted((ROOT / "agent" / "profiles").glob("*/agents/*.md"))
        self.assertTrue(files, "no agent files found")
        for path in files:
            for number, line in enumerate(body(path).splitlines(), 1):
                if "code health" not in line.lower() and "9.5" not in line:
                    continue
                with self.subTest(file=str(path.relative_to(ROOT)), line=number):
                    self.assertIsNone(self.STOP.search(line), f"Code Health line stops the work: {line}")

    def test_implementers_carry_on_after_a_miss(self):
        for name in ("implementer", "careful-implementer", "opus-implementer", "slice-implementer", "general-purpose"):
            with self.subTest(agent=name):
                self.assertIn("carry on with the gate and commit", body(AGENTS / f"{name}.md"))


class AnthropicOnlyProfiles(unittest.TestCase):
    def test_anthropic_only_profiles_have_no_foreign_models(self):
        profiles = ROOT / "agent" / "profiles"
        checked = 0
        for pj in sorted(profiles.glob("*/profile.json")):
            if json.loads(pj.read_text(encoding="utf-8")).get("uses") != ["anthropic"]:
                continue
            checked += 1
            files = sorted((pj.parent / "agents").glob("*.md")) + [pj.parent / "routing.md"]
            for path in files:
                text = path.read_text(encoding="utf-8")
                if path.suffix == ".md" and path.parent.name == "agents":
                    text = "\n".join(l for l in text.splitlines() if l.startswith("model:"))
                for banned in ("kimi-coding", "openai-codex"):
                    with self.subTest(profile=pj.parent.name, file=path.name, banned=banned):
                        self.assertNotIn(banned, text)
        self.assertGreater(checked, 0, "no anthropic-only profile found")

    def test_touched_profiles_have_every_balanced_agent(self):
        profiles = ROOT / "agent" / "profiles"
        expected = {p.name for p in (profiles / "balanced" / "agents").glob("*.md")}
        for name in ("balanced-anthropic", "anthropic-heavy"):
            with self.subTest(profile=name):
                have = {p.name for p in (profiles / name / "agents").glob("*.md")}
                self.assertEqual(expected - have, set(), f"{name} lacks agents")


class LeanProfile(unittest.TestCase):
    def test_lean_is_complete_opt_in_and_kimi_free(self):
        profiles = ROOT / "agent/profiles"
        balanced = json.loads((profiles / "balanced/profile.json").read_text())
        lean = json.loads((profiles / "lean/profile.json").read_text())
        self.assertLess(lean["rank"], balanced["rank"])
        self.assertEqual(lean["requires"], balanced["requires"])
        self.assertEqual(lean["uses"], ["anthropic", "openai-codex"])
        for area, pattern in (("agents", "*.md"), ("workflows", "*.js")):
            self.assertEqual(
                {p.name for p in (profiles / "lean" / area).glob(pattern)},
                {p.name for p in (profiles / "balanced" / area).glob(pattern)})
        for path in (profiles / "lean").rglob("*"):
            if path.is_file():
                with self.subTest(file=path.name):
                    self.assertNotIn("kimi-coding", path.read_text())
        self.assertEqual((profiles / "lean/workflows/review.js").read_bytes(),
                         (ROOT / "agent/workflows/review.js").read_bytes())

    def test_roles_and_independent_review_are_pinned(self):
        expected = {
            "planner": ("anthropic/claude-sonnet-5-5", "medium"),
            "Plan": ("anthropic/claude-sonnet-5-5", "medium"),
            "general-purpose": ("anthropic/claude-sonnet-5-5", "medium"),
            "ops": ("anthropic/claude-haiku-5-5", "low"),
            "scout": ("anthropic/claude-haiku-5-5", "medium"),
            "Explore": ("anthropic/claude-haiku-5-5", "low"),
            "implementer": ("openai-codex/gpt-6.1-sol", "high"),
            "reviewer": ("anthropic/claude-opus-5-5", "medium"),
        }
        for name, (model, thinking) in expected.items():
            with self.subTest(agent=name):
                text = (ROOT / f"agent/profiles/lean/agents/{name}.md").read_text()
                self.assertIn(f"\nmodel: {model}\n", text)
                self.assertIn(f"\nthinking: {thinking}\n", text)
        for prefix in ("agent/agents", "agent/profiles/balanced/agents",
                       "agent/profiles/balanced-openai/agents"):
            for name in ("ops", "scout"):
                text = (ROOT / prefix / f"{name}.md").read_text()
                self.assertIn("\nmodel: anthropic/claude-haiku-5-5\n", text)
                self.assertNotIn("kimi-coding", text)

    def test_context_and_fallback_config(self):
        config = json.loads((ROOT / "agent/context-budget.json").read_text())
        self.assertEqual(config, {"mode": "enforce", "main": {
            "soft": 150000, "handoff": 220000, "hard": 400000, "minProgress": 50000}})
        fallback = json.loads((ROOT / "agent/provider-fallback.json").read_text())
        self.assertNotIn("kimi", json.dumps(fallback))
        self.assertEqual(fallback["pairs"], [
            ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"],
            ["anthropic/claude-sonnet-5-5", "openai-codex/gpt-6.1-sol"],
            ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna"]])


if __name__ == "__main__":
    unittest.main()
