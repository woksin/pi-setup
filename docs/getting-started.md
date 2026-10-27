# Getting started

This page is for someone who has never used pi-setup. It tells you what you get, how to start, and where to read next.

pi-setup adds rules, agents, model profiles, extensions and small command-line tools to [pi](https://github.com/earendil-works/pi-coding-agent), the coding agent. You still talk to pi in your terminal. pi-setup changes how it plans, delegates, builds and cleans up.

## 1. Install

Follow [Try pi-setup on your Mac](../TRY-ON-MAC.md) for a step-by-step guide, or see [Install](../README.md#install) in the README for all platforms and options. This page does not repeat the install commands.

## 2. Your first session

Go to any Git project and start pi:

```sh
cd path/to/a/project
pi
```

Then give it a small, safe task. Sample prompt (type it into pi):

> Explain what this project does and how it is structured. Do not change any files.

Once that works, ask for a real change. For a first try, pick something small with a test, such as a bug fix or a new unit test.

## 3. What got installed

| Part | Where it ends up | In plain words |
|---|---|---|
| Rules | `~/.pi/agent/AGENTS.md` | Standing instructions pi reads every session: keep work small, verify before shipping, how to treat issues and pull requests. |
| Agents | `~/.pi/agent/agents/` | Helpers pi can hand work to: planner, implementer, reviewer and others. |
| Profiles | `~/.pi/agent/profiles/` | Which model each agent uses. Switch with `pi-profile`. |
| Extensions | `~/.pi/agent/extensions/` | Slash commands and guards inside pi, such as `/provider-restore` and issue tracking. |
| Skills | `~/.agents/skills/` | Short playbooks pi loads when a task matches. |
| Tools | `~/.pi/agent/bin/` and `~/.local/bin/` | Command-line helpers for builds, health checks and cleanup. See the [tool reference](reference.md). |

The [README](../README.md#whats-in-it) lists every file group.

## 4. Check that it is healthy

From your `pi-setup` checkout:

```sh
./install.sh doctor
```

It reports what is missing and how to fix it. See [Doctor](../README.md#doctor) for details.

## 5. Where to go next

- [Daily workflow](daily-workflow.md): how a normal working day looks.
- [Tool reference](reference.md): every command, with its `--help`.
- [Machine performance](../README.md#machine-performance): why builds go through a queue.
- [Operating lessons](operating-lessons.md): what has gone wrong before and what the rules are for.

Scenario guides, extension internals and a hands-on tutorial are planned as later parts of [#34](https://github.com/woksin/pi-setup/issues/34).
