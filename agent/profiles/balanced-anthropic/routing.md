## Model routing

Active profile: **balanced-anthropic** (`~/.pi/agent/bin/pi-profile`). Balanced quality, deliberately leaning on Claude Max capacity. Keep OpenAI for independent review and hard second opinions; Kimi K3 is used for repository exploration and web-source gathering.

Delegate by agent type; each type pins its own model and thinking level. Never pass a `model` override to `Agent`.

### Evidence-based defaults (October 2026)
- Effort is a spend dial more than a carefulness dial. On real monorepo changes, Opus 5.5 peaked at medium; higher effort produced larger diffs and more regressions. Use high/xhigh only for named hard reasoning.
- GPT-6.1 Sol high is the default for bounded, test-gated implementation: it reached the correctness ceiling on VulcanBench from high upward at low cost. It has weak scope discipline, so every brief must state scope, files, checks and stop conditions; unrelated failures are reported, not fixed.
- Sonnet 5.5 low/medium had zero regressions across 100 real changes; use `careful-implementer` when preserving existing behaviour, UI or user-facing text matters, or tests are weak.
- Opus 5.5 is the main orchestrator and judgement model; Opus/Fable lead source synthesis evidence, while Astra leads science and harder cross-file review evidence.
- Kimi K3 is configured as `kimi-coding`. Use K3 256K for exploration and research capacity; verify its claims, and keep final decisions with Claude/OpenAI until local evaluations justify more.

### Agent routing
- `careful-implementer`: Claude Sonnet 5.5, medium
- `cleanup-steward`: Claude Sonnet 5.5, medium
- `content-writer`: Claude Opus 5.5, medium
- `cratis-cli`: Claude Sonnet 5.5, medium
- `doc-writer`: Claude Sonnet 5.5, medium
- `Explore`: Kimi K3 256K, low
- `general-purpose`: Claude Sonnet 5.5, medium
- `grunt`: Claude Sonnet 5.5, low
- `implementer`: Claude Sonnet 5.5, medium
- `opus-implementer`: Claude Opus 5.5, medium
- `Plan`: Claude Opus 5.5, high
- `planner`: Claude Opus 5.5, high
- `prose-editor`: Claude Sonnet 5.5, low
- `reviewer`: Claude Opus 5.5, medium
- `scout`: Kimi K3 256K, high
- `second-opinion`: GPT-6 Astra, high
- `sol-reviewer`: GPT-6.1 Sol, high

### Usage
- Event modeling, event sourcing and Screenplay: in repositories with the Cratis AI corpus installed (`cratis ai`, profile `cratis/screenplay`), follow the corpus skills (start with `cratis-screenplay-event-modeling`) and use its Screenplay Modeler, Reviewer and Renderer agents. Keep the independent review on the other provider (`reviewer`/`second-opinion`/`sol-reviewer`). `cratis prologue start`, Extractor runs, `prologue interpret` with an LLM configured, and `render --force` need explicit approval.

- Main session: Opus 5.5 medium by default (OpenAI-heavy: GPT-6.1 Sol high). Raise to high only for difficult design/debugging, then lower it.
- `implementer` for clear, testable work; `careful-implementer` for behaviour-preserving changes; `opus-implementer` only when you can name the unresolved design question or hard-bug judgement.
- Plan, then implement: once a request is decided to become an issue/task, run `planner` (high) to write `<repo>/.ai-work/<task>/plan.md`; read it, resolve BLOCKING questions, then hand the plan to the cheaper implementer it recommends. Skip the planner for trivial or mechanical changes (a known one-file edit, renames, bumps). The planner is read-only apart from that one file.
- `cleanup-steward` performs post-work inventory and only explicitly authorised, safety-checked cleanup.
- Cross-provider review: `reviewer` reviews GPT-written work; `sol-reviewer` reviews Claude-written work. Before merge run the `review` workflow (Opus + Sol) and always pass `author` (`gpt` when `implementer` wrote it, so Astra rather than Sol verifies Opus's findings); pass `deep: true` (Astra instead of Sol) only for security-sensitive, algorithmic/concurrency or large cross-cutting changes.
- Keep OpenAI spend down: use `second-opinion` (Astra) only for named hard reasoning — math, algorithms, proofs, a stuck hard bug or a contested design — not as a routine reviewer. Never raise its effort above high.
- Start a fresh parent session from a short `.ai-work/` handoff around ~600k tokens (hard ceiling 800k; see "Orchestrator context" in the global rules).
- Delegate searches needing more than about three grep/find/read calls to `Explore`, extraction from long logs to `grunt`, and multi-source web research to `scout`.
- Never poll: no repeated sleep/check loops, `.output` tailing, or repeated CI status calls. For waits longer than a minute, use `job_start` (e.g. `gh run watch <run-id> --exit-status`) or `job_watch` (re-runs a check until it passes), then end the turn: the completion message wakes you. Do not call `job_list`/`job_output` to wait. Otherwise use one bounded waiting command.
- Never call `get_subagent_result` with `wait: true`; completion notifications start a new turn.
- In repositories with Cratis AI installed, its rules and skills take precedence for Cratis conventions; prefer these pinned agent types over Cratis corpus agents, which inherit the session model.
- MCP calls that change state require user approval. If a model refuses, report it and suggest another agent type; do not work around refusals.
