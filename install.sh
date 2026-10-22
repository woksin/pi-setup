#!/usr/bin/env bash
# Copy this setup into ~/.pi/agent (and ~/.agents/skills, ~/.local). A thin shim around installer/dist/pi-setup.mjs.
# Flags: --dry-run  --plan  --json  --user <login>  --repos-root <dir>  --profile <name|auto>  --yes  --skip-npm  --help
# Existing files that differ are backed up to <file>.bak-<timestamp> first.
# settings.json, models.json and the other JSON configs are only written when absent.
# npm install in ~/.pi/agent/npm runs automatically (--skip-npm to skip).
# agent/launchd/*.plist are templates and are not installed; see README.
set -euo pipefail
need="pi-setup needs Node.js >= 22.19 (pi needs it too): install it from https://nodejs.org, with brew install node, or with nvm."
command -v node >/dev/null 2>&1 || { echo "$need" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || { echo "$need (found $(node -p process.versions.node))" >&2; exit 1; }
exec node "$(cd "$(dirname "$0")" && pwd)/installer/dist/pi-setup.mjs" install "$@"
