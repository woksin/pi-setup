import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { effectiveParent, expand, laneDir, saveConfig, UsageError, validate, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { slug, validId } from "../names.ts";
import { backendFor } from "../backend.ts";
import { preapprove } from "../preapprove.ts";
import { shellQuote } from "../terminal.ts";
import { readTemplate, renderTemplate, templateVars } from "../templates.ts";

interface AddContext { c: Config; root: string; ctx: LanesCtx }
type Options = Record<string, string>;
type Git = (clone: string, args: string[], timeoutMs?: number) => ReturnType<LanesCtx["run"]>;
interface Orchestration { siblings: Lane[]; orchestrator?: Lane; candidate?: Lane }

export async function add(
  id: string, opts: Options, c: Config, root: string, ctx: LanesCtx,
): Promise<number> {
  validateInput(id, opts, c);
  const lane = newLane(id, opts);
  validate({ ...c, lanes: [...c.lanes, lane] });
  const orchestration = planOrchestration(lane, opts, c);
  const { orchestrator, candidate, siblings } = orchestration;
  if (orchestrator) lane.parent = orchestrator.id;
  const env = { c, root, ctx };
  const code = await createWorktree(lane, opts, env);
  if (code !== 0) return code;
  if (candidate && await createWorktree(candidate, opts, env) !== 0) return 1;
  if (orchestrator) await assignOrchestrator(orchestration, env);
  else if (siblings.length) ctx.err(`warning: ${siblings.length + 1} lanes, no repo-orch`);
  saveConfig(root, c);
  ctx.out(`next: lanes start ${id}`); return 0;
}
function validateInput(id: string, opts: Options, c: Config): void {
  if (!validId(id) || ["ALL", c.messages.broadcast, c.coordinator.id].includes(id)) {
    throw new UsageError("invalid lane id");
  }
  if (c.lanes.some(l => l.id === id)) throw new Error(`lane ${id} already exists`);
  validateRepo(opts.repo);
  validateIssueAndGoal(opts);
}
function validateRepo(repo: string): void {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new UsageError("invalid repo (expected owner/name)");
  }
  if (repo.split("/").some(s => [".", ".."].includes(s))) {
    throw new UsageError("invalid repo (expected owner/name)");
  }
}
function validateIssueAndGoal(opts: Options): void {
  if (invalidIssue(opts.issue)) {
    throw new UsageError("invalid issue");
  }
  if (opts.goal !== undefined && !opts.goal.trim()) throw new UsageError("invalid goal");
}
function newLane(id: string, opts: Options): Lane {
  const repo = opts.repo; const name = repo.split("/")[1]; const lower = id.toLowerCase();
  const worktree = `${lower}-${name.toLowerCase()}`;
  const branch = opts.branch || defaultBranch(lower, worktree, opts);
  return {
    id, repo, ...(opts.issue ? { issue: Number(opts.issue) } : {}),
    ...(opts.goal ? { goal: opts.goal } : {}), group: opts.group || null,
    worktree, branch, prompt: `prompts/${id}.md`,
  };
}
function defaultBranch(lower: string, worktree: string, opts: Options): string {
  if (opts.issue) return `${lower}-issue-${Number(opts.issue)}`;
  return opts.goal ? `${lower}-${slug(opts.goal)}` : worktree;
}
function planOrchestration(lane: Lane, opts: Options, c: Config): Orchestration {
  const siblings = c.lanes.filter(l => !l.retired && l.repo === lane.repo);
  const current = siblings.find(l => l.role === "repo-orch");
  if (opts.orchestrator && opts["no-orchestrator"]) {
    throw new UsageError("choose --orchestrator or --no-orchestrator");
  }
  if (opts.orchestrator) return { siblings, orchestrator: promotedOrchestrator(siblings, opts.orchestrator) };
  if (!needsOrchestrator({ current, siblings }, opts)) return { siblings, orchestrator: current };
  const candidate = newOrchestrator(lane, opts, c);
  return { siblings, orchestrator: candidate, candidate };
}
function promotedOrchestrator(siblings: Lane[], id: string): Lane {
  const orchestrator = siblings.find(l => l.id === id);
  if (!orchestrator) throw new UsageError("--orchestrator must name an existing lane in the repository");
  if (siblings.some(l => l.role === "repo-orch" && l.id !== orchestrator.id)) {
    throw new UsageError("repository already has a repo-orch");
  }
  return orchestrator;
}
function newOrchestrator(lane: Lane, opts: Options, c: Config): Lane {
  const name = lane.repo.split("/")[1];
  const id = opts["orchestrator-id"] || `R-${name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14)}`;
  const reserved = [lane.id, c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.map(l => l.id)];
  if (!validId(id) || reserved.includes(id)) {
    throw new Error("repo-orch ID collision or invalid ID; choose --orchestrator-id");
  }
  const lower = id.toLowerCase();
  return {
    id, repo: lane.repo, group: null, role: "repo-orch", parent: c.coordinator.id,
    worktree: lower, branch: `${lower}-candidate`, prompt: `prompts/${id}.md`,
  };
}
async function assignOrchestrator(plan: Orchestration, { c, root, ctx }: AddContext): Promise<void> {
  const orchestrator = plan.orchestrator!;
  orchestrator.role = "repo-orch"; orchestrator.parent = c.coordinator.id;
  const active = c.lanes.filter(l => !l.retired && l.repo === orchestrator.repo);
  for (const sibling of active.filter(l => l.id !== orchestrator.id)) sibling.parent = orchestrator.id;
  saveConfig(root, c);
  for (const sibling of plan.siblings.filter(l => l.id !== orchestrator.id)) {
    await backendFor(c, ctx, root).send({
      from: c.coordinator.id, to: sibling.id, topic: "repo-orch-assigned",
      body: `Report to ${orchestrator.id} from now on.`,
    });
  }
  ctx.out(`next: lanes start ${orchestrator.id}`);
}
export async function createWorktree(lane: Lane, opts: Options, env: AddContext): Promise<number> {
  const { c, root, ctx } = env;
  const git: Git = (clone, args, timeoutMs = 10000) => ctx.run("git", ["-C", clone, ...args], { timeoutMs });
  const clone = await findClone(lane, opts, env, git);
  const base = await prepareBase({ clone, lane, opts, env }, git);
  const wt = laneDir(lane, c, root, ctx);
  await addWorktree({ clone, lane, wt, base }, git);
  try {
    const lock = await git(clone, ["worktree", "lock", "--reason", `lanes ${lane.id}`, wt]);
    if (lock.code !== 0) throw new Error(`git worktree lock failed: ${lock.stderr.trim()}`);
    writePrompt({ lane, wt, base }, env);
    c.lanes.push(lane);
    await preapprove(ctx, wt, c.launch.preapproveMcp);
  } catch (e) {
    ctx.err((e as Error).message);
    ctx.err(`undo: git -C ${shellQuote(clone)} worktree unlock ${shellQuote(wt)} ` +
      `&& git -C ${shellQuote(clone)} worktree remove ${shellQuote(wt)} ` +
      `&& git -C ${shellQuote(clone)} branch -D ${shellQuote(lane.branch)}`);
    return 1;
  }
  return 0;
}
async function findClone(lane: Lane, opts: Options, { c, root, ctx }: AddContext, git: Git): Promise<string> {
  const [owner, name] = lane.repo.split("/"); const repos = expand(c.reposRoot, c, root, ctx.home);
  const candidates = [
    opts.path ? resolve(ctx.cwd, opts.path) : undefined,
    c.repos[lane.repo] ? expand(c.repos[lane.repo], c, root, ctx.home) : undefined,
    join(repos, name), join(repos, owner, name),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) if ((await git(path, ["rev-parse", "--git-dir"])).code === 0) return path;
  throw new Error(`clone it first: gh repo clone ${lane.repo} ${join(repos, name)}`);
}
async function prepareBase(
  input: { clone: string; lane: Lane; opts: Options; env: AddContext }, git: Git,
): Promise<string> {
  const { clone, lane, opts, env: { c, ctx } } = input;
  const remote = await git(clone, ["remote", "get-url", "origin"]);
  if (!remote.stdout.trim().endsWith(lane.repo) && !remote.stdout.trim().endsWith(`${lane.repo}.git`)) {
    ctx.err(`warning: origin does not match ${lane.repo}`);
  }
  const base = opts.base || c.baseBranch;
  const fetch = await git(clone, ["fetch", "origin"], 120000);
  const ref = await git(clone, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (ref.code !== 0) throw new Error(`base ${base} does not resolve`);
  if (fetch.code !== 0) ctx.err(`warning: fetch origin failed; using local ${base}`);
  return base;
}
async function addWorktree(input: { clone: string; lane: Lane; wt: string; base: string }, git: Git): Promise<void> {
  const { clone, lane, wt, base } = input;
  if (existsSync(wt)) throw new Error(`worktree already exists: ${wt}`);
  if ((await git(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`])).code === 0) {
    throw new Error(`branch already exists: ${lane.branch}`);
  }
  const created = await git(clone, ["worktree", "add", "-b", lane.branch, wt, base], 120000);
  if (created.code !== 0) throw new Error(`git worktree add failed: ${created.stderr.trim()}`);
}
function writePrompt(input: { lane: Lane; wt: string; base: string }, { c, root, ctx }: AddContext): void {
  const { lane, wt, base } = input; const { id, repo, branch } = lane;
  const prompt = expand(lane.prompt, c, root, ctx.home);
  mkdirSync(dirname(prompt), { recursive: true });
  const template = readTemplate(ctx, lane.role === "repo-orch" ? "repo-orchestrator.md" : "lane.md");
  const vars = {
    ...templateVars(c, ctx, root), id, repo, parent: effectiveParent(lane, c),
    parent_sh: shellQuote(effectiveParent(lane, c)),
    lanes: c.lanes.filter(l => l.repo === repo).map(l => l.id).join(", "),
    issue: lane.issue ?? "none", goal: lane.goal || "none", group: lane.group || "none", worktree: wt, branch, base,
  };
  writeFileSync(prompt, renderTemplate(template, vars), { flag: "wx" });
}

function invalidIssue(issue: string | undefined): boolean {
  if (issue === undefined) return false;
  return !/^\d+$/.test(issue) || Number(issue) < 1;
}
function needsOrchestrator(plan: { current?: Lane; siblings: Lane[] }, opts: Options): boolean {
  if (plan.current || !plan.siblings.length) return false;
  return !opts["no-orchestrator"];
}
