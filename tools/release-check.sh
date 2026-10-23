#!/usr/bin/env bash
# Release step: every test suite must pass and the whole git history must scan clean.
set -euo pipefail
cd "$(dirname "$0")/.."
# Tests the repository being released (agent/), not the live install; node_modules fall back to ~/.pi/agent/npm.
agent/bin/pi-setup-tests "${PI_AGENT_DIR:-agent}"
python3 -m unittest discover -s tests
(cd agent/local-packages/pi-questions && node --test --test-timeout=30000 'test/*.test.ts')
npm --prefix installer ci --no-audit --no-fund
npm --prefix installer run build
git diff --exit-code -- installer/dist
npm --prefix installer test
bash -n install.sh
gitleaks git . --no-banner --redact
