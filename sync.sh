#!/usr/bin/env bash
# Refresh this repo from the live pi install. Allowlist only: runtime state,
# auth, sessions, caches and machine identity are never copied.
set -euo pipefail
cd "$(dirname "$0")"
PI="$HOME/.pi/agent"
RS=(rsync -a --delete --exclude=__pycache__ --exclude=node_modules --exclude=.DS_Store)

mkdir -p agent skills tools/bin
for d in agents extensions early-extensions lib workflows templates profiles loose-threads; do
  "${RS[@]}" "$PI/$d/" "agent/$d/"
done
"${RS[@]}" --exclude=fd "$PI/bin/" agent/bin/
"${RS[@]}" --exclude=state "$PI/pi-phase/" agent/pi-phase/
for f in AGENTS.md models.json subagents.json provider-fallback.json mcp-adapter.json; do
  cp "$PI/$f" "agent/$f"
done
jq 'del(.deviceId, .lastChangelogVersion) | .packages |= map(if test("^\\./local-packages/pi-(jobs|recover)$") then "npm:@woksin/" + ltrimstr("./local-packages/") else . end)' "$PI/settings.json" > agent/settings.json
jq '{name, private, dependencies}' "$PI/npm/package.json" > agent/npm-package.json

for s in ai-work-lifecycle github-issue-hygiene; do
  "${RS[@]}" -L "$HOME/.agents/skills/$s/" "skills/$s/"
done
"${RS[@]}" "$HOME/.local/share/ai-work-lifecycle/" tools/ai-work-lifecycle/
sed -e "s#/opt/homebrew/bin/python3#python3#" -e "s#$HOME#\$HOME#g" "$HOME/.local/bin/ai-work-lifecycle" > tools/bin/ai-work-lifecycle
chmod +x tools/bin/ai-work-lifecycle

gitleaks dir . --no-banner --redact
git status --short
