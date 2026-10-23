import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { backendFor } from "../backend.ts";
import type { Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { liveWatch, parseWatches } from "../joblogs.ts";
async function livePrs(text: string, ctx: LanesCtx): Promise<void> {
  if (!ctx.which("gh")) return;
  const refs = new Set(text.match(/\bPR [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g));
  for (const ref of refs) {
    const [repo, n] = ref.slice(3).split("#"); let state = "unknown";
    const r = await ctx.run("gh", ["pr", "view", n, "--repo", repo, "--json", "state,mergeStateStatus,headRefOid"], { timeoutMs: 30000 });
    if (r.code === 0) {
      try { const p = JSON.parse(r.stdout); state = `${p.state} ${p.mergeStateStatus} ${String(p.headRefOid).slice(0, 9)}`; } catch { /* unknown */ }
    }
    ctx.out(`LIVE    ${ref.slice(3)}: ${state}`);
  }
}
export async function resumeCheck(c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const now = ctx.now(); let bad = false;
  ctx.out(`date: ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
  const watches = join(root, "coordinator/WATCHES.md");
  if (!existsSync(watches)) { ctx.out("MISSING coordinator/WATCHES.md"); bad = true; }
  else for (const w of parseWatches(readFileSync(watches, "utf8"))) {
    if (liveWatch(join(ctx.piAgentDir, "jobs"), w, now)) ctx.out(`OK      watch: ${w.label}`);
    else { ctx.out(`MISSING watch: ${w.label} -> job_watch until=${w.until} interval=${w.interval} check from coordinator/WATCHES.md`); bad = true; }
  }
  const unread = await backendFor(c, ctx, root).unread(c.coordinator.id);
  if (unread === undefined) { ctx.out("MISSING inbox marker: the coordinator inbox watch has not run"); bad = true; }
  else {
    const old = unread.filter((m) => now.getTime() - m.at.getTime() > 300000);
    for (const m of old) ctx.out(`UNREAD  inbox: ${m.name}`);
    if (old.length) bad = true; else ctx.out("OK      inbox: no unread backlog");
  }
  const path = join(root, "coordinator/NOW.md");
  if (!existsSync(path)) { ctx.out("MISSING coordinator/NOW.md"); bad = true; }
  else {
    await livePrs(readFileSync(path, "utf8"), ctx);
    const age = Math.floor((now.getTime() - statSync(path).mtimeMs) / 60000);
    if (age > 90) { ctx.out(`STALE   NOW.md not updated for ${age} min`); bad = true; }
  }
  const questions = join(ctx.piAgentDir, "local-packages/pi-questions/dist/cli.js");
  if (existsSync(questions)) {
    const r = await ctx.run(process.execPath, [questions, "list", "--all"], { timeoutMs: 15000 });
    for (const line of r.stdout.split("\n").filter((s) => /^Q-\d+/.test(s))) ctx.out(`OPEN    ${line}`);
  }
  return bad ? 1 : 0;
}
