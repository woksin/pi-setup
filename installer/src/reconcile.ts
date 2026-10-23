import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSha, homeRel } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import type { Action, Ctx } from "./types.ts";

export type KeepAction = Extract<Action, { op: "keep" }>;

export interface Reconciled {
  actions: Action[];
  /** The `keep` actions, in plan order; interactive runs may turn some into `take`. */
  conflicts: KeepAction[];
}

function newVersionNeedsWrite(newPath: string, content: Buffer): boolean {
  return !(existsSync(newPath) && readFileSync(newPath).equals(content));
}

/**
 * Decide, per file, between installing silently and keeping the user's version:
 * a file that still matches what pi-setup installed is updated; one the user changed is kept.
 * user.json merges and the settings.json registration are never conflicts.
 */
export function reconcile(actions: Action[], manifest: Manifest | undefined, home: string): Reconciled {
  const conflicts: KeepAction[] = [];
  const out = actions.map((action): Action => {
    if (action.op !== "install" || action.merge) return action;
    if (!action.existed || !existsSync(action.path)) return { ...action, decision: "new" };
    const entry = manifest?.files[homeRel(home, action.path)];
    if (!action.noMarkers) {
      if (!entry) return { ...action, decision: "replace" };
      if (fileSha(action.path) === entry.sha256) return { ...action, decision: "update" };
    }
    const newPath = `${action.path}.pi-setup-new`;
    const keep: KeepAction = {
      op: "keep", path: action.path, newPath, content: action.content, mode: action.mode, mtimeMs: action.mtimeMs,
      write: newVersionNeedsWrite(newPath, action.content),
      ...(action.noMarkers ? { noMarkers: true } : {}),
    };
    conflicts.push(keep);
    return keep;
  });
  return { actions: out, conflicts };
}

/** Turn the conflicts the user chose "take the new version" for back into installs. */
export function applyTakes(actions: Action[], takes: Set<string>): Action[] {
  return actions.map((a): Action =>
    a.op === "keep" && takes.has(a.path)
      ? { op: "install", path: a.path, content: a.content, mode: a.mode, mtimeMs: a.mtimeMs, existed: true, decision: "take" }
      : a);
}

const DIFF_LINES = 200;

/** Unified diff of the user's file against the new version, capped. */
export async function diffText(ctx: Ctx, conflict: KeepAction): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pisetup-diff."));
  try {
    const tmp = join(dir, "new");
    writeFileSync(tmp, conflict.content);
    const result = await ctx.run("diff", ["-u", conflict.path, tmp], { timeoutMs: 10000 });
    if (result.code === null || result.code > 1) return `(diff is not available; the new version is in ${conflict.newPath})`;
    const lines = result.stdout.split("\n");
    if (lines.length <= 1) return "(no differences)";
    return lines.slice(0, DIFF_LINES).join("\n") + (lines.length > DIFF_LINES ? `\n… ${lines.length - DIFF_LINES} more lines` : "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
