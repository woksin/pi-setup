---
name: dev-machine-performance
description: Use when local gates or phase queues are slow, the machine is swapping, or Docker shows memory pressure. Not for application-runtime performance tuning.
---

# Development-machine performance

Run `~/.pi/agent/bin/dev-doctor` for long pi-phase queues, high load with idle
cores, swap, slow gates, or Docker OOM. Use `--json` for structured findings,
`--repos-root DIR` to override user.json, or `--only id,id` to narrow checks.
It checks Spotlight, Docker memory/stale containers, build oversubscription,
MSBuild environment, Testcontainers in test phases, sampled worktree output,
disk floors, browsers, idle pi sessions/helpers, and configured owned containers.
Missing tools or failed probes mean unknown, not healthy.

Present the evidence and exact suggested commands or UI paths to the user.
Call out which need user confirmation or sudo. Never apply non-auto fixes yourself:
no Spotlight changes, Docker settings, pruning, or unconfigured forced removals.
`--apply` removes exited containers older than 20 minutes and configured labelled
orphans only when `pi-phase status` proves no phase is running. Unknown blocks it.
Owned rules require a local Docker context, age ≥30 min, readable owner cwds,
and no matching owner hash; missing labels/session labels are report-only (fuse 10).
Browser SIGTERM is phase-independent: only temporary Puppeteer/headless roots,
never persistent `~/.pi` profiles or user Chrome (fuse 5). Hot means >50% CPU over
≥30 min; idle means <1% group CPU over ≥2h. Only the root is signalled.
Pi sessions idle ≥4h and helper RSS are suggest-only: close them manually.
Samples in `~/.pi/agent/dev-doctor/samples.json` track CPU and Docker usage peaks;
Docker sizing suggests 1.5× observed peak, floor 8 GiB, not an automatic change.
Guardian calls the narrow cleanup checks at most every 15 min; `--quiet` logs actions and fuse trips.
The doctor never removes images, volumes or checkout files. A zero-CPU container sample
alone does not prove it is abandoned; confirm ownership.

Disk defaults in `dev-doctor.json`: `disk.build_floor_gib: 25`,
`disk.cleanup_trigger_gib: 40`. Below 40 GiB suggest `pi-cleanup` (dry run);
keep building down to 25 GiB, then start no new heavy phase/worktree.
`pi-cleanup --if-free-below config` reads the cleanup trigger. Disk is suggest-only.
- Below `disk.bin_sweep_below_gib` (50), `pi-cleanup --only bins` plans idle-bin removal; `--apply` deletes bins, never obj. Doctor samples reclaimable bins.
- `dev-doctor --only package-cache-volume` diagnoses NuGet/pnpm/yarn volume copies. Explicit `--apply --only package-cache-volume` writes only the outside-checkout rsp; `--move-nuget` is separate and retains packages.old.
- Measure bin size before/after the cache/rsp change and verify a build. In-place bin rewrites can alter hard-linked packages; restore the rsp backup to revert.
## Habits before tuning
- Mirror CI build flags: code generation it skips, and warnings-as-errors it enables.
- Iterate on the single affected project, not the solution.
- Run independent frontend checks in parallel, within memory/scheduler limits.
- Do not force `RestoreNoCache` in gates.
- Skip local coverage collection unless it is gated.
- Measure A/B, one run each, before changing GC or runtime settings.
- The local gate equals CI's lanes, filters and flags: no more, no less. An
  unfiltered solution test can start extra service stacks and inflate Tier 1.
- Container-backed specs run as `--kind integration`, using the integration permit.
- Reuse one warm worktree per lane; do not share build outputs between lanes.
  Cold worktrees can cost restore time, but a large serial compile may dominate.
- Build only affected projects while iterating; run the full required gate later.
- `-p:RunAnalyzers=false` (and `-p:EnforceCodeStyleInBuild=false`) is for iteration
  builds only, never gates. Do not skip analyzers to claim CI parity.
- Keep `MSBUILDDISABLENODEREUSE=1` when memory is tight. Its small startup cost
  avoids resident idle nodes; it does not disable the warm Roslyn compiler server.
- Do not put `-m` in `Directory.Build.rsp`: the dotnet CLI overrides it. Pass an
  explicit `-m:N` or opt in to pi-phase's `msbuild_max_cpu` setting instead.
- Do not enable Testcontainers reuse on shared machines; cross-lane state makes
  results order-dependent. Fix lane/filter parity before increasing Docker RAM.
- Use long bounded queue timeouts instead of requeue loops; queue time is separate
  from execution time. Never bypass the scheduler to escape contention.

High load with idle cores can be swap/I/O pressure rather than CPU saturation.
Compare host swap and Docker allocation; measure integration peak before asking
the user to reduce VM memory. Docker OOM may instead require more memory.
Spotlight at low CPU is unlikely to be the main bottleneck. Reclaimable images
save disk, not compile time. Treat sampled counts and correlations as hints,
not proof of process/container ownership or a reason to delete worktrees.

Guardian image hygiene is separate: every 15 min, with no integration running,
remove superseded tags (newest 2 per variant/precision group) or filtered dangling images >24h.
Keep all container-used, pinned, <6h-old and floating-tag images. Review globs in
`~/.pi/agent/docker-guardian/pinned.txt` (seeded once); `docker rmi` is never forced.
Never `prune -a`. Shared layers mean about 1 GB saved from a 13.7 GB reclaimable report.
Variant suffixes never compete; short aliases stay when longer versions exist.
Pins also match RepoDigests; install activates image hygiene by seeding pinned.txt.
An empty `~/.pi/agent/docker-guardian/no-image-prune` file disables only image cleanup.
Images are checked before exited-container removal; later passes may reclaim them.
