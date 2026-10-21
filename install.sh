#!/usr/bin/env bash
# Copy this setup into ~/.pi/agent (and ~/.agents/skills, ~/.local).
# Existing files that differ are backed up to <file>.bak-<timestamp> first.
# settings.json, models.json and the other JSON configs are only written when absent.
# agent/launchd/*.plist are templates and are not installed; see README.
set -euo pipefail
cd "$(dirname "$0")"
PI="$HOME/.pi/agent"
TS=$(date +%Y%m%d-%H%M%S)
DRY=
GITHUB_USER=
REPOS_ROOT=
while (( $# )); do
  case $1 in
    --dry-run) DRY=--dry-run; shift ;;
    --user|--repos-root)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || { echo "Missing value for $1" >&2; exit 1; }
      if [[ $1 == --user ]]; then GITHUB_USER=$2; else REPOS_ROOT=$2; fi
      shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
SETTINGS=$(python3 setup-user.py config "$PI/user.json" "$GITHUB_USER" "$REPOS_ROOT")
TMP=
trap '[[ -z $TMP ]] || rm -rf "$TMP"' EXIT

put() { # src dest
  local src=$1 dest=$2 rendered
  if grep -qE '\{\{(GITHUB_USER|REPOS_ROOT)\}\}' "$src"; then
    if [[ $DRY == --dry-run ]]; then
      if [[ -e $dest ]] && cmp -s <(python3 setup-user.py render "$src" "$SETTINGS") "$dest"; then return; fi
      echo "install $dest"
      return
    fi
    [[ -n $TMP ]] || TMP=$(mktemp -d)
    rendered=$TMP/rendered
    cp -p "$src" "$rendered"
    python3 setup-user.py render "$src" "$SETTINGS" > "$rendered"
    src=$rendered
  fi
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

if [[ $DRY != --dry-run ]]; then
  TMP=$(mktemp -d)
  printf '%s\n' "$SETTINGS" > "$TMP/user.json"
  put "$TMP/user.json" "$PI/user.json"
fi

for d in agents extensions early-extensions lib workflows templates profiles loose-threads bin pi-phase lane-policy; do
  tree "agent/$d" "$PI/$d"
done
put agent/AGENTS.md "$PI/AGENTS.md"
put agent/AGENTS.subagent.md "$PI/AGENTS.subagent.md"
for f in settings.json models.json subagents.json provider-fallback.json mcp-adapter.json efficiency.json context-budget.json; do
  [[ -e $PI/$f ]] || put "agent/$f" "$PI/$f"
done
[[ -e $PI/npm/package.json ]] || put agent/npm-package.json "$PI/npm/package.json"
for s in skills/*/; do tree "$s" "$HOME/.agents/$s"; done
[[ $DRY == --dry-run ]] || mkdir -p "$PI/skills"
[[ -e $PI/skills/ai-work-lifecycle || $DRY == --dry-run ]] || ln -s "$HOME/.agents/skills/ai-work-lifecycle" "$PI/skills/ai-work-lifecycle"
tree tools/ai-work-lifecycle "$HOME/.local/share/ai-work-lifecycle"
put tools/bin/ai-work-lifecycle "$HOME/.local/bin/ai-work-lifecycle"
echo "Done. Install the npm packages: (cd $PI/npm && npm install --legacy-peer-deps), then restart pi."
