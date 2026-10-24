"""Profile agent files must carry the same body as the shared agent (only frontmatter differs)."""
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


if __name__ == "__main__":
    unittest.main()
