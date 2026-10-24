# Provider fallback and recovery

`provider-fallback.json` controls equivalents/chains and provider limits. Provider limit marks live in `.provider-limits.json` beside the agent config. Automatic expiry restores the remembered original model unless `restoreWhenExpired` is false.

After provider recovery, `/provider-restore [provider]` clears one provider's mark (or all marks when omitted) and immediately restores this session's remembered original, even with expiry restoration disabled. Add `--all` to broadcast to other running sessions. The stdlib-only `provider-restore [provider] [--all-sessions]` CLI always clears and broadcasts, without restarting sessions. It honors `PI_PROVIDER_FALLBACK_STATE` and `PI_CODING_AGENT_DIR`.

Broadcast epochs live in `.provider-restore.json` beside the limit state. Other sessions consume them at the next turn/agent boundary, not in a polling loop. Only sessions still on an extension-selected fallback with a remembered original restore; manual choices and sessions started on the fallback remain unchanged. A new real provider limit wins over an older restore request. Recovery does not disable future fallback.

## Context allowance

- `maxContextTokensForFallback`: default `"auto"`. A number is an explicit token override; `0` disables this fallback context check.
- `fallbackContextRatio`: default `0.5`.

Auto allowance is `min(session handoff threshold, fallbackContextRatio × (TARGET contextWindow − TARGET maxTokens))`. Window and maximum output tokens come from the pi model registry, not the current model. For a main session, a 1.05M-window target normally caps at 400k; a 272k window with 128k output yields 72k. Subagents normally cap at 200k.

The role is read from the context-budget extension's current-process session status when available; otherwise UI sessions use main defaults and headless sessions use subagent defaults. Handoff thresholds are read from `context-budget.json` (`main.handoff`, `subagent.handoff`, and `models[CURRENT_MODEL][role].handoff`), honoring `PI_CONTEXT_BUDGET_CONFIG` and `PI_CONTEXT_BUDGET_STATE_DIR`. Missing config uses 400k/200k; missing target-window metadata uses the handoff cap.

Above the allowance, the notice gives the effective threshold and target and asks for `context_handoff` now (or `/compact`), ending the turn. The provider mark is retained. At the next prompt, fallback is attempted again against the reduced context; limits and other safety checks still apply. This does not turn off the context guard or compact destructively on the operator's behalf.
