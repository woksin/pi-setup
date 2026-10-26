---
name: github-issue-hygiene
description: Use when starting work on, creating, commenting on, updating the description of, or finishing work on a GitHub issue, and during post-work cleanup to close completed, duplicate or obsolete issues.
---

# GitHub issue hygiene

An issue is read later by people who were not in the session. Every visible change must make sense to them on its own.

## Ownership: one writer per issue

- Only the **session that owns the work** (normally the main session) edits an issue body, posts comments, or closes it. Subagents never touch issues; they report findings to their parent, which decides what goes on the issue. The one exception: the parent may explicitly hand a subagent (for example `cleanup-steward`) ownership of named issues for the rest of the task, and then must not edit them itself meanwhile.
- Never rewrite text you did not write. The original problem statement and other people's content stay intact.

## Description versus comment

**Update the description** (the agent-managed status block) for the *current state*: scope as now understood, decisions, plan/checklist, linked PRs, what remains. Readers should be able to read only the description and know where things stand.

When a `planner` plan exists, the status block links the plan file and summarises the chosen approach in 1–2 lines.

**Post a comment** only for an *event worth a notification* that a reader later needs in the timeline:
- a decision or scope change and its reason;
- a blocker or question for a human;
- a PR opened or merged, or a release that contains the fix;
- the closing summary.

Do not post progress chatter, tool output, verification receipts, test counts, model/agent notes or "working on it" messages. Do not repeat the description in a comment. Prefer editing your own recent comment (`gh issue comment <n> --edit-last`) over a series of small comments.

Every comment must stand alone: what happened, why it matters, what happens next. Link absolute URLs to PRs, commits and other issues.

## Claiming an issue when work starts

When a session starts working on an issue, it must be clear on the issue itself that it is being worked on, so humans and other agent sessions do not pick it up in parallel or assume it is stalled.

**In pi, use the `issue_work` tool**: `claim` does steps 1–3 below in one call and records the session in the local registry behind `/issues`; `update` does step 4; `list` shows what is in flight for the end-of-work audit. Use the manual steps only when the tool is unavailable.

1. Read the status block first (`issue-status.py show`). If it says `In progress` or `In review` from another session or branch, do not start; report it to the user.
2. Assign it (in Cratis repos: `--add-assignee {{GITHUB_USER}}`).
3. Before writing code, update the status block to `**State:** In progress`, with the scope as understood and the branch name (add the draft PR URL once it exists).
4. Keep the state true as the work moves: `In review` when the PR is opened, `Blocked` with the reason when waiting on someone, `Paused` with what remains when the session ends before the scope is done, `Done` when closing. Never leave an issue saying `In progress` when nobody is working on it.

This is done in the description, not with a "working on it" comment.

## Updating the status block safely

The status block sits between `<!-- agent-status:start -->` and `<!-- agent-status:end -->` at the end of the description. Only that block is changed; the rest is preserved. Write the status to a file, then run:

```sh
~/.agents/skills/github-issue-hygiene/scripts/issue-status.py update --repo OWNER/REPO --issue N --file .ai-work/issue-N-status.md
~/.agents/skills/github-issue-hygiene/scripts/issue-status.py show --repo OWNER/REPO --issue N
```

The script re-reads the issue immediately before writing, recomposes once if it changed, refuses on persistent concurrent edits, and verifies afterwards. GitHub has no conditional writes, so the single-writer rule above is what actually prevents agents from overwriting each other.

Suggested status content (keep it short):

```markdown
## Status
**State:** In progress | In review | Paused | Blocked | Done
**Branch:** feature-branch-name (draft PR URL once open)
**Scope:** one or two sentences, as currently agreed.
**Delivered:** - https://github.com/OWNER/REPO/pull/123 (merged)
**Remaining:** - item, or "Nothing" when done.
**Follow-ups:** - https://github.com/OWNER/REPO/issues/456
```

## Closing issues

PRs in Cratis repositories do not use `Closes`/`Fixes` keywords, so **merging a PR does not close its issue. Close it explicitly.**

- **Completed**: all scope delivered (PR merged, or the change is otherwise in place). Update the status block to Done, create issues for any genuine follow-ups, then:
  `gh issue close <n> --repo OWNER/REPO --reason completed --comment "Completed in <PR URL>. <one sentence on what changed>. Follow-ups: <issue URLs or none>."`
- **Partially done**: keep it open; the status block lists what remains. If the remaining part is really separate work, move it to a new issue and close this one as completed with a link.
- **Not needed / superseded / duplicate**: close with `--reason "not planned"` and a comment giving the reason and a link to the superseding or duplicate issue. Only do this when the evidence is clear (for example a duplicate created during the same work, or the user said it is no longer needed). When unsure, comment with the question and leave it open.
- Never close an issue whose PR is still open, unmerged, reverted, or failing, and never close issues you were not involved with unless the user asked.

## End-of-work audit

Before declaring work finished, and in post-work cleanup, list the issues touched by the work (in pi: `issue_work list` first) and reconcile each one, leaving none `In progress` without a live session:

```sh
gh issue list --repo OWNER/REPO --assignee @me --state open --json number,title,updatedAt
gh pr list --repo OWNER/REPO --state merged --search "<issue number or title words>" --json number,title,mergedAt,url
```

For each issue: close if complete or obsolete, otherwise make sure the status block says exactly what remains and who/what it waits for.
