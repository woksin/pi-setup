import { basename } from "node:path";
import type { LanesCtx } from "../ctx.ts";

export interface ProcessSample { pid: number; ppid: number; command: string; cpuSeconds: number }
/** Explicit work commands; generic node/package-manager processes are not work by themselves. */
export function workCommand(command: string): boolean {
  const words = command.trim().replace(/["']/g, "").split(/\s+/);
  const executable = basename(words[0] || "");
  if (/^(dotnet|msbuild|vstest(?:\.console)?|testhost|cargo|make|gmake|vitest|jest)(?:\.exe)?$/i.test(executable)) return true;
  if (/(?:^|\s)(?:\S*\/)?pi-phase\s+run\b/.test(command)) return true;
  if (/^(node|nodejs|npm|npx|yarn|pnpm)$/.test(executable)) {
    return words.slice(1).some(word => /^(test|build|vitest|jest)(?::[\w-]+)?$/.test(word) || /(?:^|\/)(vitest|jest)(?:\.[cm]?js)?$/.test(word));
  }
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable)) return /\s-m\s+(pytest|unittest)\b/.test(command);
  return executable === "docker" && /\s(?:build|buildx\s+build)\b/.test(command);
}
export function helperKind(command: string): string {
  if (/\binbox-watch\b/.test(command)) return "inbox-watch";
  if (/\bmcp\b|mcp-server|server-mcp/.test(command)) return "mcp";
  if (/\bjob_watch\b|\bwatch\b/.test(command)) return "watch";
  if (/^(?:\S*\/)?-?(?:bash|zsh|sh|fish)(?:\s|$)/.test(command)) return "shell";
  return "other";
}
export function helperCommand(command: string): boolean { return helperKind(command) !== "other"; }
function cpuTime(value: string): number {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  const seconds = clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return Number(days) * 86400 + seconds;
}
export async function processInventory(ctx: LanesCtx): Promise<ProcessSample[]> {
  if (ctx.processInventory) return ctx.processInventory();
  const ps = await ctx.run("ps", ["-A", "-o", "pid=,ppid=,time=,command="], { timeoutMs: 4000 });
  if (ps.code !== 0 || ps.timedOut) throw new Error("process descendants unknown");
  const lines = ps.stdout.trim().split("\n").filter(Boolean);
  if (lines.length > 20000) throw new Error("process descendants inventory too large");
  return lines.map(parseSample);
}
function parseSample(line: string): ProcessSample {
  const match = /^(\d+)\s+(\d+)\s+([\d:.\-]+)\s+(.+)$/.exec(line.trim());
  if (!match) throw new Error("process descendants malformed");
  return { pid: Number(match[1]), ppid: Number(match[2]), cpuSeconds: cpuTime(match[3]), command: match[4] };
}
function descendants(pid: number, inventory: ProcessSample[]): ProcessSample[] {
  const owned = new Set([pid]); let changed = true;
  while (changed) {
    changed = false;
    for (const row of inventory) {
      if (!owned.has(row.ppid) || owned.has(row.pid)) continue;
      owned.add(row.pid); changed = true;
    }
  }
  return inventory.filter(row => row.pid !== pid && owned.has(row.pid));
}
async function ownedPhase(cwd: string, ctx: LanesCtx): Promise<boolean> {
  const phase = ctx.which("pi-phase"); if (!phase) return false;
  const result = await ctx.run(phase, ["status"], { timeoutMs: 4000 });
  if (result.code !== 0 || result.timedOut) throw new Error("pi-phase status unknown");
  // Status includes detached phase groups; ownership is the exact lane worktree (or a subdirectory).
  return result.stdout.split("\n").some(line => {
    const match = / pid=\d+ cwd=(.+) elapsed=\d+s (?:running|orphan-group)\b/.exec(line);
    return match !== null && (match[1] === cwd || match[1].startsWith(cwd + "/"));
  });
}
export async function childWork(pid: number, cwd: string, ctx: LanesCtx): Promise<{ busy: boolean; helpers: string[] }> {
  const children = descendants(pid, await processInventory(ctx));
  const helpers = children.filter(row => !workCommand(row.command)).map(row => helperKind(row.command));
  if (children.some(row => workCommand(row.command)) || await ownedPhase(cwd, ctx)) return { busy: true, helpers };
  if (!children.length) return { busy: false, helpers };
  await (ctx.sleep ? ctx.sleep(1000) : new Promise(done => setTimeout(done, 1000)));
  const second = descendants(pid, await processInventory(ctx));
  // At least 50 ms CPU in the one-second sample window (5% of one core).
  const busy = second.some(row => {
    const before = children.find(first => first.pid === row.pid && first.ppid === row.ppid && first.command === row.command);
    return before !== undefined && row.cpuSeconds - before.cpuSeconds >= 0.05;
  });
  return { busy, helpers };
}
