import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
export interface Watch { label: string; until: string; interval: number; check: string }
export function parseWatches(text: string): Watch[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const [tag, label, until, interval, ...check] = line.split("|");
    if (tag !== "WATCH") return [];
    if (!label || !until || !/^\d+$/.test(interval) || Number(interval) <= 0 || !check.join("|")) throw new Error("invalid WATCH line");
    return [{ label, until, interval: Number(interval), check: check.join("|") }];
  });
}
function chunk(path: string, length: number, position: number): string {
  const fd = openSync(path, "r");
  try { const b = Buffer.alloc(length); return b.subarray(0, readSync(fd, b, 0, length, position)).toString("utf8"); }
  finally { closeSync(fd); }
}
function day(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function liveWatch(jobs: string, watch: Watch, now: Date): boolean {
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  for (const date of [now, yesterday]) {
    const dir = join(jobs, day(date)); let names: string[];
    try { names = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const name of names.filter((n) => n.endsWith(".log"))) {
      const path = join(dir, name); const stat = statSync(path);
      if (!stat.isFile() || !chunk(path, Math.min(4096, stat.size), 0).split("\n")[0].includes(watch.check)) continue;
      const tail = chunk(path, Math.min(65536, stat.size), Math.max(0, stat.size - 65536));
      const last = tail.split("\n").filter((s) => /^--- check .* exit \d+ ---$/.test(s)).at(-1);
      if (watch.until === "success" && /exit 0 ---$/.test(last || "")) continue;
      if (now.getTime() - stat.mtimeMs <= (watch.interval + 90) * 1000) return true;
    }
  }
  return false;
}
