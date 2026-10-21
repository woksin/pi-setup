#!/bin/bash
# Outputs: main.tsv (per repo main checkout), worktrees.tsv, branches.tsv, stashes.tsv
OUT=${LT_OUT:?}
cd "{{REPOS_ROOT}}"
now=$(date +%s)
: > $OUT/main.tsv; : > $OUT/worktrees.tsv; : > $OUT/branches.tsv; : > $OUT/stashes.tsv
while read r; do
  R=${r#./}
  def=$(git -C "$r" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  [ -z "$def" ] && for c in origin/main origin/master; do git -C "$r" rev-parse -q --verify $c >/dev/null && { def=$c; break; }; done
  [ -z "$def" ] && def=NONE
  slug=$(git -C "$r" remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/]##; s#\.git$##')
  cur=$(git -C "$r" symbolic-ref -q --short HEAD || echo DETACHED@$(git -C "$r" rev-parse --short HEAD))
  dirty=$(git -C "$r" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  ab=$(git -C "$r" rev-list --left-right --count $def...HEAD 2>/dev/null | tr '\t' '/')
  printf "%s\t%s\t%s\t%s\tdirty=%s\tbehind/ahead=%s\n" "$R" "$slug" "$def" "$cur" "$dirty" "$ab" >> $OUT/main.tsv
  # worktrees
  wtbranches=$(git -C "$r" worktree list --porcelain | awk '/^branch /{print substr($0,19)}')
  git -C "$r" worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^HEAD /{h=substr($0,6)} /^branch /{print p"\t"substr($0,19)"\t"h} /^detached/{print p"\tDETACHED\t"h} /^prunable/{print p"\tPRUNABLE\t"h}' | tail -n +2 | while IFS=$'\t' read -r wt br h; do
    if [ ! -d "$wt" ]; then printf "%s\t%s\t%s\t%s\tMISSING\n" "$R" "$slug" "$wt" "$br" >> $OUT/worktrees.tsv; continue; fi
    d=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    a=$(git -C "$wt" rev-list --left-right --count $def...HEAD 2>/dev/null | tr '\t' '/')
    ct=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0); age=$(( (now-ct)/3600 ))
    up=$(git -C "$wt" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo -)
    unpushed=$( [ "$up" != "-" ] && git -C "$wt" rev-list --count $up..HEAD 2>/dev/null || echo NA)
    onremote=$(git -C "$r" branch -r --contains HEAD 2>/dev/null | wc -l | tr -d ' ')
    mt=$(stat -f %m "$wt" 2>/dev/null); 
    sz=$(du -sk "$wt" 2>/dev/null | cut -f1)
    printf "%s\t%s\t%s\t%s\tdirty=%s\tbehind/ahead=%s\tcommitAgeH=%s\tupstream=%s\tunpushed=%s\tremoteContains=%s\tsizeMB=%s\n" "$R" "$slug" "$wt" "$br" "$d" "$a" "$age" "$up" "$unpushed" "$onremote" "$((sz/1024))" >> $OUT/worktrees.tsv
  done
  # local branches without worktree
  git -C "$r" for-each-ref --format='%(refname:short)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:unix)' refs/heads | while IFS=$'\t' read -r b up tr ct; do
    echo "$wtbranches" | grep -qxF "$b" && continue
    [ "$b" = "$cur" ] && continue
    a=$(git -C "$r" rev-list --left-right --count $def..."$b" 2>/dev/null | tr '\t' '/')
    onremote=$(git -C "$r" branch -r --contains "$b" 2>/dev/null | wc -l | tr -d ' ')
    printf "%s\t%s\t%s\tbehind/ahead=%s\tupstream=%s\ttrack=%s\tremoteContains=%s\tageH=%s\n" "$R" "$slug" "$b" "$a" "${up:--}" "${tr:--}" "$onremote" "$(( (now-ct)/3600 ))" >> $OUT/branches.tsv
  done
  git -C "$r" stash list --format='%gd%x09%ct%x09%gs' 2>/dev/null | while IFS=$'\t' read -r s ct msg; do
    printf "%s\t%s\t%s\tageH=%s\t%s\n" "$R" "$slug" "$s" "$(( (now-ct)/3600 ))" "$msg" >> $OUT/stashes.tsv
  done
done < $OUT/repos.txt
