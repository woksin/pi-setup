<!-- Copyright (c) Cratis. All rights reserved. -->
<!-- Licensed under the MIT license. See LICENSE file in the project root for full license information. -->

# Local `.ai-work` lifecycle

A small task workflow for **new, explicitly disposable resources**, not a general
cache cleaner. Requires Python 3.9+, local `git`, `ps`, and `lsof`, and the owning
normal user on macOS/Linux. Root/elevated execution is refused.

## Quickstart

Use the installed `ai-work-lifecycle` launcher, or substitute
`python3 tooling/ai-work-lifecycle.py`. The exact Git root and ignored `.ai-work`
must already exist; use absolute paths without symlinks or traversal.

```sh
root="$(pwd -P)/.ai-work"
mkdir -p "$root"
ai-work-lifecycle --root "$root" start build-check --owner-pid "$$"
# Use the returned absolute paths:
# keep/   unique notes, receipts, recovery patches — never registered
# cache/  disposable downloaded packages and scratch files
# output/ disposable generated binaries and scratch files

# After producers have stopped and all useful work is reconciled:
ai-work-lifecycle --root "$root" finish build-check
ai-work-lifecycle --root "$root" finish build-check --apply
```

`start` **is the explicit declaration** that its new cache/output are exclusively
owned, regenerable, and disposable. It creates a private `0700` task workspace,
auto-registers cache as `package` and output as `build`, and returns exact paths.
Existing tasks/scopes are refused, never adopted. Use a new task ID for new work.
`$$` is appropriate in a real interactive shell; integrations supply the actual
session PID, not a transient tool shell.

`finish` alone is a **read-only preview**: it never completes, releases, authorizes,
or schedules deletion. Its compact JSON includes counts/logical bytes and
`ready-to-finish`, `blocked`, `eligible`, or `already-cleaned` status; it omits the
full manifest. `finish --apply` explicitly relinquishes all resource use, completes,
authorizes, and immediately sweeps **only that task**, with fresh safety checks.
Live workers, inspection failures, or drift retain resources. A failed immediate
cleanup before deletion rolls back newly granted completion authorization; a
partial deletion retains a blocking receipt for manual review. Successful repeats
are no-ops; recreating a cleaned path blocks. `keep/` and task records remain.

### One bounded foreground command

```sh
ai-work-lifecycle --root "$root" run-task check -- python3 -c \
  'import os,pathlib; pathlib.Path(os.environ["AI_WORK_OUTPUT"],"check.log").write_text("generated")'
```

`run-task TASK -- COMMAND [args...]` starts a new task owned by the wrapper PID,
sets `AI_WORK_TASK`, `AI_WORK_KEEP`, `AI_WORK_CACHE`, and `AI_WORK_OUTPUT`, and
leases one child **before** allowing it to execute. The lock is not held while
the command runs. No shell interpolation is performed, and full argv/environment
are not recorded. Do not put secrets in task IDs or resource filenames.

The child inherits normal stdin/stdout/stderr; lifecycle JSON goes **only to
stderr**, leaving command stdout unchanged. Shared package caches, cwd, and normal
output defaults are **unchanged**: the producer must explicitly use the supplied
paths. This is not a sandbox or automatic interception of build outputs.

On success the wrapper releases the exited child and runs `finish --apply`.
Failure or Ctrl-C pauses and retains outputs; command exit codes are preserved
(signals use `128 + signal`, Ctrl-C is 130). Cleanup refusal after command success
is reported on stderr but does not change its zero exit code. Launch/lease failure
returns 2. Ctrl-C terminates only the directly owned child, waits up to five
seconds, then kills/reaps that child if needed; never an unrelated process group.

**No detaching, daemons, background workers, or interactive terminal job control.**
The child runs in a separate session and must join any subprocesses before exit.
This is one foreground command, not orchestration. Forced termination of the
wrapper (including SIGTERM/SIGKILL) cannot guarantee pause or child cleanup;
retained active tasks/leases still do not imply completion. For separately managed
workers use the low-level lease API and a host-provided startup barrier.

## Reference

Exactly one location option precedes the command:

