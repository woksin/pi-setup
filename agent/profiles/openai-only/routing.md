## Model routing

Active profile: **openai-only** (`~/.pi/agent/bin/pi-profile`). Use only `openai-codex` models through ChatGPT/Codex authentication; never route to Anthropic, Kimi or another provider, including fallback and review. Verified against Pi's available model list on 2026-10-11: GPT-6.1 Sol and GPT-6 Astra are available with 1.1M context. Catalog refresh was blocked by a stale separate `openai` OAuth credential; do not treat the cached list as a successful refresh.

Delegate by agent type; each type pins its model and thinking level. Never pass a `model` override to `Agent`.

### Practical defaults
- Main session: **GPT-6.1 Sol, high** for coding and orchestration. Use medium for straightforward questions; escalate to **GPT-6 Astra, high** for named hard design, debugging or reasoning tasks.
- Routine search, mechanical work, operations legwork, copy editing and source gathering: GPT-6.1 Terra (low, or medium for prose-editor and scout). Terra scores 4–6 points below Sol on Artificial Analysis (Coding Agent Index 48 vs 54) at about 44% lower cost per task. It has a much lower hallucination rate (38%, down from 88%), and the ChatGPT/Codex allowance covers substantially more Terra work than Sol work. OpenAI keeps Sol and Astra for the hardest coding. Synthesis, operations and cleanup: Sol medium/low. Implementation: Sol high with explicit scope and test gates.
- Behaviour-preserving implementation, architecture and substantial writing: Astra medium/high. Reserve xhigh for a specific hard reasoning problem or deep review, not every task.
- Keep model IDs explicit. Do not choose a newer-looking alias solely by name or assert benchmark advantages without evidence. GPT-6 Luna remains an optional manually selected alternative, not an unvalidated default worker.

### Agent routing
- `careful-implementer`: GPT-6 Astra, medium
- `cleanup-steward`: GPT-6.1 Sol, medium
- `content-writer`: GPT-6 Astra, high
- `cratis-cli`: GPT-6.1 Sol, high
- `doc-writer`: GPT-6 Astra, medium
- `Explore`: GPT-6.1 Terra, low
- `general-purpose`: GPT-6.1 Sol, high
- `grunt`: GPT-6.1 Terra, low
- `implementer`: GPT-6.1 Sol, high
- `ops`: GPT-6.1 Terra, low
- `opus-implementer`: GPT-6 Astra, high (legacy agent name retained for compatibility)
- `Plan`: GPT-6 Astra, high
- `planner`: GPT-6 Astra, high
- `prose-editor`: GPT-6.1 Terra, medium
- `reviewer`: GPT-6 Astra, high
- `scout`: GPT-6.1 Terra, medium
- `second-opinion`: GPT-6 Astra, xhigh
- `sol-reviewer`: GPT-6.1 Sol, high

### Review policy while this profile is active
- This explicitly replaces the global cross-provider requirement: review is **cross-model within OpenAI**, not cross-provider. It offers less provider diversity; do not claim otherwise or invoke Claude to satisfy the old requirement.
- Quick review: Astra for Sol/GPT-written work, Sol for Astra-written work. Full review: independent Sol and Astra reviews, with blocking findings adversarially checked by the other model. Deep mode raises Astra to xhigh. Before merge, run the full `review` workflow and require `passed: true`; retain the existing fail-closed and three-round rules.
- Reviewers remain read-only; checks must obey execution budgets and scope. Agent names do not indicate provider: `reviewer` and `opus-implementer` both use OpenAI here.

### Usage
- Event modeling, event sourcing and Screenplay: follow the installed Cratis corpus skills and conventions. Prefer these pinned agents; corpus agents must inherit an OpenAI model or have an explicitly verified OpenAI route. `cratis prologue start`, Extractor runs, LLM interpretation and `render --force` still need explicit approval.
- `implementer` for clear, testable work; `careful-implementer` for behaviour preservation; `opus-implementer` only when the brief names the hard reason (an unresolved design question or hard-bug judgement). Default scoped changes (a named file set and check) to `careful-implementer`. Every brief names the build configuration to verify (e.g. Release, warnings as errors).
- Plan, then implement: once a request is decided to become an issue/task, run `planner` (high) to write `<repo>/.ai-work/<task>/plan.md`; read it, resolve BLOCKING questions, then hand the plan to the cheaper implementer it recommends. Skip the planner for trivial or mechanical changes (a known one-file edit, renames, bumps). After accepting the plan, pass a 1–3 sentence approach summary as `issue_work update plan=...` (or on claim). The planner is read-only apart from that one file.
- `cleanup-steward` performs inventory and only explicitly authorised, safety-checked cleanup.
- Delegate searches needing more than about three grep/find/read calls to `Explore`, log extraction to `grunt`, and multi-source research to `scout`.
- Never poll. Use `job_start` or `job_watch` for long waits and end the turn; completion wakes the session. Never call `get_subagent_result` with `wait: true`.
- Start a fresh session from a `.ai-work/` handoff around 600k context tokens (hard ceiling 800k).
- Provider fallback stays disabled. If OpenAI is unavailable or a guard blocks an action, report it rather than switching provider or bypassing the guard. MCP state changes still require approval.
