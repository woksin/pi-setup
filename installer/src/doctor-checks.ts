import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PACKAGE_BINS, npmPackageCheck } from "./packages.ts";
import { installCommand } from "./prereqs.ts";
import { missingBinDirs, pathFixCommand, shellPath } from "./shell-path.ts";
import { fileSha, fromHomeRel, symlinkTarget, readManifest, validateManifest } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { chooseProfile, loadProfiles, overlayFor } from "./profiles.ts";
import { buildPlan } from "./plan.ts";
import { resolveSettings } from "./settings.ts";
import { homeRel } from "./manifest.ts";
import { PROVIDER_LABELS } from "./types.ts";
import type { Ctx, GithubState, ProviderState } from "./types.ts";
import type { DoctorCheck } from "./doctor.ts";

export interface DoctorFacts {
  providers: Record<string, ProviderState>;
  catalog: Set<string> | null;
  head?: string;
  checkoutClean?: boolean;
  github?: GithubState;
  summary: boolean;
}
interface Pin { model: string; agents: { name: string; fallback: boolean }[] }
interface State {
  ctx: Ctx; facts: DoctorFacts; piDir: string; setup: string;
  manifest?: Manifest; manifestError?: string; profile: string;
  settings: Record<string, unknown>; pins: Pin[];
  missing: string[]; changed: string[]; modes: string[];
}

export function setupCmd(ctx: Ctx): string {
  if (ctx.which("pi-setup")) return "pi-setup";
  if (ctx.cwd === ctx.repoDir) return "./install.sh";
  const path = join(ctx.repoDir, "install.sh");
  return path.startsWith(`${ctx.home}/`) ? `~/${path.slice(ctx.home.length + 1)}` : path;
}

/** Only named, non-secret configuration files are read here. */
export function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}
const text = (path: string): string => { try { return readFileSync(path, "utf8").trim(); } catch { return ""; } };
const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };
const providerStatus = (s: State, model: string) => s.facts.providers[model.split("/")[0]]?.status;
const ready = (s: State, model: string): boolean => providerStatus(s, model) === "ready";
const check = (id: string, status: DoctorCheck["status"], detail: string, fix?: string, items?: string[]): DoctorCheck => ({ id, title: id, status, detail, ...(fix ? { fix } : {}), ...(items?.length ? { items } : {}) });

function livePins(piDir: string, settings: Record<string, unknown>): Pin[] {
  const pins = new Map<string, Pin["agents"]>();
  const dir = join(piDir, "agents");
  if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => f.endsWith(".md"))) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text(join(dir, file)))?.[1] ?? "";
    const model = /^model:\s*(\S+)/m.exec(front)?.[1];
    if (!model) continue;
    const extensions = /^extensions:\s*([^\n]*(?:\n[ \t]+[^\n]*)*)/m.exec(front)?.[1] ?? "";
    const agents = pins.get(model) ?? [];
    agents.push({ name: basename(file, ".md"), fallback: /\bprovider-fallback\b/.test(extensions) });
    pins.set(model, agents);
  }
  if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
    const model = `${settings.defaultProvider}/${settings.defaultModel}`;
    pins.set(model, [...(pins.get(model) ?? []), { name: "settings.json", fallback: true }]);
  }
  return [...pins].map(([model, agents]) => ({ model, agents }));
}

function state(ctx: Ctx, facts: DoctorFacts): State {
  const piDir = join(ctx.home, ".pi", "agent");
  const s: State = { ctx, facts, piDir, setup: setupCmd(ctx), profile: text(join(piDir, "profiles/ACTIVE")), settings: readJson(join(piDir, "settings.json")) ?? {}, pins: [], missing: [], changed: [], modes: [] };
  try {
    s.manifest = readManifest(piDir);
    if (s.manifest) validateManifest(ctx.home, s.manifest);
  } catch (error) { s.manifest = undefined; s.manifestError = (error as Error).message; }
  s.pins = livePins(piDir, s.settings);
  for (const [rel, entry] of Object.entries(s.manifest?.files ?? {})) {
    const path = fromHomeRel(ctx.home, rel);
    if (!present(path)) s.missing.push(rel);
    else if (fileSha(path) !== entry.sha256) s.changed.push(rel);
    else if ((lstatSync(path).mode & 0o7777) !== entry.mode) s.modes.push(rel);
  }
  for (const [rel, link] of Object.entries(s.manifest?.symlinks ?? {})) {
    const path = fromHomeRel(ctx.home, rel);
    try {
      if (!lstatSync(path).isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== symlinkTarget(ctx.home, link.target)) s.missing.push(rel);
    } catch { s.missing.push(rel); }
  }
  return s;
}

