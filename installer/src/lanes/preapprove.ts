import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanesCtx } from "./ctx.ts";
export const SUPPORTED_MAJORS = [5];
export async function preapprove(ctx: LanesCtx, cwd: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    ctx.out("MCP preapproval is off; enable with lanes init --preapprove-mcp for a new folder, or set launch.preapproveMcp to true in lanes.json.");
    return;
  }
  const files = [".mcp.json", ".pi/mcp.json"].filter((f) => existsSync(join(cwd, f)));
  if (!files.length) return;
  const skip = (reason: string) => ctx.err(`MCP preapproval skipped: ${reason}; pi will ask once per server when the lane starts.`);
  let reason = "adapter not found";
  try {
    const adapter = join(ctx.piAgentDir, "npm/node_modules/pi-mcp-adapter");
    const pkg = JSON.parse(readFileSync(join(adapter, "package.json"), "utf8"));
    if (!SUPPORTED_MAJORS.includes(Number(String(pkg.version).split(".")[0]))) {
      reason = `adapter ${pkg.version} not supported (supports ${SUPPORTED_MAJORS.join(", ")}.x)`;
      throw new Error(reason);
    }
    reason = "adapter API changed";
    const mod = await ctx.loadModule(join(adapter, "dist/project-server-trust.js"));
    if (typeof mod.approveProjectServer !== "function" || typeof mod.hashProjectServerDefinition !== "function") throw new Error(reason);
    for (const file of files) {
      let servers: Record<string, unknown>;
      try { servers = JSON.parse(readFileSync(join(cwd, file), "utf8")).mcpServers ?? {}; }
      catch { skip(`invalid ${file} (${join(cwd, file)})`); continue; }
      for (const [name, def] of Object.entries(servers)) {
        const hash = await mod.hashProjectServerDefinition(def);
        await mod.approveProjectServer(cwd, name, def);
        ctx.out(`approved ${file} ${name} ${String(hash).slice(0, 12)}`);
      }
    }
  } catch {
    skip(reason);
  }
}
