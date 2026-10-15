#!/bin/bash
# usage: exec_wt.sh <worktree-path-relative-to-repos>...
# Saves .ai-work, uncommitted changes and a branch bundle into <main>/.ai-work/keep/recovered/worktree-<name>/,
# then removes the worktree (no --force) and deletes its branch.
set -u
LOG=${LT_OUT:-$HOME/.ai-work/loose-threads}/exec-wt.log
LSOF=$(mktemp); lsof -nP 2>/dev/null | awk '{print $NF}' > "$LSOF"
for rel in "$@"; do
  wt=/Volumes/sourcecode/repos/$rel
  [ -d "$wt" ] || { echo "SKIP $rel missing" >> $LOG; continue; }
  if grep -q "^$wt" "$LSOF"; then echo "SKIP $rel in use" >> $LOG; continue; fi
  common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir); main=$(dirname "$common")
  br=$(git -C "$wt" branch --show-current); name=$(basename "$wt")
  git -C "$main" check-ignore -q .ai-work/keep/x || { echo "SKIP $rel parent .ai-work not ignored" >> $LOG; continue; }
  dest="$main/.ai-work/keep/recovered/worktree-$name"; mkdir -p "$dest"
  [ -d "$wt/.ai-work" ] && rsync -a --exclude bin --exclude obj --exclude node_modules --exclude .venv "$wt/.ai-work/" "$dest/ai-work/"
  git -C "$wt" status --porcelain > "$dest/status.txt"; { git -C "$wt" rev-parse HEAD; echo "$br"; } > "$dest/HEAD.txt"
  if [ -s "$dest/status.txt" ]; then
    git -C "$wt" diff HEAD --binary > "$dest/uncommitted.patch" || { echo "FAIL $rel diff" >> $LOG; continue; }
    (cd "$wt" && git ls-files -o --exclude-standard -z | tar czf "$dest/untracked.tgz" --null -T -) || { echo "FAIL $rel tar" >> $LOG; continue; }
  fi
  if [ -n "$br" ]; then
    git -C "$main" bundle create "$dest/branch.bundle" "refs/heads/$br" >/dev/null 2>&1 && git -C "$main" bundle verify "$dest/branch.bundle" >/dev/null 2>&1 || { echo "FAIL $rel bundle" >> $LOG; continue; }
  fi
  if [ -s "$dest/status.txt" ]; then
    git -C "$wt" restore --staged --worktree -- . && (cd "$wt" && git ls-files -o --exclude-standard -z | xargs -0 rm -f) && git -C "$wt" clean -fd -q >/dev/null
  fi
  if git -C "$main" worktree remove "$wt" 2>>$LOG; then
    git -C "$main" worktree prune
    [ -n "$br" ] && git -C "$main" branch -D "$br" >/dev/null 2>&1
    echo "REMOVED $rel (branch ${br:-detached} deleted; saved in $dest)" >> $LOG
  else echo "FAIL $rel worktree remove" >> $LOG; fi
done
rm -f "$LSOF"