function firstInstall(s: State): DoctorCheck {
  try {
    const settings = resolveSettings({ flagUser: "", flagRoot: "", saved: readJson(join(s.piDir, "user.json")) ?? {}, home: s.ctx.home, repoDir: s.ctx.repoDir, readOnly: true });
    const profiles = loadProfiles(s.ctx.repoDir);
    const profile = profiles.some(p => p.name === s.profile) ? s.profile : chooseProfile(new Set(Object.keys(s.facts.providers).filter(p => ready(s, `${p}/`))), profiles).name;
    const actions = buildPlan({ repoDir: s.ctx.repoDir, home: s.ctx.home, settings, overlay: overlayFor(s.ctx.repoDir, profile, settings), which: s.ctx.which });
    const overwritten = actions.filter(a => a.op === "install" && a.existed && !a.merge && !a.noMarkers).map(a => homeRel(s.ctx.home, a.path));
    return check("files", "warn", `no install manifest; first install would overwrite ${overwritten.length} differing files (using saved/default settings and ${profile} profile)`, s.setup, overwritten);
  } catch (error) {
    return check("files", "warn", `no install manifest; cannot preview first-install overwrites: ${(error as Error).message}`, s.setup);
  }
}

function files(s: State): DoctorCheck {
  if (!existsSync(s.piDir)) return check("files", "fail", "not installed", s.setup);
  if (s.manifestError) return check("files", "fail", s.manifestError, s.setup);
  if (!s.manifest) return firstInstall(s);
  const moved = s.manifest.source.commit && s.facts.head && s.manifest.source.commit !== s.facts.head;
  let detail = `${s.missing.length} missing, ${s.changed.length} changed by you`;
  if (moved) detail += `; checkout is at ${s.facts.head!.slice(0, 7)}, installed ${s.manifest.source.commit!.slice(0, 7)}; the checkout moved since the install; this would also update`;
  const restorable = s.missing.length > 0 && s.facts.checkoutClean === true && Boolean(s.facts.head) && s.facts.head === s.manifest.source.commit;
  return { ...check("files", s.missing.length ? "fail" : moved ? "warn" : "ok", detail, s.missing.length && s.facts.checkoutClean === false ? "commit or stash local changes, then rerun" : s.setup, s.missing.length ? s.missing : s.changed), ...(restorable ? { fixable: "restore" as const } : {}) };
}
function pending(s: State): DoctorCheck {
  const paths = [...new Set([...Object.values(s.manifest?.files ?? {}).flatMap(e => e.pending ? [e.pending.path] : []), ...Object.keys(s.manifest?.pendingNew ?? {})])].filter(p => existsSync(fromHomeRel(s.ctx.home, p)));
  const first = paths[0] && fromHomeRel(s.ctx.home, paths[0]);
  return check("pending", paths.length ? "warn" : "ok", `${paths.length} pending .pi-setup-new files`, first ? `diff ${first.replace(/\.pi-setup-new$/, "")} ${first}` : undefined, paths);
}
function modes(s: State): DoctorCheck {
  return { ...check("modes", s.modes.length ? "warn" : "skip", `${s.modes.length} unchanged files have mode drift`, `${s.setup} doctor --fix`, s.modes), ...(s.modes.length ? { fixable: "chmod" as const } : {}) };
}
function npm(s: State): DoctorCheck[] {
  const pkg = readJson(join(s.piDir, "npm/package.json"));
  const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? Object.keys(pkg.dependencies) : [];
  const installed = (name: string) => existsSync(join(s.piDir, "npm/node_modules", name, "package.json"));
  const missing = deps.filter(n => !installed(n));
  const result: DoctorCheck[] = [{ ...check("npm", missing.length ? "fail" : "ok", missing.length ? `${missing.length} missing dependencies` : "dependencies present", "(cd ~/.pi/agent/npm && npm install --legacy-peer-deps)", missing), ...(missing.length ? { fixable: "npm" as const } : {}) }];
  for (const spec of packages(s)) {
    if (spec.startsWith("npm:")) {
      const finding = npmPackageCheck(spec, s.piDir);
      if (finding) result.push(finding);
    } else if (spec.startsWith(".") && !existsSync(resolve(s.piDir, spec))) result.push(check(`package:${spec}`, "warn", "local package is missing", `edit ~/.pi/agent/settings.json`));
  }
  return result;
}
const packages = (s: State): string[] => Array.isArray(s.settings.packages) ? s.settings.packages.filter((p): p is string => typeof p === "string") : [];
function profile(s: State): DoctorCheck {
  if (!s.profile) return check("profile", "warn", "no ACTIVE profile", `${s.setup} --profile auto`);
  const meta = loadProfiles(s.ctx.repoDir).find(p => p.name === s.profile);
  if (!meta) return check("profile", "warn", `unknown profile ${s.profile}`, `${s.setup} --profile auto`);
  const missing = meta.requires.filter(p => s.facts.providers[p]?.status === "not_ready");
  if (missing.length) return check("profile", "fail", `${s.profile}: ${missing.map(p => PROVIDER_LABELS[p] ?? p).join(", ")} has no login`, `run \`pi\`, type /login and choose ${PROVIDER_LABELS[missing[0]] ?? missing[0]}`);
  const unknown = meta.requires.filter(p => s.facts.providers[p]?.status !== "ready");
  if (unknown.length) return check("profile", "warn", `${unknown.map(p => PROVIDER_LABELS[p] ?? p).join(", ")}: could not check (pi auth check timed out)`, `${s.setup} doctor`);
  return check("profile", "ok", `${s.profile}; ready: ${Object.keys(s.facts.providers).filter(p => ready(s, `${p}/`)).map(p => PROVIDER_LABELS[p] ?? p).join(", ")}`);
}
function providers(s: State): DoctorCheck[] {
  return Object.entries(s.facts.providers).filter(([, provider]) => provider.status === "unknown").map(([id]) => check(`provider:${id}`, "warn", `${PROVIDER_LABELS[id] ?? id}: could not determine`, `${s.setup} doctor`));
}
function models(s: State): DoctorCheck {
  if (!s.facts.catalog?.size) {
    if (s.facts.summary || !Object.values(s.facts.providers).some(p => p.status === "ready")) return check("models", "skip", "catalog not checked");
    return check("models", "fail", "pi lists no models", "pi update");
  }
  const missing = s.pins.filter(p => ready(s, p.model) && !s.facts.catalog!.has(p.model)).map(p => p.model);
  return check("models", missing.length ? "fail" : "ok", missing.length ? "pins missing from catalog" : "available pins are in the catalog", "pi update", missing);
}
function fallback(s: State): DoctorCheck[] {
  const config = readJson(join(s.piDir, "provider-fallback.json")) ?? {};
  const pairs = Array.isArray(config.pairs) ? config.pairs.filter((p): p is string[] => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === "string")) : [];
  const chains = config.chains && typeof config.chains === "object" ? config.chains as Record<string, unknown> : {};
  const targets = (pin: string): string[] => Array.isArray(chains[pin]) ? (chains[pin] as unknown[]).filter((v): v is string => typeof v === "string") : pairs.filter(p => p.includes(pin)).map(p => p[0] === pin ? p[1] : p[0]);
  const available = (pin: string) => ready(s, pin) && (!s.facts.catalog?.size || s.facts.catalog.has(pin));
  const result: DoctorCheck[] = [];
  for (const pin of s.pins.filter(p => providerStatus(s, p.model) === "not_ready")) {
    const target = targets(pin.model).find(available);
    const safe = config.enabled === true && target && pin.agents.every(a => a.fallback);
    const label = PROVIDER_LABELS[pin.model.split("/")[0]] ?? pin.model.split("/")[0];
    const choice = chooseProfile(new Set(Object.keys(s.facts.providers).filter(p => ready(s, `${p}/`))), loadProfiles(s.ctx.repoDir));
    result.push(check(`fallback:${pin.model}`, safe ? "warn" : "fail", `${pin.agents.map(a => a.name).join(", ")} pin ${pin.model} but ${label} has no login: subagents may run on the parent model or fail before fallback switches${target ? ` to ${target}` : "; no ready target"}${!safe ? " (fallback unavailable)" : ""}`, `run \`pi\`, type /login and choose ${label}; or \`${s.setup} --profile auto\` (would pick ${choice.name})`));
  }
  const sources = new Set([...Object.keys(chains), ...pairs.flat()]);
  const unavailable = [...sources].filter(p => ready(s, p) && !targets(p).some(available));
  if (config.enabled === true && unavailable.length) result.push(check("fallback-targets", "warn", "fallback sources have no ready target", "edit ~/.pi/agent/provider-fallback.json", unavailable));
  if (!result.length) result.push(check("fallback", "ok", "fallback targets ready"));
  return result;
}
function guards(s: State): DoctorCheck {
  const path = join(s.piDir, "guards.json");
  const config = readJson(path);
  let detail = "all on";
  if (existsSync(path)) {
    const off = config?.off;
    if (!off || typeof off !== "object" || Array.isArray(off) || Object.values(off).some(v => typeof v !== "boolean")) return check("guards", "warn", "invalid guards.json shape", "/guards in pi (guards default to on)");
    const names = Object.entries(off).filter(([, v]) => v).map(([n]) => n);
    if (names.length) detail = `on, except ${names.join(", ")} (persisted off)`;
  }
  if (s.ctx.env.PI_GUARDS_OFF) detail += `; PI_GUARDS_OFF=${s.ctx.env.PI_GUARDS_OFF}`;
  return check("guards", "ok", detail);
}
function path(s: State): DoctorCheck[] {
  const missing = missingBinDirs(s.ctx);
  const result = [check("path", missing.length ? "warn" : "ok", missing.length ? `${missing.map(p => `~/${p}`).join(", ")} not on PATH` : "~/.local/bin and ~/.pi/agent/bin are on PATH", pathFixCommand(s.ctx))];
  for (const [pkg, cmd] of PACKAGE_BINS) {
    if (!packages(s).some(p => p.includes(pkg))) continue;
    const target = `~/.pi/agent/npm/node_modules/@woksin/${pkg}/bin/${cmd}`;
    const fix = existsSync(join(s.ctx.home, target.slice(2))) ? `ln -s ${target} ~/.local/bin/${cmd}` : `https://github.com/woksin/${pkg}#readme`;
    const link = join(s.ctx.home, ".local/bin", cmd);
    if (s.ctx.which(cmd)) result.push(check(`path:${cmd}`, "ok", `${cmd} found`, fix));
    else if (present(link) && missing.includes(".local/bin")) result.push(check(`path:${cmd}`, "warn", `${cmd} is installed at ~/.local/bin/${cmd}, but ~/.local/bin is not on PATH`, `${pathFixCommand(s.ctx)} (or reinstall with --edit-shell-profile)`));
    else result.push(check(`path:${cmd}`, "warn", `${cmd} is missing`, fix));
  }
  return result;
}

