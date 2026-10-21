#!/bin/bash
# Read-only loose-threads inventory. Usage: inventory.sh [OUTDIR]
# Writes repos.txt, main/worktrees/branches/stashes.tsv, refs.json (with PR/issue evidence), lifecycle.tsv, cwd.tsv, pi-cleanup-dry.txt.
# Side effects: git fetch --prune, refs/pull/N/head object fetches, git merge-tree objects. Nothing is deleted or pushed.
set -u
export LT_OUT=${1:-$HOME/.ai-work/loose-threads/$(date +%Y-%m-%d)}
mkdir -p "$LT_OUT"; D=$(cd "$(dirname "$0")" && pwd)
cd "{{REPOS_ROOT}}" && find . -maxdepth 5 -name .git -type d -not -path '*/node_modules/*' 2>/dev/null | sed 's|/.git$||' | sort > "$LT_OUT/repos.txt"
bash "$D/fetch.sh"
bash "$D/collect.sh"
python3 "$D/analyze.py" && python3 "$D/analyze2.py" && python3 "$D/analyze3.py"
python3 "$D/lifecycle.py"
lsof -nP -d cwd 2>/dev/null | awk 'NR>1{print $1"\t"$2"\t"$NF}' | grep -F "{{REPOS_ROOT}}" | sort -u > "$LT_OUT/cwd.tsv"
~/.pi/agent/bin/pi-cleanup --only worktrees --idle-days 0 --worktree-min-idle-days 0 > "$LT_OUT/pi-cleanup-dry.txt" 2>&1
docker volume ls -qf dangling=true > "$LT_OUT/docker-dangling.txt" 2>/dev/null
df -h ~ > "$LT_OUT/df.txt"
echo "inventory written to $LT_OUT"
