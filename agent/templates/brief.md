# Brief: <one-line goal> (<repo>#<issue>)

Copy to `<repo>/.ai-work/<task>/brief.md`, fill every section, and pass the agent only:
"Read and follow <absolute path to this brief>." plus anything run-specific.

## Goal
<What must be true when you are done, in 1–3 sentences. Link the issue.>

## Where
- Worktree / branch: <absolute path> (`<branch>`). Work only there.
- First step: `git fetch origin && git merge origin/main` (or rebase if the repo does that); stop and report on conflicts you cannot resolve mechanically.
- Files / areas you own: <paths>. Do not edit anything else.
- Read first (only these): <rules/docs paths>.

## Done =
- [ ] The Tier 1 gate `<exact command, e.g. .ai-work/ci-local.sh>` exits 0 (whole-solution build with CI's configuration and warnings, lint, all non-integration tests). Affected-project commands are for iterating only, never completion evidence. If a Tier 1 part genuinely cannot run here, name it and say what ran instead.
- [ ] <acceptance check: failing-first spec now passes / behaviour X observable via Y>.
- [ ] Diff limited to the owned files; no unrelated reformatting or renames.
- [ ] Committed locally with a clear message. Do not push.

## Verify with
- Iterate with: `<narrow affected-project command>`.
- Finish with the Done gate once. Use `pi-phase run ... --log <repo>/.ai-work/<task>/<phase>.log` instead of redirects, pipes or `; echo $?`.

## Stop and report (do not work around) when
- The gate fails for a reason outside your files, or a pre-existing test fails.
- The spec is ambiguous or the fix needs a design decision.
- You would need to touch files outside "Files you own".
- Two attempts at the same failure did not change the result.

## Report back (≤ 25 lines)
Status (done / blocked), commits (SHA + subject), gate command + exit code, files changed, anything skipped or open.
Write a short handoff to `<repo>/.ai-work/<task>/handoff.md` before reporting if work is unfinished.