function prerequisites(s: State): DoctorCheck[] {
  const required = ["git", "gh", "jq", "rg", "fd", "python3", "npm", "pi", "node"];
  const optional: Record<string, string> = {
    gitleaks: "secret-sweep cannot scan without it; https://github.com/gitleaks/gitleaks#installing",
    rtk: "optional output compression unavailable; https://github.com/rtk-ai/rtk#installation",
    docker: "Docker tooling and docker-guardian require Docker Desktop/Engine",
    tmux: "optional lanes terminal backend unavailable; macOS Terminal remains an alternative",
  };
  const tools = [...required, ...Object.keys(optional)];
  return tools.map(tool => {
    const found = s.ctx.which(tool);
    const fix = installCommand(s.ctx, tool);
    const isRequired = required.includes(tool);
    const fixHint = isRequired || tool === "gitleaks" || tool === "tmux" ? fix : optional[tool];
    const base = check(`tool:${tool}`, found ? "ok" : isRequired ? "fail" : "warn", found ? `${tool} is on PATH` : `${tool} is missing`, found ? undefined : fixHint);
    return !found && isRequired ? { ...base, fixable: "prereq" as const } : base;
  });
}

export function localChecks(ctx: Ctx, facts: DoctorFacts): { checks: DoctorCheck[]; manifest?: Manifest; profile: string; modePaths: string[] } {
  const s = state(ctx, facts);
  return { checks: [files(s), pending(s), modes(s), ...npm(s), profile(s), ...providers(s), models(s), ...fallback(s), guards(s), ...prerequisites(s), ...path(s)], manifest: s.manifest, profile: s.profile, modePaths: s.modes };
}
