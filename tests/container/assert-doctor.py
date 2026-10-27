#!/usr/bin/env python3
"""Check `install.sh doctor --json` output after a first-time install in a clean machine.

Prerequisite and installation checks must be ok; logins, optional tools and checks that cannot pass in a
checkout without .git or without network/services are allowed to be non-ok. Anything else fails.
"""
import fnmatch
import json
import sys

MUST_BE_OK = [
    "tool:git", "tool:gh", "tool:jq", "tool:rg", "tool:fd", "tool:python3", "tool:npm", "tool:node", "tool:pi",
    "npm", "files", "pi", "python",
]
ALLOWED_NOT_OK = [
    "profile", "gh", "provider:*", "fallback*", "models",  # logins: a first-time install has none
    "tool:gitleaks", "tool:rtk", "tool:docker", "tool:tmux",  # optional tools
    "update", "launchd*", "docker", "disk*",  # need .git, macOS services, docker or network
    "path",  # the PATH snippet is only added with --edit-shell-profile
]


def main(path):
    with open(path, encoding="utf-8") as handle:
        report = json.load(handle)
    checks = {check["id"]: check for check in report.get("checks", [])}
    bad = []
    for wanted in MUST_BE_OK:
        got = checks.get(wanted)
        if got is None:
            bad.append(f"{wanted}: missing from the doctor report")
        elif got["status"] != "ok":
            bad.append(f"{wanted}: {got['status']} ({got.get('detail', '')})")
    for cid, check in checks.items():
        if check["status"] in ("ok", "skip") or cid in MUST_BE_OK:
            continue
        if not any(fnmatch.fnmatch(cid, pattern) for pattern in ALLOWED_NOT_OK):
            bad.append(f"{cid}: {check['status']} ({check.get('detail', '')})")
    if bad:
        print("doctor checks failed:\n  " + "\n  ".join(bad))
        return 1
    print(f"doctor: {len(checks)} checks, all required ones ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
