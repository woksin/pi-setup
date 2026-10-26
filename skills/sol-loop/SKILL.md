---
name: sol-loop
description: 'Use when the user says "sol loop".'
license: MIT
---

# Sol loop

A bounded review loop between you (the writer) and the native `sol-reviewer`
agent. The reviewer only reads and reports. You verify every claim, fix or
decline it with evidence, and stop at the budget. Sol approval is not merge
approval and is not a full cross-provider review.

## 1. Scope and budget

- Run `git status --short --branch` and record the exact base and head SHAs.
  Do not stash, discard, switch branches or fetch unless the task authorises it.
- State the intent, the allowed paths and what is out of scope.
- Untracked files may be reviewed in a preliminary loop. Evidence you want to
  reuse later needs committed, full base and head SHAs and an unchanged scope.
- Run the checks that cover the change first. Record failures that existed
  before your edits, and missing evidence.
- Hard budget: **at most 3 review attempts in total**, fewer if the brief says so.
  Failed, cancelled and mandatory-policy review passes count. There is no
  force flag, no fifth round and no extra review after the budget is spent.
- Pause all edits to the scope while a review is running.
- If Sol or another GPT model wrote any code in scope, including fixes made
  during this loop, a Sol-only loop is never its review. Run the `review`
  workflow with `author: "gpt"` (§9) so a non-GPT provider reviews it, within
  the same three-attempt budget. Without that review the result is
  **Incomplete**, not Approved.

## 2. Reviewer identity

- Confirm the `sol-reviewer` type is enabled. It is configured as
  `openai-codex/gpt-6.1-sol`, but that is configuration, not proof the model is
  available. Do not install other CLIs, add providers or change profile or
  fallback settings.
- The agent runs with skills disabled. Pass the complete brief in the prompt.
- Take the effective model and effort from the Agent result details, never from
  the reviewer's own claim. A general-purpose substitute, a provider-fallback
  completion or an unknown or mismatched identity is **Incomplete**. Do not
  label it Sol.

## 3. Native lifecycle

Start one reviewer and keep its ID:

```
Agent({ subagent_type: "sol-reviewer", description: "Sol loop round N",
        prompt: BRIEF, run_in_background: true })
```

- Completion arrives as a notification. It is only a preview. Fetch the full
  result once with `get_subagent_result({ agent_id, wait: true })`. Use
  `run_in_background: false` only when you need the answer immediately.
- Do not poll or sleep, start a second reviewer, or resume while it runs.
- To follow up, resume a **finished** reviewer:
  `Agent({ resume: ID, subagent_type: "sol-reviewer", prompt, description, run_in_background: true })`.
  Resume reuses the old session and ignores new model or thinking arguments.
- Interrupting a wait cancels only the wait. The agent keeps running. There is no
  stop tool for you: ask the user to stop it through `/agents`, Running agents,
  and stay blocked until it has a terminal state. Steering is a request, not
  proof of cancellation. Record the stop evidence before any retry.

## 4. Review brief

The reviewer is read-only. The brief says: no writes, commits, tests, builds,
formatters or installs, no publication or PR comments, no nested agents, and
`bash` for inspection only. It contains:

- absolute repository path, allowed paths, intent, out of scope
- full base and head SHAs, and `since` for a follow-up
- checks run with results, and a Not examined list
- the rubric: `blocker` (correctness, security, data loss, regression, broken
  build or tests), `should`, `nit`
- the reply format: stable ID, severity, `file:line`, concrete claim and fix,
  evidence, then `APPROVE`, `CHANGES` or `Incomplete`

A security, data-loss or caller-breaking defect is never downgraded as rare or
out of scope. The brief must make sense to a reader with no history.

## 5. Answering findings

Verify each claim yourself. For each one: fix it minimally (with a failing test
first where one is justified), or decline with concrete evidence. Do not accept
feedback on trust, and do not widen the scope to end the loop. Docs, comment and
format-only fixes and declined nits need no further behavioural review.

## 6. Next round

Round 1 covers the whole scope. Later rounds cover only the delta since the last
reviewed head and the open finding IDs, with the same base and ledger. Do not
re-review unchanged code for nits or for a tidy agreement.

## 7. Ledger

You write `.ai-work/<task>/sol-loop.md`. The reviewer never does. Record per
round: attempt and agent ID, scope, base, head and since, expected versus
observed model and effort, each finding's ID, severity and state, your response
and evidence, checks, terminal status, stop proof, verdict and missing evidence.
Record usage only when it is exposed. No secrets, no whole transcripts.

## 8. Stopping

- Only nits left: stop, but do not call it APPROVE if the reviewer said CHANGES.
- Agreed means the approval covers the current behaviour and no credible blocker,
  should or writer concern remains.
- A dispute that survives two replies, or an exhausted budget: show both
  positions with evidence and ask the user. No approval.
- Errors, silence or unknown identity: Incomplete.
- `sol-reviewer` disabled, unavailable or replaced by fallback: report the loop
  **blocked**. Do not substitute another reviewer under the Sol name.
- Never push during the loop. Publication needs separate user authorisation and
  the repository's normal gates.

## 9. When a full review is required

The standalone Sol result cannot seed the `review` workflow cache and is not full
assurance. If policy already requires a full cross-provider review, or Sol or GPT
wrote any code in scope (§1), run the
`review` workflow from the start as the carrier. Put this protocol's scope,
read-only rules, budget and ledger instructions in `context`. It already runs one
Sol reviewer, an independent Opus reviewer and finding verifiers. Count each
workflow round against the same three-round budget.

- Inputs: `target`, `context`, `author` (`"gpt"` for Sol or GPT-authored work,
  `"claude"` otherwise), `round`, full `baseSha` and `headSha`. Never pass `force`.
- Follow-ups: `since` is the last fully reviewed head, and `prior` is one string of
  open findings plus dismissals with reasons. Keep the mode, raise `round`.
- Workflow mode exposes no Sol agent ID. Do not invent a handle to resume.
- `quick` routes to the other provider and suits only work whose policy allows
  quick review. `deep` uses Astra, not Sol. Never describe deep as a Sol review.
- Reuse a result without a new model call only if you hold the entire unchanged
  earlier result with `passed` and `complete` true, nothing blocking or
  unverified, and the same target, context, author, mode, base and head. It is not
  valid for quick, `since` or `prior` results. Verify the real Git identity and a
  clean scope yourself. Any new commit changes the key, so label older exact-head
  evidence as stale.
- If required coverage will not fit in the budget, report blocked. Do not claim
  approval.

## 10. End report

Give: candidate, base and reviewed SHAs, rounds and attempts used, actual model
and effort (or unknown), findings with fixes, disagreements and declines, diff
size before and after, usage if exposed, Not examined, missing gates, the verdict,
and whether anything was pushed. Map the verdict to Approved, Approved with
suggestions, Changes requested or Incomplete. Keep `APPROVE` and `CHANGES` as
the reviewer's words in the ledger.
