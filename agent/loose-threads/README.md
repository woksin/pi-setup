# Loose-threads audit

A backstop for leftovers from agent sessions under `{{REPOS_ROOT}}`: linked worktrees, local-only branches, stashes, unfinished `ai-work-lifecycle` tasks and dangling Docker volumes. Run it about once a week.

1. **Inventory** (read-only, about 10 to 15 minutes, so start it with `job_start`):
   `~/.pi/agent/loose-threads/inventory.sh [OUTDIR]` (default `~/.ai-work/loose-threads/<date>`).
   Its only side effects are `git fetch --prune`, `refs/pull/N/head` object fetches and `git merge-tree` objects.
2. **Plan**: "run the loose-threads-plan workflow" with `{ "dir": "<OUTDIR>" }`. It writes `<OUTDIR>/plan.md`. A second provider then tries to refute every removal.
3. **Execute, only after the user approves:**
   - Branches: bundle them into `<repo>/.ai-work/keep/recovered/branches-<date>/`, then delete them.
   - Worktrees: `LT_OUT=<OUTDIR> ~/.pi/agent/loose-threads/exec_wt.sh <path relative to {{REPOS_ROOT}}>...`. It copies `.ai-work`, the uncommitted diff, the untracked files and a branch bundle to `<main>/.ai-work/keep/recovered/worktree-<name>/`, then removes the worktree without `--force` and deletes its branch.
   - Docker volumes: remove them by exact name, never with `prune`, and check that they are still dangling first.
   - Lifecycle tasks: run `ai-work-lifecycle --repo <root> finish TASK --apply` only for tasks that are `ready-to-finish`.

## What the 2026-10-07 run taught

- A PR merged with `--squash` or into a batch or stacking branch looks unmerged to git. Prove it from the PR head (`tip==prhead` / ancestor), not from `git branch --merged`.
- Read an issue's status block before "delivering" a branch that was never pushed: #4541 recorded that its branch must not ship.
- Subagents have no `job_start`. For long gates, run them yourself in the background, or tell agents to wait for build slots with `--queue-timeout`.
- Other sessions keep creating worktrees, about 28 a day, so the count comes back quickly.
