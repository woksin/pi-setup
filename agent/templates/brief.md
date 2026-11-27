# Brief: <one-line goal> (<repo>#<issue>)

Copy to `<repo>/.ai-work/<task>/brief.md`, fill every section, and pass the agent only:
"Read and follow <absolute path to this brief>." plus anything run-specific.

## Planning and coordination
Reuse a still-valid plan. Run `planner` only for more than three implementation files, cross-repository dependencies or a named unresolved design/behaviour question; never pair it with `Plan`. Stronger user/repository requirements take precedence. Tests and docs do not inflate the implementation-file count.
Only send actionable coordination: deliveries, blocker changes, questions/decisions or new relevant safety holds. No unchanged status, ACK-of-ACK or cc messages. ALL is reserved for truly global safety holds; keep targeted critical alerts.
Send action-needed reports only to the named owner/parent. Acknowledge deliveries and questions, not information-only or ALL/FYI messages. Timeouts only re-arm watches silently; renew waiting-on leases locally. Notify once on blocking, then only on material change, lease expiry or explicit request; no hourly "still waiting" messages.
Write the parent handoff at 150k context tokens and reset by 220k; 400k is a hard guardrail, not a target.
Investigation budget: for any question needing more than ~5 reads/searches or ~200 lines of output, send a subagent (`Explore`/`ops`) for a short answer instead of reading yourself.

## Goal
<What must be true when you are done, in 1–3 sentences. Link the issue.>

## Where
- Worktree / branch: <absolute path> (`<branch>`). Work only there. The parent restores dependencies (e.g. `dotnet restore`, `yarn install`) before spawning; if they are missing, report instead of stalling.
- First step: `git fetch origin && git merge origin/main` (or rebase if the repo does that); stop and report on conflicts you cannot resolve mechanically.
- Issue register: <issue → FREE/OWNED per `issue_work owner`, checked by the parent>; claimed by the delegating session <session id prefix>. Work under that claim is authorized; stop and report only if the register shows the issue owned by a different session.
- Files / areas you own: <paths>. Do not edit anything else.
- Pass-through allowed: <dir, or none>. Only thread a parameter/collaborator through with behaviour unchanged; list these files in the report. A logic change there is a stop condition.
- Start here (file:line ranges, so you do not re-orient): <path:Lstart-Lend — why>. Do not explore the repository beyond these and what they reference.
- Read first (only these): <rules/docs paths>. If the task touches CI, runners, secrets, permissions or production, name the governing rule file here (e.g. `.cratis/ai/rules/github-actions.md`) and check the request against it before sending.

## Done =
- [ ] Tier <A/B/C>. The check `<exact command>` exits 0 on the final code state: tier A builds and tests the affected projects with CI's configuration (Release, warnings as errors); tier B runs the named smoke check; tier C needs none. Checks already run during iteration on the same state count. Whole-solution, matrix and integration suites are CI's job unless the brief names one.
- [ ] Candidate delivery instead (repo has an open `pi-train` candidate): the same check, then `pi-train fold <branch>`.
- [ ] <acceptance check: behaviour X observable via Y; one spec per caller-visible outcome, only when the behaviour is new or changed>.
- [ ] CodeScene (if available): one `code_health_review` of changed production files; fix an obvious decline you introduced, otherwise mention it. No scores table, no second pass.
- [ ] Diff limited to the owned files; no unrelated reformatting or renames. Work only in this repository and issue; report anything else instead of doing it.
- [ ] Every claim of "done" is backed by a check you ran on the final code state; a report without a run check is "unverified", not done.
- [ ] The deliverable is the change in the repository, not notes about it. Decide reversible implementation details yourself and record the choice in the report; ask only for decisions the brief reserves.
- [ ] Once the required checks pass, broaden or repeat testing only when new changes, failures or unresolved concerns justify it.
- [ ] Committed locally with a clear message. Do not push.

## Working efficiently
- Every tool call re-reads your whole context: batch independent reads/greps in one message, `rg` before a ranged `read`, one `edit` per file, never print whole logs.
- Budget: about 40 tool calls for this unit. If you will exceed it, write `handoff.md` and report; the parent resumes you rather than respawning.

## Plan (optional; filled by `planner`)
Ordered, small steps, each naming the file(s) and the change, and the spec for each new or changed caller-visible behaviour (none for refactors, docs or prose).

## Execution policy (binding — do not re-decide)
- pi-phase policy: auto / direct / fast / queued (pass `--policy` for an explicit choice); pack/restore use `--kind build`, including `pi-phase run --kind build ... -- bash …/cratis-local-packages.sh pack-nuget …` (inner dotnet shim applies; version/stamp tokens are normalized for history).
- High priority: yes / no.
- These execution decisions override general rules; run the exact gate below.

## Verify with
- Configuration to verify: <e.g. Release, warnings as errors; must match CI>.
- Iterate with: `<narrow affected-project command>` (the parent fills this in; `pi-affected` can suggest it). Optional `pi-phase run --profile iterate` turns analyzers off for speed; such runs do not count for the Done check.
- Finish with the Done check once. Use `pi-phase run ... --log <repo>/.ai-work/<task>/<phase>.log` instead of redirects, pipes or `; echo $?`. A `pi-phase run` goes alone in its tool turn, never batched with edits or quick checks (a parallel batch records results only when all calls finish).

## Stop and report (do not work around) when
- The gate fails for a reason outside your files, or a pre-existing test fails.
- The spec is ambiguous or the fix needs a design decision.
- You would need to touch files outside "Files you own".
- Two attempts at the same code or test failure did not change the result. Never rerun a failed phase on an unchanged tree: read the failing log first, then change code, inputs or the diagnosis (a named flaky or infrastructure cause) before the rerun.
- `pi-phase` exit 75 (queue timeout) is not a failed attempt. Never loop short requeues (each retry goes to the back). Continue code work, then retry the phase once in the background (`job_start`) with `--queue-timeout 3600 --approved-long-timeout` (up to 7200 for integration; a deep `pi-phase status` queue is the runtime basis) and `--priority low` unless a merge waits on it. If that also times out, report "gate not run: queue saturated", not "failed". A duplicate CI watcher also returns 75: reuse the existing watch, do not retry it.

## Report back (≤ 1.5k characters; details go in a file)
Status (done / blocked), commits (SHA + subject), gate command + exit code, files changed, anything skipped or open.
Write a short handoff to `<repo>/.ai-work/<task>/handoff.md` before reporting if work is unfinished.
