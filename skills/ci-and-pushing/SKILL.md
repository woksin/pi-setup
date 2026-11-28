---
name: ci-and-pushing
description: Use before pushing a branch, when waiting on or cancelling GitHub Actions runs, or when local Docker must stay available for CI-like runs.
license: MIT
---

# CI and pushing

Procedures moved out of the global `AGENTS.md` (woksin/pi-setup#158). The always-loaded "Default loop" there (first discriminating check wherever it is cheapest, no redundant runs, whole-solution/matrix runs in CI, diagnose before pushing a fix, the PR label check) still applies; this skill holds the detail. Policy 2026-11-27: local machine and CI runners are both saturated (local queue p90 8–11 min under the memory guard; shared CI queues 10–60 min), so moving load between them does not help; removing redundant runs does.

## Local gates and push batching

- **Criticality tiers come first** (see `AGENTS.md` "Criticality tiers" and "Criticality and execution" below). Tier C needs no local full gate (push and merge on green CI); Tier B needs only a focused smoke/regression check. The full-gate rules in this section apply to Tier A.
- **Tier A pre-push check uses CI's settings on the affected projects.** Read the repository's `.github/workflows/` once per session for CI's configuration (Release, warnings-as-errors, analyzers, test filters, lint, formatting) and apply those settings to the affected projects (`pi-affected` target). Run a whole-solution local build only when the affected set falls back to the whole solution or the change touches shared build configuration (`Directory.Build.*`, package versions, analyzers); otherwise CI's whole-solution run is the gate. Iteration checks that already ran in CI configuration count; run only missing coverage.
  - **Build once, at the end (2026-10-21).** Do the coding, specs and fixes first, verifying only with incremental builds of the touched project and the affected spec projects or filters. Run the pre-push check once, when the work is believed complete. Never rerun a full build or spec suite on a code state that already passed it. In release-train and candidate setups (one owner assembles several deliveries, including concurrent worktrees of one repository), deliveries come with the targeted check that already passed on their branch; do not repeat it. The train owner builds and tests the union of the affected projects once on the assembled candidate (CI configuration) and lets CI run the whole solution and integration. When that fails, the owner attributes the failure to a delivery, and that delivery's owner fixes it.
  - **Iteration profile (opt-in).** While coding, `pi-phase run --profile iterate` (no analyzers or style enforcement for dotnet build/test) is the fast loop; its runs are never gate evidence. Before delivery run a full-profile Release build of the touched projects. Tier 1 is unchanged and always runs the full profile. Pick what to iterate on with `~/.pi/agent/bin/pi-affected` in the worktree: it prints a `target:` (a solution filter of the affected projects, the whole solution when a fallback rule fires, or none for docs-only changes) for `pi-phase run --profile iterate --kind build|test ... -- dotnet build|test <target>`. The selection is never gate or delivery evidence.
- **Reuse a verified .NET build when running tests.** After a successful restored build that included the test projects, use `dotnet test --no-build --no-restore` only with the same unchanged checkout, configuration, TFM, RID, SDK, profile and other inputs, and intact outputs. When uncertain, rebuild. Never share mutable `bin`/`obj` between lanes. `pi-phase` does not add these flags automatically; compiler sharing is a separate A/B trial.
- When CI or a review finds problems, fix all of them, run the narrowest check for the fix plus any check its dependency or configuration change invalidates, then push once.

## Local Docker (2026-10-20: Docker must keep working without a human)

- `docker-guardian` (launchd, every 2 min; log `~/.pi/agent/logs/docker-guardian.log`) restarts Docker Desktop after ~6 min unresponsive (budget 1 per 20 min, 3 per 2 h), starts it when it is not running, and every 15 min removes exited containers older than 20 min, unused networks older than 30 min, unused anonymous volumes/build cache above 8 GB, plus only superseded semver image tags (keep newest 2 per repository/variant/numeric precision) and dangling images older than 24 h. Image cleanup runs only when `pi-phase status` reports no active phases or only `build`, `test` or `ci`; an active integration phase or unknown phase status blocks image removal, even under disk pressure, and the log names the skip reason. At or above the cleanup floor (40 GiB by default) it keeps pinned globs (`~/.pi/agent/docker-guardian/pinned.txt`), floating tags and images younger than 6 h; below the floor pins and floating tags no longer protect images and the minimum age drops to 1 h. It always keeps container-used images and uses only `docker rmi` without force. Under confirmed disk pressure build cache retention drops to 0 even when the image pass is skipped. It posts passive `BCAST-docker-guardian-*` notices (they ride with a lane's next wake and never wake it); do not duplicate it. `touch ~/.pi/agent/docker-guardian/paused` stops its restarts (only on the user's request).
- Any agent may restart Docker Desktop itself when it has been unresponsive for 10+ minutes and the guardian has not acted (`osascript -e 'quit app "Docker"'`, `pkill -f com.docker.backend` if it lingers, `open -a Docker`), announcing it to other sessions first. No approval needed.
- Every phase that starts containers (Testcontainers specs, `docker build`, compose, local Stage/Chronicle) runs through `pi-phase --kind integration` so container load is serialised; never run Docker work in an unwrapped background script. Every Docker call in specs and scripts has a deadline.
- Clean up what you start: stop and remove your containers and networks when a phase ends or is abandoned. Never `docker image prune -a` or `docker system prune -a`.

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

## Criticality and execution

The global criticality tiers determine required verification. C has no mandatory local gate, specs, review, or Code Health; B requires focused smoke/regression evidence and risk-triggered review. A retains CI-matched local verification only when its inputs/dependency closure changed. Reuse successful unchanged-input/configuration results; handoffs and reviews do not invalidate them. Required CI and safety contracts remain binding. Iteration-profile results are not A delivery-gate evidence.

Derive required commands from the repository workflows: configurations, warning/analyzer settings, test filters, lint and formatting. Build once per relevant state/configuration. In a coordinated candidate, only its owner runs the assembled applicable full gate; deliveries provide targeted evidence. A review/CI fix invalidates only results whose inputs changed, not every prior result.

Run each phase separately through `~/.pi/agent/bin/pi-phase run --kind KIND --label '...' --timeout SECONDS -- COMMAND ARGUMENTS`. Lint, format, restore and pack use build; containers use integration. Honor the user, then parent brief, then repository policy. Direct admission is for light checks (about two minutes, no Docker/.NET); fast is for a short single-project or filtered run. Never use direct/fast to disguise integration, whole-solution, or multi-minute work. pi-phase already withholds STUDIO_CHRONICLE_* variables.

Default to 120 seconds for targeted checks and 300 for a build/test. Longer execution needs runtime evidence; beyond 600 seconds use --approved-long-timeout and a background job. Queue waits may be up to 7200 seconds in the background without that flag. Read the pi-phase README for admission, cancellation, and hangs. Do not repeatedly requeue or ask for speculative long-timeout approval.

Before heavy work, inspect pi-phase status once. Use a background job for long queues and independent work while waiting. Do not edit queued-build inputs or start another heavy phase in the checkout. One phase per bash call and tool turn. Prefer --log .ai-work/<task>/<phase>.log and --tail N; the runner must preserve the exact producer exit. Outer timeouts cover queue, execution, and cleanup without exceeding their sum plus 60 seconds. No filtered gate pipelines or successful trailing commands masking failure.

High priority is only for an exact critical-path result and needs user or designated-orchestrator approval. Only the orchestrator grants priority; never edit grant files. Use low priority for bulk background work. Do not duplicate the runner's fairness/aging configuration in agent instructions.

Integration runs in CI by default. Local container proof is limited to cross-repository package verification under the global tier policy, through the local-packages helper and integration admission. Report deferred coverage accurately. Before a second attempted fix, compare a cheap instrumented check on main and the branch; independently validate claims used to waive consequential coverage.

## Waiting and release safety

Watch immutable run IDs or full commit SHAs, never a moving PR number. After dispatch, capture the intended workflow run and disambiguate concurrent dispatches. Use one background watch; do not inspect status in between. End the turn if no independent work remains. Unknown failures block merging; validate a flaky/pre-existing diagnosis independently before waiving consequential coverage. No retry loops or silent security/critical-path quarantine.

Do not merge workflow changes while a release-labeled Publish has not created its tag. Recover the resulting token/workflow mismatch with Publish workflow_dispatch from current main, not a rerun of the old attempt. Confirm the intended push workflow exists for the merge commit. Keep cancellation safeguards: identify each run, preserve the newest/only run, and protect release/deploy runs and owners' merge checks, including merged-head checks consumed by Publish.

## Docker cleanup floor

Use the guardian rather than duplicating its sweeps. At or above 40 GiB free, preserve pinned/floating/young images under guardian policy. Below 40 GiB, managed cleanup may remove unused images regardless of pins, preserving container-used and younger-than-one-hour images; build cache above zero may be pruned. Use docker rmi without force, never docker image prune -a or docker system prune -a. Do not pause the guardian without the user's request. Restart only under the existing unresponsive-Docker procedure, notifying other sessions first.
