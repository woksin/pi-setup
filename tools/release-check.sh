#!/usr/bin/env bash
# Release step: scan the whole git history, not just the working tree.
set -euo pipefail
cd "$(dirname "$0")/.."
gitleaks git . --no-banner --redact
