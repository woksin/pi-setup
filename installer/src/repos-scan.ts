import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "./types.ts";

export interface Candidate {
  path: string;
  score: number;
}

const NAMES = ["repos", "src", "code", "dev", "projects", "git", "work", "source"];
const SKIP = new Set(["Library", "node_modules", ".Trash"]);

function originUrl(gitDir: string): string {
  try {
    const config = readFileSync(join(gitDir, "config"), "utf8");
    const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    return /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * One point per checkout directly below the folder (<root>/<repo>) and per checkout one level further down
 * (<root>/<org>/<repo>), one more when its origin belongs to the user or an org.
 */
export function scoreCandidate(
  path: string,
  owners: string[],
  options: { maxChildren: number; expired: () => boolean },
): number {
  const names = owners.filter(Boolean).map(escapeRegExp);
  const owned = names.length ? new RegExp(`[:/](${names.join("|")})/`, "i") : undefined;
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((name) => !SKIP.has(name)).slice(0, options.maxChildren);
    } catch {
      return [];
    }
  };
  const points = (dir: string): number => {
    const git = join(dir, ".git");
    return 1 + (owned && statSync(git).isDirectory() && owned.test(originUrl(git)) ? 1 : 0);
  };
  let score = 0;
  let budget = options.maxChildren * 4;
  for (const name of list(path)) {
    if (options.expired()) break;
    const child = join(path, name);
    if (isCheckout(child)) {
      score += points(child);
      continue;
    }
    for (const grand of list(child)) {
      if (options.expired() || budget-- <= 0) break;
      if (isCheckout(join(child, grand))) score += points(join(child, grand));
    }
  }
  return score;
}

export function scanRoots(
  candidates: string[],
  owners: string[],
  options: { now: () => number; deadlineMs?: number; maxChildren?: number },
): Candidate[] {
  const deadline = options.now() + (options.deadlineMs ?? 1500);
  const expired = () => options.now() > deadline;
  const seen = new Set<string>();
  const scored: Candidate[] = [];
  for (const path of candidates) {
    if (seen.has(path) || expired()) continue;
    seen.add(path);
    scored.push({ path, score: scoreCandidate(path, owners, { maxChildren: options.maxChildren ?? 500, expired }) });
  }
  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

export async function candidateRoots(ctx: Ctx): Promise<string[]> {
  const list: string[] = [];
  const common = await ctx.run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ctx.repoDir, timeoutMs: 3000,
  });
  // The templates expect <root>/<org>/<repo>, so the installer's own checkout implies the grandparent.
  if (common.code === 0 && common.stdout.trim()) list.push(dirname(dirname(dirname(common.stdout.trim()))));
  list.push(...NAMES.map((n) => join(ctx.home, n)));
  if (ctx.platform === "darwin") {
    let volumes: string[] = [];
    try {
      volumes = readdirSync("/Volumes");
    } catch {
      volumes = [];
    }
    for (const volume of volumes) list.push(...NAMES.map((n) => join("/Volumes", volume, n)));
  }
  return list;
}
