#!/usr/bin/env bash
# Release step: every test suite must pass and the whole git history must scan clean.
set -euo pipefail
case "${1:-}" in -h|--help)
    cat <<'HELP'
Usage: tools/release-check.sh [-h|--help]
Maintainer release gate: skills tests, pi-setup-tests, unit tests, installer build and a full-history secret scan.
Running it without a help flag executes the whole gate (including npm ci).

Examples:
  tools/release-check.sh --help   # this text, no side effects
  tools/release-check.sh          # run the full gate (slow)
Exit codes:
  0 every step passed
  non-zero: the first failing step's exit code
See also: docs/reference.md, agent/bin/pi-setup-tests, agent/bin/secret-sweep
HELP
    exit 0 ;;
esac
cd "$(dirname "$0")/.."
node --test --test-timeout=30000 tools/skills.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s skills/github-issue-hygiene/scripts -p 'test_*.py'
# Tests the repository being released (agent/), not the live install; node_modules fall back to ~/.pi/agent/npm.
agent/bin/pi-setup-tests "${PI_AGENT_DIR:-agent}"
python3 -m unittest discover -s tests
(cd agent/pi-phase && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p 'test_*.py')
(cd agent/local-packages/pi-questions && node --test --test-timeout=30000 'test/*.test.ts')
npm --prefix installer ci --no-audit --no-fund
npm --prefix installer run build
git diff --exit-code -- installer/dist
npm --prefix installer test
sh -n install.sh
sh -n bootstrap.sh
sh -n tools/release-asset.sh
sh -n installer/bootstrap/preflight.sh
shellcheck -s sh install.sh bootstrap.sh tools/release-asset.sh installer/bootstrap/preflight.sh tests/container/inside.sh
shellcheck tests/container/run.sh
# No personal paths or names in the installer, its shell scripts or the container test.
# (lanes-reap.test.ts holds pre-existing ps-output fixtures; it is excluded until they are anonymised.)
if grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude=lanes-reap.test.ts '/Users/' installer install.sh bootstrap.sh tools/release-asset.sh tests/container; then echo "personal path (/Users/) found" >&2; exit 1; fi
gitleaks git . --no-banner --redact
