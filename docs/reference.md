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
| `pi-phase` | Runs one build, test or integration command through a shared queue with time limits and logs. Subcommands include `run`, `status`, `stats` and `report`. See the [pi-phase README](../agent/pi-phase/README.md). | `pi-phase --help` | [source](../agent/bin/pi-phase) |
| `cratis-local-run` | Wrapper that sends each step of a cross-repository check through `pi-phase`. | `cratis-local-run --help` | [source](../agent/bin/cratis-local-run) |
| `pi-setup-tests` | Runs the `lib/*.test.ts` tests of an agent directory. | `pi-setup-tests --help` | [source](../agent/bin/pi-setup-tests) |
| `ci-feedback` | Read-only GitHub Actions feedback times per PR head SHA, workflow/job p50/p90, queues and job-minutes/week by event. Writes only a local jobs cache. | `ci-feedback --help` | [source](../agent/bin/ci-feedback) |

### CI feedback

Run `ci-feedback Cratis/cli --days 7 --limit 40` for readable tables, or add `--json` for individual job timings and full metrics. Requires authenticated `gh`; uses Node stdlib only. `--signal-pattern 'compile|unit'` overrides the case-insensitive build/spec/test job-name heuristic (only executed completed jobs count).

For a before/after trial: `ci-feedback Cratis/cli --since 2026-10-01 --until 2026-11-01 --compare 2026-10-15`. Deltas are after minus before; each side's job-minutes/week is normalized by its own length. PR runs for the same SHA stay together on the side of their first observed creation; non-PR runs split by creation date. Percentiles use nearest rank and ignore unavailable timings; empty samples and unmatched comparison groups show `-`/JSON `null`, not zero.

Push time is approximated by the earliest observed Actions run creation for a PR SHA, not the actual push timestamp. First failure includes timed-out and action-required jobs; signal is the first completed matching executed job; all-green requires every observed run's latest attempt and jobs to be completed successful or skipped. All attempts contribute execution job-minutes (no billing multipliers); queue time is job start minus the original run's creation, including rerun delay. Pending job duration is unknown, not extrapolated. Workflow duration is creation to last observed latest-attempt job completion for completed runs; job duration is start to completion. JSON `jobDetails` includes per-execution queue times across all events.

