# pi-setup

My [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent setup: global rules, custom agents, extensions, workflows, model-routing profiles, skills and helper scripts. Take the whole thing or copy the pieces you want.

Auth, sessions, caches and machine identity are never included.

## Install

```sh
git clone https://github.com/woksin/pi-setup && cd pi-setup
./install.sh --dry-run   # show what would change
./install.sh             # differing files are backed up to <file>.bak-<timestamp>
(cd ~/.pi/agent/npm && npm install --legacy-peer-deps)
```

`--legacy-peer-deps` is needed: the packages declare conflicting peer ranges for `@earendil-works/pi-*` (for example `@vigolium/piolium` wants `^0.74`, `@tintinweb/pi-subagents` wants `>=1.1.0`), so a plain `npm install` fails with ERESOLVE.

`settings.json`, `models.json` and the other JSON configs are only written when they don't exist yet. `efficiency.json` and `context-budget.json` follow the same rule. Restart pi afterwards.

Optional, macOS only: `agent/launchd/*.plist` are templates for the `docker-guardian` and `pi-cleanup` schedules. They are not installed by `install.sh`. Replace `__HOME__` with your home directory, create `~/.pi/agent/logs` (they write stderr there), copy them to `~/Library/LaunchAgents/`, then `launchctl load` them.

`settings.json` lists the packages I load. Local checkouts are mapped to their public sources (`npm:@woksin/pi-jobs`, `npm:@woksin/pi-recover`, `git:github.com/woksin/pi-context-budget`, `git:github.com/woksin/pi-orch`). Remove the ones you don't want.

Some of it is tied to my workflow: `AGENTS.md` contains rules for [Cratis](https://github.com/Cratis) repositories and my GitHub user (`woksin`), and `pi-cleanup`, `loose-threads` and `ai-work-lifecycle` assume repositories live under `/Volumes/sourcecode/repos`. Change those before you use them. `cratis-cli-guard`, the `cratis-cli` agent and the MCP approval patterns in `mcp-adapter.json` are Cratis-specific too.

## What's in it

### `agent/` → `~/.pi/agent/`

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Global rules: scope, execution budgets, delegation briefs, review loops, GitHub issue hygiene, shipping, CI minutes, disk hygiene. |
| `agents/` | Custom subagent types (`implementer`, `reviewer`, `sol-reviewer`, `ops`, `scout`, `grunt`, …), each pinned to a model and thinking level. |
| `profiles/` | Model-routing profiles (`balanced`, `anthropic-heavy`, `openai-heavy`, …). Switch with `bin/pi-profile use <name>`. |
| `extensions/guards.ts` | `/guards` command that turns the guards below on or off. |
| `extensions/wait-guard.ts` | Blocks long foreground waits and repeated CI status polling. |
| `extensions/cratis-cli-guard.ts` | Blocks state-changing `cratis chronicle` commands unless approved. |
| `extensions/issue-work.ts` | `issue_work` tool: claim, update and list the GitHub issues a session is working on, with leases across sessions and checks for new activity (logic in `lib/issue-work.ts`). |
| `extensions/phase-priority.ts` | Asks you before an agent gets high priority in the `pi-phase` queue (`--priority high`); blocks subagents and self-granting. `/phase-priority` grants or revokes. A session you designate as orchestrator can grant priority itself, capped at 10 uses or 120 minutes (`lib/phase-priority.ts`). |
| `extensions/provider-fallback.ts` | Falls back to another provider's model when a usage or rate limit is hit (`provider-fallback.json`). |
| `extensions/lane-policy.ts`, `lib/lane-policy.ts`, `lane-policy/README.md` | **Dormant pilot.** A cooperative guard for git push and `gh` writes in repositories you enrol with `/lane-policy`. Does nothing until you enrol a repository. Read `lane-policy/README.md` before turning it on. |
| `extensions/subagent-result-guard.ts` | Stops agents from re-reading a subagent result that was already delivered in full. |
| `extensions/output-cap.ts`, `extensions/observation-mask.ts` | Cap large tool output (full text goes to `.ai-work/tool-out/`) and mask old tool output in subagent context. Tuned in `efficiency.json`. |
| `extensions/cache-retention.ts` | Defaults Anthropic prompt caching to the 1-hour tier. |
| `extensions/ai-work-lifecycle.ts` | Integrates the `ai-work-lifecycle` task-output tool. |
| `early-extensions/mcp-project-trust.ts` | Only loads project MCP configs from trusted folders. |
| `workflows/review.js` | Cross-provider code review with adversarial verification; gates only on confirmed blocking findings. |
| `workflows/bulk-edit.js` | One mechanical change across many files, then verified. |
| `workflows/loose-threads-plan.js` | Turns a `loose-threads` inventory into a cleanup plan. |
| `loose-threads/` | Weekly audit of leftover worktrees, branches, stashes and Docker volumes. |
| `pi-phase/`, `bin/pi-phase` | Wrapper for build and test commands with time limits, logs and a shared queue ordered by priority (`low`, `normal`, `high`), then first come first served. |
| `bin/docker-guardian` | macOS: checks that Docker Desktop answers every 2 minutes, restarts it within a budget, removes dead containers and old build cache, never prunes images. Run it from the launchd template in `launchd/`. |
| `bin/inbox-watch` | Polls a directory of files that parallel agent sessions use as messages; pair it with one `job_watch`. Set `INBOX_DIR`. |
| `bin/gpt-meter` | Read-only spend meter for OpenAI usage from session logs. |
| `launchd/` | Templates for the `docker-guardian` and `pi-cleanup` schedules (placeholders instead of my user name). |
| `context-budget.json`, `efficiency.json`, `provider-fallback.json`, `subagents.json`, `mcp-adapter.json` | Default configs for the extensions and packages above. |
| `AGENTS.subagent.md` | Rules for subagents (derived from `AGENTS.md`, without the orchestration policy). |
| `bin/pi-profile` | Switch model-routing profiles. |
| `bin/pi-account` | Switch between saved Anthropic logins (tokens are never printed or stored here). |
| `bin/pi-usage` | Provider usage and limit pressure from session logs. |
| `bin/pi-cleanup` | Disk cleanup of build output and stale worktrees (dry run by default). |
| `templates/brief.md` | Template for delegation briefs. |
| `settings.json`, `npm-package.json` | My pi settings and the npm packages I use. |

### Workflow rules worth knowing

- **Phase priority and orchestrator mode.** `pi-phase run --priority high` jumps the queue. `phase-priority.ts` blocks it unless you or a designated orchestrator session approve; subagents can't grant themselves priority.
- **Reload recovery.** After `/reload`, background jobs survive but subagents don't. `AGENTS.md` tells the agent to run `/jobs`, read the `pi-recover` notice, re-arm only what's missing and not to `/reload` while it needs running subagents.
- **Guards.** `wait-guard`, `cratis-cli-guard`, `subagent-result-guard`, `lane-policy` and the MCP approval guard share `/guards on|off <name>` (`--persist` to keep it). Disabling a guard is always your call, not the agent's.
- **Issue work.** `issue_work` keeps a registry of the issues each session works on under `~/.pi/agent/issue-work/` (runtime state, not included).
- **Provider fallback.** When one provider hits a usage limit, `provider-fallback.ts` switches to the paired model in `provider-fallback.json`. Edit the pairs to match the models you have.

### `skills/` → `~/.agents/skills/`

- `ai-work-lifecycle`: managing temporary AI task outputs without leaving large caches behind.
- `github-issue-hygiene`: keeping issues current and closing them when done (includes `issue-status.py`).

### `tools/` → `~/.local/`

The `ai-work-lifecycle` CLI that the skill and extension use.

## Related repositories

- [woksin/pi-jobs](https://github.com/woksin/pi-jobs) (npm: [`@woksin/pi-jobs`](https://www.npmjs.com/package/@woksin/pi-jobs)): background shell jobs and watches that wake the agent when they finish (`job_start`, `job_watch`).
- [woksin/pi-recover](https://github.com/woksin/pi-recover) (npm: [`@woksin/pi-recover`](https://www.npmjs.com/package/@woksin/pi-recover)): `/recover` picks up subagents, jobs and workflows from a session that stopped abruptly.

Third-party packages I use (see `agent/npm-package.json`): `@tintinweb/pi-subagents`, `pi-mcp-adapter`, `pi-web-access`, `pi-browser-use`, `@gotgenes/pi-anthropic-auth`, `donsetch`. The CodeScene Code Health skills (`explaining-code-health`, `guiding-refactoring-with-code-health`, `making-the-business-case-for-code-health`, `prioritizing-technical-debt`, `risk-based-testing-with-code-health`, `routing-work-with-code-ownership`, `safeguarding-ai-generated-code`) are not vendored here. Copy them from the `skills/` folder of [codescene-oss/codescene-mcp-server](https://github.com/codescene-oss/codescene-mcp-server/tree/main/skills) (Apache 2.0). The CodeScene section of `AGENTS.md` assumes the `codescene` MCP server in `mcp-adapter.json`. The `pi-extensions` skill comes from [Dwsy/pi-extensions-skill](https://github.com/Dwsy/pi-extensions-skill).

### Experimental and git-only packages

- [woksin/pi-orch](https://github.com/woksin/pi-orch) (experimental, listed in `settings.json` as `git:github.com/woksin/pi-orch`): repo-owner orchestration with a durable order bus, batched candidate PRs and a shared GitHub poller. Expect rough edges; remove it from `packages` if you don't want it.
- [woksin/pi-context-budget](https://github.com/woksin/pi-context-budget) (listed as `git:github.com/woksin/pi-context-budget`; not on npm yet): structured context handoffs and bounded long sessions. Observe mode by default; the default config is `context-budget.json`. Fresh-process fallback needs its `pi-session` wrapper on PATH (see that repo's INSTALL.md).

## What is deliberately not included

- Auth, accounts, sessions, jobs, logs, backups, caches, trust and approval files, and any per-machine runtime state (`pi-phase/state`, `issue-work/` registry, `docker-guardian` state, `lane-policy/policy.json`, the active profile marker).
- `local-packages/`: published separately (see above). The unloaded `model-safety-*` and `pi-subagents-reliability-*` packages are not part of the setup.
- Retired profiles, `*.bak*` files, and the `fd` and `rg` binaries in `bin/`.
- The CodeScene skills (see above).
- The `/Volumes/sourcecode/repos` layout is mine and is kept in `pi-cleanup`, `loose-threads` and `ai-work-lifecycle`; adjust it for your machine.

## Keeping it up to date

`./sync.sh` copies an allowlisted set of files from the live install into this repo, removes `deviceId` from the settings, points local checkouts of pi-jobs and pi-recover at their npm packages, points pi-context-budget and pi-orch at their GitHub repos (deduplicated), replaces my user name in the launchd templates, and runs `gitleaks`. Review the diff before committing.
