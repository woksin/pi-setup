import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { EvidenceContext, Signals } from "./signals.ts";
import type { Lane } from "../config.ts";
import { optionalText } from "./files.ts";

function statusFiles(base: string): string[] {
  const dirs = [base]; const files: string[] = []; let scanned = 0;
  while (dirs.length) {
    const dir = dirs.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    scanned += entries.length;
    if (scanned > 10000) throw new Error(`local claim scan exceeds limit: ${base}`);
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(join(dir, entry.name));
      else if (entry.isFile() && entry.name === "status.md") files.push(join(dir, entry.name));
    }
  }
  return files;
}

function field(text: string, name: string): string | undefined {
  return new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, "mi").exec(text)?.[1].trim().replace(/^`|`$/g, "");
}
function exactOwner(text: string, s: Signals): boolean {
  return field(text, "Session") === s.sessionId || field(text, "SessionId") === s.sessionId
    || [field(text, "Cwd"), field(text, "Worktree")].includes(s.cwd);
}
function issueOwner(text: string, path: string, lane: Lane, base: string): boolean {
  if (!lane.repo || !lane.issue) return false;
  const issue = field(text, "Issue");
  const ref = `${lane.repo}#${lane.issue}`.toLowerCase();
  if (issue?.toLowerCase() === ref) return true;
  if (field(text, "Repo")?.toLowerCase() === lane.repo.toLowerCase() && issue === `#${lane.issue}`) return true;
  return relative(base, path).toLowerCase() === `${lane.repo}/${lane.issue}/status.md`.toLowerCase();
}
export function localClaims(s: Signals, env: EvidenceContext): void {
  const bases = [...new Set([env.root, s.cwd])].map(root => join(root, ".ai-work/issue-work"));
  for (const base of bases) for (const path of statusFiles(base)) {
    const text = optionalText(path)!;
    if (field(text, "State")?.toLowerCase() !== "in-progress") continue;
    if (exactOwner(text, s) || issueOwner(text, path, env.lane, base)) s.keeps.push("in-progress local claim");
    else if (!field(text, "Repo") || field(text, "Repo")?.toLowerCase() === env.lane.repo?.toLowerCase()) {
      s.asks.push("local claim ownership unknown");
    }
  }
}
