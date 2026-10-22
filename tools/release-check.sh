#!/usr/bin/env bash
# Release step: every test suite must pass and the whole git history must scan clean.
set -euo pipefail
cd "$(dirname "$0")/.."
agent/bin/pi-setup-tests "${PI_AGENT_DIR:-$HOME/.pi/agent}"
python3 -m unittest discover -s tests
gitleaks git . --no-banner --redact
