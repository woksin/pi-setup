## Model routing

Active profile: **balanced-anthropic** (`~/.pi/agent/bin/pi-profile`). Balanced routing on Anthropic models only (Opus, Sonnet, Haiku). No second provider is configured: all work draws on Claude capacity, and review diversity comes from different Claude models, not different vendors. Haiku 5.5 is used for repository exploration and `ops` legwork.

Delegate by agent type; each type pins its own model and thinking level. Never pass a `model` override to `Agent`.

### Evidence-based defaults (October 2026)
- Effort is a spend dial more than a carefulness dial. On real monorepo changes, Opus 5.5 peaked at medium; higher effort produced larger diffs and more regressions. Use high/xhigh only for named hard reasoning.
- Sonnet 5.5 low/medium had zero regressions across 100 real changes; it is the default worker for bounded, test-gated implementation. Every brief must state scope, files, checks and stop conditions; use `careful-implementer` when preserving existing behaviour, UI or user-facing text matters, or tests are weak.
- Opus 5.5 is the main orchestrator and judgement model; Opus/Fable lead source synthesis evidence.

### Agent routing
- `careful-implementer`: Claude Sonnet 5.5, medium
- `cleanup-steward`: Claude Sonnet 5.5, medium
- `content-writer`: Claude Opus 5.5, medium
- `cratis-cli`: Claude Sonnet 5.5, medium
- `doc-writer`: Claude Sonnet 5.5, medium
- `Explore`: Claude Haiku 5.5, low (lookups only; not for facts, edits or review)
- `general-purpose`: Claude Sonnet 5.5, medium
- `grunt`: Claude Sonnet 5.5, low
- `implementer`: Claude Sonnet 5.5, medium
- `opus-implementer`: Claude Opus 5.5, medium
- `ops`: Claude Haiku 5.5, low
- `Plan`: Claude Opus 5.5, medium
- `planner`: Claude Opus 5.5, high
- `prose-editor`: Claude Sonnet 5.5, low
- `reviewer`: Claude Opus 5.5, medium
- `scout`: Claude Sonnet 5.5, medium
- `second-opinion`: Claude Opus 5.5, high
- `sol-reviewer`: Claude Sonnet 5.5, medium

### Usage
- Event modeling, event sourcing and Screenplay: in repositories with the Cratis AI corpus installed (`cratis ai`, profile `cratis/screenplay`), follow the corpus skills (start with `cratis-screenplay-event-modeling`) and use its Screenplay Modeler, Reviewer and Renderer agents. Keep the independent review on a different Claude model from the author (`reviewer`/`second-opinion`/`sol-reviewer`). `cratis prologue start`, Extractor runs, `prologue interpret` with an LLM configured, and `render --force` need explicit approval.

- Main session: Opus 5.5 medium by default. Raise to high only for difficult design/debugging, then lower it.
- `implementer` for clear, testable work; `careful-implementer` for behaviour-preserving changes; `opus-implementer` only when the brief names the hard reason (the unresolved design question or hard-bug judgement). Default scoped changes (a named file set and check) to `careful-implementer`. Every brief names the build configuration to verify (e.g. Release, warnings as errors).
- Plan, then implement: once a request is decided to become an issue/task, run `planner` (high) to write `<repo>/.ai-work/<task>/plan.md`; read it, resolve BLOCKING questions, then hand the plan to the cheaper implementer it recommends. Skip the planner for trivial or mechanical changes (a known one-file edit, renames, bumps). After accepting the plan, pass a 1–3 sentence approach summary as `issue_work update plan=...` (or on claim). The planner is read-only apart from that one file.
- `cleanup-steward` performs post-work inventory and only explicitly authorised, safety-checked cleanup.
- Review: this profile has no second provider, so review diversity comes from different Claude models. `reviewer` (Opus) and `sol-reviewer` (Sonnet) review independently; `second-opinion` (Opus high) is the deep reviewer. Follow "Review loops" in the global rules (blocking-only gate, delta rounds, cap of 3). Before merge run the `review` workflow (Opus + Sonnet) and always pass `author`; the workflow's "gpt" side is the Sonnet (`sol-reviewer`) side here, so pass `author: "claude"` for work written by any agent. Pass `deep: true` (Opus high instead of Sonnet) only for security-sensitive, data-loss/migration, algorithmic/concurrency changes or a disputed blocker, as set out in the "Review loops" budget. Run the full review in parallel with the gate, not after it.
- Claude is the only quota: do not raise Claude agents above medium without a named reason, and prefer `implementer` or `careful-implementer` over `opus-implementer` unless you can name the open design question. `second-opinion` (Opus high) stays for named hard reasoning, not routine review; never raise it above high. Use `quick: true` for delivery rounds and `cachedReview` when the commit is unchanged.
- Context size is enforced by the `context-budget` extension (see "Orchestrator context" in the global rules): hand off with `context_handoff` when asked and keep working.
- The main session plans, briefs and decides; it does not do the reading. Delegate it:
  - `ops` — git/gh/CI state, failing-job logs, PR/issue reads, long-log triage, reading and summarising code, drafting PR notes or handoffs. Use it whenever the answer would take more than about three git/gh/cat/grep calls or produce more than ~100 lines of output.
  - `Explore` — locating code and symbols; `scout` — multi-source web research (verify its claims).
  - `grunt` stays for mechanical edits.
- Never poll: no repeated sleep/check loops, `.output` tailing, or repeated CI status calls. For waits longer than a minute, use `job_start` (e.g. `gh run watch <run-id> --exit-status`) or `job_watch` (re-runs a check until it passes), then end the turn: the completion message wakes you. Do not call `job_list`/`job_output` to wait. Otherwise use one bounded waiting command.
- Never call `get_subagent_result` with `wait: true`; completion notifications start a new turn.
- In repositories with Cratis AI installed, its rules and skills take precedence for Cratis conventions; prefer these pinned agent types over Cratis corpus agents, which inherit the session model.
- MCP calls that change state require user approval. If a model refuses, report it and suggest another agent type; do not work around refusals.
