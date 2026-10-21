---
name: dev-machine-performance
description: Diagnose slow gates, long phase queues, swap and Docker memory pressure with bounded, read-only dev-doctor checks.
---

# Development-machine performance

Run `~/.pi/agent/bin/dev-doctor` for long pi-phase queues, high load with idle
cores, swap, slow gates, or Docker OOM. Use `--json` for structured findings,
`--repos-root DIR` to override user.json, or `--only id,id` to narrow checks.
It checks Spotlight, Docker memory/stale containers, build oversubscription,
MSBuild environment, Testcontainers in test phases, and sampled worktree output.
Missing tools or failed probes mean unknown, not healthy.

Present the evidence and exact suggested commands or UI paths to the user.
Call out which need user confirmation or sudo. Never apply non-auto fixes yourself:
no Spotlight changes, Docker settings, forced container removal, or pruning.
`dev-doctor --apply` only removes exited containers older than 20 minutes, and
only when `pi-phase status` positively reports no running phase. Unknown blocks
application. It never removes images, volumes, running containers, or files.
A zero-CPU container sample does not prove it is abandoned; confirm ownership.

## Habits before tuning

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
