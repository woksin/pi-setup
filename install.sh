#!/usr/bin/env bash
# Copy this setup into ~/.pi/agent (and ~/.agents/skills, ~/.local).
# Existing files that differ are backed up to <file>.bak-<timestamp> first.
# settings.json, models.json and the other JSON configs are only written when absent.
set -euo pipefail
cd "$(dirname "$0")"
PI="$HOME/.pi/agent"
TS=$(date +%Y%m%d-%H%M%S)
DRY=${1:-}

put() { # src dest
  local src=$1 dest=$2
  if [[ -e $dest ]] && cmp -s "$src" "$dest"; then return; fi
  echo "install $dest"
  [[ $DRY == --dry-run ]] && return
  mkdir -p "$(dirname "$dest")"
  [[ -e $dest ]] && cp -p "$dest" "$dest.bak-$TS"
  cp -p "$src" "$dest"
}
tree() { # srcdir destdir
  (cd "$1" && find . -type f) | while read -r f; do put "$1/$f" "$2/${f#./}"; done
}

for d in agents extensions early-extensions lib workflows templates profiles loose-threads bin pi-phase; do
  tree "agent/$d" "$PI/$d"
done
put agent/AGENTS.md "$PI/AGENTS.md"
for f in settings.json models.json subagents.json provider-fallback.json mcp-adapter.json; do
  [[ -e $PI/$f ]] || put "agent/$f" "$PI/$f"
done
[[ -e $PI/npm/package.json ]] || put agent/npm-package.json "$PI/npm/package.json"
for s in skills/*/; do tree "$s" "$HOME/.agents/$s"; done
mkdir -p "$PI/skills"
[[ -e $PI/skills/ai-work-lifecycle || $DRY == --dry-run ]] || ln -s "$HOME/.agents/skills/ai-work-lifecycle" "$PI/skills/ai-work-lifecycle"
tree tools/ai-work-lifecycle "$HOME/.local/share/ai-work-lifecycle"
put tools/bin/ai-work-lifecycle "$HOME/.local/bin/ai-work-lifecycle"
echo "Done. Install the npm packages: (cd $PI/npm && npm install), then restart pi."
