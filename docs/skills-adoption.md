# Skills: provenance, adoption decisions and ownership

Issue: woksin/pi-setup#60.

## Update direction

`skills/` in this repository is the source. The installer copies it to
`~/.agents/skills/`. `sync.sh` can copy live files back into the repository as a
snapshot. Do not use it to overwrite `skills/sol-loop`, and it does not list that
skill. Installed or package-owned copies are not patched from here.

## First-party skills

| Skill | Source | Description |
|---|---|---|
| `sol-loop` | new, adapted from tstack (below) | `Use when the user says "sol loop".` |
| `ai-work-lifecycle` | this repository | Rewritten as an invocation hint. |
| `dev-machine-performance` | this repository | Rewritten as an invocation hint. |
| `github-issue-hygiene` | this repository (tracked in `skills/`) | Rewritten as an invocation hint; body unchanged. |

Delivery note: if a live installed copy of any of these is maintained somewhere else,
that copy gets the new description when its owner updates it. This slice does not edit
installed copies.

## sol-loop provenance

- Upstream: `t3dotgg/tstack`, skill `sol-loop`, MIT, copyright (c) 2026 Theo Browne.
- Pinned at `7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd`
  (https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/LICENSE).
- The full licence ships as `skills/sol-loop/LICENSE`.
- Kept from upstream: scope, budget, brief, answer, next-round and stop organisation;
  `blocker/should/nit` severities; writer verification of every claim.
- Adapted on purpose:
  - Native lifecycle: `Agent` with `sol-reviewer`, background completion,
    `get_subagent_result`, resume of a finished agent. No Codex CLI, `wait_agent` or
    `stop_agent`. The host has a UI stop only, so the skill asks the user to stop.
  - Identity: the enabled `sol-reviewer` (pinned `openai-codex/gpt-6.1-sol`) must be
    confirmed from the Agent result. A fallback or unknown identity is Incomplete.
  - Read-only reviewer and a self-contained brief, because `sol-reviewer` runs without skills.
  - Hard cap of three attempts, with no five-round extension and no `force`.
  - Report vocabulary mapped to Approved / Approved with suggestions / Changes requested / Incomplete.
  - Review carrier: where policy already requires a full cross-provider review, use the existing
    `review` workflow from the start instead of a separate Sol pass. A standalone Sol result cannot
    seed its cache. Deep mode uses Astra, not Sol.
- No agent, workflow, provider, profile or installer runtime code changed. The model is configured,
  not availability-tested.

## Decisions for the nine tstack skills

| Skill | Decision |
|---|---|
| `sol-loop` | Adapted now. |
| `leaving-pr-comments` | Next useful adapter: verified identity, secret review, posting only by the authorised parent. |
| `modernize` | Next useful adapter: intent, range-diff, history changes only when authorised. |
| `council` | Opt-in only, with explicit provider cost, availability and caps. |
| `babysit-pr` | Defer scripts. Use the existing owned watch. |
| `takeover` | Defer until a live-owner handoff is needed. |
| `full-stop` | Defer the ready-unmerged concept. No auto-merge setting changes. |
| `file-pr` | Defer. Adapter belongs with the existing PR policy. |
| `full-send` | Reject: unattended merge, force-push and ignoring human review are unsafe. Defer any replacement. |

No bodies, scripts or dependencies were added for the other eight. A reference between skills
never grants authority, publication, watchers or force-push permission.

## Exclusions and follow-ups (tracked under #60)

- Cratis AI corpus (139 entries, 25 licensed adaptations, and its worker skill): owned by L24, separate repository.
  Notices and modification records are preserved there.
- Cratis AI's 18 worker-vendor descriptions: L24 maintained-frontmatter patch in a later slice. No claim of completion.
- Other installed external-package skills (browser, CodeScene, pi extensions): the source owner's follow-up.
  Home-directory packages have not been audited.
- Not performed: model-powered routing evaluation, live install, the full release gate, independent source review.
  The routing fixtures guard intent and format only.
