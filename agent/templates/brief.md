# Brief: <one-line goal> (<repo>#<issue>)

Copy to `<repo>/.ai-work/<task>/brief.md`, fill every section, and pass the agent only:
"Read and follow <absolute path to this brief>." plus anything run-specific.

## Goal
<What must be true when you are done, in 1–3 sentences. Link the issue.>

## Where
- Worktree / branch: <absolute path> (`<branch>`). Work only there.
- First step: `git fetch origin && git merge origin/main` (or rebase if the repo does that); stop and report on conflicts you cannot resolve mechanically.
- Issue register: <issue → FREE/OWNED per `issue_work owner`, checked by the parent>; claimed by the delegating session <session id prefix>. Work under that claim is authorized; stop and report only if the register shows the issue owned by a different session.
- Files / areas you own: <paths>. Do not edit anything else.
- Pass-through allowed: <dir, or none>. Only thread a parameter/collaborator through with behaviour unchanged; list these files in the report. A logic change there is a stop condition.
- Start here (file:line ranges, so you do not re-orient): <path:Lstart-Lend — why>. Do not explore the repository beyond these and what they reference.
- Read first (only these): <rules/docs paths>. If the task touches CI, runners, secrets, permissions or production, name the governing rule file here (e.g. `.cratis/ai/rules/github-actions.md`) and check the request against it before sending.

## Done =
- [ ] The Tier 1 gate `<exact command, e.g. .ai-work/ci-local.sh>` exits 0 (whole-solution build with CI's configuration and warnings, lint, all non-integration tests). Affected-project commands are for iterating only, never completion evidence. If a Tier 1 part genuinely cannot run here, name it and say what ran instead.
- [ ] Candidate delivery instead (repo has an open `pi-train` candidate): targeted checks `<command>` exit 0 and the branch is delivered with `pi-train fold <branch>`; the candidate owner runs Tier 1 once.
- [ ] <acceptance check: failing-first spec now passes / behaviour X observable via Y>.
- [ ] Diff limited to the owned files; no unrelated reformatting or renames. Work only in this repository and issue; report anything else instead of doing it.
- [ ] Every claim of "done" is backed by a check you ran on the final code state; a report without a run check is "unverified", not done.
- [ ] The deliverable is the change in the repository, not notes about it. Decide reversible implementation details yourself and record the choice in the report; ask only for decisions the brief reserves.
- [ ] Once the required checks pass, broaden or repeat testing only when new changes, failures or unresolved concerns justify it.
- [ ] Committed locally with a clear message. Do not push.

## Working efficiently
- Every tool call re-reads your whole context: batch independent reads/greps in one message, `rg` before a ranged `read`, one `edit` per file, never print whole logs.
- Budget: about 40 tool calls for this unit. If you will exceed it, write `handoff.md` and report; the parent resumes you rather than respawning.

## Plan (optional; filled by `planner`)
Ordered, small steps, each naming the file(s) and the change, and the specs/tests to add first.

## Execution policy (binding — do not re-decide)
- pi-phase policy: auto / direct / fast / queued (pass `--policy` for an explicit choice); pack/restore use `--kind build`, including `pi-phase run --kind build ... -- bash …/cratis-local-packages.sh pack-nuget …` (inner dotnet shim applies; version/stamp tokens are normalized for history).
- High priority: yes / no.
- These execution decisions override general rules; run the exact gate below.

## Verify with
- Configuration to verify: <e.g. Release, warnings as errors; must match CI>.
- Iterate with: `<narrow affected-project command>`.
- Finish with the Done gate once. Use `pi-phase run ... --log <repo>/.ai-work/<task>/<phase>.log` instead of redirects, pipes or `; echo $?`. A `pi-phase run` goes alone in its tool turn, never batched with edits or quick checks (a parallel batch records results only when all calls finish).

## Stop and report (do not work around) when
- The gate fails for a reason outside your files, or a pre-existing test fails.
- The spec is ambiguous or the fix needs a design decision.
- You would need to touch files outside "Files you own".
- Two attempts at the same code or test failure did not change the result.
- `pi-phase` exit 75 (queue timeout) is not a failed attempt. Never loop short requeues (each retry goes to the back). Continue code work, then retry the phase once in the background (`job_start`) with `--queue-timeout 3600 --approved-long-timeout` (up to 7200 for integration; a deep `pi-phase status` queue is the runtime basis) and `--priority low` unless a merge waits on it. If that also times out, report "gate not run: queue saturated", not "failed". A duplicate CI watcher also returns 75: reuse the existing watch, do not retry it.

## Report back (≤ 1.5k characters; details go in a file)
Status (done / blocked), commits (SHA + subject), gate command + exit code, files changed, anything skipped or open.
Write a short handoff to `<repo>/.ai-work/<task>/handoff.md` before reporting if work is unfinished.
