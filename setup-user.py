#!/usr/bin/env python3
"""Resolve install settings and render/reverse-map the shared operator templates."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


# Only these synced files contain operator identity or repository-root settings.
TEMPLATES = [
    "agent/AGENTS.md", "agent/bin/docker-guardian", "agent/bin/pi-cleanup",
    "skills/github-issue-hygiene/SKILL.md",
    "tools/ai-work-lifecycle/README.md",
    "tools/ai-work-lifecycle/sweep-known-roots.py",
]


def read_settings(path):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a JSON object")
    for key in ("githubUser", "reposRoot"):
        if key in data and (not isinstance(data[key], str) or not data[key].strip()):
            raise ValueError(f"{path}: {key} must be a nonempty string")
    return data


def resolve(path, user, root):
    saved = read_settings(path)
    user = user or saved.get("githubUser", "")
    root = root or saved.get("reposRoot", "")
    if not user and shutil.which("gh"):
        result = subprocess.run(["gh", "api", "user", "--jq", ".login"],
                                capture_output=True, text=True)
        if result.returncode == 0:
            user = result.stdout.strip()
    if not user and sys.stdin.isatty():
        print("GitHub login: ", end="", file=sys.stderr, flush=True)
        user = input().strip()
    if not user:
        raise ValueError("Cannot determine GitHub login; pass --user <login> (or authenticate gh).")
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", user):
        raise ValueError("Invalid GitHub login; pass --user <login>.")
    if not root:
        root = str(Path.home() / "repos")
        if sys.stdin.isatty():
            print(f"Repositories root [{root}]: ", end="", file=sys.stderr, flush=True)
            root = input().strip() or root
    root = os.path.abspath(os.path.expanduser(root))
    if any(c in root for c in "\n\r\x00\"'$`\\"):
        raise ValueError("Repositories root must be a single-line path without quotes, $, backticks or backslashes.")
    return {"githubUser": user, "reposRoot": root}


def render(text, settings):
    return text.replace("{{GITHUB_USER}}", settings["githubUser"]).replace(
        "{{REPOS_ROOT}}", settings["reposRoot"])


def normalize(text, user, root):
    # Neutral provenance, not a reference to the current operator.
    text = re.sub(r"\(" + re.escape(user) + r", (\d{4}-\d{2}-\d{2})", r"(\1", text,
                  flags=re.IGNORECASE)
    text = re.sub(r"Authorised by " + re.escape(user) + r" (\(\d{4}-\d{2}-\d{2}\))",
                  r"Authorised \1", text, flags=re.IGNORECASE)
    # A login within a URL, npm scope, launchd label or larger identifier is not an operator.
    text = re.sub(r"(?<![A-Za-z0-9_@./-])" + re.escape(user) + r"(?![A-Za-z0-9_/-])",
                  "{{GITHUB_USER}}", text, flags=re.IGNORECASE)
    return text.replace(root, "{{REPOS_ROOT}}")


def main():
    command, *args = sys.argv[1:]
    if command == "config":
        print(json.dumps(resolve(Path(args[0]), args[1], args[2]), indent=2))
    elif command == "render":
        sys.stdout.write(render(Path(args[0]).read_text(), json.loads(args[1])))
    elif command == "normalize":
        saved = read_settings(Path(args[0]))
        user = saved.get("githubUser", args[1])
        root = saved.get("reposRoot", args[2])
        lane = Path("agent/lane-policy/README.md")
        text = lane.read_text().replace(f"`{root}/cratis/.ai-work/pi-lane-policy/`",
                                       "the author's local notes directory (not published)")
        lane.write_text(text)
        loose = Path("agent/loose-threads")
        paths = [Path(p) for p in TEMPLATES] + [loose / "README.md"]
        paths += list(loose.glob("*.py")) + list(loose.glob("*.sh"))
        paths += list(Path("agent/agents").glob("*.md"))
        for path in paths:
            if path.is_file():
                text = path.read_text()
                updated = normalize(text, user, root)
                if text != updated:
                    path.write_text(updated)
    else:
        raise ValueError(f"Unknown command: {command}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, EOFError) as error:
        sys.exit(f"setup-user: {error}")
