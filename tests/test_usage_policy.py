"""Guard the lean profile's agent files without starting sessions or changing installed files."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


class UsagePolicy(unittest.TestCase):
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
