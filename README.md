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

Install requires Python 3. Flags may be given in any order: `--user <login>`, `--repos-root <dir>` and `--dry-run` (writes nothing). The operator settings are saved in `~/.pi/agent/user.json` as `{"githubUser": "<login>", "reposRoot": "<dir>"}` and reused on later installs unless flags override them. Without a saved login, the installer uses the authenticated `gh api user --jq .login`, then prompts in a terminal; noninteractive installs must supply `--user` if gh cannot identify you. Without a saved repositories root, it prompts with `$HOME/repos` as the default, or uses that default noninteractively. Repo templates use `{{GITHUB_USER}}` and `{{REPOS_ROOT}}`; install renders them for you. Pass `--repos-root` on the first install: without it (and without a saved `user.json`) the root silently defaults to `$HOME/repos` when there is no terminal to prompt in.

`--legacy-peer-deps` is needed: the packages declare conflicting peer ranges for `@earendil-works/pi-*` (for example `@vigolium/piolium` wants `^0.74`, `@tintinweb/pi-subagents` wants `>=1.1.0`), so a plain `npm install` fails with ERESOLVE.

`settings.json`, `models.json` and the other JSON configs are only written when they don't exist yet. `efficiency.json` and `context-budget.json` follow the same rule. Restart pi afterwards.

Optional, macOS only: `agent/launchd/*.plist` are templates for the `docker-guardian` and `pi-cleanup` schedules. They are not installed by `install.sh`. Replace `__HOME__` with your home directory, create `~/.pi/agent/logs` (they write stderr there), copy them to `~/Library/LaunchAgents/`, then `launchctl load` them.

`settings.json` lists the packages I load. Local checkouts are mapped to their npm packages (`npm:@woksin/pi-jobs`, `npm:@woksin/pi-recover`, `npm:@woksin/pi-context-budget`, `npm:@woksin/pi-orch`). Remove the ones you don't want.

## For Cratis team members

```sh
git clone https://github.com/woksin/pi-setup && cd pi-setup
./install.sh --user <your-github-login> --repos-root <where-your-repos-live>
cd ~/.pi/agent/npm && npm install --legacy-peer-deps
```

Restart pi. Agents assign issues and PRs to you and request you as reviewer (skipping the review request when you are the PR author). They merge Cratis PRs themselves once required CI is green and the final review passes, but never PRs that trigger major releases.

Remove the parts you don't want:

- **docker-guardian:** a macOS launchd template, not installed by default. If you installed it, run `launchctl unload ~/Library/LaunchAgents/com.example.docker-guardian.plist` (use your actual plist name if renamed), then remove that plist to prevent future loads.
- **pi-orch:** remove `npm:@woksin/pi-orch` from `packages` in `~/.pi/agent/settings.json`.
- **loose-threads:** remove `~/.pi/agent/loose-threads` and its entry from `AGENTS.md`; it is a manually invoked backstop, not a scheduled service.
- **Cratis-specific rules:** remove the Cratis sections of `AGENTS.md`, the `cratis-cli-guard` extension, the `cratis-cli` agent and the Cratis MCP approval patterns in `mcp-adapter.json` if they don't apply. `pi-cleanup`, `loose-threads` and `ai-work-lifecycle` use your configured repositories root.

Reinstalling restores shared files, so also remove unwanted components from your setup checkout.

## Machine performance

Run `~/.pi/agent/bin/dev-doctor` for slow gates, long queues, swap or Docker OOM.
It checks Spotlight, Docker memory/observed peak and stale containers, build
oversubscription, MSBuild environment, Testcontainers in test phases, sampled
worktree outputs, home/repos disk floors, browser hygiene, idle pi sessions/helpers, and labelled orphans.
Use `--json`, `--only id,id`, or `--repos-root DIR` (otherwise it uses user.json's
`reposRoot`, then `$HOME/repos` if present). Missing tools are reported as skipped.
`--apply` removes exited containers older than 20 minutes and explicitly configured
label-rule orphans only when pi-phase reports no running phase; unknown blocks it.
It can also SIGTERM temporary Puppeteer/headless browser **root** PIDs, even during
phases: >50% CPU sustained ≥30 min or <1% group CPU over ≥2h (fuse 5).
Persistent `~/.pi` profiles and user Chrome are never killed. Idle pi sessions
(≥4h CPU inactivity) and their helper RSS are suggest-only. `--quiet` prints
successful actions and fuse trips; docker-guardian runs the narrow cleanup checks
at most every 15 minutes. The doctor never uses sudo, changes Docker settings,
prunes images/volumes or deletes checkout files.

