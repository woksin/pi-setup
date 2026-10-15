# pi-setup

My [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent setup: global rules, custom agents, extensions, workflows, model-routing profiles, skills and helper scripts. Take the whole thing or copy the pieces you want.

Auth, sessions, caches and machine identity are never included.

## Install

```sh
git clone https://github.com/woksin/pi-setup && cd pi-setup
./install.sh --dry-run   # show what would change
./install.sh             # differing files are backed up to <file>.bak-<timestamp>
(cd ~/.pi/agent/npm && npm install)
```

`settings.json`, `models.json` and the other JSON configs are only written when they don't exist yet. Restart pi afterwards.

Some of it is tied to my workflow: `AGENTS.md` contains rules for [Cratis](https://github.com/Cratis) repositories and my GitHub user, and `pi-cleanup`, `loose-threads` and `ai-work-lifecycle` assume repositories live under `/Volumes/sourcecode/repos`. Change those before you use them.

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
| `extensions/provider-fallback.ts` | Falls back to another provider's model when a usage or rate limit is hit (`provider-fallback.json`). |
| `extensions/cache-retention.ts` | Defaults Anthropic prompt caching to the 1-hour tier. |
| `extensions/ai-work-lifecycle.ts` | Integrates the `ai-work-lifecycle` task-output tool. |
| `early-extensions/mcp-project-trust.ts` | Only loads project MCP configs from trusted folders. |
| `workflows/review.js` | Cross-provider code review with adversarial verification; gates only on confirmed blocking findings. |
| `workflows/bulk-edit.js` | One mechanical change across many files, then verified. |
| `workflows/loose-threads-plan.js` | Turns a `loose-threads` inventory into a cleanup plan. |
| `loose-threads/` | Weekly audit of leftover worktrees, branches, stashes and Docker volumes. |
| `pi-phase/`, `bin/pi-phase` | Wrapper for build and test commands with time limits, a queue and logs. |
| `bin/pi-profile` | Switch model-routing profiles. |
| `bin/pi-account` | Switch between saved Anthropic logins (tokens are never printed or stored here). |
| `bin/pi-usage` | Provider usage and limit pressure from session logs. |
| `bin/pi-cleanup` | Disk cleanup of build output and stale worktrees (dry run by default). |
| `templates/brief.md` | Template for delegation briefs. |
| `settings.json`, `npm-package.json` | My pi settings and the npm packages I use. |

### `skills/` → `~/.agents/skills/`

- `ai-work-lifecycle`: managing temporary AI task outputs without leaving large caches behind.
- `github-issue-hygiene`: keeping issues current and closing them when done (includes `issue-status.py`).

### `tools/` → `~/.local/`

The `ai-work-lifecycle` CLI that the skill and extension use.

## Related repositories

- [woksin/pi-jobs](https://github.com/woksin/pi-jobs) (npm: [`@woksin/pi-jobs`](https://www.npmjs.com/package/@woksin/pi-jobs)): background shell jobs and watches that wake the agent when they finish (`job_start`, `job_watch`).
- [woksin/pi-recover](https://github.com/woksin/pi-recover) (npm: [`@woksin/pi-recover`](https://www.npmjs.com/package/@woksin/pi-recover)): `/recover` picks up subagents, jobs and workflows from a session that stopped abruptly.

Third-party packages I use (see `agent/npm-package.json`): `@tintinweb/pi-subagents`, `pi-mcp-adapter`, `pi-web-access`, `pi-browser-use`, `@gotgenes/pi-anthropic-auth`, `donsetch`. The CodeScene skills come from CodeScene's MCP server, and the `pi-extensions` skill from [Dwsy/pi-extensions-skill](https://github.com/Dwsy/pi-extensions-skill).

## Keeping it up to date

`./sync.sh` copies an allowlisted set of files from the live install into this repo, removes `deviceId` from the settings, points local checkouts of pi-jobs and pi-recover at their npm packages, and runs `gitleaks`. Review the diff before committing.
