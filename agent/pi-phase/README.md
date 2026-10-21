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

The shipped config sets heavy capacity **4** (build/test/integration); without a config file the fallback is **2**. Integration additionally occupies **1** integration permit (atomic claim, no deadlock). CI watchers take **no heavy permits**. Config is shared in `~/.pi/agent/pi-phase/config.json`, optional, for example:

```json
{"heavy_slots": 2, "integration_slots": 1}
```

Change this single config for *all cooperating sessions*, not a per-invocation override. Prefer changing limits when idle; lowering them mid-run does not evict current jobs. Do not modify/delete `state/` lock or owner files while jobs are active. Locks are kernel-backed; owner JSON is only diagnostics plus a conservative guard for a crashed supervisor whose child group remains alive. A status entry marked `orphan-group` means a slot remains unavailable until that group goes away; investigate the recorded PID/group rather than deleting state. Crash between launcher creation and metadata publication is guarded by an execution gate: the command never starts until metadata exists. The producer inherits its lease FD. The supervisor starts a new process group, sends TERM then KILL **only to that group** on timeout, cancellation or completed-leader cleanup, and does not kill GitHub CI or other local jobs. Programs deliberately creating new sessions, leaving that group, moving to another user, or escaping inherited descriptors/group tracking cannot be guaranteed; this is not a sandbox. Detached grandchildren can inherit terminal output: they may keep a caller's output pipe open after a crash.

Admission uses one deadline-bounded process-list snapshot per scan outside the shared coordinator; a failed/slow probe conservatively defers admission rather than taking an orphaned permit. Cancellation is checked after admission and before the launcher receives its execution gate, so an already-cancelled command does not start. Execution defaults to **300s** for build/test/integration and **120s** for CI, with a **separate 120s queue budget** (queue time does not consume execution time). Choose ~120s for known short targeted checks; 300s for a build/test phase; longer than 600s for either budget requires the `--approved-long-timeout` declaration, which the agent adds itself when it has a concrete runtime basis (run such phases in the background, not as a foreground bash call) (e.g. `--timeout 900 --approved-long-timeout`). Do not use speculative long limits. No stdout-silence killer or automatic retries. Exit 124 means phase timeout; 130/143 mean SIGINT/SIGTERM cancellation; 75 means queue timeout or duplicate CI watcher (neither is a test/CI failure); 125 means wrapper/config/cleanup failure; 126/127 mean command could not be executed; otherwise the exact producer exit (a producer itself can return one of these codes). Timeouts/CI cancellation are **incomplete/unknown**, never a pass or evidence of a remote CI failure. For long-running diagnostics prefer native runner hang support when compatible, not a generic silence timeout.

On queue-timeout exit 75, the command did not start: it is not a failed code/test attempt. Continue code work and retry the phase in the background with a larger queue budget, up to 600s; above 600s needs a concrete runtime basis and `--approved-long-timeout`. Stop after three consecutive queue timeouts on the same phase once code work is complete and report `gate not run: queue saturated`. The timeout message does not include counts or rank: run `pi-phase status` once at that checkpoint for running/queued entries and waiter ranks. For a duplicate CI watcher (also 75), reuse the existing watch instead of retrying.

## EPERM after producer success

`Passed!` followed by `Operation not permitted` and exit 125 is a wrapper/cleanup failure, not a passing gate. Keep the full producer log and wrapper diagnostics; inspect `pi-phase status` and the recorded process group once for remaining descendants. Do not delete state, suppress cleanup errors, or infer the producer's exit code from its output. If no owned processes remain, request owner approval for a bounded direct rerun of the exact producer command under `job_start` with a full log and its actual exit code; report that fallback separately from the wrapper failure. Do not bypass the heavy-command wrapper policy without that approval. Do not rerun while descendants remain or ownership is unknown.

The executable `bin/pi-phase` is only a Python launcher; cleanup lives in `pi-phase/pi_phase.py`. It already handles missing groups and ignores EPERM only when no live group members remain. A reported EPERM alone does not establish that cleanup was safe, so do not swallow all permission errors. Changes to that implementation require separate scope and descendant-cleanup tests.

## Waiting in the queue

A queued phase is time to use, not to sit in. Run `pi-phase status` once before a heavy phase; when several phases are running or ahead of you, start the phase in the background (`job_start` or a background subagent) and do independent work meanwhile: read code for the next step, write specs, draft PR notes, check issue and PR comments, scope the next issue. Do not start a second heavy phase in the same worktree, do not edit files the queued phase builds (or rerun it afterwards), and never shorten or skip a gate to avoid the queue. With nothing independent to do, end the turn and let the completion notification wake you.
