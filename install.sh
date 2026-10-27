#!/bin/sh
# Copy this setup into ~/.pi/agent (and ~/.agents/skills, ~/.local). A thin shim around installer/dist/pi-setup.mjs.
# First it makes sure Node.js >= 22.19 exists (installer/bootstrap/preflight.sh, plain sh); the Node installer then installs missing prerequisites and pi, with your consent.
# Flags: --dry-run  --plan  --json  --user <login>  --repos-root <dir>  --profile <name|auto>  --yes  --skip-npm  --install-prereqs  --no-install-prereqs  --help
# Also: ./install.sh uninstall | update | backups [list|prune] | doctor [--fix] [--json] | lanes [--dir <folder>]. A manifest in ~/.pi/agent/.pi-setup/ tracks what was installed.
# Files you changed since the last install are kept (new version in <file>.pi-setup-new); overwritten files are backed up to ~/.pi/agent/.pi-setup/backups/<timestamp>/.
# settings.json, models.json and the other JSON configs are only written when absent.
# npm install in ~/.pi/agent/npm runs automatically (--skip-npm to skip).
# agent/launchd/*.plist are templates and are not installed; see README.
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=installer/bootstrap/preflight.sh
. "$dir/installer/bootstrap/preflight.sh"
ps_preflight "$@"
exec node "$dir/installer/dist/pi-setup.mjs" install "$@"