Skipped jobs are counted separately from cancelled, failed, pending and other conclusions, but their routing reason cannot be inferred. Runs with empty job lists are flagged; workflows that never triggered, third-party checks and required-check coverage are unknown. All-green means only the observed Actions jobs, not proof that all required checks ran. The default limit is 300 runs (maximum 1000, matching GitHub's filtered-run cap); a truncated sample is labelled and weekly rates are sampled lower bounds. Runs are selected by creation in the half-open window, not by completion. Jobs are paginated for every attempt and cached only when the parent run is completed, under `~/.cache/ci-feedback/OWNER/REPO/RUN-ATTEMPT.json`; active runs are always fetched live. Cache entries can be removed to refresh completed results.

### pi-phase options added by #81 (all off by default)

- `hang_timeout` config key and `pi-phase run --no-hang-timeout`: fail-fast `--blame-hang-timeout` for direct VSTest `dotnet test` iteration runs. Details in the [pi-phase README](../agent/pi-phase/README.md).
- `pi-phase run --profile iterate|full` (default `full`): `iterate` adds `-p:RunAnalyzers=false -p:EnforceCodeStyleInBuild=false` to direct `dotnet build`/`test`; recorded in the ledger and rejected as `pi-train ship` evidence. See the [pi-phase README](../agent/pi-phase/README.md#iteration-profile---profile-iteratefull).
- `skip_cross_worktree` config key (default `false`): skip a build/test whose identical gate already passed in another worktree of the repository; never integration, `--rerun` forces a run.
- `reap_build_servers` config key (default `{"mode": "off"}`): enables `reap-build-servers`. With `PI_PHASE_SHARED_COMPILATION=1` each phase gets its own `SharedCompilationId` and stops only that server when it ends.

## Pull requests and trains

Train shipping reads `.pi/trains/config.json`. Configure `gateComponents` by exact repository name to require every component for the current train HEAD:

```json
{
  "gateComponents": {
    "Cratis/Chronicle": [
      { "id": "release", "kind": "build", "label": "tier1 release" },
      { "id": "specs", "kind": "test", "label": "tier1 spec" }
    ]
  }
}
```

Each component needs a unique nonempty `id`, `kind` (`build` or `test`) and a case-insensitive regex `label`. Only passed, verified, clean records for the exact HEAD count. Integration is never Tier 1. Missing or incomplete Tier 1 evidence always blocks shipping (fail closed; the former `requireGate` key is an accepted no-op, "always on"). Iterate-profile records never count. `Cratis/Chronicle` has a built-in component set (`agent/lib/train-gate-defaults.json`, from Chronicle's CI: a Release build and the non-integration specs; label the Release build phase `<train>-t1-build` (or `tier1 release`) and the spec phases `<train>-t1-<project>` (or `tier1 specs`), as Chronicle trains already do), which a `gateComponents` entry in the config replaces. Without any component list for the repository, shipping fails closed; `pi-train ship --allow-unconfigured-gate` overrides that, logs a warning and accepts any verified clean build/test. Ledger records need no new fields. Gate estimates prefer the median of at least three measured clean passing chains, otherwise the sum of per-kind build/test p90s; integration is excluded.

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `pi-train` | Manages a release train: fold several PRs into one branch, check status and ship it. See [Release trains](../README.md#release-trains). | `pi-train --help` | [source](../agent/bin/pi-train) |
| `pi-publish` | Posts issue, PR and comment text through a secret scan. Normally used from inside pi. | `pi-publish --help` | [source](../agent/bin/pi-publish) |

## Lanes and messaging (opt-in)

Lanes are several coordinated sessions. See [Lanes](../README.md#parallel-sessions-lanes).

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `lanes` | Creates and starts lanes and sends messages between them. Installed with `./install.sh --with lanes`. | `lanes --help` | [Lanes](../README.md#parallel-sessions-lanes) |
| `inbox-watch` | Prints new message files addressed to a lane; made for a single `job_watch`. | `inbox-watch --help` | [source](../agent/bin/inbox-watch) |
| `lane-status` | Records whether a lane is working, waiting or closed. | `lane-status --help` | [source](../agent/bin/lane-status) |
| `session-watchdog` | Notify-only detector for stuck pi sessions. Never kills anything. | `session-watchdog --help` | [source](../agent/bin/session-watchdog) |

## Machine health and cleanup

| Tool | Purpose | Help | Source |
|---|---|---|---|
| `dev-doctor` | Read-only diagnostics for slow gates, queues, swap and Docker memory. | `dev-doctor --help` | [source](../agent/bin/dev-doctor) |
| `pi-cleanup` | Disk cleanup for checkouts, worktrees and Docker. Dry run by default; `--apply` executes. | `pi-cleanup --help` | [source](../agent/bin/pi-cleanup) |
| `pi-retain` | Owner-scoped, expiring protection for cleanup roots, so scheduled cleanup skips active verification chains. | `pi-retain --help` | [source](../agent/bin/pi-retain) |
| `disk-growth` | Samples free disk space and alerts on a fast drop. Runs on a schedule. | `disk-growth --help` | [source](../agent/bin/disk-growth) |
| `docker-guardian` | **Acts.** Keeps Docker Desktop usable: restarts it when unresponsive and removes stale containers and images. Runs on a schedule. | `docker-guardian --help` | [source](../agent/bin/docker-guardian) |
| `renice-builders` | **Acts.** Lowers the CPU priority of shared .NET build servers. Run by `docker-guardian`. | `renice-builders --help` | [source](../agent/bin/renice-builders) |
| `reap-build-servers` | **Acts only in `enforce` mode** (config key `reap_build_servers`, default off). Stops idle orphaned Roslyn/MSBuild servers with SIGTERM. Run by `docker-guardian`. | `reap-build-servers --help` | [source](../agent/bin/reap-build-servers) |
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
| `release-asset.sh` | Builds the checksummed archive, `SHA256SUMS` and the pinned `bootstrap.sh` uploaded to each release. | `release-asset.sh --help` | [source](../tools/release-asset.sh) |

Per-tool pages, extension depth and scenario guides are planned for later parts of [#34](https://github.com/woksin/pi-setup/issues/34).
