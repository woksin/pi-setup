import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { available, COMPONENTS } from "./components.ts";
import { fileSha, homeRel } from "./manifest.ts";
import type { ComponentRecord, Manifest, ServiceRecord } from "./manifest.ts";
import type { Action, Ctx } from "./types.ts";

/** Plist base name per service component. */
const LAUNCHD_NAME: Record<string, string> = { "docker-guardian": "docker-guardian", cleanup: "pi-cleanup", "secret-sweep": "secret-sweep" };
const TIMER = "pi-cleanup.timer";
const TIMEOUT = 5000;

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `com.<user>.<n>` like sync.sh; USER sanitised, fallback `pi-setup`. */
export function serviceUser(env: Record<string, string | undefined>): string {
  return (env.USER ?? "").replace(/[^A-Za-z0-9-]/g, "") || "pi-setup";
}

export const isService = (id: string): boolean => COMPONENTS.some((c) => c.id === id && c.service);

interface Unit { path: string; content: Buffer }

function systemdUnits(home: string): Unit[] {
  const dir = join(home, ".config/systemd/user");
  return [
    {
      path: join(dir, "pi-cleanup.service"),
      content: Buffer.from(
        "[Unit]\nDescription=pi-setup scheduled cleanup\n\n[Service]\nType=oneshot\nEnvironment=PYTHONDONTWRITEBYTECODE=1\nExecStart=%h/.pi/agent/bin/pi-cleanup --scheduled\n",
      ),
    },
    {
      path: join(dir, TIMER),
      content: Buffer.from("[Unit]\nDescription=pi-setup scheduled cleanup (daily)\n\n[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"),
    },
  ];
}

function launchdUnit(ctx: Pick<Ctx, "home" | "env" | "repoDir">, id: string): { unit: Unit; label: string } | undefined {
  const name = LAUNCHD_NAME[id];
  const src = join(ctx.repoDir, "agent", "launchd", `com.example.${name}.plist`);
  if (!name || !existsSync(src)) return undefined;
  const user = serviceUser(ctx.env);
  const text = readFileSync(src, "utf8").split("__HOME__").join(xml(ctx.home)).split("com.example.").join(`com.${user}.`);
  return { unit: { path: join(ctx.home, "Library/LaunchAgents", `com.${user}.${name}.plist`), content: Buffer.from(text) }, label: `com.${user}.${name}` };
}

export interface ServicePlan {
  actions: Action[];
  /** manifest.components entries for every service component. */
  records: Record<string, ComponentRecord>;
  notes: string[];
}

/** File actions for the services that are on. They never go through `keep`: a foreign or edited unit is left alone. */
export function planServices(
  ctx: Pick<Ctx, "home" | "env" | "repoDir" | "platform" | "which">, manifest: Manifest | undefined, on: Record<string, boolean>,
): ServicePlan {
  const out: ServicePlan = { actions: [], records: {}, notes: [] };
  for (const def of COMPONENTS.filter((c) => c.service)) {
    if (!on[def.id] || available(def.id, ctx) !== true) {
      out.records[def.id] = { on: false };
      continue;
    }
    let kind: ServiceRecord["kind"] = "launchd";
    let label = "";
    let units: Unit[] = [];
    if (ctx.platform === "darwin") {
      const l = launchdUnit(ctx, def.id);
      if (l) { units = [l.unit]; label = l.label; }
    } else {
      kind = "systemd";
      label = TIMER;
      units = systemdUnits(ctx.home);
    }
    if (!units.length) {
      out.records[def.id] = { on: false };
      continue;
    }
    let managed = true;
    const actions: Action[] = [];
    for (const u of units) {
      const rel = homeRel(ctx.home, u.path);
      const there = existsSync(u.path) && statSync(u.path).isFile();
      if (!there) actions.push({ op: "install", path: u.path, content: u.content, mode: 0o644, existed: false, decision: "new" });
      else if (readFileSync(u.path).equals(u.content)) actions.push({ op: "adopt", path: u.path });
      else if (manifest?.files[rel] && fileSha(u.path) === manifest.files[rel].sha256) {
        actions.push({ op: "install", path: u.path, content: u.content, mode: 0o644, existed: true, decision: "update" });
      } else {
        managed = false;
        out.notes.push(`left your ${u.path.replace(`${ctx.home}/`, "~/")}; pi-setup does not load or remove it`);
      }
    }
    if (managed) out.actions.push(...actions);
    out.records[def.id] = { on: true, service: { kind, label, files: units.map((u) => homeRel(ctx.home, u.path)), managed } };
  }
  return out;
}

