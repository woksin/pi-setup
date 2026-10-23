import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Porcelain -z keeps spaces, quotes, newlines and rename sources unambiguous. */
export function changedPaths(status: string): string[] {
  const records = status.split("\0"); const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    if (!/^[ MADRCU?!]{2} /.test(record)) throw new Error("git status paths unknown");
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2))) paths.push(renameSource(records[++i]));
  }
  return [...new Set(paths)].sort();
}
function renameSource(path: string | undefined): string {
  if (!path) throw new Error("git rename source unknown"); return path;
}
function below(cwd: string, path: string): string {
  const full = resolve(cwd, path); const rel = relative(cwd, full);
  if (!rel) throw new Error("git path outside worktree");
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("git path outside worktree"); return full;
}
function contents(path: string): Buffer | string {
  let stat;
  try { stat = lstatSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "<missing>"; throw e; }
  if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
  if (!stat.isFile()) throw new Error("dirty directory/submodule contents unknown");
  return Buffer.concat([Buffer.from(`mode:${stat.mode}:`), readFileSync(path)]);
}
export function treeDigest(input: { cwd: string; paths: string[]; status: string; diff: string }): string {
  const hash = createHash("sha256").update(input.status).update(input.diff);
  for (const path of input.paths) hash.update(JSON.stringify(path)).update(contents(below(input.cwd, path)));
  return hash.digest("hex");
}
export function commitList(text: string): string[] {
  const commits = text.trim().split(/\s+/).filter(Boolean);
  if (!commits.every(sha => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error("unpushed commits unknown");
  return commits;
}
