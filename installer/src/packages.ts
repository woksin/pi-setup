import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readManifest } from "./manifest.ts";
import { deepEqual } from "./settings.ts";
import type { JsonOp } from "./types.ts";
import type { DoctorCheck } from "./doctor.ts";

/** pi's global npm package store is ~/.pi/agent/npm (npm install --prefix). */
export const PINNED_PACKAGES = [
  { name: "@woksin/pi-jobs", version: "0.3.1" },
  { name: "@woksin/pi-context-budget", version: "0.4.0" },
  { name: "@woksin/pi-recover", version: "0.1.1" },
  { name: "@woksin/pi-orch", version: "0.1.1" },
];
export const PACKAGE_BINS = [
  ["pi-context-budget", "pi-session"], ["pi-orch", "orch"], ["pi-orch", "orch-poll"],
];
export function packageBinLinks(piDir: string, home: string): { path: string; target: string }[] {
  return PACKAGE_BINS.map(([pkg, cmd]) => ({ path: join(home, ".local/bin", cmd), target: join(piDir, "npm/node_modules/@woksin", pkg, "bin", cmd) })).filter(link => existsSync(link.target));
}

/** npm may normalize unrelated dependency ranges; retain only our selected pin edits. */
export function pinnedNpmManifest(before: Buffer, selected: typeof PINNED_PACKAGES): Buffer | undefined {
  let data;
  try { data = JSON.parse(before.toString("utf8")); }
  catch { return; } // Leave invalid manifests to npm, as before preservation was added.
  if (typeof data !== "object") return;
  if (data === null) return;
  if (Array.isArray(data)) return;
  const dependencies = { ...data.dependencies, ...Object.fromEntries(selected.map(p => [p.name, p.version])) };
  if (!selected.length || deepEqual(data.dependencies, dependencies)) return before;
  return Buffer.from(`${JSON.stringify({ ...data, dependencies }, null, 2)}\n`);
}

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

interface PinContext {
  piDir: string;
  fresh: boolean;
  recorded: unknown[];
  keyCreated: boolean;
}
type PackageOp = Exclude<JsonOp, { op: "set" }>;

function pinOperation(list: unknown[], pkg: typeof PINNED_PACKAGES[number], context: PinContext): PackageOp | undefined {
  const source = `npm:${npmSpec(pkg)}`;
  const matches = list.filter(p => refersTo(p, pkg.name, context.piDir));
  const earlier = context.recorded.filter(value => refersTo(value, pkg.name, context.piDir));
  const add: PackageOp = { op: "array-add", key: "packages", value: source, keyCreated: context.keyCreated };
  if (!matches.length) return context.fresh || !earlier.length ? add : undefined;
  if (matches.length !== 1) return;
  const before = matches[0];
  if (before === source) return context.fresh ? add : undefined;
  const managed = [`npm:${pkg.name}`, ...earlier].some(value => deepEqual(value, before));
  if (!managed) return;
  return { op: "array-replace", key: "packages", before, after: source };
}

function recordedPackages(piDir: string): unknown[] {
  return (readManifest(piDir)?.json[".pi/agent/settings.json"]?.ops ?? []).flatMap(op => {
    if (op.key !== "packages") return [];
    return op.op === "array-add" ? [op.value] : op.op === "array-replace" ? [op.after] : [];
  });
}

/** Record individual additions/replacements so uninstall preserves unrelated user edits. */
export function pinPackages(data: Record<string, unknown>, piDir: string, fresh = false): JsonOp[] {
  const recorded = recordedPackages(piDir);
  const original = data.packages;
  const list = Array.isArray(original) ? [...original] : [];
  const ops: JsonOp[] = [];
  const context = { piDir, fresh, recorded, keyCreated: original === undefined };
  for (const pkg of PINNED_PACKAGES) {
    const op = pinOperation(list, pkg, context);
    if (!op) continue;
    if (op.op === "array-add" && !list.includes(op.value)) list.push(op.value);
    if (op.op === "array-replace") list[list.indexOf(op.before)] = op.after;
    ops.push(op);
  }
  if (ops.length) data.packages = list;
  return ops;
}
