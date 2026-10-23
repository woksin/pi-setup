import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
/** Optional absence is distinct from unreadable or malformed evidence. */
export function optionalText(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`cannot read ${path}`); }
}
export function jsonFiles(dir: string): Record<string, any>[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`cannot read ${dir}`); }
  return names.filter(n => n.endsWith(".json")).map(n => {
    try { const value = JSON.parse(readFileSync(join(dir, n), "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new Error(`cannot read ${join(dir, n)}`); }
  });
}
export function mtime(path: string): number { return statSync(path).mtimeMs; }
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); renameSync(tmp, path);
}
