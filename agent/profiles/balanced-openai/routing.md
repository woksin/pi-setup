## Model routing

Active profile: **balanced-openai** (`~/.pi/agent/bin/pi-profile`). Balanced routing with spare OpenAI weekly capacity spent where GPT is strongest, one thinking level above `balanced`: Sol for test-gated and security-related implementation, Cratis CLI diagnosis and reviewing Claude-written work; Astra for hard reasoning and the GPT side of full reviews. Claude keeps orchestration, planning, writing, mechanical edits, cleanup and behaviour-preserving changes, where its scope discipline is the evidence. Switch back to `balanced` when OpenAI usage runs low. Haiku 5.5 is used for repository exploration; Kimi K3 for web-source gathering.

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
- `cratis-cli`: GPT-6.1 Sol, xhigh
- `doc-writer`: Claude Sonnet 5.5, medium
- `Explore`: Claude Haiku 5.5, low (lookups only; not for facts, edits or review)
- `general-purpose`: Claude Sonnet 5.5, medium
- `grunt`: Claude Sonnet 5.5, low
- `implementer`: GPT-6.1 Sol, xhigh
- `opus-implementer`: Claude Opus 5.5, medium
- `ops`: Kimi K3 256K, low
- `Plan`: Claude Opus 5.5, high
- `prose-editor`: Claude Sonnet 5.5, low
- `reviewer`: Claude Opus 5.5, medium
- `scout`: Kimi K3 256K, high
- `second-opinion`: GPT-6 Astra, xhigh
- `sol-reviewer`: GPT-6.1 Sol, xhigh

### Usage
- Event modeling, event sourcing and Screenplay: in repositories with the Cratis AI corpus installed (`cratis ai`, profile `cratis/screenplay`), follow the corpus skills (start with `cratis-screenplay-event-modeling`) and use its Screenplay Modeler, Reviewer and Renderer agents. Keep the independent review on the other provider (`reviewer`/`second-opinion`/`sol-reviewer`). `cratis prologue start`, Extractor runs, `prologue interpret` with an LLM configured, and `render --force` need explicit approval.

- Main session: Opus 5.5 medium by default (OpenAI-heavy: GPT-6.1 Sol high). Raise to high only for difficult design/debugging, then lower it.
- `implementer` for clear, testable work; `careful-implementer` for behaviour-preserving changes; `opus-implementer` only when you can name the unresolved design question or hard-bug judgement.
- `cleanup-steward` performs post-work inventory and only explicitly authorised, safety-checked cleanup.
- Cross-provider review: `reviewer` reviews GPT-written work; `sol-reviewer` (xhigh) reviews Claude-written work. Follow "Review loops" in the global rules (blocking-only gate, delta rounds, cap of 3). Before merge run the `review` workflow (Opus + GPT-6 Astra: high review, xhigh verification, in this profile) and always pass `author`; pass `deep: true` (Astra reviews at xhigh too) for security-sensitive, algorithmic/concurrency or large cross-cutting changes.
- OpenAI capacity is plentiful in this profile: use `second-opinion` (Astra xhigh) freely for hard reasoning, contested designs, stuck bugs and as a second review of important Claude-written plans. Route clear, well-tested changes to `implementer` (Sol xhigh); keep `careful-implementer` (Sonnet) for changes where tests are weak or existing behaviour, UI or user-facing text must be preserved — its regression record is the evidence there, not cost.
- Start a fresh parent session from a short `.ai-work/` handoff around ~600k tokens (hard ceiling 800k; see "Orchestrator context" in the global rules).
- The main session plans, briefs and decides; it does not do the reading. Delegate to Kimi (pilot, re-evaluated with `~/.ai-work/pi-usage-eval/analyze.py`):
  - `ops` — git/gh/CI state, failing-job logs, PR/issue reads, long-log triage, reading and summarising code, drafting PR notes or handoffs. Use it whenever the answer would take more than about three git/gh/cat/grep calls or produce more than ~100 lines of output.
  - `Explore` — locating code and symbols; `scout` — multi-source web research.
  - `grunt` stays for mechanical edits.
- Never poll: no repeated sleep/check loops, `.output` tailing, or repeated CI status calls. For waits longer than a minute, use `job_start` (e.g. `gh run watch <run-id> --exit-status`) or `job_watch` (re-runs a check until it passes), then end the turn: the completion message wakes you. Do not call `job_list`/`job_output` to wait. Otherwise use one bounded waiting command.
- Never call `get_subagent_result` with `wait: true`; completion notifications start a new turn.
- In repositories with Cratis AI installed, its rules and skills take precedence for Cratis conventions; prefer these pinned agent types over Cratis corpus agents, which inherit the session model.
- MCP calls that change state require user approval. If a model refuses, report it and suggest another agent type; do not work around refusals.
