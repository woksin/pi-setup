# Operating lessons

Lessons from running many agent sessions ("lanes") in parallel on one machine. Each entry records the symptom, the cause, the rule that prevents it, and where that rule is enforced. When an orchestrator or lane hits a systemic problem, it appends an entry here (see "Record lessons" in `agent/AGENTS.md`).

Enforcement levels: **tool** (the setup does it or warns), **rule** (an `AGENTS.md` rule agents follow), **practice** (orchestrator habit, not yet automated).

## 2026-10-24

### Waiting on events that local tools remove
- **Symptom:** many lanes idle "waiting on" a train merge, a package release or an owner's cut, some for hours.
- **Cause:** lanes treated merges, releases and owner events as blockers.
- **Rule:** base work on the local candidate branch; verify against locally built packages; drop an item from a candidate after 2 h instead of holding the candidate; owners cut at least every 4 h. Only the build queue is a real wait, and it is used for independent work.
- **Enforced:** rule (`AGENTS.md`, "Shipping finished work").

### Full hang dumps fill the disk
- **Symptom:** free disk fell from 27 GiB to 5 GiB in two minutes.
- **Cause:** a recommended test command used `--blame-hang`, whose default dump type is full (7.4 GB per dump).
- **Rule:** mini dumps only (`--blame-hang-dump-type mini`, `--hangdump-type Mini`); delete `.dmp` files once the stack is extracted.
- **Enforced:** tool (pi-phase warns before such phases and lists leftover dumps of 1 GiB or more afterwards).

### Provider fallback does not restore after limits lift
- **Symptom:** sessions stayed on the fallback model after the primary provider's limits reset; restoring meant editing the limits file and switching every terminal by hand.
- **Rule:** one command restores the original model, and one broadcast restores all main sessions.
- **Enforced:** tool. `/provider-restore [provider]` clears the limit mark and restores this session; `/provider-restore --all` or the `provider-restore [provider] --all-sessions` command also tells every running session to restore at its next turn. A fresh real limit still wins. See `agent/provider-fallback.md`.

### Fallback switches forced constant compaction
- **Symptom:** main sessions compacted far too often because fallback refused to switch above a fixed 150k-token context.
- **Cause:** one fixed limit for every target model and session kind.
- **Rule:** the limit follows the target model and the session's own handoff threshold; over the limit, hand off first and switch at the next prompt.
- **Enforced:** tool (`maxContextTokensForFallback: "auto"`, the smaller of the context-budget handoff threshold and `fallbackContextRatio` × (target window − max output); a number is an explicit override).

### Lanes lose their inbox watch silently
- **Symptom:** lanes ran without an inbox watch for an unknown time and missed messages.
- **Rule:** a lane re-arms its inbox watch on every wake.
- **Enforced:** tool (the `inbox-rearm` extension blocks the turn with the exact re-arm call when a finished inbox watch has no replacement) and rule (`AGENTS.md`, "Orchestrator context").

### Agents file more issues than they close
- **Symptom:** over seven days, open issues grew by more than 200, three quarters of them created by agents.
- **Rule:** fix small same-area leftovers in place (under about an hour); review findings go into the PR; one issue with a checklist per cluster; close epics whose leftovers are tracked; ship smaller trains more often.
- **Enforced:** rule (`AGENTS.md`, "GitHub issues and pull requests").

### Green but stale pull requests
- **Symptom:** a PR was green on CI from two days earlier while main had changed the same paths, and it had no final review.
- **Rule:** before merging, check main for overlapping changes since the CI run; if any, merge main, rerun CI and review.
- **Enforced:** rule (`AGENTS.md`, "Shipping finished work") and tool (`lanes green-prs` flags stale PRs).

### The critical path stuck in the queue
- **Symptom:** the release build that eight lanes waited on sat at rank 30 in the build queue.
- **Rule:** the orchestrator grants high priority, time-boxed, to the one phase chain most lanes depend on.
- **Enforced:** rule (`AGENTS.md`, execution budgets) and tool (`pi-phase status` points out the likely critical-path chain).

### Repository policy specs can encode tooling choices
- **Symptom:** removing a tool across an organisation broke CI in a repository whose specs required that tool's config file.
- **Rule:** before an organisation-wide tooling removal, search specs and docs for anything that encodes it.
- **Enforced:** rule (`AGENTS.md`).

### Roll calls need evidence
- **Symptom:** self-reported status was mostly accurate, but an independent check found a stale PR, a dead lane and unanswered roll calls.
- **Rule:** pair every roll call with a read-only git/GitHub audit.
- **Enforced:** practice (orchestrator).
