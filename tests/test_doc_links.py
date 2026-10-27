"""README.md, TRY-ON-MAC.md and docs/**/*.md contain no dead relative links or anchors."""
import re
import unittest
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
LINK = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")


def slug(heading):
    """GitHub heading slug: lowercase, drop punctuation except - and _, spaces to -."""
    text = re.sub(r"[`*]", "", heading).strip().lower()
    return "".join(c for c in text if c.isalnum() or c in "-_ ").replace(" ", "-")


def lines_outside_fences(text):
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            fenced = not fenced
        elif not fenced:
            yield number, line


def anchors(path):
    seen, found = {}, set()
    for _, line in lines_outside_fences(path.read_text()):
        match = HEADING.match(line)
        if match:
            base = slug(match.group(1))
            count = seen.get(base, 0)
            found.add(base if count == 0 else f"{base}-{count}")
            seen[base] = count + 1
    return found


def documents():
    files = [ROOT / "README.md", ROOT / "TRY-ON-MAC.md", *sorted((ROOT / "docs").rglob("*.md"))]
    return [f for f in files if f.exists()]


def problems_in(path):
    problems = []
    for number, line in lines_outside_fences(path.read_text()):
        line = re.sub(r"`[^`]*`", "", line)  # links inside inline code are examples
        for target in LINK.findall(line):
            if re.match(r"(https?:|mailto:)", target):
                continue
            file_part, _, fragment = target.partition("#")
            destination = path if not file_part else (path.parent / unquote(file_part))
            where = f"{path.relative_to(ROOT)}:{number}: {target}"
            if not destination.exists():
                problems.append(f"{where} (missing file)")
            elif fragment and destination.suffix == ".md" and unquote(fragment).lower() not in anchors(destination):
                problems.append(f"{where} (missing anchor)")
    return problems


class SlugSpecs(unittest.TestCase):
    def test_github_slugs(self):
        self.assertEqual(slug("What's in it"), "whats-in-it")
        self.assertEqual(slug("`agent/` → `~/.pi/agent/`"), "agent--piagent")
        self.assertEqual(slug("Snake_case and-dash"), "snake_case-and-dash")

    def test_duplicate_headings_get_numeric_suffixes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            doc = Path(folder, "a.md")
            doc.write_text("# Setup\n\n```\n# not a heading\n```\n\n## Setup\n\n## Setup\n")
            self.assertEqual(anchors(doc), {"setup", "setup-1", "setup-2"})


class DocLinkSpecs(unittest.TestCase):
    def test_no_dead_links(self):
        problems = [p for document in documents() for p in problems_in(document)]
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
