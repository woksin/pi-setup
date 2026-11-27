/**
 * loose-threads-plan.js: classify a loose-threads inventory into a read-only cleanup plan.
 *
 * First run the inventory (about 10 to 15 minutes, use job_start):
 *   ~/.pi/agent/loose-threads/inventory.sh [OUTDIR]   # default ~/.ai-work/loose-threads/<date>
 * Then: "run the loose-threads-plan workflow" with args { dir: "<OUTDIR>" }.
 *
 * Produces <OUTDIR>/plan.md. It changes nothing: no deletion, push, PR or issue change.
 * Executing the plan needs the user's approval. Use ~/.pi/agent/loose-threads/exec_wt.sh
 * for worktree removal, which backs up .ai-work, uncommitted changes and a branch bundle first.
 */
export const meta = {
  name: 'loose-threads-plan',
  description: 'Classify a loose-threads inventory (worktrees, branches, stashes, lifecycle tasks) into a verified, read-only cleanup plan',
  whenToUse: 'Periodic backstop after ~/.pi/agent/loose-threads/inventory.sh has produced an inventory directory',
  phases: [
    { title: 'Classify', detail: 'one agent writes plan.md from the inventory' },
    { title: 'Verify', detail: 'the other provider tries to refute every remove/delete claim' },
  ],
}

const input = typeof args === 'string' ? JSON.parse(args) : (args || {})
const dir = input.dir
if (!dir) return { error: 'Pass args.dir: the inventory directory written by inventory.sh.' }

const RULES = `Rules (from ~/.pi/agent/AGENTS.md, destructive-action safety, and the ai-work-lifecycle skill):
- Read-only: do not delete, push, open PRs, or create, edit or close issues. Only write ${dir}/plan.md.
- Treat anything with commits or reflog activity in the last 6 h, or with a live process (cwd.tsv, lsof), as in flight: LEAVE.
- "Merged" needs proof. One of: tip == or ancestor of a merged PR's head (pr_checks rel tip==prhead / tip-ancestor-of-prhead);
  merge_result content-in-default; 0 ahead of the default branch; or "superseded", quoted from the closing PR comment or title.
  Check the PR's base branch: a PR merged into a batch or stacking branch is not on main.
- Before proposing work as never pushed, read the linked issue's status block. It may record a decision to keep the work unshipped.
- Never --force, git branch -D on unproven work, git clean -fdx, git stash drop, or deleting .ai-work/keep/.
- Actions: DEL-BR (bundle first), REMOVE-WT (exec_wt.sh), SWITCH-MAIN, KEEP (open PR), LEAVE (in flight), DELIVER (push + PR after gates), RECORD (issue status block + bundle + remove), ASK.`

phase('Classify')
const plan = await agent(`Inventory data is in ${dir}: refs.json (every branch and worktree, with ahead/behind, merge-tree result, cherry, PR checks, issue info), worktrees.tsv, branches.tsv, main.tsv, stashes.tsv, lifecycle.tsv, cwd.tsv, pi-cleanup-dry.txt, docker-dangling.txt, df.txt.
Write ${dir}/plan.md: one row per item (repo, path, branch, state, evidence, proposed action), grouped by repo. Start with a short summary and a numbered list of the decisions you need from the user. Give the evidence for every "merged" or "superseded" claim. Investigate unclear items with git and gh (read-only).
${RULES}
Return a compact summary: counts per action, and the items you were unsure about.`,
  { label: 'classify', phase: 'Classify', agentType: 'general-purpose' })

phase('Verify')
const verdict = await agent(`Adversarially verify the plan in ${dir}/plan.md. For every row proposing REMOVE-WT, DEL-BR, SWITCH-MAIN or "superseded", try to prove it would lose unique work. Check:
- unique commits not on the default branch and not in a merged PR head
- uncommitted or ignored-but-valuable files (.env, appsettings.*.json, keys, databases, .ai-work/keep)
- recent activity or a live process
- a PR merged into a non-default base
- an issue status block that records a decision to keep the work
Read-only: change nothing except appending a "## Verification" section to ${dir}/plan.md that lists every refuted row with its evidence.
Return the refuted rows: repo, branch, reason.`,
  { label: 'verify', phase: 'Verify', agentType: 'sol-reviewer' })

return { plan: String(plan || '').slice(0, 3000), verification: String(verdict || '').slice(0, 3000), file: `${dir}/plan.md` }
