---
name: ai-work-lifecycle
description: Manage temporary AI task outputs without leaving large caches behind. Use before creating disposable build outputs, running verification commands, or closing a task with local artifacts.
license: MIT
compatibility: Local POSIX Git checkout with a reviewed ai-work-lifecycle CLI installed.
---

<!-- Copyright (c) Cratis. All rights reserved. -->
<!-- Licensed under the MIT license. See LICENSE file in the project root for full license information. -->

# Temporary task work, without the leftovers

Use the installed `ai-work-lifecycle` CLI. If unavailable, report the setup gap;
do not download tooling or copy another repository's AI configuration. Small notes
alone do not need a registered task. Keep them in ignored `.ai-work/`.

## One foreground command

From the actual repository root, with `.ai-work/` already present and ignored:

```sh
ai-work-lifecycle --repo "$PWD" run-task unique-check -- YOUR_COMMAND ARGUMENTS
```

The wrapper creates/registers a new private task workspace, owns the foreground
worker, and exposes `AI_WORK_KEEP`, `AI_WORK_CACHE`, and `AI_WORK_OUTPUT` to it.
Success attempts immediate cleanup of disposable outputs. Failure/interruption
retains them for diagnosis. Read the cleanup result: command success is not proof
that cleanup passed. Never detach a daemon or background worker through this wrapper.

**Output routing is explicit.** The wrapper is not a sandbox and does not change
package-cache settings or build-output defaults. Commands must write disposable
files into the supplied paths for those files to be managed. For example:

```sh
ai-work-lifecycle --repo "$PWD" run-task compile-check -- sh -c \
  'dotnet build path/to/project.csproj --no-restore -o "$AI_WORK_OUTPUT"'
```

Use the repository's actual supported verification command, not that placeholder.
Build intermediates outside `AI_WORK_OUTPUT` remain outside the cleanup scope.

## Work spanning multiple commands

```sh
ai-work-lifecycle --repo "$PWD" start unique-task --owner-pid REAL_SESSION_PID
# Use the returned paths; keep/ retains notes, patches, source and recovery evidence.
# cache/ and output/ are automatically registered, classified disposable locations.
ai-work-lifecycle --repo "$PWD" finish unique-task
# Review the preview, join/release any workers, and only when genuinely done:
ai-work-lifecycle --repo "$PWD" finish unique-task --apply
```

Pass the real host-session PID, not a transient tool-shell PID. In Pi,
`/ai-work start unique-task` supplies it (from Pi's bash tool, `$PPID` is the Pi
session). Extra workers require the CLI's existing `lease` / `release` commands;
prefer `run-task` for a simple single-command check.

**Nothing finishes automatically** — not session quit, reload, terminal close, age
or a dead PID. When a task is genuinely done, finish it explicitly (preview, then
`finish TASK --apply`); otherwise `state TASK paused`. Pi lists this repo's tasks
unfinished for more than 24h at session start.

Parent agents own worker lifecycle and must pass the managed paths to delegated
workers. Finish a genuinely completed task promptly: join/release workers, review
`finish TASK`, then `finish TASK --apply`. Failure, pause, exit, reload, compaction,
age and dead PIDs never imply completion.

## What this CLI does not cover

Know the boundaries before trusting the registry as a disk-hygiene mechanism:

- `--repo` requires an exact Git repository root. A `.ai-work/` directory sitting in
  a non-repository container directory (a folder that merely holds sibling clones)
  cannot be managed by the CLI at all, and `--root` inspection of a non-repository
  path fails with `repository inspection failed`. Inspect those by hand.
- Only *registered* roots are swept. Unregistered `.ai-work/` trees are invisible to
  `inventory`/`sweep`, so registered-root counts are not a measure of real usage.
- The registry tracks `cache/` and `output/`. It does not track build output that
  tools drop elsewhere — `bin`, `obj`, `build`, `dist`, `target`, `node_modules`
  inside checkouts and worktrees are typically far larger than everything the sweep
  can reclaim. Measure with `du`/`df` rather than assuming the sweep covered it.
- Build output is safe to delete only when `git ls-files` reports nothing tracked
  inside the directory; some repositories track a `build/` or `bin/` path as source.
  Never include a worktree root in such a deletion.

## Removing a worktree

`git worktree remove` without `--force` refuses modified or untracked files but
**not ignored ones** — and a nested `.ai-work/`, `.env`, local credentials or a local
database are all ignored. Removing the worktree deletes them silently. So, per worktree:

1. `git status --porcelain` must be empty.
2. `git status --ignored --porcelain` — read the `!!` lines. Build output is fine;
   `.env*`, `appsettings.*.json`, keys, databases, and any `.ai-work/keep/` are not.
   Move what matters out first or leave the worktree alone.
3. Its commits must be on `origin/<default>` (`git rev-list --count origin/main..BRANCH`
   is 0). "Reachable from some remote branch" is weaker — that branch can be deleted
   later — so treat it as a separate, lower-confidence category and say so.
4. No live process or container holds the path (`lsof +D`, `docker ps`).
5. Remove with `git worktree remove PATH`, then `git worktree prune` in the parent repo.
   Never `--force`; a refusal means stop and look.

Remove the worktree you created for a task once its branch is merged to the default
branch (step 3 above) — pushed is not merged. If the branch must outlive the task
unmerged, leave the worktree and say so in the handoff. Do this from the parent
checkout, not from inside the worktree being removed. Leaving worktrees behind is how
hundreds accumulate.

Measure reclaimed space with `df` before and after, not by summing estimates.

## Keep it small and safe

- Share standard package caches unless cold-cache isolation is what the test proves.
- Use worktrees only when concurrent editing requires isolation, not for every review.
- `keep/` is never automatically purged. Keep only useful small evidence there;
  durable knowledge belongs in reviewed documentation and follow-ups in issues.
- Only newly owned disposable files may enter `cache/` or `output/`. Never put
  credentials, backups, local-only packages, databases or unique source there.
- File classifications remain conservative. Full extracted package trees, arbitrary
  JSON/source, and whole worktrees require review; never rename files or change
  manifests to bypass a refusal. Check `--help` and the installed reference for limits.
- The hourly sweep is a fallback for explicitly completed, authorized tasks in its
  configured roots. It does not infer completion from age, exit, idle or a dead PID.
- Before making another large environment, inspect disk usage. Treat 5 GiB per task
  as a review warning, not permission to delete it or a claimed enforced quota.
- `.ai-work/` means untracked, not automatically disposable.
- Legacy or mixed package trees and records remain review-only. Automatic cleanup is
  limited to registered, explicitly completed disposable outputs in configured roots.
- Never blanket-delete `.ai-work/`, `git clean -fdx`, or force-remove a worktree.
  Preserve uncommitted/untracked work and unreferenced commits; removing a worktree
  requires ignored-file review plus a live process/container check.
- Full reference and setup: `~/.local/share/ai-work-lifecycle/README.md` and
  `REFERENCE.md` in the same directory.
