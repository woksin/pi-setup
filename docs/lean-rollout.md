# Lean routing rollout

## Source-first delivery

This delivery changes source/configuration and policy only. It does not activate the installed setup, enforce session admission, park lanes, add persistent subscriptions or change the handoff/fallback engines. Keep existing active inbox watches armed and re-arm on wakes and resets; timeout-only wakes are silent.

`balanced` remains the automatic default with Claude and ChatGPT. `lean` is opt-in, ranks below `balanced`, requires both providers and uses no Kimi. The optional public `kimi-heavy` profile remains available but is not selected by lean. Default/shared and balanced-openai ops/scout also use Haiku; Claude/OpenAI controlled fallback and restoration remain enabled.

## Routing and scheduling policy

- Ordinary worker main sessions: Sonnet 5.5 medium. Orchestration: Opus 5.5 medium.
- At most six active worker lanes plus two orchestration sessions globally, across repositories, not per repository. Coordinators enforce this policy manually; source/runtime admission enforcement and parking are a later delivery. Do not cancel inbox watches as a substitute for parking.
- Lean planner, Plan and general-purpose: Sonnet medium; ops: Haiku low; scout: Haiku medium with its existing research tools. Ambiguous reasoning goes to Sonnet/Opus, not more Haiku fan-out.
- Sol high implementation, Sonnet medium careful implementation, Opus medium review, Sol high review and existing narrowly scoped Astra roles are unchanged. The full review workflow is an unchanged copy, including independent provider verification, security coverage (also for config/tests/docs), review caps and Astra verification semantics. There is no diff-size security exemption.
- Use a planner only for more than three implementation files, a cross-repository dependency or a named unresolved design/behaviour question. Tests and docs do not inflate the count. Otherwise the main session writes the standard brief. Reuse valid plans; never pair Plan and planner. Stronger user/repository requirements take precedence.

Only send actionable coordination: deliveries, blocker changes, questions/decisions or new relevant safety holds. Address the owner/parent, not cc recipients. Acknowledge actionable deliveries/questions, not information-only messages or acknowledgements. No unchanged status or hourly waiting messages. Renew waiting-on leases locally; notify once on blocking, then on material change, lease expiry or explicit request. ALL is reserved for truly global safety holds; preserve targeted critical alerts. Existing watches remain in use; this policy does not claim durable subscriptions exist.

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
