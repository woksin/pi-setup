# Local pi phase runner

`~/.pi/agent/bin/pi-phase` is an **explicit**, foreground, cooperative wrapper for heavy commands run by this user's pi sessions and subagents on this host. It does not change shell tools or start a daemon. Adopt it for builds, tests, integration runs and local CI watching; ordinary `bash` and pre-existing jobs bypass it. It is not host-wide enforcement for other users or programs.

```sh
~/.pi/agent/bin/pi-phase run --kind build --label 'solution Release' \
  --timeout 300 --queue-timeout 120 -- dotnet build My.sln -c Release -m:2
~/.pi/agent/bin/pi-phase run --kind test --label 'unit tests' \
  --timeout 300 --queue-timeout 120 -- dotnet test Tests.csproj -c Release --no-build
~/.pi/agent/bin/pi-phase status
```

Use a single *direct executable and its arguments* after `--` for each phase. Do not hide phases in shell chains/pipelines or use `| head/grep` as gate evidence; the runner streams raw output and returns the **producer's exact exit code**. One command per phase. `-m:2` above is an **explicit example**, not a silently imposed MSBuild option: choose the project's correct configuration/CI flags and parallelism yourself. Run status in a separate terminal to see kind, label, PID, cwd and elapsed time (never full command or arguments); queued/running heartbeat messages appear on the initiating terminal every ~5 seconds. A noninteractive caller must keep the foreground process running until completion. If `job_start` (pi-jobs) exists, prefer it for completion notification/cancellation; otherwise run a single bounded `bash` tool call. Set the *outer caller's* timeout greater than **queue-timeout + phase timeout + ~5 seconds cleanup/startup**, so the caller does not kill the supervisor prematurely. Do not use repeated polling as an alternative.

## Compact output with a full log

Prefer `--log FILE` over shell redirects or output pipes: it overwrites FILE (creating parent directories) with the producer's full, combined stdout/stderr without streaming it to the terminal. Runner status and heartbeats remain visible. On completion, including timeout, cancellation or queue timeout, it prints the last 60 log lines followed by `pi-phase: log=<absolute path> exit=<code> lines=<count>`. The exit status is unchanged; read the full log separately when diagnosing a failure.

```sh
~/.pi/agent/bin/pi-phase run --kind test --label 'unit tests' \
  --timeout 300 --queue-timeout 120 --log .ai-work/unit-tests.log --tail 20 \
  -- dotnet test Tests.csproj -c Release --no-build
```

`--tail N` requires `--log` and a nonnegative integer; `--tail 0` prints only runner messages and the summary. Without `--log`, output and exit behaviour are unchanged.

## Capacity and timeouts

Defaults: heavy capacity **2** (build/test/integration); integration additionally occupies **1** integration permit (atomic claim, no deadlock). CI watchers take **no heavy permits**. Config is shared in `~/.pi/agent/pi-phase/config.json`, optional, for example:

```json
{"heavy_slots": 2, "integration_slots": 1}
```

Change this single config for *all cooperating sessions*, not a per-invocation override. Prefer changing limits when idle; lowering them mid-run does not evict current jobs. Do not modify/delete `state/` lock or owner files while jobs are active. Locks are kernel-backed; owner JSON is only diagnostics plus a conservative guard for a crashed supervisor whose child group remains alive. A status entry marked `orphan-group` means a slot remains unavailable until that group goes away; investigate the recorded PID/group rather than deleting state. Crash between launcher creation and metadata publication is guarded by an execution gate: the command never starts until metadata exists. The producer inherits its lease FD. The supervisor starts a new process group, sends TERM then KILL **only to that group** on timeout, cancellation or completed-leader cleanup, and does not kill GitHub CI or other local jobs. Programs deliberately creating new sessions, leaving that group, moving to another user, or escaping inherited descriptors/group tracking cannot be guaranteed; this is not a sandbox. Detached grandchildren can inherit terminal output: they may keep a caller's output pipe open after a crash.

