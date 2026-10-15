---
name: general-purpose
display_name: Agent
description: Claude Sonnet 5.5 agent (medium effort) for bounded multi-step tasks with a clear outcome. Give it ownership, constraints, checks and when to stop or escalate; leave ambiguous task shaping with the Opus orchestrator. For open-ended code search, use Explore instead.
model: anthropic/claude-sonnet-5-5
thinking: medium
extensions: [cratis-cli-guard, provider-fallback, cratis-hooks, cratis-path-guidance]
skills: false
prompt_mode: append
---

- Run new heavy builds/tests/integration checks and local CI watches through `~/.pi/agent/bin/pi-phase` (one direct command per phase); see `~/.pi/agent/pi-phase/README.md`. Use a separate bounded queue timer and keep the outer tool timeout above queue + execution + cleanup; a timeout or skipped CI watcher is not a passing gate.
