# pi-setup

My pi coding agent setup, ready to install: global rules, subagents, extensions, an installer, `lanes` and `pi-train`.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Release](https://img.shields.io/github/v/release/woksin/pi-setup)](https://github.com/woksin/pi-setup/releases)

This is the setup I run [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) with every day. Take the whole thing or copy the pieces you want. Auth, sessions, caches and machine identity are never included.

## What you get

- **Global rules** (`AGENTS.md`) for scope, execution budgets, delegation briefs, review loops, GitHub issue hygiene and shipping.
- **Custom subagents** pinned to a model and thinking level, and **model-routing profiles** you switch with `pi-profile`.
- **Extensions and guards** for long waits, usage-limit fallback, output caps, issue tracking and more.
- **Workflows and tools**: cross-provider `review`, the `pi-phase` build/test queue, `pi-train` release trains and opt-in `lanes` for parallel sessions.
- **An installer** that detects your setup, backs up what it overwrites and can update, uninstall and run a doctor check.
- **Standalone packages** from the same author: [pi-jobs](https://github.com/woksin/pi-jobs), [pi-recover](https://github.com/woksin/pi-recover), [pi-context-budget](https://github.com/woksin/pi-context-budget) and the experimental [pi-orch](https://github.com/woksin/pi-orch).

```sh
git clone https://github.com/woksin/pi-setup && cd pi-setup
./install.sh --dry-run   # show what would change, no flags needed
./install.sh             # guided setup; overwritten files are backed up first
```

Prerequisites: none. Run `./install.sh`. It checks what your machine has, shows what it will install and asks once before it starts. It sets up Node.js, the tools below and pi itself. The full installer reference follows below (see [The guided installer](#the-guided-installer)).

## Contents

- [Install](#install), the guided installer, including update, uninstall, doctor and the opt-in lanes
- [For Cratis team members](#for-cratis-team-members)
- [Machine performance](#machine-performance)
- [What's in it](#whats-in-it)
- [Related repositories](#related-repositories)
- [What is deliberately not included](#what-is-deliberately-not-included)
- [Keeping it up to date](#keeping-it-up-to-date)

## Highlights

- Safe to re-run: files you changed are kept and the new version is written next to them, and every overwrite is backed up.
- Nothing is scheduled behind your back. The `docker-guardian`, `cleanup`, `secret-sweep` and `disk-growth` schedules are extras: the guided installer pre-selects the ones your machine supports and shows them in the Review before anything is written, and unattended installs need `--with <id>`.
- Releases are cut by hand from tagged versions; `./install.sh update` moves a checkout to the latest release tag.

## Install

### New machine prerequisites

**Prerequisites: none. Run `./install.sh`. Done.** On a new machine it installs what is missing, after showing you every command and asking `Continue? [Y/n]`. It never runs anything you have not seen first.

What it installs, and with which command:

- **macOS:** Node.js with `brew install node` (it offers the official Homebrew installer first if Homebrew is missing), then `brew install gh jq ripgrep fd python git` for whatever is missing.
- **Debian/Ubuntu:** `sudo apt-get install -y gh jq ripgrep fd-find python3 git` (and `apt-get update` first), plus a `fd` link in `~/.local/bin`. Fedora and similar: `sudo dnf install -y ...`.
- **Node.js on Linux:** the official nodejs.org tarball (latest v26: the pinned `@woksin/pi-orch` needs Node 26 or newer; Homebrew's `node` is 26 too), checked against its SHA-256 and unpacked into `~/.local/lib/nodejs`, with `node`, `npm` and `npx` linked in `~/.local/bin`. No sudo is needed for Node itself.
- **pi:** `npm install -g @earendil-works/pi-coding-agent@<the version this setup pins>`, into `~/.local` when the global npm directory is not yours. Never with sudo.
- **Windows:** use WSL2 and run `./install.sh` inside it; native Windows shells are not supported.

When it asks: in a terminal it always asks. `--install-prereqs` skips the question and installs, `--no-install-prereqs` only reports what is missing. `--yes` takes the defaults: on a fresh machine it installs, but when you already have a pi-setup install (an update) it only reports what is missing and prints the command to fix it, and `--skip-npm` never installs anything. `--dry-run` prints the commands it would run and changes nothing. If a step fails, it names the command, the log (`~/.local/state/pi-setup/install.log`) and says to re-run `./install.sh`, which continues from where it stopped.

<details>
<summary>Manual setup (fallback)</summary>

Use Node.js **22.19 or newer** (including current Node 24/26 releases), npm, Python **3.9 or newer** (macOS/Linux), Git, GitHub CLI (`gh`), `jq`, ripgrep (`rg`) and `fd` on PATH. Install pi with `npm install -g @earendil-works/pi-coding-agent`.

- macOS (Homebrew): `brew install node python git gh jq ripgrep fd`
- Debian/Ubuntu: `sudo apt install python3 git gh jq ripgrep fd-find`; install a current Node.js/npm from [nodejs.org](https://nodejs.org) if the distro version is too old. Debian calls fd `fdfind`: expose it as `fd` in `~/.local/bin`.

</details>

| Prerequisite | Required? | Without it |
| --- | --- | --- |
| Node ≥22.19, npm, Python ≥3.9 (macOS/Linux), Git, pi | Required | Installer, package fetching or bundled CLI tools cannot run. |
| `gh` (run `gh auth login`) | Required for this setup | GitHub issue/PR workflows fail; use `--user` if login cannot be detected. |
| `jq`, `rg`, `fd` | Required for this setup | JSON processing and the prescribed search workflow fail. |
| `gitleaks` | Optional (`brew install gitleaks`) | `secret-sweep` cannot scan; required if enabling that schedule. |
| `rtk` | Optional ([install](https://github.com/rtk-ai/rtk#installation)) | Output compression is unavailable; commands still run normally. |
| Docker Desktop/Engine | Optional ([install](https://docs.docker.com/get-started/get-docker/)) | Container workflows and docker-guardian are unavailable. |
| `tmux` | Optional (`brew install tmux` / `sudo apt install tmux`) | No tmux lanes backend; macOS Terminal is an alternative. |
| `CS_ACCESS_TOKEN` + `cs-mcp` | Optional, for CodeScene | No authenticated CodeScene analysis; doctor warns when CodeScene is enabled. [Setup](https://github.com/codescene-oss/codescene-mcp-server#readme). Never store the token in this repo. |

Doctor fails missing required tools/packages and warns about missing optional tools. Only `./install.sh doctor --fix` can install them, and only after asking (see Doctor).

### The guided installer

In a terminal, `./install.sh` opens a short welcome and one first choice:

- **Use our recommended setup** (the default; on a rerun it reads **Update with your current choices**). It uses what detection finds and asks only what it cannot settle itself, such as your GitHub login or repositories folder. The recommended extras are the detected defaults: `docker-guardian` (macOS with Docker), `cleanup`, `secret-sweep` (macOS with `gitleaks`), `disk-growth` (macOS), `codescene` (when `cs-mcp` or `CS_ACCESS_TOKEN` is found), `cratis` (when Cratis repositories are found) and web tools. `lanes` is off.
- **Customise step by step** asks every step: GitHub login, repositories folder, AI logins, profile and extras.

Each question shows "Step n of N". Steps already answered by flags such as `--user`, `--repos-root` or `--profile` are skipped and not counted.

1. **AI logins** shows Claude, ChatGPT and Kimi with ✓ or ✗. "Log in now, then check again" lets you run `pi` and `/login` and come back without quitting.
2. **Profile** lists every profile with what it needs. Profiles whose logins are missing are shown but cannot be picked, and the recommended one comes first. With no logins yet, `balanced` stays available so you can install now and run `./install.sh --profile auto` after logging in.
3. **Review** shows everything that will change before anything is written. Choose Install, Change a step…, Show every file or Cancel. Files you edited are handled here. When `~/.local/bin` or `~/.pi/agent/bin` is missing from your PATH, "Add them to PATH in your shell profile" is pre-selected; your shell profile is only changed when you choose Install with that line selected.
4. **Installing** shows one progress line per phase, then a health summary that says "Installed, with N things to finish" if something still needs you.
5. **What's next** lists: open a new terminal if PATH changed, start `pi`, log in to any missing provider, switch profiles with `pi-profile list` or `./install.sh --profile <name>`, and check with `./install.sh doctor`. The lanes offer follows as an optional step.

A rerun with nothing to change ends with "Everything is up to date." Non-interactive runs (`--yes`, `--plan`, `--dry-run`, `--json`, `CI`, no terminal) never prompt and print the full file list. `--plan` and `--dry-run` work without `--user` or a `gh` login: names then show `<you>` and a note asks you to pass `--user` for the final names.

### First ten minutes: pi, login, then install

1. From this checkout, run `./install.sh` and answer the few questions. It installs the prerequisites and pi for you (with your consent). Use `--user <GitHub-login> --yes` for an unattended install.
2. Log in: the finish screen lists what is left. Run `gh auth login` for GitHub, start `pi` and use `/login` for the providers you have. Rerun `./install.sh` after adding a login, or use `./install.sh --profile auto` to recompute the profile.
3. Start pi with `pi`.
4. Restart your shell/pi and run `./install.sh doctor`. Review the selected profile with `pi-profile list`; select another with `./install.sh --profile <name>`.

| Profile | Required logins/subscriptions | Optional provider |
| --- | --- | --- |
| `openai-only` | ChatGPT (`openai-codex`) | — |
| `balanced` | Claude (`anthropic`) + ChatGPT | Kimi (`kimi-coding`), otherwise ops/scout fall back to GPT |
| `balanced-anthropic` | Claude | — (Claude only, every role) |
| `balanced-openai` | Claude + ChatGPT | Kimi, otherwise GPT fallback |
| `anthropic-heavy` | Claude + ChatGPT | — |
| `openai-heavy` | Claude + ChatGPT | — |
| `kimi-heavy` | Claude + ChatGPT + Kimi | — |

`auto` chooses the highest-ranked profile whose required logins are ready: `balanced` with Claude + ChatGPT (with or without Kimi), `balanced-anthropic` with Claude alone, `openai-only` with ChatGPT alone. No matching profile (for example Kimi-only, or no logins yet) gives provisional `balanced` and asks for the missing logins. It does **not** automatically prefer `kimi-heavy`; select that explicitly. A normal rerun keeps the active profile; `--profile auto` recomputes it.

`pi-questions` is deliberately **bundled** in `agent/local-packages/pi-questions`, installed into `~/.pi/agent/local-packages/pi-questions` and registered as `./local-packages/pi-questions`. It needs no separate publication, npm install or private clone.


```sh
git clone https://github.com/woksin/pi-setup && cd pi-setup
./install.sh --dry-run   # show what would change
./install.sh             # overwritten files are backed up to ~/.pi/agent/.pi-setup/backups/<timestamp>/
```

Install needs Node.js 22.19 or newer (pi needs it too) and Python 3.9 or newer (macOS/Linux); `./install.sh` installs them for you when they are missing. `install.sh` is a thin shim around the committed bundle `installer/dist/pi-setup.mjs`; it detects your setup first and asks only what it could not find out. In a terminal it runs a short wizard; with `--yes`, `CI` set or no terminal it never prompts. It detects your GitHub login (saved, then `gh`), your repositories root (saved, then the best match among the usual places such as `~/repos` and the parent of this checkout, then `$HOME/repos`), which providers you are logged in to, and picks a profile from `agent/profiles/<name>/profile.json` (an already active profile is kept on re-runs; `--profile <name>` switches). It then runs npm install in pi's global package store, `~/.pi/agent/npm`, when inputs change or a pinned package is missing/wrong. New installs register and fetch `npm:@woksin/pi-jobs@0.3.1`, `npm:@woksin/pi-context-budget@0.5.0`, `npm:@woksin/pi-recover@0.1.1` and `npm:@woksin/pi-orch@0.1.1` (with `--save-exact --legacy-peer-deps`). Existing explicit package versions and local overrides are kept. `--skip-npm` skips fetching; doctor then reports missing packages. Launchers `pi-session`, `orch` and `orch-poll` are linked into `~/.local/bin` on the first install; existing files/foreign links there are left alone.

Flags, in any order: `--install-prereqs` (install missing prerequisites and pi without asking), `--no-install-prereqs` (only report them), `--user <login>`, `--repos-root <dir>`, `--profile <name|auto>`, `--yes` (never prompt), `--skip-npm`, `--dry-run` (writes nothing), `--plan` (print detection, profile and actions, write nothing) and `--json` (one JSON object on stdout). The operator settings are saved in `~/.pi/agent/user.json` (`githubUser` and `reposRoot`; other keys are kept) and reused on later installs unless flags override them. Without a login from any source, a real install fails and asks for `--user`; `--plan` and `--dry-run` use the placeholder `<you>` instead. Repo templates use `{{GITHUB_USER}}` and `{{REPOS_ROOT}}`; install renders them for you. A re-run that has nothing to change prints `Everything up to date`, no `install` lines, and creates no backups.

### Update, uninstall and backups

Each install records what it wrote in `~/.pi/agent/.pi-setup/manifest.json` (HOME-relative paths and hashes; no checkout path or remote). Re-runs use it: a file you have not changed is updated silently (the old bytes go to `~/.pi/agent/.pi-setup/backups/<timestamp>/`); a file you changed is kept, and in a terminal install asks whether to keep yours, take the new one or show the diff, otherwise it writes the new version next to it as `<file>.pi-setup-new`. An install made before the manifest existed is adopted on its next run. `settings.json` and `user.json` are merged key by key, so uninstall can revert just those keys.

- `./install.sh update [--dry-run] [--ref <tag>]` checks out the latest `v*` release tag of this checkout (detached; `git switch main` goes back) and runs that release's installer. It refuses a checkout with local changes.
- `./install.sh uninstall [--dry-run] [--yes]` removes what the manifest lists, restores files that install had replaced, and leaves files you changed (it lists them). It never touches `auth.json`, `sessions/`, `accounts/`, `jobs/`, caches or anything that is not in the manifest.
- `./install.sh backups [list | prune --keep N]` lists the run folders or prunes them; installs keep the last 10. Backups that uninstall restores from are pinned and never pruned.

`~/.pi/agent/.pi-setup/` holds the uninstall data (the manifest and the pinned backups). Do not delete it by hand; use `pi-setup uninstall` or `pi-setup backups prune`. pi rewrites `settings.json` at runtime, so a `settings.json` created by install counts as "changed by you" on uninstall and is left; one that existed before is reverted key by key. npm packages (`~/.pi/agent/npm/node_modules`) and pi's runtime state are not in the manifest, so uninstall leaves `~/.pi/agent` in place when they exist.

### Doctor

Run `./install.sh doctor [--fix] [--json]` (or `pi-setup doctor`): exit 0 means green, 1 warnings, 2 failures or invalid arguments.
`--fix` installs missing prerequisites and pi after asking (`--install-prereqs` skips the question; it prints the exact command first), reinstalls missing npm dependencies, restores missing tracked files/links when the checkout still matches the installed commit, and restores modes of unchanged files; it never changes logins, guards, profiles, PATH, services or edited files.
Doctor runs `pi --version`, `pi auth check --provider <id> --no-refresh --json` (no token refresh), and `pi --offline --list-models` (no model call or network). pi may perform its normal one-time migrations; extension errors that do not crash pi are not visible.
The update check is cached once a day; `PI_OFFLINE=1` skips it. Otherwise doctor is read-only, and `--json` emits one object on stdout.
For build performance and disk cleanup, use `~/.pi/agent/bin/dev-doctor`; doctor delegates its disk check to that tool.

`--legacy-peer-deps` is needed: the packages declare conflicting peer ranges for `@earendil-works/pi-*` (for example `@vigolium/piolium` wants `^0.74`, `@tintinweb/pi-subagents` wants `>=1.1.0`), so a plain `npm install` fails with ERESOLVE.

`settings.json`, `models.json` and the other JSON configs are only written when they don't exist yet. `efficiency.json` and `context-budget.json` follow the same rule. Restart pi afterwards.

Both `~/.local/bin` and `~/.pi/agent/bin` must be on PATH. The installer prints a shell-specific snippet when either is missing and **does not edit shell profiles by default**. Add it yourself or opt in with `--edit-shell-profile` (append-only, idempotent; zsh `.zshrc`, bash `.bash_profile` on macOS/`.bashrc` on Linux, fish `config.fish`). Restart your shell afterwards.

```sh
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:$PATH"
```

For temporary-HOME testing use `--no-launchd`. Loading/unloading launchd is also automatically skipped whenever HOME differs from the OS account's real home, including turn-off and uninstall; selected unit files can still be staged in the temporary HOME. Linux systemd behavior is unchanged.

`inbox-watch` accepts an explicit directory with `INBOX_DIR=/absolute/path/to/messages ~/.pi/agent/bin/inbox-watch`. Set it for your checkout rather than relying on the legacy default.

Optional extras: `--with <id>` / `--without <id>` (or the wizard's "Extras" question) turn on `docker-guardian`, `cleanup`, `secret-sweep`, `disk-growth`, `codescene`, `cratis`, `web` or `lanes`. Your choice is saved in the manifest and reused on later runs; turning one off removes what pi-setup added and leaves files you changed. The schedules (`docker-guardian`, `cleanup`, `secret-sweep`, `disk-growth`) are only installed when you choose them (the guided installer pre-selects the supported ones in its Review; unattended runs need `--with`): on macOS they are written to `~/Library/LaunchAgents/com.<user>.<name>.plist` and loaded with `launchctl bootstrap`; `cleanup` on Linux uses a systemd user timer. `codescene` needs `cs-mcp` on PATH and `CS_ACCESS_TOKEN` in your shell profile; pi-setup never stores the token.

### Lanes (opt-in)

Install with `./install.sh --with lanes`, then run `lanes init <dir>` to create a coordination folder.
For hand-started sessions, `lanes adopt --dir <root> --exclude-tty ttys004 --inventory <file>` previews a config diff; add `--write` to merge atomically without controlling sessions or moving messages.
For guided setup, run `./install.sh lanes [--dir <folder>]`; it selects local repositories and issues or goals, creates locked worktrees, and offers to open the coordinator.
Add work with `lanes --dir <dir> add L1 --repo owner/name --issue 123` (clone the repository first).
Run `lanes --dir <dir> start coordinator` or `start L1`; the coordinator starts in the coordination folder.
`lanes send <TO> <topic> -m "text" --from L0` sends a message; `lanes status` shows the lanes (use `--dir` outside the folder).
Terminal.app, iTerm and tmux are supported; `--terminal print` prints a shell command without starting a session.

Multiple lanes in one repository get one repo orchestrator automatically when the second lane is added: `R-<REPO>` uses a locked `<id>-candidate` branch. Start it with the printed `lanes start` command. Use `add ... --orchestrator ID` to promote an existing lane, `--orchestrator-id ID` to resolve an ID collision, or `--no-orchestrator` to opt out (status warns). `lanes status` shows role/parent and indents children; `--all` includes retired lanes. Lane reports addressed to L0 route through their repo parent; `send ... --direct` bypasses this. Repo orchestrators report to L0. A repo-orch may additionally declare `orchestrates: ["owner/repo", "owner/other"]`; `repo` remains its current workspace repository. Parent grouping, routing and warnings cover both `repo` and `orchestrates`, with only one active orchestrator per covered repository. Adopt with `--role SPEC=repo-orch --orchestrates SPEC=Cratis/Fundamentals,Cratis/Specifications` (repeat `--orchestrates` for other lanes).

`lanes reap [ID] [--minutes n] [--json]` is a **dry-run by default**: it saves only `.state/reap-plan.json`. `close --inactive` is an alias. Silence is never proof of completion. The planner checks exact session identity/write age, descendants, open jobs/watch logs, inbox markers and messages, claims, repository state, waits and optional orchestration/context evidence. Watcher `.state/inbox-<ID>.marker` epoch contents and canonical message marker mtimes are supported; when readers disagree, the oldest valid marker is used. Exact session, worktree, branch or repo-plus-issue local claims block retirement; branch substrings alone never establish ownership. Missing inbox markers are JSON notes unless pending inbound needs watch evidence; old ambiguous names do not block an otherwise-proven handoff. Own session history uses an aligned bounded tail, and human summary lists show at most ten samples while the saved plan retains complete lists. Job snapshots cover watch intervals, and unrelated subagent statuses are ignored. Human reasons show at most three summaries; JSON retains the full asks/keeps lists. Missing, ambiguous or contradictory evidence yields `ask`; busy, unread, active claims or snoozed work yields `keep`. Optional pi-orch/context-budget/gh facilities are not prerequisites. The fallback inactivity threshold is 75 minutes (a configured `idle.minutes` takes precedence). Set `lanes snooze ID --until +90m` (or an ISO timestamp), and `--clear` to remove it.

Apply explicitly with `lanes reap ID --apply [--handoff-to ID]`. It creates a handoff pack and request to a live recipient (default parent); it does **not** close the lane until the recipient reviews and accepts: `lanes handoff ID --accept --from RECIPIENT`. You can prepare it separately with `lanes handoff ID --to RECIPIENT`. Packs include branch/SHA, dirty/ahead state, claims, coordination notes, unknown pending acknowledgements and next actions. Acceptance records takeover, not completion; unfinished local claims are paused with a handoff note only after confirmed exit, never marked done. If `PI_ORCH_ID` is set, acceptance must match that identity. Changed evidence invalidates acceptance. File messages lack machine-readable delivery acknowledgements/candidate ownership, so they never establish `finished`; that work requires takeover.

On apply, reap first asks the target pi through its guarded TTY to write its own context to `.state/handoffs/<ID>.md`. It waits at most 30 seconds for a file newer than the request, checks nonempty goal/constraints/open-items/launch sections and a JSON Snapshot (HEAD, repository, worktree, branch, every dirty path and unpushed commit), and refuses missing, stale or mismatching context. The machine pack also records exact porcelain status and a content digest; unaccounted dirty work is never retired. A handoff-induced session write still restarts the inactivity wait; a validated handoff can be reused only while the captured session/tree state remains unchanged.

After accepted takeover, reap rechecks safety immediately before sending `/quit` to the exact foreground pi TTY through tmux/Terminal/iTerm. It never kills a process. Only confirmed exit permits metadata retirement: prompt, status, marker, lane-addressed messages, handoff and closure evidence are archived under `.state/retired/<stamp>/<ID>/`, with the config entry marked retired. Worktrees, branches, dirty files, session JSONL and pi-questions identities remain untouched. Each closure appends `.state/reaped.log` and coordinator STATE, pauses unfinished owned claims, and posts `lane-closed` to the parent. Quit failure leaves active metadata alone. Ordinary `start` refuses retired IDs. Restore in one command with `lanes resume ID` or `lanes start NEW-ID --from-handoff ID` (an explicit handoff file path also works); the context is the launch prompt and the preserved worktree is reused. Re-running apply skips retired lanes. Children are considered before parents. The caller and its parent always return `keep` with an explicit reason.

Message retention is configured with `messages.retention`: `mode` is `keep`, `archive` or `delete`; `maxAgeDays` sets the age threshold; `archiveDir` must stay strictly below the messages folder and outside `status/` (relative or absolute paths, without `..`); `archiveMaxAgeDays: null` keeps archives forever. New folders default to archive after 14 days in `archive`, with `keepUnread: true` protecting messages newer than an addressed configured lane’s inbox marker (missing markers do not protect), and `auto: true` pruning before start; prune errors only warn. Existing configs without retention keep messages. Run `lanes messages prune [--dry-run] [--json]` manually; archive expiry also runs in keep mode.

MCP preapproval is off by default. The wizard asks before trusting project MCP server definitions; `./install.sh --with lanes --preapprove-mcp` saves this opt-in for new coordination folders. `lanes init <new-dir> --preapprove-mcp` opts in for one folder. Existing folders keep their saved setting; doctor reports the current folder’s setting or the installed default.

Lanes operations (use `--dir <folder>` outside the coordination folder):
- `lanes idle-check [--minutes n]` reports running lanes that have gone silent.
- `lanes nudge <ID|coordinator> <text>` sends one line only to a foreground pi session.
- `lanes resume-check` verifies standing watches, unread inbox and NOW.md after a reset.
- `lanes green-prs [--new | --ack]` lists green PRs or acknowledges the current list.
- `lanes close <ID> [--reassign-to ID2] [--reason text] [--quit]` posts closure and a removal hint; it never removes worktrees or edits lanes.json. `--quit` is opt-in and refuses busy or recently active sessions.
Watch exits: 0 fire/OK, 1 nothing/missing, 2 error. Nudge: 0 sent, 3 refused, 4 no tab/pane or print backend.

Optional, macOS only: use `--with docker-guardian`, `--with cleanup`, `--with secret-sweep` or `--with disk-growth` to manage schedules. The installer fills in your home and username and creates `~/Library/LaunchAgents/com.<user>.docker-guardian.plist`, `com.<user>.pi-cleanup.plist`, `com.<user>.secret-sweep.plist` or `com.<user>.disk-growth.plist`. Files under `agent/launchd/` remain manual-install templates, not the managed filenames.

`settings.json` lists the packages I load. Local checkouts are mapped to their npm packages (`npm:@woksin/pi-jobs`, `npm:@woksin/pi-recover`, `npm:@woksin/pi-context-budget`, `npm:@woksin/pi-orch`). Remove the ones you don't want.

## For Cratis team members

```sh
git clone https://github.com/woksin/pi-setup && cd pi-setup
./install.sh --user <your-github-login> --repos-root <where-your-repos-live>
```

Restart pi. Agents assign issues and PRs to you and request you as reviewer (skipping the review request when you are the PR author). They merge Cratis PRs themselves once required CI is green and the final review passes, but never PRs that trigger major releases.

Remove the parts you don't want:

- **docker-guardian:** the guided installer pre-selects it when Docker is found on macOS; untick it in the Review, or for an existing schedule run `./install.sh --without docker-guardian` to unload and remove it. For a manually copied template, unload and remove your actual plist in `~/Library/LaunchAgents/` (managed names use `com.<user>.docker-guardian.plist`).
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

Dry runs have one 60-second planning budget (`--budget SECONDS`, `0` for unlimited).
Text sections stream as they finish; `--json` emits one complete document instead.
Unfinished sections/items say `not measured (budget)` and are never marked removable.
Sizes are optional; `--apply` ignores this budget and retains its full safety checks.
Dry runs use existing remote-tracking refs without fetching (`remote refs not refreshed
(dry run)`). Budget expiry signals only the section worker, never its git children;
`--apply` still fetches before classifying worktrees.
`PI_CLEANUP_TIMING=1` prints planning milestones to stderr even without a terminal.
The caches step also lists stale, user-owned `pisync.*` and `gr-stage-ui*` directories
under `/tmp` and `/private/tmp`, deduplicating their aliases. `--apply` removes only
real directories older than two hours, after fresh open-file/cwd and fixture-lock
checks; symlinks, busy directories and unknown process state are kept.

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

**Disk-growth alert:** `bin/disk-growth` samples home-volume free space every minute and alerts on a drop of at least 5 GiB within 5 minutes (45 s jitter slack). Enable with `--with disk-growth`. Notices are `ALL-disk-growth-<HHMM>.md` in each existing `DISK_GROWTH_MESSAGES` directory (path-separated), otherwise `PI_ORCH_MESSAGES_DIR`, user.json `orchMessagesDir`, or `.ai-work/messages` under `PI_ORCH_REPO_ROOT` / user.json `orchRepoRoot`. State is `~/.pi/agent/disk-growth/state.json`, log `~/.pi/agent/logs/disk-growth.log`. A notice is suppressed for 30 minutes unless free space falls another 5 GiB below the last alert. `~/.pi/agent/disk-growth.json` accepts `drop_gib`, `window_seconds`, `debounce_seconds`, `rearm_gib`, `probe_budget_seconds`, `volume`, `roots`, `watch_files` and `messages_dirs`. Defaults probe user.json `reposRoot`, pi jobs/logs/sessions/pi-phase and the temp directory; Docker.raw allocated growth is sampled separately. Overrides: `DISK_GROWTH_DROP_GIB`, `DISK_GROWTH_WINDOW_S`, `DISK_GROWTH_CONFIG`, `DISK_GROWTH_STATE`, `DISK_GROWTH_LOG`. The isolated probe is killed after 20 s, caps discovery at 3000 units and discovery/traversal at 100000 entries, skips symlinks and may report partial coverage. Writer sizes are full allocated sizes of recently modified files, not true write deltas; APFS purgeable space or snapshots may explain drops with no obvious writer. `--dry-run` prints the evaluation and any notice without writing state or notices.

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

The lessons behind the global rules are in [docs/operating-lessons.md](docs/operating-lessons.md).

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Global rules: scope, execution budgets, delegation briefs, review loops, GitHub issue hygiene, shipping, CI minutes, disk hygiene. |
| `agents/` | Custom subagent types (`implementer`, `reviewer`, `sol-reviewer`, `ops`, `scout`, `grunt`, …), each pinned to a model and thinking level. |
| `profiles/` | Model-routing profiles (`balanced`, `anthropic-heavy`, `openai-heavy`, …). Switch with `bin/pi-profile use <name>`. |
| `extensions/guards.ts` | `/guards` command that turns the guards below on or off. |
| `extensions/wait-guard.ts` | Blocks long foreground waits and repeated CI status polling. |
| `extensions/dotnet-guard.ts` | In orchestration mode, blocks unwrapped .NET build/test/run work with a pi-phase replacement; `/guards off dotnet` disables it. |
| `extensions/train-guard.ts` | Blocks pushes to folded/planned branches in active local trains, including in coordinator lanes; `/guards off trains` disables it. Auto-discovered with the other installed extensions. |
| `extensions/cratis-cli-guard.ts` | Blocks state-changing `cratis chronicle` commands unless approved. |
| `extensions/issue-work.ts` | `issue_work` tool: claim, update, list (repo/state/free filters) and query ownership (owner) of the GitHub issues sessions work on, with leases across sessions and checks for new activity (logic in `lib/issue-work.ts`); existing output unchanged except the intentional new delivery refusal on claim. |
| `extensions/phase-priority.ts` | Asks you before an agent gets high priority in the `pi-phase` queue (`--priority high`); blocks subagents and self-granting. `/phase-priority` grants or revokes. A session you designate as orchestrator can grant priority itself, capped at 10 uses or 120 minutes (`lib/phase-priority.ts`). |
| `extensions/stale-cwd.ts` | Warns once (and shows a status) when the process working directory went stale, with the recovery (`lib/stale-cwd.ts`). |
| `extensions/provider-fallback.ts` | Falls back to another provider's model when a usage or rate limit is hit (`provider-fallback.json`). |
| `extensions/model-provenance.ts` | Stamps StructuredOutput with runtime assistant model records (also headless), overwriting self-reported attribution. Review workflows require the full runtime shape and a schema/prompt-hidden stamp, failing `INCOMPLETE` on missing or mixed/wrong model evidence. Best-effort accidental-fallback detection for cooperating agents, not authentication: an adversarial reviewer with source access can imitate the record if the extension is absent. |
| `extensions/lane-policy.ts`, `lib/lane-policy.ts`, `lane-policy/README.md` | **Dormant pilot.** A cooperative guard for git push and `gh` writes in repositories you enrol with `/lane-policy`. Does nothing until you enrol a repository. Read `lane-policy/README.md` before turning it on. |
| `extensions/subagent-result-guard.ts` | Stops agents from re-reading a subagent result that was already delivered in full. |
| `extensions/output-cap.ts`, `extensions/observation-mask.ts` | Cap large tool output (full text goes to `.ai-work/tool-out/`) and mask old tool output in subagent context. Tuned in `efficiency.json`. |
| `extensions/cache-retention.ts` | Defaults Anthropic prompt caching to the 1-hour tier. |
| `extensions/cratis-cleanup-env.ts` | Sets `CRATIS_CLEANUP_NO_GH=1` so the Cratis worktree cleanup hook stops querying GitHub once per worktree; git-ancestry cleanup still runs. |
| `extensions/ai-work-lifecycle.ts` | Integrates the `ai-work-lifecycle` task-output tool. |
| `early-extensions/mcp-project-trust.ts` | Only loads project MCP configs from trusted folders. |
| `workflows/review.js` | Cross-provider code review with adversarial verification; gates only on confirmed blocking findings and requires runtime provenance matching each pinned reviewer/verifier model. |
| `workflows/bulk-edit.js` | One mechanical change across many files, then verified. |
| `workflows/loose-threads-plan.js` | Turns a `loose-threads` inventory into a cleanup plan. |
| `loose-threads/` | Weekly audit of leftover worktrees, branches, stashes and Docker volumes. |
| `pi-phase/`, `bin/pi-phase` | Wrapper for build and test commands with time limits, logs and a shared queue ordered by priority (`low`, `normal`, `high`), then first come first served. Includes a 60-day run ledger, exact passed-state skipping (`--rerun` to bypass), per-stack throughput `stats` and read-only `wait --eta` estimates. Long queue waits belong in background jobs (`job_start`), with `--queue-timeout` up to 7200 seconds and no approval flag; execution beyond 600 seconds still needs `--approved-long-timeout`. |
| `bin/pi-train` | Local release trains: `init`, `concurrency`, `fold`, `planned`, `status --json`, `ship` and optional push hooks. Folding closes superseded PRs, cancels eligible CI runs and collects release bullets immediately. Manifests live in `${PI_TRAIN_DIR:-~/.pi/trains}`; mutating commands support `--dry-run`. Local packages are a follow-up slice. |
| `bin/dev-doctor`, `dev-doctor.example.json` | Bounded diagnostics and safe, fused cleanup for old exited/label-owned containers and temporary browsers. |
| `bin/docker-guardian` | macOS: checks that Docker Desktop answers every 2 minutes, restarts it within a budget, removes dead containers and old build cache, only removes superseded semver tags/dangling old images under the narrow rule below. Run it from the launchd template in `launchd/`. |
| `bin/inbox-watch` | Polls a directory of files that parallel agent sessions use as messages; pair it with one `job_watch`. Set `INBOX_DIR`. |
| `bin/gpt-meter` | Read-only spend meter for OpenAI usage from session logs. |
| `launchd/` | Templates for the `docker-guardian`, `pi-cleanup`, `secret-sweep` and `disk-growth` schedules (placeholders instead of my user name). |
| `context-budget.json`, `efficiency.json`, `provider-fallback.json`, `subagents.json`, `mcp-adapter.json` | Default configs for the extensions and packages above. |
| `AGENTS.subagent.md` | Rules for subagents (derived from `AGENTS.md`, without the orchestration policy). |
| `bin/pi-profile` | Switch model-routing profiles. |
| `bin/pi-account` | Switch between saved Anthropic logins (tokens are never printed or stored here). |
| `bin/pi-usage` | Provider usage and limit pressure from session logs. |
| `bin/secret-sweep` | Read-only daily gitleaks scan of local sessions and `.ai-work` records; redacted reports under `~/.pi/agent/logs/secret-sweep/`. |
| `bin/disk-growth` | macOS: per-minute free-space sampling and bounded top-writer alerts; helper in `bin/disk_growth_probe.py`. |
| `bin/pi-cleanup` | Disk cleanup of build output and stale worktrees (dry run by default). |
| `templates/brief.md` | Template for delegation briefs. |
| `templates/repo-orchestrator-brief.md` | Template brief for the repo orchestrator that coordinates several lanes in one repository. |
| `settings.json`, `npm-package.json` | My pi settings and the npm packages I use. |

### Release trains

- `pi-train fold <PR#|branch> [--eta when]` and `pi-train planned <PR#> <train-branch> [--eta when]` store a delivery's expected ready time as UTC. Use an ISO 8601 timestamp with seconds and timezone, or `+90m`/`+2h`/`+1d` resolved when invoked. Repeating a command with `--eta` updates it; omitting the flag preserves it. `pi-train eta <PR#|branch> <when|clear> [--train branch]` updates or clears an existing delivery locally.
- `pi-train status [--gate 90m]` lists ETAs and recommends holding only for pending/planned deliveries due within one gate (including overdue deliveries). Completed folded deliveries and deliveries with no ETA never hold the train. Without history it reports `unknown`; `--json` includes `recommendation`, `gateSeconds`, `gateSource`, `gateRuns` and item ETAs. The gate is the sum of per-kind nearest-rank p90 execution wall times (`runS`) for completed build/test/integration runs in the last seven days, matched by Git common directory across repository worktrees. Cancelled, skipped and unstarted runs are excluded. History comes from `${PI_PHASE_STATE:-~/.pi/agent/pi-phase/state}/ledger`. `--gate` overrides a manifest's positive `gateSeconds`, which overrides history; durations accept positive numbers with `s`, `m`, `h` or `d`. No additional network calls are made for the recommendation.
- `pi-train close [train-branch] [--shipped PR#] [--head sha]` marks a train `released` once it has shipped, recording the train PR and shipped head; `--abandoned` marks a dropped train. Never hand-edit a manifest. It only updates the manifest, so it also works when the train worktree or branch is gone. Closed trains leave `status` and the push guard. When a close leaves no open train, and in `status` (`untrackedCandidates` in `--json`), local `cand/*` branches ahead of the base that no manifest tracks are listed with a read-only `adopt with: pi-train init --adopt <repo-dir> <branch> --base origin/main` hint; nothing is adopted automatically. `status --all` reports a train whose worktree is missing as `train unavailable` instead of stopping.
- `pi-train init --adopt <repo-dir> <existing-train-branch> [--base origin/main]` adopts an existing local branch, reusing its worktree or attaching it to a new one without recreating the branch. It records the merge-base and lists first-parent merges and open PR heads already in the train; it does **not** fold them. Run the suggested `pi-train fold <pr>` commands to close/cancel superseded PRs without re-merging their commits. Main/default branches and existing manifests are refused.
- `pi-train ship [--train branch] [--label major|minor|patch|no-release] [--summary-file f] [--title text]` checks the clean train head, completed fold steps, closed folded PRs and ancestry against the fetched base (`--allow-behind` is explicit). It writes `.ai-work/trains/<train>/pr-body.md` and `pr-notes.md`, checks the body, pushes, and creates or updates one train PR. Repeating it does not duplicate comments or PRs. The body contains the optional summary and collected release bullets; reviewer notes contain folded heads, cancelled runs and gate evidence.
- `pi-train concurrency [--json]` detects pending work across the main checkout and its worktrees, offline. Two or more pending worktrees converge into one candidate: one assembled Tier 1, one PR, one release. The train worktree is excluded; merged idle branches do not count. It suggests `init` and `fold` commands without creating anything.
- `pi-train fold [branch]` defaults to the current worktree branch, uses its local head without pushing or fetching, and accepts forward re-deliveries; rewritten history is refused. PR deliveries still use the PR head. The command prints the local SHA it folds.
- Under the `trains` switch, `gh pr create` for a non-candidate head is blocked when this repository has an open candidate; the candidate head is allowed, orchestration only warns, and concurrent work without a candidate or a full gate off-candidate only warns in the tool result. Named `PI_CANDIDATE_EXCEPTION=major|urgent-fix` prefixes allow and log PR exceptions and suppress gate notices; errors fail open with a notice. Close abandoned candidates with `pi-train close --abandoned` before opening unrelated PRs.
- Without `--label`, the highest release label on folded PRs wins: major, minor, then patch. The no-release fallback requires every folded PR to carry no-release; otherwise missing release labels require an explicit choice. A Cratis repo's `.cratis/ai/hooks/scripts/cratis-check-pr.mjs` checks the body before any push or PR mutation. Otherwise `${PI_TRAIN_DIR:-~/.pi/trains}/config.json` may supply `"checkPr": ["checker", "--body-file", "{bodyFile}", "--label", "{label}"]` (argv, not a shell command). Without either checker, ship prints `no PR-body check in this repo`.
- Ship searches `~/.pi/agent/pi-phase/state/ledger/*.jsonl` for passed, verified, clean build/test evidence for the exact train head. Missing evidence warns `no verified Tier 1 for <sha>`; `"requireGate": true` in the same config makes it a refusal. This does not run CI or infer a passing gate from logs.
- The train guard reads active manifests locally; there is no daemon, remote manifest or repository config. It covers bare/`-C` git pushes, upstream pushes, refspecs and all/mirror pushes. Unparseable pushes are allowed with a notice. `pi-train hook install` adds an opt-in pre-push hook for exact pushed refs, respecting `core.hooksPath`/common-dir hooks and chaining an executable existing hook. Non-executable hooks are preserved without running them, with a warning. Installation refuses tracked or husky-managed hook directories; choose an untracked `core.hooksPath` instead. `hook uninstall` restores the original hook and will not remove an unrelated one. Deletions are allowed. An unavailable or broken train guard allows the push with a notice; only a positive folded/planned destination match blocks it. Hooks apply outside pi too: the exact-branch escape hatch is `PI_TRAIN_ALLOW_PUSH=<branch> git push …` (in pi, the independent extension must also allow the push). The guard ignores released/abandoned trains, other repositories and unrelated branches.

### Workflow rules worth knowing

- **Phase priority and orchestrator mode.** `pi-phase run --priority high` jumps the queue, up to 3 queued/running HIGH phases (`max_high`, configurable 1–10); further approved requests queue as normal without consuming a grant use. `phase-priority.ts` blocks it unless you or a designated orchestrator session approve; subagents can't grant themselves priority.
- **Reload recovery.** After `/reload`, background jobs survive but subagents don't. `AGENTS.md` tells the agent to run `/jobs`, read the `pi-recover` notice, re-arm only what's missing and not to `/reload` while it needs running subagents.
- **Guards.** `wait-guard`, `cratis-cli-guard`, `subagent-result-guard`, `lane-policy`, `publish` and the MCP approval guard share `/guards on|off <name>` (`--persist` to keep it). Disabling a guard is always your call, not the agent's.
- **Secret sweep (optional).** Install `gitleaks` on PATH and run `~/.pi/agent/bin/secret-sweep`, or opt in with `./install.sh --with secret-sweep` for a daily 05:30 scan (`com.<user>.secret-sweep.plist`). It scans `~/.pi/agent/sessions` and discovers `.ai-work` directories under `~`; set `PI_SECRET_SWEEP_ROOTS` to additional roots separated by `os.pathsep` (`:` on macOS/Linux), or repeat `--root PATH` to add discovery roots (home and sessions are still scanned). For launchd, add `--root` and a root path to the template's `ProgramArguments`, or set `PI_SECRET_SWEEP_ROOTS` in its `EnvironmentVariables`. Discovery prunes symlinks, `~/Library`, `~/.Trash`, caches and build directories (including `.git`, `node_modules`, `bin`, `obj`, virtualenvs, `dist`, `Pods`, `.gradle`, `target` and `.next`). It defaults to depth 8 (`--max-depth`) and 100,000 directories (`--max-directories`), reserving at most 30 seconds or half of the 120-second total budget (`--timeout`) for discovery. Unreadable directories are skipped and counted; hitting a discovery cap still scans discovered records and marks the report partial. Each file scan is capped at 20 MiB. Reports are `~/.pi/agent/logs/secret-sweep/<date>.md`: file, rule, count and line numbers only; scanner output is suppressed and matched values are excluded defensively. Exit codes: 0 clean, 1 findings, 2 tool/report error (including missing gitleaks). Depth-limited discovery is not exhaustive. The scan never rewrites records; redacting ended sessions is a follow-up. Rotate exposed credentials.
- **Secret-mask limits.** Result notices report category and start line for at most 20 redactions, with an omitted-location count. Output lines refer to text presented to the scanning hook (text parts joined with one LF), before its masking; earlier extensions may already have modified it. Output-cap notices use lines before output-cap truncation. Read notices may include a bounded, sanitized requested path only; content provenance stays unknown, including appended rules. They never claim file-line attribution. Operational labels with credential-like values remain masked when indistinguishable from credentials. User shell escapes (`!`/`!!`) have no completed-output hook API, so their output is not redacted. Output-cap pre-masking honours secret-mask's `allowlist` and `enabled: false`; disabling it permits raw offloads.
- **Guards and the Cratis hooks.** When Pi has actually loaded the managed Cratis hooks extension from the process cwd (its `cratis_quality_gate` tool is registered in `pi.getAllTools()` from `.cratis/ai/harnesses/pi/extensions/cratis-hooks`, which the `.pi/extensions` symlink points to; an untrusted project's extensions are skipped by Pi, so they never count, no repository script is run and the Cratis switch is not honoured), `cratis-cli-guard` and `secret-mask` ask the Cratis script itself (same script, cwd and payload) about a command they would block, and stand down only when it exits 2, so the command is refused once. For `cratis chronicle` mutations the switch is `CRATIS_HOOKS_ALLOW_STORE_MUTATIONS=1`; for credential-printing commands it is `CRATIS_HOOKS_ALLOW_SECRET_READS=1` (both set in the environment the harness starts from; `/guards off cratis|secrets` is not needed there). If the script allows the command, cannot run or times out (for example it silently no-ops without `jq`), or the Cratis extension is not proven loaded, the local guard blocks as before. `secret-mask` redaction always stays on; `/guards off cratis` disables confirmations only and still refuses production mutations; `cratis-cli-guard` also keeps `cratis prologue start` confirmation, still denies production targets when the Cratis switch is set, and reads the Cratis read-only list at runtime, falling back to its built-in list.
- **Text publication.** Use the structured `publish` tool or `pi-publish` for GitHub titles/bodies/comments/reviews, release notes, gists and typed API writes. Requests reject unknown fields/flags; no arbitrary gh argv, environment, host or scanner override is accepted. Lane admission runs before payload IO, and PR creation also checks candidate policy. Capture is bounded (2 MiB per string/file, 8 MiB aggregate), regular-file-only and strict UTF-8; all outbound values and captured file bytes are scanned before any send. Refusals cover credentials, mask placeholders and private/local path markers; diagnostics expose rule/source/line/count only. Private snapshots, not reread original paths, are sent through an absolute gh executable with shell disabled. Raw gh output/errors are suppressed. No live install or activation is implied.
- **Publish controls and limits.** Only explicit user `/guards off publish [--persist]` disables cooperative shell routing; `/guards on publish` restores it. `all` and `PI_GUARDS_OFF` exclude publish. The tool/CLI scanner stays mandatory even with that switch off. Rewrite refused text; do not encode, split, mask or change transport to evade it. `check` scans a captured snapshot only, not a later send. The shell guard covers literal executable positions and known job/nested-tool shapes, including supported env wrappers; unknown env options such as `-S` are refused. Pure quoted documentation/heredocs stay data. Opaque scripts/interpreters/eval/xargs, comprehensive substitutions, dynamic URLs/configs, arbitrary encodings/split paths and UNC paths are not covered comprehensively. This is not a same-user process/filesystem/network sandbox. `pi-train ship` and `issue-status.py update` now scan what they send through the shared scanner; `pi-train fold`'s fixed close/link comments and other trusted internal writers remain direct and are not claimed scanned.

```json
{"kind":"issue-comment","repo":"OWNER/REPO","number":123,"body":"A concise public update."}
```

CLI: `pi-publish issue-comment --repo OWNER/REPO --number 123 --body-file .ai-work/comment.md`. Use separate long-option values (not `--flag=value`); repeat list options. `pi-publish check --file .ai-work/comment.md` is advisory; `pi-publish --help` does not publish. Supported kinds include issue/PR create/edit/comment/close/reopen, PR review/merge, release-create/release-notes, gist-create/gist-edit and api; enrolled lane policy may deny kinds without a supported grant action. The CLI relies on guarded shell admission, not a standalone Pi-session identity. Installed enforcement paths (including scanner dependencies and launcher), symlinks and ancestor/glob mutations are operator-maintained even for named setup writers; repository source edits and reads remain allowed.

- **Issue work.** `issue_work` keeps a registry of the issues each session works on under `~/.pi/agent/issue-work/` (runtime state, not included).
- **Provider fallback.** When one provider hits a usage limit, `provider-fallback.ts` switches to the paired model in `provider-fallback.json`. Edit the pairs to match the models you have.

### `skills/` → `~/.agents/skills/`

- `ai-work-lifecycle`: managing temporary AI task outputs without leaving large caches behind.
- `dev-machine-performance`: diagnosing slow gates and queues, with safe machine advice and CI-parity lane habits.
- `github-issue-hygiene`: keeping issues current and closing them when done (includes `issue-status.py`).
- `sol-loop`: a bounded review loop with the native `sol-reviewer` agent. Invoked by saying "sol loop"; ships its upstream MIT `LICENSE`.

Descriptions are invocation hints only. Source lives here in `skills/` and the installer copies it to `~/.agents/skills/`; `sync.sh` is an optional live-to-repository snapshot and does not cover `sol-loop`. See [`docs/authoring-skills.md`](docs/authoring-skills.md), [`docs/skill-template.md`](docs/skill-template.md) and [`docs/skills-adoption.md`](docs/skills-adoption.md).

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
- `local-packages/` other than `pi-questions`: published separately (see above). `pi-questions` is bundled here and its tests run in `tools/release-check.sh`.
- Retired profiles, `*.bak*` files, and the `fd` and `rg` binaries in `bin/`.
- The CodeScene skills (see above).
- `user.json`: operator identity and repositories root are local install settings, never synced into this repo.

## Troubleshooting

**Subagents or tools fail within milliseconds with `ENOENT: process.cwd failed`, and pi shows "stale cwd".** The pi process's working directory went stale (the directory was deleted or replaced while pi kept running), even if the path exists again. `/reload` does not change a process's cwd. Exit pi, then run `cd <project path> && pi -c`. The `stale-cwd` extension shows this warning at session start.

## Keeping it up to date

`./sync.sh` copies an allowlisted set of files from the live install into this repo, removes `deviceId` from the settings, points local checkouts of pi-jobs, pi-recover, pi-context-budget and pi-orch at their npm packages (deduplicated), replaces the local user name in the launchd templates, and checks the result before touching the checkout. It reverse-maps operator references and the repositories root in the copied templates to `{{GITHUB_USER}}` and `{{REPOS_ROOT}}`, using `~/.pi/agent/user.json`. For older installs without that file it uses the original author's login and `/Volumes/sourcecode/repos`; it does not write to the live install. Links, npm names, launchd labels and test fixtures stay unchanged. Review the diff before committing.

The sync first builds the whole published tree in a temporary directory and checks it with `tools/publish-check.py` and `gitleaks`. Only if everything passes is it written into the checkout; otherwise the sync fails, names the file and leaves the checkout unchanged. The checks are: a file-type allowlist (`.ts .mts .js .mjs .cjs .md .py .sh .json .jsonc .toml .yaml .yml .txt .plist`, `LICENSE`/`README`, and executable scripts with a shebang; anything else, including symlinks and binaries, fails), credential-like field names (`apiKey`, `token`, `secret`, `password`, `authorization`, `bearer`, `credential`) holding, or containing, a literal string in the published JSON configs (numbers and `$VAR`/`env:` references are fine), `PASSWORD=`-style assignments and connection strings with embedded passwords, and the live `lib/secret-mask.ts` scanner (required: missing, failing, or a file it skips as too large fails the sync). Files under `test/` and `*.test.ts` are exempt from the text and secret-mask checks only. The few known false positives are listed in `publish-check.py`.

Release steps: run `tools/release-check.sh` before tagging or publishing: it runs every extension and library suite (`agent/bin/pi-setup-tests`), the repository tests and `gitleaks git` over the whole history, and fails if any of them fails. To scan staged changes on every commit, run `git config core.hooksPath .githooks` once.
