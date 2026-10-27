# Daily workflow

A normal day with pi-setup, step by step. New here? Read [Getting started](getting-started.md) first. Every command has a `--help`; the [tool reference](reference.md) lists them all.

Lines marked **Prompt** are sample text for you to type into pi, not shell commands.

## 1. Start pi in a repository

```sh
cd path/to/repo
git fetch
pi
```

Start pi inside the repository you work on. Keep one session on one repository and one task.

## 2. Check the profile

The profile decides which model each agent uses.

```sh
pi-profile            # show the active profile
pi-profile list       # list all profiles
pi-profile use <name> # switch; applies to new sessions
```

If you use more than one Anthropic account, `pi-account list` and `pi-account use <name>` switch between saved logins. To see how much each provider is being used, run `pi-usage` (read-only).

## 3. Ask for work and let pi delegate

Describe the outcome, the files in scope and how you will know it is done.

**Prompt:** *"Fix issue #123. Keep the change to the files under `src/billing/`. Done when the existing tests pass and there is a new test for the bug."*

For anything larger than a small fix, pi works in steps:

1. A planner agent writes a plan and a brief in `.ai-work/<task>/`.
2. An implementer agent makes the change in a worktree.
3. A reviewer agent from the other model provider checks the result. The rules limit how many review rounds a change gets.

You can read and change the plan before work starts. The rules behind this are in `~/.pi/agent/AGENTS.md`; the source is [agent/AGENTS.md](../agent/AGENTS.md).

## 4. Builds and tests go through `pi-phase`

Builds and tests wait in a shared queue so several sessions do not overload the machine. pi runs them for you. To run one yourself:

```sh
pi-phase run --kind test --label "unit tests" --timeout 300 -- npm test
pi-phase status
```

`--kind` is `build`, `test` or `integration`. Put your command after `--`. See [pi-phase README](../agent/pi-phase/README.md) for policies, priorities and the fast lane, and `pi-phase --help` for the commands.

## 5. Track issues with `issue_work`

`issue_work` is a tool inside pi, not a shell command. It records which session works on which GitHub issue, so two sessions do not take the same one.

**Prompt:** *"Claim issue #123 before you start, and mark it in-review when the pull request is open."*

## 6. Long waits

CI and long builds can take a long time. pi starts them as background jobs (`job_start`, `job_watch`) and wakes when they finish. You do not need to wait or poll. See [pi-jobs](https://github.com/woksin/pi-jobs).

## 7. Context handoff

Long sessions get slower and costlier as they grow. When the context budget extension asks for it, pi writes a short handoff and continues from a smaller context. You do not need to do anything. To switch sessions yourself, **Prompt:** *"Write a handoff for the next session in `.ai-work/`."*

## 8. Housekeeping

```sh
dev-doctor                # read-only machine diagnostics: slow gates, memory, Docker
pi-cleanup                # dry run: shows what it would clean, changes nothing
pi-cleanup --apply        # runs the cleanup
ai-work-lifecycle --help  # temporary task outputs under .ai-work/
```

Always read the `pi-cleanup` dry run before using `--apply`. See [ai-work-lifecycle](../tools/ai-work-lifecycle/README.md) for the task lifecycle.

## 9. Several sessions at once (optional)

Lanes let you run several coordinated sessions. They are opt-in; see [Lanes](../README.md#parallel-sessions-lanes).

More guides are planned as part of [#34](https://github.com/woksin/pi-setup/issues/34).
