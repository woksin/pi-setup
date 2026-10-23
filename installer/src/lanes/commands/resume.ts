import { join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { laneDir, effectiveParent, saveConfig, validate, UsageError, type Lane } from "../config.ts";
import { validId } from "../names.ts";
import { readContext, type Snapshot } from "../reap/context-format.ts";
import type { CommandEnv } from "../reap/signals.ts";
import { changedPaths, treeDigest } from "../reap/tree.ts";
import { requireProbe } from "../reap/process.ts";
import { start } from "./start.ts";

type Options = Record<string, string>;
export async function startCommand(id: string, opts: Options, env: CommandEnv): Promise<number> {
  if (opts["from-handoff"]) return fromHandoff({ id, opts }, env);
  return start(id, opts, env.c, env.root, env.ctx);
}
export async function resume(args: string[], opts: Options, env: CommandEnv): Promise<number> {
  return fromHandoff({ id: args[0], opts: { ...opts, "from-handoff": args[0] } }, env);
}
function filePath(value: string, env: CommandEnv): string {
  return env.c.lanes.some(lane => lane.id === value) ? join(env.root, ".state/handoffs", `${value}.md`)
    : resolve(env.ctx.cwd, value);
}
function sourceLane(snapshot: Snapshot, env: CommandEnv): Lane {
  const { c, ctx, root } = env;
  const lanes = c.lanes.filter(lane => lane.repo === snapshot.repo && lane.branch === snapshot.branch);
  const source = lanes.find(lane => ctx.realpath(laneDir(lane, c, root, ctx)) ===
    ctx.realpath(snapshot.worktree));
  if (!source) throw new UsageError("handoff does not match a configured lane worktree"); return source;
}
function restoreLane(input: { id: string; path: string; source: Lane }, env: CommandEnv): Lane {
  const { c } = env; const { id, path, source } = input;
  validateTarget({ id, source }, env);
  return { ...source, id, prompt: path, retired: false, parent: activeParent(source, env) };
}
function validateTarget({ id, source }: { id: string; source: Lane }, { c }: CommandEnv): void {
  if (!validId(id) || [c.coordinator.id, "ALL", c.messages.broadcast].includes(id)) {
    throw new UsageError("invalid lane id");
  }
  if (id !== source.id && c.lanes.some(lane => lane.id === id)) throw new UsageError("resume target lane already exists");
}
function activeParent(source: Lane, { c }: CommandEnv): string {
  const parent = effectiveParent(source, c);
  if (parent === c.coordinator.id) return parent;
  if (c.lanes.some(lane => lane.id === parent && !lane.retired)) return parent;
  return c.coordinator.id;
}

async function verifyWorktree(snapshot: Snapshot, env: CommandEnv): Promise<void> {
  requireWorktree(snapshot.worktree);
  const head = await env.ctx.run("git", ["--no-optional-locks", "-C", snapshot.worktree, "rev-parse", "HEAD"],
    { timeoutMs: 4000 });
  if (head.code || head.timedOut) throw new Error("handoff HEAD changed");
  if (head.stdout.trim() !== snapshot.head) throw new Error("handoff HEAD changed");
  await warnDirtyDrift(snapshot, env);
}
async function dirtyTree(snapshot: Snapshot, { ctx }: CommandEnv): Promise<{ paths: string[]; digest: string }> {
  const args = ["--no-optional-locks", "-C", snapshot.worktree];
  const status = await ctx.run("git", [...args, "status", "--porcelain=v1", "--untracked-files=all", "-z"], { timeoutMs: 4000 });
  requireProbe(status, "dirty paths unavailable");
  const diff = await ctx.run("git", [...args, "diff", "--binary", "HEAD"], { timeoutMs: 4000 });
  requireProbe(diff, "dirty digest unavailable");
  const paths = changedPaths(status.stdout);
  return { paths, digest: treeDigest({ cwd: snapshot.worktree, paths, status: status.stdout, diff: diff.stdout }) };
}
async function warnDirtyDrift(snapshot: Snapshot, env: CommandEnv): Promise<void> {
  try {
    const current = await dirtyTree(snapshot, env);
    if (JSON.stringify(current.paths) !== JSON.stringify([...snapshot.paths].sort())) {
      env.ctx.err("Warning: handoff dirty paths changed; continuing with the preserved worktree");
    }
    if (current.digest !== snapshot.digest) {
      env.ctx.err("Warning: handoff dirty digest changed or missing; continuing with the preserved worktree");
    }
  } catch (e) {
    env.ctx.err(`Warning: could not compare handoff dirty paths/digest: ${(e as Error).message}; continuing`);
  }
}
async function fromHandoff(input: { id: string; opts: Options }, env: CommandEnv): Promise<number> {
  const { c, root, ctx } = env;
  const path = filePath(input.opts["from-handoff"], env); const file = readContext(path);
  const source = sourceLane(file.snapshot, env); await verifyWorktree(file.snapshot, env);
  const restored = restoreLane({ id: input.id, path, source }, env);
  const lanes = c.lanes.filter(lane => lane.id !== input.id).concat(restored); const next = { ...c, lanes };
  validate(next, root, ctx.home);
  const opts = { ...input.opts }; delete opts["from-handoff"];
  const code = await start(input.id, opts, next, root, ctx);
  if (code === 0) { saveConfig(root, next); c.lanes = lanes; }
  return code;
}

function requireWorktree(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("handoff worktree missing");
}
