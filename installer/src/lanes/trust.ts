import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { expand, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import type { laneTarget } from "./sessions.ts";

const PROJECT_FILES = [".pi/settings.json", ".pi/mcp.json", ".pi/extensions", ".pi/skills", ".pi/prompts", ".pi/themes",
  ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md", ".agents/skills"];
/** True only for a lanes-created worktree of a lane repo, and only when the folder opted in. Fails closed. */
export function approveProjectTrust(c: Config, root: string, target: ReturnType<typeof laneTarget>, ctx: LanesCtx): boolean {
  try {
    const lane = target.lane;
    if (c.launch.approveProjectTrust !== true || target.coordinator || !lane || lane.retired) return false;
    if (!lane.repo || lane.cwd !== undefined) return false;
    const base = ctx.realpath(expand(c.worktreesDir, c, root, ctx.home));
    const expected = join(base, lane.worktree), actual = ctx.realpath(target.cwd);
    return actual === expected && actual.startsWith(base + sep);
  } catch { return false; }
}
/** Whether the worktree carries project-local pi files that make pi ask for trust. */
export function hasProjectFiles(cwd: string): boolean {
  return PROJECT_FILES.some(f => existsSync(join(cwd, f)));
}
