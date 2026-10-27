import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "./args.ts";
import { localChecks, setupCmd } from "./doctor-checks.ts";
import { gatherFacts } from "./doctor-probes.ts";
import { fileSha, fromHomeRel, readManifest, validateManifest } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { ensurePrereqs } from "./prereqs-run.ts";
import type { Ctx, Detection, Prompter } from "./types.ts";
import { componentChecks } from "./doctor-components.ts";

export { setupCmd } from "./doctor-checks.ts";
export { compactChecks } from "./doctor-compact.ts";
export interface DoctorCheck {
  id: string;
  title: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  fix?: string;
  fixable?: "npm" | "restore" | "chmod" | "prereq";
  items?: string[];
}
export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some(c => c.status === "fail") ? 2 : checks.some(c => c.status === "warn") ? 1 : 0;
}
const counts = (checks: DoctorCheck[]) => {
  const count = (status: DoctorCheck["status"]) => checks.filter(c => c.status === status).length;
  return `${count("ok")} ok, ${count("warn")} warnings, ${count("fail")} failures`;
};
function render(checks: DoctorCheck[]): string[] {
  return checks.filter(c => c.status !== "skip").flatMap(c => {
    const items = c.items?.length ? ` (${c.items.slice(0, 3).join(", ")}${c.items.length > 3 ? ` and ${c.items.length - 3} more` : ""})` : "";
    const line = `${c.status === "ok" ? "✔" : c.status === "warn" ? "⚠" : "✖"} ${c.title}: ${c.detail}${items}`;
    return c.status === "ok" ? [line] : [line, `  fix: ${c.fix}`];
  });
}
async function inspect(ctx: Ctx) {
  let manifest: Manifest | undefined;
  try { manifest = readManifest(join(ctx.home, ".pi/agent")); if (manifest) validateManifest(ctx.home, manifest); } catch { manifest = undefined; }
  const gathered = await gatherFacts(ctx, manifest);
  const local = localChecks(ctx, gathered.facts);
  const extras = await componentChecks(ctx, local.manifest);
  return { ...local, facts: gathered.facts, checks: [...local.checks, ...gathered.checks, ...extras] };
}

export async function runDoctor(ctx: Ctx, options: Options, baseCtx: Ctx, prompter?: Prompter): Promise<number> {
  let report = await inspect(ctx);
  const fixed: string[] = [];
  if (options.fix) {
    const fixable = new Set(report.checks.map(c => c.fixable));
    if (fixable.has("prereq")) {
      const tools = report.checks.filter(c => c.fixable === "prereq" && c.id.startsWith("tool:")).map(c => c.id.slice(5));
      const wantPi = report.checks.some(c => c.fixable === "prereq" && c.id === "pi");
      if (report.checks.some(c => c.fixable === "prereq" && c.id === "gh")) tools.push("gh");
      const result = await ensurePrereqs(ctx, { ...options, yes: false }, prompter, { tools: [...new Set(tools)], pi: wantPi, fresh: false });
      if (result.ran) fixed.push("prereqs");
    }
    if (fixable.has("npm")) {
      const r = await ctx.run("npm", ["install", "--legacy-peer-deps"], { cwd: join(ctx.home, ".pi/agent/npm"), inherit: !options.json, timeoutMs: 120000 });
      if (r.code === 0 && !r.timedOut) fixed.push("npm");
    }
    if (fixable.has("restore") && report.facts.checkoutClean === true && report.facts.head && report.facts.head === report.manifest?.source.commit) {
      const r = await ctx.run(ctx.nodePath ?? process.execPath, [join(ctx.repoDir, "installer/dist/pi-setup.mjs"), "install", "--yes", "--skip-npm"], { inherit: !options.json, timeoutMs: 120000 });
      if (r.code === 0 && !r.timedOut) fixed.push("restore");
    }
    if (fixable.has("chmod") && report.manifest) {
      let changed = false;
      for (const rel of report.modePaths) {
        const path = fromHomeRel(ctx.home, rel);
        const entry = report.manifest.files[rel];
        if (fileSha(path) !== entry.sha256) continue;
        chmodSync(path, entry.mode);
        changed = true;
      }
      if (changed) fixed.push("chmod");
    }
    report = await inspect(ctx);
  }
  const exitCode = doctorExitCode(report.checks);
  if (options.json) baseCtx.out(JSON.stringify({ version: 1, exitCode, checks: report.checks, fixed }));
  else {
    const source = report.manifest?.source;
    ctx.out(`pi-setup doctor — profile ${report.profile || "none"}, installed ${source?.release || source?.commit?.slice(0, 7) || "unknown"}`);
    if (fixed.length) ctx.out(`Fixed: ${fixed.join(", ")}`);
    for (const line of render(report.checks)) ctx.out(line);
    const names = [...new Set(report.checks.map(c => c.fixable).filter(Boolean))];
    ctx.out(`${counts(report.checks)}.${!options.fix && names.length ? ` \`${setupCmd(ctx)} doctor --fix\` can fix: ${names.map(n => n === "prereq" ? "missing tools (asks first; --install-prereqs to skip the question)" : n).join(", ")}.` : ""}`);
    if (exitCode) ctx.out(`Setup defect? Run \`${setupCmd(ctx)} report\` for versions and the reporting repository (https://github.com/woksin/pi-setup/issues).`);
  }
  return exitCode;
}

/** The install already paid for detection: no subprocesses belong in this summary. */
export async function installSummary(ctx: Ctx, detection: Detection, _piDir: string): Promise<string[]> {
  const local = localChecks(ctx, { providers: detection.providers, catalog: detection.catalog, github: detection.github.host ? detection.github : undefined, summary: true });
  const checks = local.checks;
  if (!doctorExitCode(checks)) return [`Doctor: all ${checks.filter(c => c.status === "ok").length} checks passed (full check: \`${setupCmd(ctx)} doctor\`).`];
  return [`Doctor: ${counts(checks)}:`, ...render(checks.filter(c => c.status === "warn" || c.status === "fail")), `Full check: \`${setupCmd(ctx)} doctor\``];
}

/** The same checks as installSummary, for grouping by cause in the guided flow. */
export function installChecks(ctx: Ctx, detection: Detection): DoctorCheck[] {
  return localChecks(ctx, { providers: detection.providers, catalog: detection.catalog, github: detection.github.host ? detection.github : undefined, summary: true }).checks;
}
