import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LanesCtx } from "../ctx.ts";
import { piIn } from "../sessions.ts";

const GIT_MS = 10000;
const AI_WORK = ".ai-work";

interface Git { code: number; out: string }
type Verdict = { ok: true } | { ok: false; why: string };
const left = (why: string): Verdict => ({ ok: false, why });

async function git(ctx: LanesCtx, dir: string, args: string[]): Promise<Git | undefined> {
  try {
    const r = await ctx.run("git", ["-C", dir, ...args], { timeoutMs: GIT_MS });
    return r.timedOut ? undefined : { code: r.code, out: r.stdout };
  } catch { return undefined; }
}
const real = (p: string): string | undefined => { try { return realpathSync(p); } catch { return undefined; } };

/** Paths in `git status --porcelain --ignored` other than .ai-work. */
function foreign(porcelain: string): string[] {
  return porcelain.split("\n").filter((l) => l.trim()).filter((l) => {
    const path = l.slice(3).replace(/^"|"$/g, "");
    return path !== AI_WORK && path !== `${AI_WORK}/` && !path.startsWith(`${AI_WORK}/`);
  });
}

async function isClean(ctx: LanesCtx, cwd: string): Promise<Verdict> {
  const top = await git(ctx, cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const root = top?.code === 0 ? real(top.out.trim()) : undefined;
  if (!root || root !== real(cwd)) return left("worktree root could not be verified");
  const status = await git(ctx, cwd, ["status", "--porcelain", "--ignored"]);
  if (!status || status.code !== 0) return left("git status failed");
  const other = foreign(status.out);
  return other.length ? left(`worktree is dirty (${other.length} path${other.length === 1 ? "" : "s"}, e.g. ${other[0].trim()})`) : { ok: true };
}

async function isMerged(ctx: LanesCtx, clone: string, cwd: string): Promise<Verdict> {
  const head = await git(ctx, clone, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const ref = head?.code === 0 ? head.out.trim() : "";
  if (!ref) return left("default branch unknown");
  const merged = await git(ctx, cwd, ["merge-base", "--is-ancestor", "HEAD", ref]);
  if (!merged) return left("merge check failed");
  if (merged.code === 1) return left("not merged");
  return merged.code === 0 ? { ok: true } : left("merge check failed");
}

async function archive(ctx: LanesCtx, clone: string, cwd: string): Promise<Verdict> {
  const src = join(cwd, AI_WORK);
  if (!existsSync(src)) return { ok: true };
  const base = join(clone, AI_WORK, "keep", "removed-worktrees", basename(cwd));
  const dest = existsSync(base) ? `${base}-${ctx.now().getTime()}` : base;
  const ignored = await git(ctx, clone, ["check-ignore", "-q", dest]);
  if (!ignored || ignored.code !== 0) return left(`archive path is not git-ignored: ${dest}`);
  try { mkdirSync(dirname(dest), { recursive: true }); cpSync(src, dest, { recursive: true, errorOnExist: true, force: false }); }
  catch (error) { return left(`archive of ${AI_WORK} failed: ${(error as Error).message}`); }
  return { ok: true };
}

async function checks(id: string, cwd: string, clone: string, ctx: LanesCtx): Promise<Verdict> {
  if (!existsSync(cwd)) return left("worktree already removed");
  if (await piIn(cwd, ctx)) return left(`${id} is still running`);
  for (const step of [() => isClean(ctx, cwd), () => isMerged(ctx, clone, cwd), () => archive(ctx, clone, cwd)]) {
    const verdict = await step();
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** Removes a merged, clean lane worktree; every doubt leaves it in place. Returns one status line. */
export async function tryRemove(id: string, cwd: string, clone: string | undefined, ctx: LanesCtx): Promise<string> {
  if (!clone) return "worktree left: clone could not be determined";
  const verdict = await checks(id, cwd, clone, ctx);
  if (!verdict.ok) return `worktree left: ${verdict.why}`;
  await git(ctx, clone, ["worktree", "unlock", cwd]);
  const removed = await git(ctx, clone, ["worktree", "remove", cwd]);
  if (removed?.code === 0) return `worktree removed: ${cwd} (${AI_WORK} archived under ${join(clone, AI_WORK, "keep", "removed-worktrees")}; branch kept)`;
  await git(ctx, clone, ["worktree", "lock", "--reason", `lanes ${id}`, cwd]);
  return "worktree left: git refused to remove it (re-locked)";
}
