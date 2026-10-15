# Local AI work lifecycle

One CLI, one shared skill, one hourly fallback. No root service or session-exit deletion.

## Everyday use

From an actual Git root with an existing ignored `.ai-work/`:

```sh
ai-work-lifecycle --repo "$PWD" run-task unique-check -- YOUR_COMMAND ARGUMENTS
```

The wrapper creates a private task, registers its disposable paths and manages one
foreground worker. It supplies `AI_WORK_KEEP`, `AI_WORK_CACHE`, `AI_WORK_OUTPUT`.
Commands must explicitly use these paths: existing build-output and shared-cache
settings are not changed. Success attempts immediate cleanup; failure/interruption
retains the outputs. A cleanup refusal is reported on stderr without replacing the
command's exit code. No detached workers, daemons or terminal job control.

For longer work:

```sh
ai-work-lifecycle --repo "$PWD" start unique-task --owner-pid REAL_SESSION_PID
# keep/: retained notes/recovery; cache/ and output/: registered disposable files
ai-work-lifecycle --repo "$PWD" finish unique-task          # read-only preview
ai-work-lifecycle --repo "$PWD" finish unique-task --apply  # explicit completion + cleanup
```

The owner PID must be the real host session, not a transient tool shell. Extra
workers need `lease`/`release`; the foreground wrapper handles its worker itself.
Use `state TASK paused` for unfinished work. Do not infer completion from exit,
reload, compaction, age or a dead PID: nothing finishes automatically, including
Pi session shutdown (Pi reports signals and terminal close as "quit" too). Agents
must `finish TASK --apply` when genuinely done. Pi notifies at session start about
this repo's tasks unfinished for more than 24h (`unfinished --older-than`), with the
finish/pause commands. `finish-owned` is a manual command only (see REFERENCE). `keep/`, source, legacy worktrees, backups,
credentials and databases are never auto-purged. File-type/content restrictions
still apply; full extracted package trees and mixed outputs require manual review.
See [REFERENCE.md](REFERENCE.md) for the low-level API and safeguards.

## Your AI tools

The shared personal skill is `~/.agents/skills/ai-work-lifecycle/SKILL.md` (Codex
and compatible Copilot clients). Pi and Claude's personal skill folders link to
the same file; the Pi compatibility link was verified with the installed loader.
Pi, Claude and Codex global instructions explicitly route disposable-output work
to this skill. These are local-machine capabilities, not cloud installations.
Existing sessions are not interrupted; refresh/restart them to load the changes.
Pi supports `/reload`, then `/ai-work start TASK`, `/ai-work finish TASK`, and
`/ai-work status|plan|apply [TASK]`. Finish/apply require confirmation in Pi.
Isolated subagents may have discovery disabled; their parent must supply managed
paths and own their worker lifecycle rather than overriding those boundaries.

## Hourly fallback and measurement

`local.ai-work-lifecycle` sweeps the roots in `~/.config/ai-work-lifecycle/roots.json`
plus any EXISTING registry (`<git-root>/.ai-work/.lifecycle`, owned by you) found
under `/Volumes/sourcecode/repos` (depth 6, build/package/task trees pruned); with
`--apply` those are added to roots.json. It never creates registries or adopts
unregistered folders. All roots are always processed. Blocked tasks are classed
`expected` (not completed, owner/lease/handle still live), `stale` (task folder or
`tasks/` gone: report only), `safety` (foreign/malformed record, identity mismatch,
manifest drift; unknown reasons default here) or `partial` (failed cleanup).
Exit 0 unless a root failed operationally or a cleanup failed/was partial (exit 2,
"degraded"). Root failures, partial cleanups, new safety blocks (once per task per
day) and home free space below 40 GiB write an `ALERT` line to
`~/.ai-work/ai-work-lifecycle/sweep.log` (one summary line per run) and post a
macOS notification (best effort; identical notifications at most every 6 h). Completed low-level tasks must have explicit cleanup
authorization; active, paused, changed and still-used resources remain protected.

Latest report: `~/.ai-work/ai-work-lifecycle/last-sweep.json` (includes
`blocked_reasons`, `new_roots`, `missing`).

Host identity: new records store `machine:<IOPlatformUUID>`. Older records carry the
DHCP-dependent hostname of the time; former names of this machine are listed in
`~/.config/ai-work-lifecycle/host-aliases.json` (owner-maintained, `0600`).
Trend: `~/.ai-work/ai-work-lifecycle/usage-history.json` (one sample/hour, 168 maximum).
Reports include registered roots, task counts, logical bytes cleaned, allocated
`.ai-work` size and free space. Logical-byte receipts are not guaranteed APFS
savings; disk changes include other sessions. The 5 GiB task budget is a review
warning, not an enforced quota. Unknown measurements are reported, not treated as zero.

```sh
# Dry-run and refresh measurement:
python3 ~/.local/share/ai-work-lifecycle/sweep-known-roots.py
# Disable the hourly user service:
launchctl bootout gui/$(id -u)/local.ai-work-lifecycle
```

Source lives in `Cratis/AI` (`tooling/ai-work-lifecycle.py`, its tests/reference,
and `.ai/skills/ai-work-lifecycle`). The installed CLI and skill are reviewed local
copies, not live executable imports from the checkout. Changes are uncommitted and
unpublished; no shared package or repository version pin was changed.