const uid = (): number => (typeof process.getuid === "function" ? process.getuid() : 0);

async function sh(ctx: Ctx, cmd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await ctx.run(cmd, args, { timeoutMs: TIMEOUT });
    return { ok: r.code === 0 && !r.timedOut, text: `${r.stdout}${r.stderr}`.trim() };
  } catch (error) {
    return { ok: false, text: (error as Error).message };
  }
}

/** Load the services that are on and managed. A failure is a warning with the manual command; it never fails the install. */
export async function syncServices(
  ctx: Ctx, components: Record<string, ComponentRecord>, changed: Set<string>, dryRun: boolean,
): Promise<void> {
  for (const [id, c] of Object.entries(components)) {
    const svc = c.service;
    if (!c.on || !svc?.managed) continue;
    const plist = join(ctx.home, svc.files[0]);
    const domain = `gui/${uid()}`;
    if (svc.kind === "launchd") {
      if (dryRun) { ctx.out(`would load ${svc.label} (launchctl bootstrap ${domain} ${plist})`); continue; }
      mkdirSync(join(ctx.home, ".pi/agent/logs"), { recursive: true });
      const loaded = (await sh(ctx, "launchctl", ["print", `${domain}/${svc.label}`])).ok;
      if (loaded && !svc.files.some((f) => changed.has(join(ctx.home, f)))) continue;
      if (loaded) await sh(ctx, "launchctl", ["bootout", `${domain}/${svc.label}`]);
      const r = await sh(ctx, "launchctl", ["bootstrap", domain, plist]);
      if (!r.ok) ctx.err(`warning: could not load ${id}: launchctl bootstrap ${domain} ${plist}`);
      else ctx.out(`loaded ${svc.label}`);
    } else {
      if (dryRun) { ctx.out(`would enable ${svc.label} (systemctl --user enable --now ${svc.label})`); continue; }
      if (!ctx.which("systemctl")) { ctx.out(`note: systemctl not found; start ${id} later with: systemctl --user enable --now ${svc.label}`); continue; }
      await sh(ctx, "systemctl", ["--user", "daemon-reload"]);
      const r = await sh(ctx, "systemctl", ["--user", "enable", "--now", svc.label]);
      if (!r.ok) ctx.err(`warning: could not enable ${id}: systemctl --user enable --now ${svc.label}`);
      else ctx.out(`enabled ${svc.label}`);
    }
  }
}

/** The command line `unloadService` runs, for step lists and --dry-run. */
export function unloadLine(svc: ServiceRecord): string {
  return svc.kind === "launchd" ? `boot out ${svc.label} (launchctl bootout gui/${uid()}/${svc.label})` : `disable ${svc.label} (systemctl --user disable --now ${svc.label})`;
}

/** Stop a managed service before its files are removed. "Not loaded" is fine. */
export async function unloadService(ctx: Ctx, svc: ServiceRecord): Promise<void> {
  if (!svc.managed) return;
  if (svc.kind === "launchd") await sh(ctx, "launchctl", ["bootout", `gui/${uid()}/${svc.label}`]);
  else if (ctx.which("systemctl")) await sh(ctx, "systemctl", ["--user", "disable", "--now", svc.label]);
}

/** After the unit files are gone. */
export async function reloadSystemd(ctx: Ctx, svc: ServiceRecord): Promise<void> {
  if (svc.managed && svc.kind === "systemd" && ctx.which("systemctl")) await sh(ctx, "systemctl", ["--user", "daemon-reload"]);
}
