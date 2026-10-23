import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCratisFile, WEB_PACKAGES } from "./components.ts";
import { saveIfChanged } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { retireFiles, retireSymlinks, revertOps } from "./uninstall.ts";
import type { Step } from "./uninstall.ts";
import { reloadSystemd, unloadLine, unloadService } from "./services.ts";
import type { Ctx } from "./types.ts";

const PI = ".pi/agent/";
const WEB_PACKAGE_OP = (op: { op: string; key: string; value?: unknown }): boolean =>
  op.op === "array-add" && op.key === "packages" && WEB_PACKAGES.includes(op.value as string);

/** Which components were on before this run. Non-services fall back to what an older install already has. */
export function wasOn(manifest: Manifest | undefined, current: Record<string, boolean>, id: string): boolean {
  const saved = manifest?.components?.[id];
  return saved ? saved.on : current[id] === true;
}

/** Packages in settings.json that are web tools pi-setup did not add (no recorded op). */
function leftWebPackages(ctx: Ctx, manifest: Manifest): string[] {
  const path = join(ctx.home, PI, "settings.json");
  if (!existsSync(path)) return [];
  let packages: unknown;
  try {
    packages = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).packages;
  } catch {
    return [];
  }
  const added = new Set((manifest.json[`${PI}settings.json`]?.ops ?? []).filter(WEB_PACKAGE_OP).map((o) => (o as { value: string }).value));
  return Array.isArray(packages) ? WEB_PACKAGES.filter((p) => (packages as unknown[]).includes(p) && !added.has(p)) : [];
}

/**
 * Take back what pi-setup put there for each component that goes from on to off: unchanged files are removed or restored,
 * JSON ops are reverted, services are booted out. Changes you made are left, each with a line.
 * Returns the trimmed manifest, saved before `apply` unless this is a dry run.
 */
export async function retire(
  ctx: Ctx, piDir: string, manifest: Manifest | undefined, off: string[], dryRun: boolean,
): Promise<Manifest | undefined> {
  if (!manifest || off.length === 0) return manifest;
  const m = structuredClone(manifest);
  const steps: Step[] = [];
  const lines: string[] = [];
  const files = (rels: string[]): void => {
    for (const step of retireFiles(ctx, piDir, m, rels)) steps.push(step);
  };
  for (const id of off) {
    const svc = m.components?.[id]?.service;
    if (svc) {
      if (svc.managed) steps.push({ line: unloadLine(svc), run: () => unloadService(ctx, svc) });
      files(svc.files);
      if (svc.managed && svc.kind === "systemd") steps.push({ line: "reload systemd (systemctl --user daemon-reload)", run: () => reloadSystemd(ctx, svc) });
    }
    if (id === "lanes") {
      files(Object.keys(m.files).filter((rel) => rel.startsWith(".local/share/pi-setup/lanes/")));
      steps.push(...retireSymlinks(ctx, m, [".local/bin/lanes"]));
    }
    if (id === "cratis") files(Object.keys(m.files).filter((rel) => rel.startsWith(PI) && isCratisFile(rel.slice(PI.length))));
    if (id === "web") {
      lines.push(...revertOps(ctx, m, `${PI}settings.json`, WEB_PACKAGE_OP, dryRun));
      for (const p of leftWebPackages(ctx, m)) lines.push(`left ${p} in settings.json (not added by pi-setup)`);
    }
    if (id === "codescene") {
      lines.push(...revertOps(ctx, m, `${PI}mcp-adapter.json`, (op) => op.op === "set" && op.key === "mcpServers", dryRun));
    }
    if (m.components?.[id]) m.components[id] = { on: false };
  }
  for (const step of steps) {
    ctx.out(dryRun ? `would ${step.line}` : step.line);
    if (!dryRun) await step.run();
  }
  for (const line of lines) (line.startsWith("left") ? ctx.err : ctx.out)(line);
  if (dryRun) return manifest;
  saveIfChanged(piDir, manifest, m, ctx.now());
  return m;
}
