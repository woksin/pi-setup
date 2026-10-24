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


if __name__ == "__main__":
    unittest.main()
