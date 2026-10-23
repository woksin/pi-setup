import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "./args.ts";
import { SetupError } from "./types.ts";
import type { Ctx, Prompter } from "./types.ts";

const TAG = /^v\d+(\.\d+)*$/;

/** Numeric dot-segment comparison, so v2026.10.23.10 sorts after v2026.10.23.9. */
export function compareTags(a: string, b: string): number {
  const x = a.slice(1).split(".").map(Number);
  const y = b.slice(1).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function latestTag(tags: string[]): string | undefined {
  return tags.filter((t) => TAG.test(t)).sort(compareTags).at(-1);
}

async function git(ctx: Ctx, args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await ctx.run("git", ["-C", ctx.repoDir, ...args], { timeoutMs });
  return { ok: r.code === 0, out: r.stdout.trim(), err: (r.stderr || r.stdout).trim() };
}

export async function remoteTags(ctx: Ctx, timeoutMs = 30000): Promise<string[]> {
  const r = await git(ctx, ["ls-remote", "--tags", "--refs", "origin", "v*"], timeoutMs);
  if (!r.ok) throw new SetupError(`git ls-remote failed: ${r.err}`);
  return r.out.split("\n").map((l) => l.split("\trefs/tags/")[1]).filter((t): t is string => Boolean(t));
}

async function pickTarget(ctx: Ctx, options: Options): Promise<string> {
  if (options.dryRun) {
    if (options.ref) return options.ref;
    const tag = latestTag(await remoteTags(ctx));
    if (!tag) throw new SetupError("no v* release tags found on origin");
    return tag;
  }
  const fetched = await git(ctx, ["fetch", "--tags", "--quiet", "origin"], 60000);
  if (!fetched.ok) throw new SetupError(`git fetch failed: ${fetched.err}`);
  let target = options.ref;
  if (!target) {
    const listed = await git(ctx, ["tag", "--list", "v*"]);
    target = latestTag(listed.out.split("\n").filter(Boolean)) ?? "";
    if (!target) throw new SetupError("no v* release tags found");
  }
  if (!(await git(ctx, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`])).ok) {
    throw new SetupError(`unknown ref '${target}'`);
  }
  return target;
}

async function releaseNotes(ctx: Ctx, tag: string): Promise<void> {
  if (!TAG.test(tag) || !ctx.which("gh")) return;
  const r = await ctx.run("gh", ["release", "view", tag, "--json", "name,body", "--jq", '.name + "\n\n" + .body'], { cwd: ctx.repoDir, timeoutMs: 15000 });
  if (r.code === 0 && r.stdout.trim()) ctx.out(r.stdout.trim());
}

export async function runUpdate(ctx: Ctx, options: Options, prompter: Prompter | undefined): Promise<number> {
  if (!existsSync(join(ctx.repoDir, ".git"))) throw new SetupError("update needs a git checkout of pi-setup");
  const status = await git(ctx, ["status", "--porcelain"]);
  if (!status.ok) throw new SetupError(`git status failed: ${status.err}`);
  if (status.out) throw new SetupError("checkout has local changes; commit or stash them first");
  const target = await pickTarget(ctx, options);
  const current = (await git(ctx, ["describe", "--tags", "--always"])).out || "unknown";
  ctx.out(`pi-setup: ${current} → ${target}`);
  await releaseNotes(ctx, target);
  if (options.dryRun) {
    ctx.out(`would check out ${target} and run install`);
    return 0;
  }
  if (prompter) {
    const answer = await prompter.confirm({ message: `Check out ${target} and install?`, initial: true });
    if (prompter.isCancel(answer) || answer !== true) {
      ctx.err("Cancelled; nothing changed.");
      return 1;
    }
  }
  const checkout = await git(ctx, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", target], 60000);
  if (!checkout.ok) throw new SetupError(`git checkout ${target} failed: ${checkout.err}`);
  ctx.out(`checkout is detached at ${target}; \`git switch main\` to go back`);
  const args = [join(ctx.repoDir, "installer", "dist", "pi-setup.mjs"), "install"];
  if (options.yes || !prompter) args.push("--yes");
  if (options.skipNpm) args.push("--skip-npm");
  const result = await ctx.run(ctx.nodePath ?? process.execPath, args, { inherit: true });
  return result.code ?? 1;
}
