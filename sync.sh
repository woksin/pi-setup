#!/usr/bin/env bash
# Refresh this repo from the live pi install. Allowlist only: runtime state,
# auth, sessions, caches and machine identity are never copied.
# The whole published tree is built in a temporary stage and checked
# (tools/publish-check.py + gitleaks) before anything is written to the checkout.
set -euo pipefail
ALLOW_STALE=()
DRY_RUN=0
while (($#)); do
  case $1 in
    --allow-stale) [ $# -ge 2 ] || { echo "usage: sync.sh [--allow-stale <repo path>]..." >&2; exit 2; }; ALLOW_STALE+=("$2"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "usage: sync.sh [--dry-run] [--allow-stale <repo path>]..." >&2; exit 2 ;;
  esac
done
cd "$(dirname "$0")"
REPO=$PWD
PI="$HOME/.pi/agent"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/pi-sync.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
EX=(--exclude=__pycache__ --exclude=node_modules --exclude=.DS_Store --exclude='*.bak*' --exclude='*.pi-setup-new' --exclude=.ai-work)
PQ_EX=(--exclude=.git --exclude=.github --exclude=.gitignore --exclude=.ai-work --exclude='*.tgz' --exclude='*.log')
RS=(rsync -a --delete "${EX[@]}")

# ---- 1. build the published tree in the stage ----
cd "$STAGE"
mkdir -p agent skills tools/bin
for d in agents extensions early-extensions lib workflows templates loose-threads; do
  "${RS[@]}" "$PI/$d/" "agent/$d/"
done
"${RS[@]}" --exclude=fd --exclude=rg "$PI/bin/" agent/bin/
"${RS[@]}" --exclude=state --exclude=config.local.json --exclude='backup-*' "$PI/pi-phase/" agent/pi-phase/
# pi-questions ships as source inside this repo (no npm package); dist/ is the CLI, rebuilt here
(cd "$PI/local-packages/pi-questions" && node scripts/build.mjs)
"${RS[@]}" "${PQ_EX[@]}" --exclude='*.tgz' "$PI/local-packages/pi-questions/" agent/local-packages/pi-questions/
# publishing sanitisers: per-user label in docker-guardian, author-specific inbox path and notes path
sed -i '' -e "s#com\\.$(id -un)\\.#com.example.#g" agent/bin/docker-guardian agent/bin/pi-cleanup
sed -i '' -e 's#\${INBOX_DIR:-[^}]*}#${INBOX_DIR:-$HOME/.pi/agent/inbox}#' agent/bin/inbox-watch
# agent/profiles/ is repo-owned: never copied from the live install (see tools/sync-profile-agents.mjs)
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

for s in ai-work-lifecycle github-issue-hygiene dev-machine-performance report-setup-issue sol-loop ci-and-pushing shipping-trains; do
  "${RS[@]}" -L "$HOME/.agents/skills/$s/" "skills/$s/"
done
"${RS[@]}" "$HOME/.local/share/ai-work-lifecycle/" tools/ai-work-lifecycle/
sed -e "s#/opt/homebrew/bin/python3#python3#" -e "s#$HOME#\$HOME#g" "$HOME/.local/bin/ai-work-lifecycle" > tools/bin/ai-work-lifecycle
chmod +x tools/bin/ai-work-lifecycle

# Reverse only the operator templates we copied, leaving links and fixtures alone.
# Older live installs have no user.json; never create one while syncing.
# normalize works on repo-relative paths, so it runs inside the stage.
python3 "$REPO/setup-user.py" normalize "$PI/user.json" woksin /Volumes/sourcecode/repos

# Profiles get the base agent bodies and workflows. Generated here, in the stage, so the checks below cover the output;
# inputs are the staged base (live), the profile files they replace must be tracked in the repo.
mkdir -p "$STAGE/agent/profiles"
node "$REPO/tools/sync-profile-agents.mjs" --repo "$REPO" --base "$STAGE/agent" --out "$STAGE/agent/profiles"

# ---- 2. check the stage; any finding stops here, before the checkout is touched ----
python3 "$REPO/tools/publish-check.py" "$STAGE" "$PI/lib/secret-mask.ts"
gitleaks dir "$STAGE" --no-banner --redact

# ---- 3. refuse to overwrite repo work newer than the live input, then write the stage into the checkout ----
# Every repo file the sync would modify or delete (content or mode) must have a live input at least as new as the
# repo's last commit touching it. A missing live input or a newer repo commit stops the sync, unless the repo path is
# passed with --allow-stale. Directory mtimes never authorize a file.
cd "$REPO"
CHANGED=()
DRY=0
INVENTORY="$STAGE/.inventory"
fail() { echo "sync.sh: $*" >&2; exit 1; }
sync_dir() { # sync_dir <src> <dst> [rsync flags...]: copy, or in dry-run mode record the files that would change
  local src=$1 dst=$2; shift 2
  if ((DRY)); then
    local line path
    "${RS[@]}" -n -c --out-format='%i|%n' -i "$@" "$src" "$dst" > "$INVENTORY" || fail "rsync dry-run failed for $dst"
    while IFS= read -r line; do
      case $line in
        "*deleting "*) path=${line#"*deleting "}
                       [ -e "$dst$path" ] || [ -L "$dst$path" ] || fail "cannot parse rsync deletion line: $line"
                       [ -d "$dst$path" ] && [ ! -L "$dst$path" ] || CHANGED+=("$dst$path") ;;
        ?d*) ;;
        *"|"*) path=${line#*|}; CHANGED+=("$dst$path") ;;
        "") ;;
        *) fail "cannot parse rsync inventory line: $line" ;;
      esac
    done < "$INVENTORY"
  else
    "${RS[@]}" "$@" "$src" "$dst"
  fi
}
sync_file() { # sync_file <src> <dst>
  if ((DRY)); then
    if { [ -e "$2" ] || [ -L "$2" ]; } && ! cmp -s "$1" "$2"; then CHANGED+=("$2"); fi
  else cp "$1" "$2"; fi
}
write_stage() {
  mkdir -p agent skills tools/bin agent/lane-policy agent/launchd
  # Repo-owned files the live install does not have (never delete them): the direct-link feature and pi-profile
  # (retired live on 2026-11-27, still an installer feature).
  for d in agents extensions early-extensions lib workflows templates loose-threads; do
    sync_dir "$STAGE/agent/$d/" "agent/$d/" --exclude='direct-link*'
  done
  sync_dir "$STAGE/agent/bin/" agent/bin/ --exclude=fd --exclude=rg --exclude=pi-profile
  sync_dir "$STAGE/agent/pi-phase/" agent/pi-phase/ --exclude=state --exclude=config.local.json --exclude='backup-*'
  sync_dir "$STAGE/agent/local-packages/pi-questions/" agent/local-packages/pi-questions/ "${PQ_EX[@]}"
  sync_file "$STAGE/agent/lane-policy/README.md" agent/lane-policy/README.md
  for f in "$STAGE"/agent/launchd/*; do sync_file "$f" "agent/launchd/${f##*/}"; done
  for f in AGENTS.md AGENTS.subagent.md models.json subagents.json provider-fallback.json mcp-adapter.json efficiency.json context-budget.json settings.json npm-package.json; do
    sync_file "$STAGE/agent/$f" "agent/$f"
  done
  for s in ai-work-lifecycle github-issue-hygiene dev-machine-performance report-setup-issue sol-loop ci-and-pushing shipping-trains; do
    sync_dir "$STAGE/skills/$s/" "skills/$s/"
  done
  sync_dir "$STAGE/tools/ai-work-lifecycle/" tools/ai-work-lifecycle/
  sync_file "$STAGE/tools/bin/ai-work-lifecycle" tools/bin/ai-work-lifecycle
  # generated profile files (repo-owned, never deleted): only the files the generator changed are in the stage
  if ((!DRY)); then rsync -a "$STAGE/agent/profiles/" agent/profiles/; fi
}
live_path() { # repo path -> the live file it is published from
  case $1 in
    agent/launchd/com.example.*.plist) local n=${1#agent/launchd/com.example.}; echo "$HOME/Library/LaunchAgents/com.$(id -un).${n%.plist}.plist" ;;
    agent/npm-package.json) echo "$PI/npm/package.json" ;;
    agent/*) echo "$PI/${1#agent/}" ;;
    skills/*) echo "$HOME/.agents/skills/${1#skills/}" ;;
    tools/ai-work-lifecycle/*) echo "$HOME/.local/share/ai-work-lifecycle/${1#tools/ai-work-lifecycle/}" ;;
    tools/bin/ai-work-lifecycle) echo "$HOME/.local/bin/ai-work-lifecycle" ;;
    *) fail "no live input known for $1" ;;
  esac
}

DRY=1; write_stage; DRY=0
STALE=()
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  [ -e "$f" ] || [ -L "$f" ] || continue          # an addition: nothing in the repo to lose
  commit=$(git log -1 --format=%ct -- "$f") || fail "git log failed for $f"
  : "${commit:=0}"
  live=$(live_path "$f") || exit 1
  if [ -e "$live" ]; then stamp=$(stat -L -f %m "$live") || fail "stat failed for $live"; else stamp=-1; fi
  if ((commit > stamp)); then
    for a in ${ALLOW_STALE[@]+"${ALLOW_STALE[@]}"}; do [ "$a" = "$f" ] && continue 2; done
    STALE+=("$f")
  fi
done
if ((${#STALE[@]})); then
  echo "sync.sh: refusing to modify or delete repo files whose live input is missing or older than their last repo commit (catch the live install up, or pass --allow-stale <path>):" >&2
  printf '  %s\n' "${STALE[@]}" >&2
  exit 1
fi
if ((DRY_RUN)); then echo "sync.sh: dry run, ${#CHANGED[@]} file(s) would change; nothing written"; exit 0; fi
write_stage

git status --short
