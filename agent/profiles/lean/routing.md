## Model routing

Active profile: **lean** (`~/.pi/agent/bin/pi-profile`). Opt-in only (`pi-profile use lean`). Sonnet plans and handles ordinary workers, Haiku gathers bounded evidence, Opus orchestrates and independently reviews; Sol implements. Balanced remains the default. Uses each provider where the evidence is strongest. Claude is the constrained quota (Oct 3–17: Anthropic usage-limit hits every day, about 3,000 in total; OpenAI 39), so low-risk roles run on GPT and `provider-fallback` moves a session to GPT when Claude hits its limit. Further role moves wait for measured quality evidence. Haiku 5.5 gathers bounded repository, operational and web evidence; escalate ambiguous reasoning to Sonnet/Opus.

Delegate by agent type; each type pins its own model and thinking level. Never pass a `model` override to `Agent`.

### Evidence-based defaults (October 2026)
- Effort is a spend dial more than a carefulness dial. On real monorepo changes, Opus 5.5 peaked at medium; higher effort produced larger diffs and more regressions. Use high/xhigh only for named hard reasoning.
- GPT-6.1 Sol high is the default for bounded, test-gated implementation: it reached the correctness ceiling on VulcanBench from high upward at low cost. It has weak scope discipline, so every brief must state scope, files, checks and stop conditions; unrelated failures are reported, not fixed.
- Sonnet 5.5 low/medium had zero regressions across 100 real changes; use `careful-implementer` when preserving existing behaviour, UI or user-facing text matters, or tests are weak.
- Opus 5.5 is the main orchestrator and judgement model; Opus/Fable lead source synthesis evidence, while Astra leads science and harder cross-file review evidence.

### Agent routing
- `careful-implementer`: Claude Sonnet 5.5, medium
- `cleanup-steward`: GPT-6.1 Sol, medium
- `content-writer`: Claude Opus 5.5, medium
- `cratis-cli`: GPT-6.1 Sol, medium
- `doc-writer`: Claude Sonnet 5.5, medium
- `Explore`: Claude Haiku 5.5, low (lookups only; not for facts, edits or review)
- `general-purpose`: Claude Sonnet 5.5, medium
- `grunt`: Claude Sonnet 5.5, low
- `implementer`: GPT-6.1 Sol, high
- `opus-implementer`: Claude Opus 5.5, medium
- `ops`: Claude Haiku 5.5, low
- `Plan`: Claude Sonnet 5.5, medium
- `planner`: Claude Sonnet 5.5, medium
- `prose-editor`: Claude Sonnet 5.5, low
- `reviewer`: Claude Opus 5.5, medium
- `scout`: Claude Haiku 5.5, medium
- `second-opinion`: GPT-6 Astra, high
- `sol-reviewer`: GPT-6.1 Sol, high
- `slice-implementer`: Claude Haiku 5.5, medium (single approved event-model slice or Screenplay MCP edit; validation required)

### Usage
- Event modeling, event sourcing and Screenplay: in repositories with the Cratis AI corpus installed (`cratis ai`, profile `cratis/screenplay`), follow the corpus skills (start with `cratis-screenplay-event-modeling`) and use its Screenplay Modeler, Reviewer and Renderer agents. Keep the independent review on the other provider (`reviewer`/`second-opinion`/`sol-reviewer`). `cratis prologue start`, Extractor runs, `prologue interpret` with an LLM configured, and `render --force` need explicit approval.

