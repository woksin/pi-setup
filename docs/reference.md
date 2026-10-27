# Tool reference

Every command-line tool pi-setup ships, grouped by what you use it for. Run `<tool> --help` for the full options and examples; this page does not copy flag lists. Read-only means the tool changes nothing on its own.

New here? Start with [Getting started](getting-started.md) and [Daily workflow](daily-workflow.md).

Some tools act on your machine when run (marked **acts**). Do not run those just to look: use `--help` or read the source.

## Models and accounts

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `pi-profile` | Show, list and switch model profiles. | `pi-profile --help` | [source](../agent/bin/pi-profile) |
| `pi-account` | Switch pi's Anthropic login between saved accounts. Always user-initiated. | `pi-account --help` | [source](../agent/bin/pi-account) |
| `pi-usage` | Read-only report of provider usage and limit hits from your session logs. | `pi-usage --help` | [source](../agent/bin/pi-usage) |
| `gpt-meter` | Read-only meter of GPT spend against a daily budget, from session logs. | `gpt-meter --help` | [source](../agent/bin/gpt-meter) |
| `provider-restore` | **Acts.** Clears recovered provider limit marks so running sessions switch back to that provider. | `provider-restore --help` | [source](../agent/bin/provider-restore) |

## Builds and queue

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `pi-phase` | Runs one build, test or integration command through a shared queue with time limits and logs. Subcommands include `run`, `status` and `stats`. See the [pi-phase README](../agent/pi-phase/README.md). | `pi-phase --help` | [source](../agent/bin/pi-phase) |
| `cratis-local-run` | Wrapper that sends each step of a cross-repository check through `pi-phase`. | `cratis-local-run --help` | [source](../agent/bin/cratis-local-run) |
| `pi-setup-tests` | Runs the `lib/*.test.ts` tests of an agent directory. | `pi-setup-tests --help` | [source](../agent/bin/pi-setup-tests) |

## Pull requests and trains

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `pi-train` | Manages a release train: fold several PRs into one branch, check status and ship it. See [Release trains](../README.md#release-trains). | `pi-train --help` | [source](../agent/bin/pi-train) |
| `pi-publish` | Posts issue, PR and comment text through a secret scan. Normally used from inside pi. | `pi-publish --help` | [source](../agent/bin/pi-publish) |

## Lanes and messaging (opt-in)

Lanes are several coordinated sessions. See [Lanes](../README.md#lanes-opt-in).

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `lanes` | Creates and starts lanes and sends messages between them. Installed with `./install.sh --with lanes`. | `lanes --help` | [Lanes](../README.md#lanes-opt-in) |
| `inbox-watch` | Prints new message files addressed to a lane; made for a single `job_watch`. | `inbox-watch --help` | [source](../agent/bin/inbox-watch) |
| `lane-status` | Records whether a lane is working, waiting or closed. | `lane-status --help` | [source](../agent/bin/lane-status) |
| `session-watchdog` | Notify-only detector for stuck pi sessions. Never kills anything. | `session-watchdog --help` | [source](../agent/bin/session-watchdog) |

## Machine health and cleanup

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `dev-doctor` | Read-only diagnostics for slow gates, queues, swap and Docker memory. | `dev-doctor --help` | [source](../agent/bin/dev-doctor) |
| `pi-cleanup` | Disk cleanup for checkouts, worktrees and Docker. Dry run by default; `--apply` executes. | `pi-cleanup --help` | [source](../agent/bin/pi-cleanup) |
| `disk-growth` | Samples free disk space and alerts on a fast drop. Runs on a schedule. | `disk-growth --help` | [source](../agent/bin/disk-growth) |
| `docker-guardian` | **Acts.** Keeps Docker Desktop usable: restarts it when unresponsive and removes stale containers and images. Runs on a schedule. | `docker-guardian --help` | [source](../agent/bin/docker-guardian) |
| `renice-builders` | **Acts.** Lowers the CPU priority of shared .NET build servers. Run by `docker-guardian`. | `renice-builders --help` | [source](../agent/bin/renice-builders) |
| `secret-sweep` | Daily read-only gitleaks sweep. Reports contain metadata, never the matched values. | `secret-sweep --help` | [source](../agent/bin/secret-sweep) |
| `ai-work-lifecycle` | Creates, tracks and cleans temporary task outputs under `.ai-work/`. See the [README](../tools/ai-work-lifecycle/README.md) and [REFERENCE](../tools/ai-work-lifecycle/REFERENCE.md). | `ai-work-lifecycle --help` | [source](../tools/ai-work-lifecycle/ai-work-lifecycle.py) |
| `sweep-known-roots` | Sweeps registered `ai-work-lifecycle` tasks across known repositories (dry run by default). Installed as a script, not on PATH; pi-setup does not schedule it, so run it yourself. | `python3 ~/.local/share/ai-work-lifecycle/sweep-known-roots.py --help` | [source](../tools/ai-work-lifecycle/sweep-known-roots.py) |

## Installer

| Entry point | Purpose | Help |
|---|---|---|
| `install.sh` | Guided installer with `update`, `uninstall`, `doctor` and `lanes` commands. See [Install](../README.md#install). | `./install.sh --help` |

## Release and maintainer tools

For people who publish pi-setup itself. Not needed for normal use.

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `release-check.sh` | **Acts.** Runs the full release gate: every test suite and a scan of the git history. | `release-check.sh --help` | [source](../tools/release-check.sh) |
| `publish-check.py` | Checks a staged copy of the published tree for disallowed files and secrets. | `publish-check.py --help` | [source](../tools/publish-check.py) |

Per-tool pages, extension depth and scenario guides are planned for later parts of [#34](https://github.com/woksin/pi-setup/issues/34).
