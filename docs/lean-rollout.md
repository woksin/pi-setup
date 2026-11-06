# Lean routing rollout

## Source-first delivery

This delivery changes source/configuration, primary-launch admission and explicit parking only. It does not activate the installed setup, park existing lanes, add persistent subscriptions or change the fallback engine. Handoff restoration now persists only at the validated, admitted actual launch, never in the terminal-request parent. Keep existing active inbox watches armed and re-arm on wakes and resets; timeout-only wakes are silent. Cancel a watch only as part of explicit parking with a handoff.

`balanced` remains the automatic default with Claude and ChatGPT. `lean` is opt-in, ranks below `balanced`, requires both providers and uses no Kimi. The optional public `kimi-heavy` profile remains available but is not selected by lean. Default/shared and balanced-openai ops/scout also use Haiku; Claude/OpenAI controlled fallback and restoration remain enabled.

## Routing and scheduling policy

- Ordinary worker main sessions: Sonnet 5.5 medium. Orchestration: Opus 5.5 medium.
- At most six active worker lanes plus two orchestration sessions globally, across repositories, not per repository. The primary launcher enforces separate non-borrowing pools across roots sharing one Pi agent directory. Coordinators must still budget SDK fan-out cooperatively; SDK agents, prompts in existing sessions and arbitrary hand-started processes are outside this interception boundary. Do not cancel inbox watches as a substitute for explicit parking.
- Lean planner, Plan and general-purpose: Sonnet medium; ops: Haiku low; scout: Haiku medium with its existing research tools. Ambiguous reasoning goes to Sonnet/Opus, not more Haiku fan-out.
- Sol high implementation, Sonnet medium careful implementation, Opus medium review, Sol high review and existing narrowly scoped Astra roles are unchanged. The full review workflow is an unchanged copy, including independent provider verification, security coverage (also for config/tests/docs), review caps and Astra verification semantics. There is no diff-size security exemption.
- Use a planner only for more than three implementation files, a cross-repository dependency or a named unresolved design/behaviour question. Tests and docs do not inflate the count. Otherwise the main session writes the standard brief. Reuse valid plans; never pair Plan and planner. Stronger user/repository requirements take precedence.

Only send actionable coordination: deliveries, blocker changes, questions/decisions or new relevant safety holds. Address the owner/parent, not cc recipients. Acknowledge actionable deliveries/questions, not information-only messages or acknowledgements. No unchanged status or hourly waiting messages. Renew waiting-on leases locally; notify once on blocking, then on material change, lease expiry or explicit request. ALL is reserved for truly global safety holds; preserve targeted critical alerts. Existing watches remain in use; this policy does not claim durable subscriptions exist.

## Runtime admission and parking

All start/resume and terminal backends print or invoke `lanes --dir ROOT run ID`. Printing or opening an unused tab reserves nothing. Execution reloads validated configuration and atomically admits just before spawning the configured wrapper with inherited stdio; the lease spans wrapper relaunches. `coordinator.maxRunning` defaults to six and is the local worker limit, capped at six even for legacy larger values. Only the coordinator and validated repo-orch/sub-orch roles use the two orchestration slots. Observed unmanaged Pi and extra Pi descendants count conservatively as workers. Over-budget existing work is not killed.

Leases and a bounded exclusive lock live under `PI_CODING_AGENT_DIR/lanes-admission` (default `~/.pi/agent`). Different agent directories are separate registries. Unknown inventories, reused identities, malformed state and uncertain cleanup refuse/retain rather than guessing. A crashed controller can leave a pending lease or lock that requires operator inspection; never clear it by age alone. No live installation or activation is part of this delivery.

To park: write a compact handoff naming owner/dependency/assessment, set `lane-status set ID parked "dependency / owner" --until +90m`, cancel the inbox watch and obsolete waits, then settle without replacement. The timestamp is an assessment for the coordinator, not an automatic wake. Idle-check/nudge and inbox recovery suppress parked lanes until explicit `lane-status set ID working` (or closed). A live parked primary still consumes admission; do not reap/close to manufacture capacity. Finite waiting-on/barred-by behavior is unchanged.

## Activation after review

Activation is a separate parent/operator step; do not run it as part of this source delivery.

1. Record the active profile, installed-file drift and existing session models. Back up the installed context/fallback configs, managed routing block, agents and workflows before changes. Preserve unrelated local edits; do not use `--force` to discard drift.
2. Review the source diff and local test evidence. Install the complete lean profile assets through the normal managed setup path only after resolving drift. Select `pi-profile use lean`; profile selection changes agent/workflow routing, not existing main-session model choices. Start worker main sessions explicitly on Sonnet medium and orchestration on Opus medium. Existing sessions need deliberate reconciliation, not a claim that selecting a profile switched all of them.
3. Merge the source context override into the installed JSON: `mode: enforce` and `main: {soft: 150000, handoff: 220000, hard: 400000, minProgress: 50000}`. Preserve local `resumeChecks`, subagent/model overrides and every other unrelated key. Do not replace the entire installed JSON with the small source file. Review model-specific overrides for the intended effective thresholds before activation.
4. Reconcile fallback config to remove Kimi pairs/chains/unavailability without discarding local unrelated settings or Claude/OpenAI recovery. Preserve unrelated live drift. Confirm effective lean/default ops/scout have Haiku pins and no Kimi route.
5. Keep state current: write the main handoff at 150k tokens, reset through the existing `context_handoff` mechanism by 220k and treat 400k as a hard guardrail, not a target. Subagent budgets and safety flags are unchanged. Do not manually reset jobs, claims or watches.

## Pilot and rollback

Check actual model pins, complete profile assets, provider-independent review/security results, context resets, worker/orchestrator counts and inbox re-arm behavior. Compare usage and delivery quality against the recorded baseline; fewer messages or lower tokens alone are not evidence of correctness. Stop rollout on missing security coverage, routing mismatch, lost actionable alerts or handoff failures. Do not resolve failures by disabling guards or review.

To undo profile selection, use `pi-profile use balanced` after accounting for live drift. This does not undo context/fallback configuration, installed rules/templates or main-session model choices: restore their reviewed pre-activation snapshots separately, preserving later unrelated edits. Reconcile models and active watches and verify effective configuration before resuming work. Keep source fixes and activation/rollback evidence separate; no push or release is part of this delivery.