- Ordinary worker main sessions: Sonnet 5.5 medium. Orchestration: Opus 5.5 medium. Raise effort only for named hard reasoning, then lower it. These main-session recommendations do not override pinned subagent roles.
- Only send actionable coordination: deliveries, blocker changes, questions/decisions or new relevant safety holds. No unchanged status, ACK-of-ACK or cc messages. ALL is reserved for truly global safety holds; keep targeted critical alerts. Timeout-only wakes re-arm inbox watches silently; renew waiting-on leases locally without messaging.
- `slice-implementer` for one already-designed event-model slice or Screenplay MCP change with an exact validation gate; `implementer` for clear, testable work; `careful-implementer` for behaviour-preserving changes; `opus-implementer` only when the brief names the hard reason (the unresolved design question or hard-bug judgement). Default scoped changes (a named file set and check) to `careful-implementer`. Every brief names the build configuration to verify (e.g. Release, warnings as errors).
- Plan, then implement: only when more than three implementation files, cross-repository dependencies or a named unresolved design/behaviour question warrant it, run `planner` (Sonnet medium) to write `<repo>/.ai-work/<task>/plan.md`; read it, resolve BLOCKING questions, then hand the plan to the cheaper implementer it recommends. Tests and docs do not inflate the implementation-file count. Reuse a still-valid plan; never pair `planner` with `Plan`. Stronger user/repository planning requirements take precedence. After accepting the plan, pass a 1–3 sentence approach summary as `issue_work update plan=...` (or on claim). The planner is read-only apart from that one file.
- `cleanup-steward` performs post-work inventory and only explicitly authorised, safety-checked cleanup.
- Cross-provider review: `reviewer` reviews GPT-written work; `sol-reviewer` reviews Claude-written work. Follow "Review loops" in the global rules (blocking-only gate, delta rounds, cap of 3). Before merge, per the review-log policy (items certified, train glue/delta only), run the `review` workflow (Opus + Sol) and always pass `author` (`gpt` when `implementer` wrote it, so Astra rather than Sol verifies Opus's findings); pass `deep: true` (Astra instead of Sol) only for security-sensitive, data-loss/migration, algorithmic/concurrency changes or a disputed blocker, as set out in the "Review loops" budget. Run the review (first whole review, delta or glue) in parallel with the gate, not after it.
- Claude is the constrained quota: prefer `implementer` over `opus-implementer` unless you can name the open design question, and do not raise Claude agents above medium without a named reason. `second-opinion` (Astra) stays for named hard reasoning, not routine review; never raise Astra above high.
- GPT capacity is available: use `implementer` for bounded, test-gated implementation and `sol-reviewer` (high) for bounded correctness diagnosis. Keep `deep: true` and review rounds within the Review loops budget; reuse `cachedReview` only for an eligible unchanged committed pass. No blanket xhigh escalation.
- Context size is enforced by the `context-budget` extension (see "Orchestrator context" in the global rules): hand off with `context_handoff` when asked and keep working.
- The main session plans, briefs and decides. Delegate collection and extraction to `ops` (Haiku for bounded evidence gathering; escalate ambiguous reasoning to Sonnet/Opus); route substantive bounded correctness and root-cause diagnosis to `sol-reviewer` (high), with named files, evidence, checks and stop conditions:
  - `ops` — collect git/gh/CI state, extract failing-job logs and PR/issue content, summarise logs/code, and draft PR notes or handoffs. Use it for collection/extraction that would take more than about three git/gh/cat/grep calls or produce more than ~100 lines of output. It does not adjudicate root cause or correctness, or certify review.
  - `Explore` — locating code and symbols; `scout` — multi-source web research.
  - `grunt` stays for mechanical edits.
- Never poll: no repeated sleep/check loops, `.output` tailing, or repeated CI status calls. For waits longer than a minute, use `job_start` (e.g. `gh run watch <run-id> --exit-status`) or `job_watch` (re-runs a check until it passes), then end the turn: the completion message wakes you. Do not call `job_list`/`job_output` to wait. Otherwise use one bounded waiting command.
- Never call `get_subagent_result` with `wait: true`; completion notifications start a new turn.
- In repositories with Cratis AI installed, its rules and skills take precedence for Cratis conventions; prefer these pinned agent types over Cratis corpus agents, which inherit the session model.
- MCP calls that change state require user approval. If a model refuses, report it and suggest another agent type; do not work around refusals.