Disk defaults in `~/.pi/agent/dev-doctor.json` are `disk.build_floor_gib: 25`
and `disk.cleanup_trigger_gib: 40` (see the example). Below 40 GiB, suggest a
`pi-cleanup` dry run and report; keep building down to 25 GiB. Below 25 GiB,
start no new heavy phase or worktree. `dev-doctor --only disk` is suggest-only.
`pi-cleanup --if-free-below config` uses the configured cleanup trigger;
the numeric form is unchanged. Use it for an extra low-disk job; the daily launchd template runs unconditionally.
`pi-cleanup --only bins` (also scheduled) plans bin-only cleanup below
`disk.bin_sweep_below_gib` (50 GiB); `--apply` deletes eligible bins, never obj.
Open build files, running phase cwds, writes within 60 min or tracked bin files
keep the worktree; unknown probes fail closed. Each worktree logs a reason and
bytes freed. Doctor's disk check samples a bounded reclaimable-bin estimate.

`dev-doctor --only package-cache-volume` compares NuGet/pnpm/yarn caches with the
source filesystem. `--apply --only package-cache-volume` only creates/appends an
outside-checkout `Directory.Build.rsp` (backing up an existing file); rare in-place
bin rewrites can modify hard-linked packages. `--move-nuget` separately opts into
an idle-only, space-checked move to `<reposRoot>/.nuget-packages`; it retains
`packages.old` until a verified build. Guardian never runs this check.

CPU anchors and observed Docker peaks are kept in
`~/.pi/agent/dev-doctor/samples.json` (`DEV_DOCTOR_STATE_DIR` overrides its directory).
Docker sizing suggests about 1.5× observed peak, floor 8 GiB; samples miss unobserved
peaks, so the user must verify integration demand and host headroom before resizing.
See the `dev-machine-performance` skill for CI-parity lanes and warm-worktree habits.

`agent/dev-doctor.example.json` is installed as `~/.pi/agent/dev-doctor.json` only
when absent. Its generic `owned_container_rules` schema includes a Studio warm-stage
example: exact labels, age ≥30 minutes, `sha256-cwd-16` owner label, process-name
allowlist and removal fuse (≤10/pass). Review or replace it for your workloads;
use `{"owned_container_rules":[]}` to disable. Cleanup requires a verified local
`default`/`desktop-linux` Unix Docker endpoint and readable `lsof` cwd probes for
all possible owner processes. Live matching owners, missing owner labels and
report-only session labels are never removed; remote/unknown context is skipped.

The pi-phase config flags `msbuild_max_cpu` (default off),
`container_test_detection` (default hint-only), and `cold_worktree_hint`
(default on, hint-only) provide opt-in caps and advisory performance guidance.
Configure these in `~/.pi/agent/pi-phase/config.json` when supported by your version.

**Stuck-session watchdog:** `bin/session-watchdog` runs every 2 min from docker-guardian and only notifies, never kills. It flags live pi sessions (positively mapped to a running pi process through pi-orch heartbeats) with an unanswered tool call or an unanswered user/tool-result message older than 10 min, and raises an all-sessions-silent alarm (3+ sessions, none writing for over 15 min). Stuck notices go to `ALL-session-watchdog-*-stuck.md` and a macOS notification; sessions it cannot map, memory pressure (`kern.memorystatus_level` below 15% with swap used over 12 GB, or below 8%) and `fseventsd` above 4 GB go to the coordinator only. State is in `~/.pi/agent/session-watchdog/`, the log in `logs/session-watchdog.log`.

**pi-phase memory ceilings:** `rss_cap_mb` (default 12288) kills a phase when one process in its tree stays above the cap for 3 consecutive samples (about 45 s; exit 76). On macOS, admission uses free memory percent; the swap-free floor (`memory_admission.min_swap_free_mb`, default 2048) applies on Linux only, since macOS grows swap on demand.

Guardian image hygiene is **active once `~/.pi/agent/docker-guardian/pinned.txt`
exists**: install seeds it only when absent from
`agent/docker-guardian/pinned.example.txt` (Mongo, Keycloak, Vault, Playwright, Ryuk).
Review/add pins; globs match tags, image IDs and RepoDigests (`repo@sha256:…`),
including digest-only images. Disable image cleanup with an empty
`~/.pi/agent/docker-guardian/no-image-prune` file (`touch` it); remove that switch
to re-enable. Other guardian/doctor hygiene continues while it is disabled.

The 15-minute image pass requires no running integration phase (unknown blocks it)
and uses only `docker rmi` **without force**, never `prune -a`. It compares numeric
tags only within repository + suffix-variant + numeric-part-count groups, keeping
the newest two in each. Only known rc/alpha/beta/preview markers with optional
digits order below the matching release; e.g. `20.11-alpine` never competes with
`20.12`. Short X/X.Y aliases stay when longer tags of the same variant exist.
Dangling images must appear in `--filter dangling=true` and be older than 24h;
intermediate layers are not cleanup candidates. Images created within 6h, floating
tags (`latest`, `*-development`, `local-*`) and pinned images are kept.

