#!/usr/bin/env bash
# Release step: every test suite must pass and the whole git history must scan clean.
set -euo pipefail
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
sh -n installer/bootstrap/preflight.sh
shellcheck -s sh install.sh installer/bootstrap/preflight.sh tests/container/inside.sh
shellcheck tests/container/run.sh
# No personal paths or names in the installer, its shell scripts or the container test.
# (lanes-reap.test.ts holds pre-existing ps-output fixtures; it is excluded until they are anonymised.)
if grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude=lanes-reap.test.ts '/Users/' installer install.sh tests/container; then echo "personal path (/Users/) found" >&2; exit 1; fi
gitleaks git . --no-banner --redact
