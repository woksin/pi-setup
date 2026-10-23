import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { effectiveParent, expand, saveConfig, UsageError, validate, type Config, type Lane } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { slug, validId } from "../names.ts";
import { backendFor } from "../backend.ts";
import { preapprove } from "../preapprove.ts";
import { shellQuote } from "../terminal.ts";
import { readTemplate, renderTemplate, templateVars } from "../templates.ts";
export async function add(id: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  if (!validId(id) || ["ALL", c.messages.broadcast, c.coordinator.id].includes(id)) throw new UsageError("invalid lane id");
  if (c.lanes.some((l) => l.id === id)) throw new Error(`lane ${id} already exists`);
  const repo = opts.repo;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((s) => [".", ".."].includes(s))) throw new UsageError("invalid repo (expected owner/name)");
  if (opts.issue !== undefined && (!/^\d+$/.test(opts.issue) || Number(opts.issue) < 1)) throw new UsageError("invalid issue");
  if (opts.goal !== undefined && !opts.goal.trim()) throw new UsageError("invalid goal");
  const [owner, name] = repo.split("/");
  const lower = id.toLowerCase();
  const worktree = `${lower}-${name.toLowerCase()}`;
  const branch = opts.branch || (opts.issue ? `${lower}-issue-${Number(opts.issue)}` : opts.goal ? `${lower}-${slug(opts.goal)}` : worktree);
  const lane: Lane = { id, repo, ...(opts.issue ? { issue: Number(opts.issue) } : {}), ...(opts.goal ? { goal: opts.goal } : {}), group: opts.group || null, worktree, branch, prompt: `prompts/${id}.md` };
  validate({ ...c, lanes: [...c.lanes, lane] });
  const siblings = c.lanes.filter(l => !l.retired && l.repo === repo);
  let orchestrator = siblings.find(l => l.role === "repo-orch");
  let candidate: Lane | undefined;
  if (opts["orchestrator"] && opts["no-orchestrator"]) throw new UsageError("choose --orchestrator or --no-orchestrator");
  if (opts.orchestrator) {
    orchestrator = siblings.find(l => l.id === opts.orchestrator);
    if (!orchestrator) throw new UsageError("--orchestrator must name an existing lane in the repository");
    if (siblings.some(l => l.role === "repo-orch" && l.id !== orchestrator!.id)) throw new UsageError("repository already has a repo-orch");
  } else if (!orchestrator && siblings.length && !opts["no-orchestrator"]) {
    const orchId = opts["orchestrator-id"] || `R-${name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14)}`;
    if (!validId(orchId) || [id, c.coordinator.id, "ALL", c.messages.broadcast, ...c.lanes.map(l => l.id)].includes(orchId)) throw new Error("repo-orch ID collision or invalid ID; choose --orchestrator-id");
    const lower = orchId.toLowerCase();
    candidate = { id: orchId, repo, group: null, role: "repo-orch", parent: c.coordinator.id, worktree: lower, branch: `${lower}-candidate`, prompt: `prompts/${orchId}.md` };
    orchestrator = candidate;
  }
  if (orchestrator) lane.parent = orchestrator.id;
  const code = await createWorktree(lane, opts, c, root, ctx);
  if (code !== 0) return code;
  if (candidate && await createWorktree(candidate, opts, c, root, ctx) !== 0) return 1;
  if (orchestrator) {
    orchestrator.role = "repo-orch"; orchestrator.parent = c.coordinator.id;
    for (const sibling of c.lanes.filter(l => !l.retired && l.repo === repo && l.id !== orchestrator!.id)) sibling.parent = orchestrator.id;
    saveConfig(root, c);
    for (const sibling of siblings.filter(l => l.id !== orchestrator!.id)) await backendFor(c, ctx, root).send({ from: c.coordinator.id, to: sibling.id, topic: "repo-orch-assigned", body: `Report to ${orchestrator.id} from now on.` });
    ctx.out(`next: lanes start ${orchestrator.id}`);
  } else if (siblings.length) ctx.err(`warning: ${siblings.length + 1} lanes, no repo-orch`);
  saveConfig(root, c);
  ctx.out(`next: lanes start ${id}`); return 0;
}
export async function createWorktree(lane: Lane, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const { id, repo, worktree, branch } = lane; const [owner, name] = repo.split("/");
  const repos = expand(c.reposRoot, c, root, ctx.home);
  const candidates = [opts.path ? resolve(ctx.cwd, opts.path) : undefined, c.repos[repo] ? expand(c.repos[repo], c, root, ctx.home) : undefined, join(repos, name), join(repos, owner, name)].filter((p): p is string => Boolean(p));
  const git = (clone: string, args: string[], timeoutMs = 10000) => ctx.run("git", ["-C", clone, ...args], { timeoutMs });
  let clone: string | undefined;
  for (const p of candidates) if ((await git(p, ["rev-parse", "--git-dir"])).code === 0) { clone = p; break; }
  if (!clone) throw new Error(`clone it first: gh repo clone ${repo} ${join(repos, name)}`);
  const remote = await git(clone, ["remote", "get-url", "origin"]);
  if (!remote.stdout.trim().endsWith(repo) && !remote.stdout.trim().endsWith(`${repo}.git`)) ctx.err(`warning: origin does not match ${repo}`);
  const base = opts.base || c.baseBranch;
  const fetch = await git(clone, ["fetch", "origin"], 120000);
  const ref = await git(clone, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (ref.code !== 0) throw new Error(`base ${base} does not resolve`);
  if (fetch.code !== 0) ctx.err(`warning: fetch origin failed; using local ${base}`);
  const wt = join(expand(c.worktreesDir, c, root, ctx.home), worktree);
  if (existsSync(wt)) throw new Error(`worktree already exists: ${wt}`);
  if ((await git(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) throw new Error(`branch already exists: ${branch}`);
  const created = await git(clone, ["worktree", "add", "-b", branch, wt, base], 120000);
  if (created.code !== 0) throw new Error(`git worktree add failed: ${created.stderr.trim()}`);
  try {
    const lock = await git(clone, ["worktree", "lock", "--reason", `lanes ${id}`, wt]);
    if (lock.code !== 0) throw new Error(`git worktree lock failed: ${lock.stderr.trim()}`);
    const prompt = expand(lane.prompt, c, root, ctx.home);
    mkdirSync(dirname(prompt), { recursive: true });
    writeFileSync(prompt, renderTemplate(readTemplate(ctx, lane.role === "repo-orch" ? "repo-orchestrator.md" : "lane.md"), { ...templateVars(c, ctx, root), id, repo, parent: effectiveParent(lane, c), parent_sh: shellQuote(effectiveParent(lane, c)), lanes: c.lanes.filter(l => l.repo === repo).map(l => l.id).join(", "), issue: lane.issue ?? "none", goal: lane.goal || "none", group: lane.group || "none", worktree: wt, branch, base }), { flag: "wx" });
    c.lanes.push(lane);
    await preapprove(ctx, wt, c.launch.preapproveMcp);
  } catch (e) {
    ctx.err((e as Error).message);
    ctx.err(`undo: git -C ${shellQuote(clone)} worktree unlock ${shellQuote(wt)} && git -C ${shellQuote(clone)} worktree remove ${shellQuote(wt)} && git -C ${shellQuote(clone)} branch -D ${shellQuote(branch)}`);
    return 1;
  }
  return 0;
}
