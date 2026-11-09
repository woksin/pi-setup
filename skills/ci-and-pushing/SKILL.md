---
name: ci-and-pushing
description: Use before pushing a branch, when waiting on or cancelling GitHub Actions runs, or when local Docker must stay available for CI-like runs.
license: MIT
---

# CI and pushing

Procedures moved out of the global `AGENTS.md` (woksin/pi-setup#158). The always-loaded rules there (push in batches, no CI as a substitute for local builds, no local integration suites, the PR label check) still apply; this skill holds the detail.

## Local gates and push batching

- **Local gates mirror CI, not what you think is affected.** Read the repository's `.github/workflows/` once per session and derive CI's exact commands (configuration, warnings-as-errors, analyzers, whole-solution build, CI's test filters, lint, formatting). Script them (e.g. `.ai-work/ci-local.sh`, with a flag for integration tests). "Affected projects only" is for iterating, never for a gate.
  - **Build once, at the end (2026-10-21).** Do the coding, specs and fixes first, verifying only with incremental builds of the touched project and the affected spec projects or filters. Run the full gate once, when the work is believed complete. Never rerun a full build or spec suite on a code state that already passed it. In release-train and candidate setups (one owner assembles several deliveries, including concurrent worktrees of one repository), deliveries come with targeted checks plus a clean build of the touched projects. Only the train owner runs the full local Tier 1 once on the assembled candidate; integration coverage runs in CI by default. When that fails, the owner attributes the failure to a delivery, and that delivery's owner fixes it.
  - **Iteration profile (opt-in).** While coding, `pi-phase run --profile iterate` (no analyzers or style enforcement for dotnet build/test) is the fast loop; its runs are never gate evidence. Before delivery run a full-profile Release build of the touched projects. Tier 1 is unchanged and always runs the full profile. Pick what to iterate on with `~/.pi/agent/bin/pi-affected` in the worktree: it prints a `target:` (a solution filter of the affected projects, the whole solution when a fallback rule fires, or none for docs-only changes) for `pi-phase run --profile iterate --kind build|test ... -- dotnet build|test <target>`. The selection is never gate or delivery evidence.
- When CI or a review finds problems, fix all of them, rerun the required tier in full, then push once.

## Local Docker (2026-10-20: Docker must keep working without a human)

- `docker-guardian` (launchd, every 2 min; log `~/.pi/agent/logs/docker-guardian.log`) restarts Docker Desktop after ~6 min unresponsive (budget 1 per 20 min, 3 per 2 h), starts it when it is not running, and every 15 min removes exited containers older than 20 min, unused networks older than 30 min, unused anonymous volumes/build cache above 8 GB, plus only superseded semver image tags (keep newest 2 per repository/variant/numeric precision) and dangling images older than 24 h. Image cleanup waits for no integration phase; it keeps pinned globs (`~/.pi/agent/docker-guardian/pinned.txt`), all container-used images, images younger than 6 h and floating tags, and uses only `docker rmi` without force. It posts passive `BCAST-docker-guardian-*` notices (they ride with a lane's next wake and never wake it); do not duplicate it. `touch ~/.pi/agent/docker-guardian/paused` stops its restarts (only on the user's request).
- Any agent may restart Docker Desktop itself when it has been unresponsive for 10+ minutes and the guardian has not acted (`osascript -e 'quit app "Docker"'`, `pkill -f com.docker.backend` if it lingers, `open -a Docker`), announcing it to other sessions first. No approval needed.
- Every phase that starts containers (Testcontainers specs, `docker build`, compose, local Stage/Chronicle) runs through `pi-phase --kind integration` so container load is serialised; never run Docker work in an unwrapped background script. Every Docker call in specs and scripts has a deadline.
- Clean up what you start: stop and remove your containers and networks when a phase ends or is abandoned. Never `docker image prune -a` or `docker system prune -a` (pinned integration images must stay).

## Cancelling unnecessary runs (2026-10-20)

Runners are a shared, saturated resource. Agents may cancel GitHub Actions runs that do not need to run, with these safeguards:

- Identify the run exactly: `gh run view <id> --repo <owner/repo> --json workflowName,event,headBranch,headSha,status,createdAt`. Never cancel by name, branch or time window alone, and never in bulk without listing each id first.
- Allowed reasons: superseded by a newer push to the same PR branch (same workflow, older head SHA); duplicate run for the same SHA and workflow; a run for a PR that was closed or merged, or folded (or decided to be folded) into a train; a run your own mistaken push started; an auto-update/bump or scheduled run that a newer one already covers.
- Never cancel a check run for a merged PR's head SHA while a Publish for that SHA is queued or in progress: the Publish gate reads those checks.
- Never cancel: a Publish/release/deploy run (or anything on `main` that tags, publishes or deploys), a run another live session is watching for a merge, or a required check on a PR about to merge — unless its owner agrees.
- Exception: a GitHub Pages/documentation site build or deploy run may be cancelled when a newer run of the same workflow for the same site is already queued or running (it would publish newer content anyway). Keep the newest run; never cancel the only or latest one.
- Cancel with `gh run cancel <id> --repo <owner/repo>`, then report in one line: id, workflow, branch/SHA, reason. Do not rerun anything to compensate.

## Waiting on GitHub CI

CI runs take 10–60 minutes, and longer where self-hosted runners queue. Waiting must cost neither session time nor tokens:

- After a push, start **one** background watch on an immutable target: `job_start` with `gh run watch <run-id> --exit-status` (or `gh pr checks <n> --repo <owner/repo> --watch --fail-fast --interval 60`), `timeoutSeconds` sized for the repo's CI (up to 7200), or `job_watch` re-running one check. When an empty timeout needs no action, give the `job_watch` `quietTimeouts: N`: it re-arms silently and wakes you only on a match, an inconclusive check or after N empty periods (at most 24 h in total). Never re-check status by hand in between; the wait-guard blocks the same status query a third time within 15 minutes.
- Watch facts, not prose: never grep cumulative `messages/` or logs for release/PR markers. After dispatch, capture and verify the intended workflow run ID (`gh run list --workflow X --commit <full headSha> --json databaseId,headSha,event,status`); disambiguate concurrent dispatches, never filter by a time window. Watch that ID.
- For releases, use `job_watch` on this exact check: `gh api repos/<o>/<r>/releases --paginate --jq '.[]|select(.draft|not).body' | grep -qF '(#<n>)'`; aggregated releases can target a later commit. For merge turns, require predecessor PRs to be `MERGED` (`gh pr view N --json state,mergedAt`) and no non-completed runs of the repo's publish workflow.
- **Flaky tests never hang a release.** Within about 15 minutes, classify a CI failure from one `--log-failed` read and the test's history on main: real or flaky. "Flaky" needs the independent root-cause validation from "Questions for the user"; an unknown failure is real and a blocker.
  - **Confirmed flake:** after the run completes (wait in `job_start`), rerun failed jobs once (`gh run rerun <id> --failed`); a known flake with a matching signature may go straight to quarantine. If the rerun fails again, quarantine the test in the same train, open a tracked issue "Flaky: <test>" with the evidence (label `flaky`) and push once. Never quarantine silently or disable security or critical-path coverage: if the security lens vetoes, evict the item or escalate.
  - **Real failure:** fix it in one round or evict the item. Never retry in loops.
  - Otherwise read `log-failed` once, check whether other jobs also failed, fix them all, run the local gate, and push once.
- Tell the user in one line what is being waited on (`Waiting on CI run <id> for PR #<n>; I will continue when it finishes.`) so nobody needs to nudge the session.
- While it runs, do independent work (the next issue, docs, review prep); if there is none, end the turn.
- Do not push trivial follow-ups (typos, formatting, comment tweaks) on their own; fold them into the next meaningful push, and never rewrite pushed history.
- Do not push a merge of `origin/main` into a PR branch on its own: PR CI already tests the merge ref. Merge main and push only when the branch conflicts, when a required check needs the newer main (e.g. a fix that landed there), or together with real changes, and right before merging if the repo requires an up-to-date branch.
- If a push is needed only as a remote backup mid-work, ask the user first.
