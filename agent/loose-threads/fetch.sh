#!/bin/bash
cd /Volumes/sourcecode/repos
while read r; do
  ( git -C "$r" fetch --prune --quiet origin >/dev/null 2>&1 || echo "FETCHFAIL $r" ) &
  while [ $(jobs -r | wc -l) -ge 8 ]; do sleep 0.2; done
done < ${LT_OUT:?}/repos.txt
wait
