#!/usr/bin/env bash
# Refresh this repo from the live pi install. Allowlist only: runtime state,
# auth, sessions, caches and machine identity are never copied.
# The whole published tree is built in a temporary stage and checked
# (tools/publish-check.py + gitleaks) before anything is written to the checkout.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$PWD
PI="$HOME/.pi/agent"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/pi-sync.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
EX=(--exclude=__pycache__ --exclude=node_modules --exclude=.DS_Store --exclude='*.bak*' --exclude='*.pi-setup-new')
PQ_EX=(--exclude=.git --exclude=.github --exclude=.gitignore --exclude=.ai-work --exclude='*.tgz' --exclude='*.log')
RS=(rsync -a --delete "${EX[@]}")

# ---- 1. build the published tree in the stage ----
cd "$STAGE"
mkdir -p agent skills tools/bin
for d in agents extensions early-extensions lib workflows templates loose-threads; do
  "${RS[@]}" "$PI/$d/" "agent/$d/"
done
"${RS[@]}" --exclude=fd --exclude=rg "$PI/bin/" agent/bin/
"${RS[@]}" --exclude=state --exclude=config.local.json "$PI/pi-phase/" agent/pi-phase/
# pi-questions ships as source inside this repo (no npm package); dist/ is the CLI, rebuilt here
(cd "$PI/local-packages/pi-questions" && node scripts/build.mjs)
"${RS[@]}" "${PQ_EX[@]}" --exclude='*.tgz' "$PI/local-packages/pi-questions/" agent/local-packages/pi-questions/
# publishing sanitisers: per-user label in docker-guardian, author-specific inbox path and notes path
sed -i '' -e "s#com\\.$(id -un)\\.#com.example.#g" agent/bin/docker-guardian agent/bin/pi-cleanup
sed -i '' -e 's#\${INBOX_DIR:-[^}]*}#${INBOX_DIR:-$HOME/.pi/agent/inbox}#' agent/bin/inbox-watch
"${RS[@]}" --exclude=ACTIVE "$PI/profiles/" agent/profiles/
# lane-policy: only the README is shared (policy.json is per-machine state)
mkdir -p agent/lane-policy
cp "$PI/lane-policy/README.md" agent/lane-policy/README.md
# launchd templates: user name and home replaced by placeholders
mkdir -p agent/launchd
for n in docker-guardian pi-cleanup; do
  sed -e "s#$HOME#__HOME__#g" -e "s#com\.[A-Za-z0-9]*\.$n#com.example.$n#" \
    -e '/DOCKER_GUARDIAN_MESSAGES/d' "$HOME/Library/LaunchAgents/com.$(id -un).$n.plist" > "agent/launchd/com.example.$n.plist"
done
for f in AGENTS.md AGENTS.subagent.md models.json subagents.json provider-fallback.json mcp-adapter.json efficiency.json ; do
  cp "$PI/$f" "agent/$f"
done
# per-session resume checks point at local scripts: not shared
jq 'del(.resumeChecks)' "$PI/context-budget.json" > agent/context-budget.json
# local packages -> their public npm packages; deduplicated, order kept
jq 'del(.deviceId, .lastChangelogVersion)
  | .packages |= (map(if test("^\\./local-packages/pi-(jobs|recover|orch)$") then "npm:@woksin/" + ltrimstr("./local-packages/")
                      elif test("context-budget") then "npm:@woksin/pi-context-budget"
                      else . end)
                  | . + ["npm:@woksin/pi-orch"]
                  | reduce .[] as $p ([]; if any(.[]; . == $p) then . else . + [$p] end))' "$PI/settings.json" > agent/settings.json
jq '{name, private, dependencies}' "$PI/npm/package.json" > agent/npm-package.json

for s in ai-work-lifecycle github-issue-hygiene; do
  "${RS[@]}" -L "$HOME/.agents/skills/$s/" "skills/$s/"
done
"${RS[@]}" "$HOME/.local/share/ai-work-lifecycle/" tools/ai-work-lifecycle/
sed -e "s#/opt/homebrew/bin/python3#python3#" -e "s#$HOME#\$HOME#g" "$HOME/.local/bin/ai-work-lifecycle" > tools/bin/ai-work-lifecycle
chmod +x tools/bin/ai-work-lifecycle

# Reverse only the operator templates we copied, leaving links and fixtures alone.
# Older live installs have no user.json; never create one while syncing.
# normalize works on repo-relative paths, so it runs inside the stage.
python3 "$REPO/setup-user.py" normalize "$PI/user.json" woksin /Volumes/sourcecode/repos

# ---- 2. check the stage; any finding stops here, before the checkout is touched ----
python3 "$REPO/tools/publish-check.py" "$STAGE" "$PI/lib/secret-mask.ts"
gitleaks dir "$STAGE" --no-banner --redact

# ---- 3. write the stage into the checkout ----
cd "$REPO"
mkdir -p agent skills tools/bin
for d in agents extensions early-extensions lib workflows templates loose-threads; do
  "${RS[@]}" "$STAGE/agent/$d/" "agent/$d/"
done
"${RS[@]}" --exclude=fd --exclude=rg "$STAGE/agent/bin/" agent/bin/
"${RS[@]}" --exclude=state --exclude=config.local.json "$STAGE/agent/pi-phase/" agent/pi-phase/
"${RS[@]}" "${PQ_EX[@]}" "$STAGE/agent/local-packages/pi-questions/" agent/local-packages/pi-questions/
"${RS[@]}" --exclude=ACTIVE "$STAGE/agent/profiles/" agent/profiles/
mkdir -p agent/lane-policy agent/launchd
cp "$STAGE/agent/lane-policy/README.md" agent/lane-policy/README.md
cp "$STAGE"/agent/launchd/* agent/launchd/
for f in AGENTS.md AGENTS.subagent.md models.json subagents.json provider-fallback.json mcp-adapter.json efficiency.json context-budget.json settings.json npm-package.json; do
  cp "$STAGE/agent/$f" "agent/$f"
done
for s in ai-work-lifecycle github-issue-hygiene; do
  "${RS[@]}" "$STAGE/skills/$s/" "skills/$s/"
done
"${RS[@]}" "$STAGE/tools/ai-work-lifecycle/" tools/ai-work-lifecycle/
cp "$STAGE/tools/bin/ai-work-lifecycle" tools/bin/ai-work-lifecycle

git status --short