```text
ai-work-lifecycle --root /absolute/repository/.ai-work COMMAND
python3 tooling/ai-work-lifecycle.py --repo /absolute/repository COMMAND

start TASK --owner-pid PID
finish TASK [--apply]
run-task TASK -- COMMAND [args...]
create TASK --owner-pid PID --declare-exclusive-disposable
register TASK PATH [--kind scratch|build|package]
state TASK active --owner-pid PID
state TASK paused
lease TASK WORKER --pid PID [--seconds 3600]
release TASK WORKER
complete TASK [--release-owner] [--authorize-cleanup]
finish-owned --owner-pid PID [--apply]
unfinished [--older-than SECONDS]
inventory [--task TASK]
sweep [--task TASK] [--apply --expect SHA256]
sweep [--task TASK] --authorized [--apply]
```

The low-level API remains available. After `create`, create and register literal
non-overlapping `tasks/TASK/cache` or `tasks/TASK/output` directories/descendants
relative to `.ai-work`. IDs use 1–64 lowercase ASCII letters, digits, underscores,
or hyphens, starting with a letter/digit. No patterns or machine-wide discovery.

`complete` seals exact content/stat/path identities. Without `--release-owner`,
a live owner blocks cleanup. Release explicitly declares no further use, requires
workers stopped/released and fresh open-handle checks, and retains owner identity.
`--authorize-cleanup` grants standing authorization for this exact manifest.
Completion is final; neither flag can be added afterward. Hosts must never infer
completion from shutdown, dead PIDs, expired leases, idle time, or session exit.
`finish-owned` is a manual, explicit command, never a shutdown hook. It
authenticates the supplied PID, not the caller: it refuses unless that PID is live
and an ancestor of the calling process, and needs a microsecond start time
(`kern.proc.pid` on macOS; unavailable elsewhere, so it refuses). Records without
`owner.started_us` (all written before this field existed) are skipped. It runs
`finish --apply` only for `active`, lease-free tasks whose owner PID, user, machine
and start times match; refusals retain the task. `unfinished` is read-only (age
from `created`, else the scope's birth time).
Live workers block even after lease expiry; dead workers with unexpired leases
block until release/expiry. Lease TTL is 1–86,400 seconds.

Inventory/default sweep do not initialize metadata or mutate records. Their
full plans include exact eligible manifests, report-only containers, and a
top-level fingerprint. Exact-plan apply requires the **reviewed top-level**
`--expect` fingerprint and all selected tasks unblocked. Never manufacture
approval by piping an unreviewed fingerprint into apply.

`--authorized` remains a dry-run unless `--apply` is supplied, cannot combine with
`--expect`, and skips blocked/unauthorized tasks. A scheduled normal-user job may
consume explicit authorization for allowlisted roots using
`sweep --authorized --apply`; it must not discover roots or infer completion.
The authorization digest binds ownership, scope, classifications, release,
leases, and manifest; it is not a signed capability against metadata tampering.

Commands emit JSON on stdout except `run-task`. Runtime refusals exit 2 with a
JSON error on stderr; argparse usage remains text. Preview/low-level sweeps can
exit 0 with blocked/skipped tasks: inspect statuses, not just the exit code.
`finish --apply` instead refuses when its task is blocked.

Preview and cleanup receipts report **logical_bytes** (regular-file sizes), file
and directory counts: **not actual APFS savings**, allocated blocks, compression,
clone deduplication, or telemetry. Both dry-run and applied sweeps have record-based
`summary.active`, `paused`, `completed`, `cleaned`, and `cleaned_logical_bytes`.
Completed includes cleaned tasks; totals cover the selected scope. Cleaned byte
sums use retained receipts (older receipts without sizes contribute zero).
Dry-run summaries additionally count eligibility and eligible logical bytes.

## Content classifications

| Kind | Accepted regular files |
| --- | --- |
| `scratch` | `.cache`, `.tmp`, `.log`, `.stdout`, `.stderr`, `.pyc`, `.out` |
| `build` | Scratch plus `.dll`, `.pdb`, `.exe`, `.so`, `.dylib`, `.a`, `.o`, `.obj`, `.lib`, `.class`, `.wasm`, `.resources`; `.deps.json`, `.runtimeconfig.json`, `.runtimeconfig.dev.json` leaves |
| `package` | Scratch plus downloaded `.nupkg`, `.jar`, `.nupkg.sha512`, `.jar.sha256`, `.jar.sha512` |

No general JSON/source/document/database/certificate/patch/archive exemption.
Protected names and common sensitive-content signatures still block all kinds.
The sole protected-name exception is the exact generated build **file leaf**
`System.Data.Common.dll` (case-insensitive), never its ancestors or directories;
content checks still apply. Backups, credentials, and source remain protected.
Opaque package archives must be regenerable downloads, never unique data/source.

Full extracted NuGet/SDK trees, `node_modules`, and mixed `.NET obj/bin` trees
are **not supported**: source, XML, docs, certificates, or unsupported metadata
block. Use dedicated binary/archive outputs or keep mixed content unregistered.
Never rename protected files or relocate legacy artifacts to evade these guards.

## Safeguards and limits

- Cooperative, exclusively owned, same-user/same-host resources only. No sharing
  with other users, services, containers, or remote hosts. Not a hostile same-user
  security boundary or full-system process visibility claim.
- Private task UID/inode (plus creation time for new records), exact `0700` mode,
  and absence of ACL grants are checked. macOS renumbers `st_dev` when a volume is
  remounted; a changed device number is accepted only if the container's inode
  (and birth time) match and it is on the same device as `.ai-work` now. Stamps are
  then compared in the record's numbering. A recreated container still blocks.
- Owner host matches the stable machine identity, the current hostname, or an
  entry in `~/.config/ai-work-lifecycle/host-aliases.json` (legacy hostnames only;
  `machine:` entries are rejected). The alias file is opened with `O_NOFOLLOW` and
  validated on the descriptor (owned regular file, not group/other writable,
  <= 64 KiB); `~/.config` and its `ai-work-lifecycle` folder must be owned real
  directories that are not group/other writable.
- Record field types are validated explicitly. Inventories/sweeps report an
  unreadable, malformed or foreign record as a blocked task instead of failing the
  whole registry; a missing `tasks/` or scope is reported as report-only. Repository and `.ai-work` must be owned and not shared writable.
  macOS ACL inspection uses `/bin/ls`; Linux checks POSIX ACL xattrs.
- Fresh `lsof -a -u UID -nP -Fpn` snapshots include matching open files, cwd,
  directories, and mappings. Missing tools, stderr, timeout, malformed/empty
  results, or failed inspection block; no permission-skipping fallback.
- Symlinks anywhere, hardlinks, special files, detected mounts/device boundaries,
  foreign/shared-writable resources, and nested `.git`/worktree markers block.
  Any tracked `.ai-work` content blocks: report it and seek separate authorization.
- Exact sealed manifests are checked again before deletion, using no-follow
  descriptor traversal rooted at `/`, never recursive glob/rmtree deletion.
  New/drifted content blocks; no force/reseal or blind retry. Partial cleanup may
  already have removed entries; its write-ahead receipt requires manual review.
- Nonblocking advisory locks serialize transitions, not arbitrary producers.
  Never remove the lock to bypass contention. Local POSIX filesystems and trusted
  CLI/PATH are required; network/shared filesystems and cross-user sharing are not
  supported. Inspection/deletion cannot be atomic against uncooperative writers.
- Bounds: 1,000 tasks, 64 paths/leases per task, 50,000 manifest entries, 32 MiB
  records. Hashing streams content. Cleaned manifests are dropped; one bounded
  receipt and ownership/completion records remain. Schema v2 records remain
  compatible; older incompatible schemas require separately authorized review.
- Existing/unregistered artifacts and worktrees are report-only. Review owner,
  purpose, processes, tracked changes, unpublished commits, and backups manually.
  Worktree removal and branch deletion need separate authorization. This tool
  installs no host extension, launcher, hook, or scheduler and publishes nothing.

## Verification

From the repository root, with an existing ignored `.ai-work`:

```sh
TMPDIR="$(pwd -P)/.ai-work" PYTHONDONTWRITEBYTECODE=1 \
  python3 -m unittest discover -s tooling/specs -p test_ai_work_lifecycle.py -v
```

Only test-created fixtures under `.ai-work` are removed. Tests cover the existing
filesystem/Git/ownership guards plus task start/finish, read-only preview, logical
sizes, command exit codes/stdout, leasing, interruption, injection, and retention.
Real normal-user `lsof` tests cover open files/cwd and successful cleanup while
an explicitly released owner remains alive. Run on the deployment host; do not
enable cleanup if own-user inspection fails.
