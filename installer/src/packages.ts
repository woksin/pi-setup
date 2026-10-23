import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JsonOp } from "./types.ts";
import type { DoctorCheck } from "./doctor.ts";

/** pi's global npm package store is ~/.pi/agent/npm (npm install --prefix). */
export const PINNED_PACKAGES = [
  { name: "@woksin/pi-jobs", version: "0.3.1" },
  { name: "@woksin/pi-context-budget", version: "0.3.0" },
  { name: "@woksin/pi-recover", version: "0.1.1" },
  { name: "@woksin/pi-orch", version: "0.1.0" },
];
export const PACKAGE_BINS = [
  ["pi-context-budget", "pi-session"], ["pi-orch", "orch"], ["pi-orch", "orch-poll"],
];
export const npmSpec = (pkg: { name: string; version: string }): string => `${pkg.name}@${pkg.version}`;
function readPackage(path: string): { name?: string; version?: string } {
  try { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")); }
  catch { return {}; }
}
export const packageVersion = (piDir: string, name: string): string | undefined => readPackage(join(piDir, "npm/node_modules", name)).version;

export function selectedPins(piDir: string): typeof PINNED_PACKAGES {
  const settings = JSON.parse(readFileSync(join(piDir, "settings.json"), "utf8"));
  return PINNED_PACKAGES.filter(p => settings.packages?.includes(`npm:${npmSpec(p)}`));
}
export const pinsMissing = (piDir: string, selected: typeof PINNED_PACKAGES): boolean => selected.some(p => packageVersion(piDir, p.name) !== p.version);

export function npmPackageCheck(spec: string, piDir: string): DoctorCheck | undefined {
  const full = spec.slice(4);
  const at = full.indexOf("@", 1);
  const name = at < 0 ? full : full.slice(0, at);
  const expected = at < 0 ? "" : full.slice(at + 1);
  const version = packageVersion(piDir, name);
  const wrongVersion = /^\d+\.\d+\.\d+$/.test(expected) && version !== expected;
  if (version && !wrongVersion) return undefined;
  const id = `package:${name}`;
  const detail = version ? `${spec}: installed ${version}, expected ${expected}` : `${spec} is missing`;
  return { id, title: id, status: PINNED_PACKAGES.some(p => p.name === name) ? "fail" : "warn", detail, fix: `pi install ${spec}` };
}

function packageSource(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "object" && value !== null && "source" in value && typeof value.source === "string" ? value.source : "";
}
function refersTo(value: unknown, name: string, piDir: string): boolean {
  const source = packageSource(value);
  if (source === `npm:${name}` || source.startsWith(`npm:${name}@`)) return true;
  if (source.endsWith(`/local-packages/${name.split("/")[1]}`)) return true;
  if (!source || source.includes(":")) return false;
  const path = source.startsWith("~/") ? resolve(piDir, "../..", source.slice(2)) : resolve(piDir, source);
  return readPackage(path).name === name;
}

/** Record individual additions/replacements so uninstall preserves unrelated user edits. */
export function pinPackages(data: Record<string, unknown>, piDir: string): JsonOp[] {
  const original = data.packages;
  const list = Array.isArray(original) ? [...original] : [];
  const ops: JsonOp[] = [];
  for (const pkg of PINNED_PACKAGES) {
    const source = `npm:${npmSpec(pkg)}`;
    const matches = list.filter(p => refersTo(p, pkg.name, piDir));
    if (!matches.length) {
      list.push(source);
      ops.push({ op: "array-add", key: "packages", value: source, keyCreated: original === undefined });
    } else if (matches.length === 1 && matches[0] === `npm:${pkg.name}`) {
      const before = matches[0];
      list[list.indexOf(before)] = source;
      ops.push({ op: "array-replace", key: "packages", before, after: source });
    }
  }
  if (ops.length) data.packages = list;
  return ops;
}
