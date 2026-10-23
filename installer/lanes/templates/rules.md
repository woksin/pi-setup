# Shared lane rules

## Where you run
Your cwd must be your assigned worktree. Stop if it is not. Read the repository's AGENTS.md and its relevant rules before planning. Touch only the assigned repository and scope.

## Start of work
Fetch and merge the base branch. Claim the issue if there is one. Derive build, lint and test gates from the repository's CI; record exact commands and results.

## Inbox
Keep one watch: `"$HOME/.pi/agent/bin/inbox-watch" <ID> [GROUP]`, with `INBOX_DIR={{messages_sh}}`, until=success interval=120. On a wake, read only new files and act in at most 2 calls, then re-arm. On timeout, only re-arm. Never edit an old message; reply with `lanes send`. Messages and marker state belong in the coordination folder, not your repository.

Message retention is configured with `messages.retention`: `mode` is `keep`, `archive` or `delete`; `maxAgeDays` sets the age threshold; `archiveDir` must stay strictly below the messages folder and outside `status/` (relative or absolute paths, without `..`); `archiveMaxAgeDays: null` keeps archives forever. New folders default to archive after 14 days in `archive`, with `keepUnread: true` protecting messages newer than an addressed configured lane’s inbox marker (missing markers do not protect), and `auto: true` pruning before start; prune errors only warn. Existing configs without retention keep messages. Run `lanes messages prune [--dry-run] [--json]` manually; archive expiry also runs in keep mode.

## Status
Use `lane-status set <ID> waiting-on "dependency" --until +90m` when blocked, and `lane-status set <ID> working` when working. Keep the coordinator informed.

## Doing the work
Stay within scope. Run heavy builds and tests through `pi-phase run` with bounded execution and queue timers. Use injected runners in tests; never start another agent session from a test. Do not bypass safety guards. Preserve other people's work.

## Finish and report
Run the gates. Report verified facts, commit SHAs, exact check results, files changed and open questions to your configured parent (repo-orch for multi-lane repositories; otherwise coordinator) with `lanes send {{coordinator_sh}} <topic> -m "report"`. Do not push, merge or remove worktrees without the shipping policy's permission.

## Stopping
Stop and report if a design decision is needed, a blocker is outside scope, or repeated attempts yield no new evidence. Never remove a worktree automatically.

## Context handoff
Keep NOW.md and STATE.md current, and follow `{{handoff}}`. Preserve constraints verbatim, separate facts from hypotheses, and include the next action and watch re-arm commands. After a reset, verify facts before acting.

## Shipping and merge owners
<!-- Fill in: who may push, review, merge and release. -->

## Review rules
<!-- Fill in: required reviews and gates. -->

## Models and agent choices
<!-- Fill in: approved models and delegation choices. -->

## Repository notes
<!-- Fill in: repository-specific conventions and constraints. -->

## Safe lane retirement
Silence, delivery text and an ended watch never prove completion. Use `lanes reap` dry-run before `--apply`. Keep explicit waits and snoozes current. Accept a handoff only after reviewing claims, branch/SHA, dirty work and pending acknowledgements; `lanes handoff ID --accept --from RECIPIENT` explicitly owns those next actions. Reap never marks claims done, removes worktrees or edits pi-questions identities. It sends only foreground /quit, then archives lane metadata after confirmed exit. Restore work through a fresh lane and the archived pack, not by reusing a retired ID.