Admission uses one deadline-bounded process-list snapshot per scan outside the shared coordinator; a failed/slow probe conservatively defers admission rather than taking an orphaned permit. Cancellation is checked after admission and before the launcher receives its execution gate, so an already-cancelled command does not start. Execution defaults to **300s** for build/test/integration and **120s** for CI, with a **separate 120s queue budget** (queue time does not consume execution time). Choose ~120s for known short targeted checks; 300s for a build/test phase; longer than 600s for either budget requires the `--approved-long-timeout` declaration, which the agent adds itself when it has a concrete runtime basis (run such phases in the background, not as a foreground bash call) (e.g. `--timeout 900 --approved-long-timeout`). Do not use speculative long limits. No stdout-silence killer or automatic retries. Exit 124 means phase timeout; 130/143 mean SIGINT/SIGTERM cancellation; 75 means queue timeout or duplicate CI watcher (neither is a test/CI failure); 125 means wrapper/config/cleanup failure; 126/127 mean command could not be executed; otherwise the exact producer exit (a producer itself can return one of these codes). Timeouts/CI cancellation are **incomplete/unknown**, never a pass or evidence of a remote CI failure. For long-running diagnostics prefer native runner hang support when compatible, not a generic silence timeout.

## VSTest opt-in (not MTP)

Only after verifying the project uses **VSTest** (not Microsoft.Testing.Platform), opt in on a `dotnet test` command:

```sh
~/.pi/agent/bin/pi-phase run --kind test --label 'VSTest unit tests' \
  --timeout 300 --vstest-confirmed --vstest-hang-minutes 2 \
  -- dotnet test Tests.csproj -c Release --no-build
```

The opt-in visibly adds `--blame-hang --blame-hang-timeout 2m --blame-hang-dump-type none --results-directory <repo>/.ai-work/pi-phase/<unique>` to **that** command. It does not run against MTP automatically and does not create large dumps by default. Run from inside the correct Git repository, keep needed small diagnostic files in its ignored `.ai-work/`, and follow the ai-work-lifecycle instructions for any disposable output cleanup. Only the user can assert VSTest compatibility; the flag is not a reliable automatic project detector. If unsupported, omit the preset and use the project's native timeout/reporting options explicitly. This directory may contain test logs after the phase, not durable docs.

## Bounded CI observation

> **Do not use this to wait for GitHub CI to finish.** Real CI runs take 10–60+ minutes and exceed the 600 s cap; use `job_start` (`gh run watch <run-id> --exit-status`) or `job_watch` as described under "Waiting on GitHub CI" in `~/.pi/agent/AGENTS.md`. `--kind ci` is only for a short, bounded check of a run that is already nearly finished.

Use an explicit identity for **repo + PR + commit** (a SHA-256 digest, not the raw key or arguments, is used in lock filenames). A concurrent observer with the same key prints `already watching` and exits 75 **without starting another watcher**. For example, after obtaining the intended PR/commit without guessing them:

```sh
~/.pi/agent/bin/pi-phase run --kind ci --label 'PR 42 checks' \
  --repo org/repo --pr 42 --commit abc123 --timeout 120 --queue-timeout 120 \
  -- gh pr checks 42 --repo org/repo --watch
```

`gh pr checks --watch` is the foreground producer, bounded by the phase timer; cancellation stops only this local watcher. A timeout means checks may still be pending; inspect once later at a deliberate checkpoint instead of spinning another watcher. An actual nonzero `gh` exit needs interpretation from its raw output. **Do not claim CI passed/failed merely because the watcher timed out or a duplicate was skipped.** Repo/PR/commit and labels are not verified against the command: use the correct immutable identity. Labels and cwd are printed/stored; keep secrets out of labels and paths. Arguments (including secrets) are never written into metadata, but child process command lines can still be visible to local OS process viewers.

## Local checks

`python3 -B -m unittest discover -s ~/.pi/agent/pi-phase -p 'test_*.py' -v` uses small synthetic subprocess jobs and isolated, test-owned `.ai-work/pi-phase-test-*` directories. `python3 -B -m py_compile` may create bytecode unless `PYTHONPYCACHEPREFIX` is set; use a task-owned `.ai-work/` path. There is no CI workflow or whole-solution gate in this local, non-Git pi configuration folder; the unittest suite plus CLI smoke/syntax checks are its local gate. This tool is POSIX-only: Python 3 with `fcntl.flock`, `waitid(WNOWAIT)`, and process groups is required.
