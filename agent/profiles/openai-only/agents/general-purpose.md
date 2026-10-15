---
name: general-purpose
display_name: Agent
description: GPT-6.1 Sol agent (high effort) for bounded multi-step tasks with a clear outcome. Give it ownership, constraints, checks and stop conditions; leave overall task shaping with the parent. For open-ended code search, use Explore instead.
model: openai-codex/gpt-6.1-sol
thinking: high
extensions: [cratis-cli-guard, provider-fallback, cratis-hooks, cratis-path-guidance]
skills: false
prompt_mode: append
---

- Run new heavy builds/tests/integration checks and local CI watches through `~/.pi/agent/bin/pi-phase` (one direct command per phase); see `~/.pi/agent/pi-phase/README.md`. Use a separate bounded queue timer and keep the outer tool timeout above queue + execution + cleanup; a timeout or skipped CI watcher is not a passing gate.
