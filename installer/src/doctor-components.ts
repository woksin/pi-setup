import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMPONENTS, CS_SKILLS } from "./components.ts";
import type { Manifest } from "./manifest.ts";
import { expectedUnit, uid } from "./services.ts";
import type { Ctx } from "./types.ts";
import type { DoctorCheck } from "./doctor.ts";

const check = (id: string, status: DoctorCheck["status"], detail: string, fix?: string): DoctorCheck => ({ id, title: id, status, detail, ...(fix ? { fix } : {}) });

async function isLoaded(ctx: Ctx, kind: "launchd" | "systemd", label: string): Promise<boolean> {
  try {
    const r = kind === "launchd"
      ? await ctx.run("launchctl", ["print", `gui/${uid()}/${label}`], { timeoutMs: 5000 })
      : await ctx.run("systemctl", ["--user", "is-active", label], { timeoutMs: 5000 });
    return r.code === 0 && !r.timedOut;
  } catch { return false; }
}

/** Read-only: asks the service manager for state, never loads, enables or writes anything. Only runs once a choice is recorded. */
export async function componentChecks(ctx: Ctx, manifest: Manifest | undefined): Promise<DoctorCheck[]> {
  const comps = manifest?.components;
  if (!comps) return [];
  const checks: DoctorCheck[] = [];
  for (const def of COMPONENTS.filter((c) => c.service)) {
    const unit = expectedUnit(ctx, def.id);
    if (!unit) continue;
    const id = `service:${def.id}`;
    const rec = comps[def.id];
    const exists = existsSync(unit.file);
    if (rec?.on && rec.service?.managed) {
      const manual = unit.kind === "launchd" ? `launchctl bootstrap gui/${uid()} ${unit.file}` : `systemctl --user enable --now ${unit.label}`;
      checks.push(await isLoaded(ctx, unit.kind, unit.label)
        ? check(id, "ok", `${unit.label} is loaded`)
        : check(id, "warn", `${unit.label} is not loaded`, manual));
    } else if (rec?.on && !rec.service?.managed) {
      checks.push(check(id, "ok", `${unit.file.replace(`${ctx.home}/`, "~/")} is not managed by pi-setup; left alone`));
    } else if (exists) {
      checks.push(check(id, "ok", `${def.id} is turned off but a unit exists at ${unit.file.replace(`${ctx.home}/`, "~/")}; left alone`));
    }
  }
  if (comps.codescene?.on) {
    const dir = join(ctx.home, ".agents/skills");
    const missing = CS_SKILLS.filter((n) => { try { return !statSync(join(dir, n)).isDirectory(); } catch { return true; } });
    checks.push(
      ctx.which("cs-mcp") ? check("codescene-mcp", "ok", "cs-mcp is on PATH")
        : check("codescene-mcp", "warn", "cs-mcp not found on PATH", "install cs-mcp: https://github.com/codescene-oss/codescene-mcp-server#readme"),
      ctx.env.CS_ACCESS_TOKEN ? check("codescene-token", "ok", "CS_ACCESS_TOKEN is set")
        : check("codescene-token", "warn", "CS_ACCESS_TOKEN is not set", "export CS_ACCESS_TOKEN=<your token> in your shell profile (pi-setup never stores it)"),
      missing.length === 0 ? check("codescene-skills", "ok", "CodeScene skills are present")
        : check("codescene-skills", "warn", `CodeScene skills missing: ${missing.join(", ")}`, "copy skills/<name> from https://github.com/codescene-oss/codescene-mcp-server/tree/main/skills to ~/.agents/skills/"),
    );
  }
  return checks;
}