Image pruning runs **before** the doctor's and guardian's exited-container removals
in the same pass. Images referenced by any container (even exited) in that pass's
inventory are retained; references are rechecked before each removal. This is not
permanent protection: a later pass can remove an image after its exited container
has been deleted. Shared layers mean modest savings: about 1 GB on a 13.7 GB
"reclaimable" report, not the reported total.

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
| `bin/dev-doctor`, `dev-doctor.example.json` | Bounded diagnostics and safe, fused cleanup for old exited/label-owned containers and temporary browsers. |
| `bin/docker-guardian` | macOS: checks that Docker Desktop answers every 2 minutes, restarts it within a budget, removes dead containers and old build cache, only removes superseded semver tags/dangling old images under the narrow rule below. Run it from the launchd template in `launchd/`. |
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
- `dev-machine-performance`: diagnosing slow gates and queues, with safe machine advice and CI-parity lane habits.
- `github-issue-hygiene`: keeping issues current and closing them when done (includes `issue-status.py`).

### `tools/` → `~/.local/`

The `ai-work-lifecycle` CLI that the skill and extension use.

## Related repositories

- [woksin/pi-jobs](https://github.com/woksin/pi-jobs) (npm: [`@woksin/pi-jobs`](https://www.npmjs.com/package/@woksin/pi-jobs)): background shell jobs and watches that wake the agent when they finish (`job_start`, `job_watch`).
- [woksin/pi-recover](https://github.com/woksin/pi-recover) (npm: [`@woksin/pi-recover`](https://www.npmjs.com/package/@woksin/pi-recover)): `/recover` picks up subagents, jobs and workflows from a session that stopped abruptly.

Third-party packages I use (see `agent/npm-package.json`): `@tintinweb/pi-subagents`, `pi-mcp-adapter`, `pi-web-access`, `pi-browser-use`, `@gotgenes/pi-anthropic-auth`, `donsetch`. The CodeScene Code Health skills (`explaining-code-health`, `guiding-refactoring-with-code-health`, `making-the-business-case-for-code-health`, `prioritizing-technical-debt`, `risk-based-testing-with-code-health`, `routing-work-with-code-ownership`, `safeguarding-ai-generated-code`) are not vendored here. Copy them from the `skills/` folder of [codescene-oss/codescene-mcp-server](https://github.com/codescene-oss/codescene-mcp-server/tree/main/skills) (Apache 2.0). The CodeScene section of `AGENTS.md` assumes the `codescene` MCP server in `mcp-adapter.json`. The `pi-extensions` skill comes from [Dwsy/pi-extensions-skill](https://github.com/Dwsy/pi-extensions-skill).

### Experimental and git-only packages

- `agent/local-packages/pi-questions` (bundled here, not on npm; `install.sh` installs it and adds `./local-packages/pi-questions` to `packages`): a durable queue of questions and decisions for the user. Sessions ask with the `user_questions` tool, the user answers with `/questions` and `/answer` from any session, and the asking session is woken with the answer. Items live in `~/.pi/agent/user-questions` (`PI_QUESTIONS_HOME` overrides). CLI: `node ~/.pi/agent/local-packages/pi-questions/dist/cli.js list|get|ask|wait`; a background watch on `wait Q-n` exits once the item is answered. See its README.

- [woksin/pi-orch](https://github.com/woksin/pi-orch) (experimental; npm: [`@woksin/pi-orch`](https://www.npmjs.com/package/@woksin/pi-orch)): repo-owner orchestration with a durable order bus, batched candidate PRs and a shared GitHub poller. Expect rough edges; remove it from `packages` if you don't want it.
- [woksin/pi-context-budget](https://github.com/woksin/pi-context-budget) (npm: [`@woksin/pi-context-budget`](https://www.npmjs.com/package/@woksin/pi-context-budget)): structured context handoffs and bounded long sessions. Observe mode by default; the default config is `context-budget.json`. Fresh-process fallback needs its `pi-session` wrapper on PATH (see that repo's INSTALL.md).

## What is deliberately not included

- Auth, accounts, sessions, jobs, logs, backups, caches, trust and approval files, and any per-machine runtime state (`pi-phase/state`, `issue-work/` registry, `docker-guardian` state, `lane-policy/policy.json`, the active profile marker).
- `local-packages/` other than `pi-questions`: published separately (see above). The unloaded `model-safety-*` and `pi-subagents-reliability-*` packages are not part of the setup.
- Retired profiles, `*.bak*` files, and the `fd` and `rg` binaries in `bin/`.
- The CodeScene skills (see above).
- `user.json`: operator identity and repositories root are local install settings, never synced into this repo.

## Keeping it up to date

`./sync.sh` copies an allowlisted set of files from the live install into this repo, removes `deviceId` from the settings, points local checkouts of pi-jobs, pi-recover, pi-context-budget and pi-orch at their npm packages (deduplicated), replaces the local user name in the launchd templates, and runs `gitleaks`. It reverse-maps operator references and the repositories root in the copied templates to `{{GITHUB_USER}}` and `{{REPOS_ROOT}}`, using `~/.pi/agent/user.json`. For older installs without that file it uses the original author's login and `/Volumes/sourcecode/repos`; it does not write to the live install. Links, npm names, launchd labels and test fixtures stay unchanged. Review the diff before committing.
