import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Options } from "./args.ts";
import { collectLanes, type Issue } from "./lanes-wizard.ts";
import { listCheckouts, type Checkout } from "./repos-scan.ts";
import { expandHome, readSettings } from "./settings.ts";
import { CANCEL, SetupError, type Ctx, type Prompter } from "./types.ts";
import { loadConfig } from "./lanes/config.ts";
import { main } from "./lanes/main.ts";
import type { LanesCtx } from "./lanes/ctx.ts";
import { shellQuote } from "./lanes/terminal.ts";
export function lanesCtxFrom(ctx: Ctx): LanesCtx {
  return { home: ctx.home, cwd: ctx.cwd, env: ctx.env, platform: ctx.platform, now: ctx.now, run: ctx.run, which: ctx.which,
    out: ctx.out, err: ctx.err, stdinTTY: ctx.stdinTTY, readStdin: async () => "",
    templatesDir: join(ctx.home, ".local/share/pi-setup/lanes/templates"), piAgentDir: ctx.env.PI_CODING_AGENT_DIR || join(ctx.home, ".pi/agent"),
    loadModule: (path) => import(pathToFileURL(path).href), realpath: realpathSync };
}
async function recentFirst(ctx: Ctx, checkouts: Checkout[]): Promise<Checkout[]> {
  const scored: { checkout: Checkout; time: number }[] = [];
  for (let i = 0; i < checkouts.length; i += 8) {
    scored.push(...await Promise.all(checkouts.slice(i, i + 8).map(async (checkout) => {
      const r = await ctx.run("git", ["-C", checkout.path, "log", "-1", "--format=%ct"], { timeoutMs: 5000 });
      return { checkout, time: r.code === 0 ? Number(r.stdout.trim()) || 0 : 0 };
    })));
  }
  return scored.sort((a, b) => b.time - a.time).map((s) => s.checkout);
}
async function issuesFor(ctx: Ctx, repo: string, user: unknown): Promise<Issue[] | undefined> {
  if (!ctx.which("gh")) return undefined;
  const r = await ctx.run("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", "number,title,assignees"], { timeoutMs: 15000 });
  if (r.code !== 0 || r.timedOut) return undefined;
  try {
    const issues = JSON.parse(r.stdout) as { number: number; title: string; assignees: { login: string }[] }[];
    return issues.length ? issues.map((i) => ({ number: i.number, title: i.title, mine: i.assignees.some((a) => a.login === user) })) : undefined;
  } catch { return undefined; }
}
export async function runLanesFlow(ctx: Ctx, options: Options, p?: Prompter, nested = false): Promise<number> {
  if (!p) {
    ctx.out("pi-setup lanes is interactive; in scripts use lanes init <dir>, lanes --dir <dir> add <ID> --repo owner/name and lanes --dir <dir> start coordinator"); return 1;
  }
  if (!existsSync(join(ctx.home, ".local/share/pi-setup/lanes/lanes.mjs"))) throw new SetupError("lanes is not installed; run ./install.sh --with lanes");
  if (!nested) p.intro("pi-setup lanes");
  const settings = readSettings(join(ctx.home, ".pi/agent/user.json"));
  const reposRoot = typeof settings.reposRoot === "string" ? settings.reposRoot : join(ctx.home, "repos");
  const requestedDir = options.dir ? expandHome(options.dir, ctx.home) : "";
  const dir = requestedDir || join(reposRoot, ".lanes");
  const c = existsSync(join(dir, "lanes.json")) ? loadConfig(dir) : undefined;
  const choice = await collectLanes(p, { dir: requestedDir || undefined, reposRoot, home: ctx.home,
    existingIds: c ? [c.coordinator.id, ...c.lanes.map((l) => l.id)] : ["L0"],
    existingIdsFor: (selected) => {
      if (!existsSync(join(selected, "lanes.json"))) return ["L0"];
      const existing = loadConfig(selected); return ["L0", existing.coordinator.id, ...existing.lanes.map((l) => l.id)];
    },
    checkouts: await recentFirst(ctx, listCheckouts(reposRoot)), issues: (repo) => issuesFor(ctx, repo, settings.githubUser) });
  if (choice === CANCEL) { if (!nested) p.outro("Cancelled."); return 1; }
  const laneCtx = lanesCtxFrom(ctx); const created: string[] = [];
  if (!existsSync(join(choice.dir, "lanes.json")) && await main(["init", choice.dir, "--repos-root", reposRoot], laneCtx) !== 0) return 1;
  for (const lane of choice.lanes) {
    const argv = ["--dir", choice.dir, "add", lane.id, "--repo", lane.repo, "--path", lane.path, ...(lane.issue ? ["--issue", String(lane.issue)] : [`--goal=${lane.goal!}`])];
    if (await main(argv, laneCtx) !== 0) { ctx.err(`Could not create ${lane.id}; created lanes: ${created.join(", ") || "none"}`); return 1; }
    created.push(lane.id);
  }
  const open = await p.confirm({ message: "Open the coordinator now?", initial: true });
  if (p.isCancel(open)) return 1;
  if (open === true && await main(["--dir", choice.dir, "start", "coordinator"], laneCtx) !== 0) return 1;
  p.note(`The coordinator starts lanes with: lanes --dir ${shellQuote(choice.dir)} start ${created[0]}`);
  if (!nested) p.outro("Lanes ready."); return 0;
}
