import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Options } from "./args.ts";
import { EXTRA_LINKS, formatCommand, installCommand, isRequired, packageManager, piStep, planPrereqs, TOOLS } from "./prereqs.ts";
import type { Step } from "./prereqs.ts";
import { CANCEL, SetupError } from "./types.ts";
import type { Ctx, Prompter } from "./types.ts";

export type Consent = "yes" | "ask" | "no";

export interface Scope {
  tools: string[];
  pi: boolean;
  /** No pi-setup manifest and no ~/.pi/agent yet: `--yes` may install on its own. */
  fresh: boolean;
}

export interface PrereqResult {
  ran: number;
  declined: boolean;
  stillMissing: string[];
}

/** `--yes` takes the defaults: install on a fresh machine, report only when updating. `--skip-npm` never installs. */
export function consentFor(options: Pick<Options, "installPrereqs" | "yes" | "skipNpm">, interactive: boolean, fresh: boolean): Consent {
  if (options.installPrereqs === false) return "no";
  if (options.installPrereqs === true) return "yes";
  if (interactive) return "ask";
  return options.yes && fresh && !options.skipNpm ? "yes" : "no";
}

export const logPath = (ctx: Ctx): string => join(ctx.home, ".local/state/pi-setup/install.log");
const statePath = (ctx: Ctx): string => join(ctx.home, ".local/state/pi-setup/bootstrap.json");

function record(ctx: Ctx, failed: { label: string; command: string } | undefined): void {
  try {
    if (!failed) { rmSync(statePath(ctx), { force: true }); return; }
    mkdirSync(dirname(statePath(ctx)), { recursive: true });
    writeFileSync(statePath(ctx), JSON.stringify({ ...failed, at: ctx.now().toISOString() }));
  } catch { /* the state file only improves the resume hint */ }
}

function previousStop(ctx: Ctx): string | undefined {
  try {
    const s = JSON.parse(readFileSync(statePath(ctx), "utf8")) as { label?: string };
    return s.label;
  } catch { return undefined; }
}

function appendLog(ctx: Ctx, text: string): void {
  try {
    mkdirSync(dirname(logPath(ctx)), { recursive: true });
    appendFileSync(logPath(ctx), text);
  } catch { /* logging must not stop an install */ }
}

const minutes = (steps: Step[]): string => steps.some((s) => s.system) ? "about 2-5 minutes" : "about a minute";

function osName(ctx: Ctx): string {
  return ctx.platform === "darwin" ? "macOS" : ctx.platform === "linux" ? "Linux" : ctx.platform;
}

/** The first screen: what was found, what will run, how long it takes. */
function firstScreen(ctx: Ctx, tools: string[], missing: string[], steps: Step[], piVersion: string): string[] {
  const manager = packageManager(ctx);
  const present = tools.filter((t) => !missing.includes(t));
  return [
    `Found: ${osName(ctx)}${manager ? ` with ${manager === "apt" ? "apt" : manager}` : ""}, ${piVersion}`,
    ...(present.length ? [`Already installed: ${present.join(", ")}`] : []),
    ...(missing.length ? [`Missing: ${missing.join(", ")}`] : []),
    "",
    "Commands I will run:",
    ...steps.map((s) => `  ${formatCommand(s.argv)}`),
    ...(steps.some((s) => s.sudo) ? ["", "Some of these run with sudo; you may be asked for your password."] : []),
    `This takes ${minutes(steps)}.`,
  ];
}

async function piVersionText(ctx: Ctx): Promise<string> {
  if (!ctx.which("pi")) return "pi not installed";
  const r = await ctx.run("pi", ["--version"], { timeoutMs: 8000 });
  return `pi ${(r.stdout || r.stderr).trim().split("\n")[0] || "(version unknown)"}`;
}

async function isRoot(ctx: Ctx): Promise<boolean> {
  const r = await ctx.run("id", ["-u"], { timeoutMs: 3000 });
  return r.code === 0 && r.stdout.trim() === "0";
}

/** Only asks who we are when a sudo prefix could matter: something is missing and the manager is not brew. */
async function rootIfNeeded(ctx: Ctx, tools: string[]): Promise<boolean> {
  const manager = packageManager(ctx);
  if (!manager || manager === "brew" || !TOOLS.some((t) => tools.includes(t.tool) && !ctx.which(t.tool))) return false;
  return isRoot(ctx);
}

function reportOnly(ctx: Ctx, steps: Step[], manual: { tool: string; link: string }[], missing: string[]): void {
  for (const tool of missing) ctx.err(`warning: ${tool} is not installed; install it with: ${installCommand(ctx, tool)}`);
  if (steps.length) ctx.err("To let the installer do this for you, re-run with --install-prereqs.");
  for (const m of manual) if (!steps.length) ctx.err(`  ${m.tool}: ${m.link}`);
}

async function runStep(ctx: Ctx, step: Step, nonInteractive: boolean): Promise<void> {
  const command = formatCommand(step.argv);
  if (step.sudo && !ctx.which("sudo")) {
    throw new SetupError(`sudo is not available. Run this as root, then re-run ./install.sh:\n  ${command.replace(/^sudo (-n )?/, "")}`);
  }
  ctx.out(`→ ${step.label}: ${command}`);
  appendLog(ctx, `\n$ ${command}\n`);
  const r = await ctx.run(step.argv[0], step.argv.slice(1), { timeoutMs: 1_800_000, inherit: step.sudo && !nonInteractive });
  appendLog(ctx, `${r.stdout}${r.stderr}\n[exit ${r.code}]\n`);
  if (r.code === 0 && !r.timedOut) { ctx.out(`✓ ${step.label}`); return; }
  record(ctx, { label: step.label, command });
  const why = r.timedOut ? "timed out" : `exit code ${r.code}`;
  const hint = step.sudo && nonInteractive ? "\nsudo needs a password here: run the command yourself in a terminal, or re-run ./install.sh interactively." : "";
  throw new SetupError(`✗ ${step.label} failed (${why}): ${command}${hint}\nDetails: ${logPath(ctx)}\nFix the problem, then re-run ./install.sh: it continues from here.`);
}

interface Pending { steps: Step[]; manual: { tool: string; link: string }[]; missing: string[]; piWarning?: string }

async function gather(ctx: Ctx, scope: Scope, interactive: boolean, probeVersion: boolean): Promise<Pending> {
  const plan = planPrereqs(ctx, { tools: scope.tools, interactive, isRoot: await rootIfNeeded(ctx, scope.tools) });
  const pi = scope.pi ? await piStep(ctx, probeVersion) : {};
  const missing = TOOLS.filter((t) => scope.tools.includes(t.tool) && !ctx.which(t.tool)).map((t) => t.tool);
  return { steps: [...plan.steps, ...(pi.step ? [pi.step] : [])], manual: plan.manual, missing: pi.step ? [...missing, "pi"] : missing, piWarning: pi.warning };
}

/** Install what is missing, with consent. Nothing missing prints nothing. */
export async function ensurePrereqs(ctx: Ctx, options: Options, prompter: Prompter | undefined, scope: Scope): Promise<PrereqResult> {
  const readOnly = options.dryRun || options.plan;
  const consent = consentFor(options, Boolean(prompter), scope.fresh);
  const pending = await gather(ctx, scope, consent === "ask", !readOnly);
  if (pending.piWarning) ctx.err(`warning: ${pending.piWarning}`);
  const done = (ran: number, declined: boolean): PrereqResult => ({
    ran, declined, stillMissing: TOOLS.filter((t) => scope.tools.includes(t.tool) && !ctx.which(t.tool)).map((t) => t.tool),
  });
  if (!pending.steps.length) {
    if (!readOnly) for (const m of pending.manual) ctx.err(`warning: ${m.tool} is not installed; install it from ${m.link}`);
    return done(0, false);
  }
  if (readOnly) {
    ctx.out("Prerequisites that would be installed:");
    for (const s of pending.steps) ctx.out(`Would run: ${formatCommand(s.argv)}`);
    return done(0, false);
  }
  if (consent === "no") { reportOnly(ctx, pending.steps, pending.manual, pending.missing); return done(0, true); }
  const lines = firstScreen(ctx, scope.tools, pending.missing, pending.steps, await piVersionText(ctx));
  if (consent === "ask" && prompter) {
    const stopped = previousStop(ctx);
    if (stopped) lines.unshift(`Last time this stopped at: ${stopped}. Continuing from there.`, "");
    prompter.note(lines.join("\n"), "Before we start");
    const ok = await prompter.confirm({ message: "Continue?", initial: true });
    if (ok === CANCEL || ok !== true) {
      ctx.err(`Skipped. Nothing was installed. To do it later: ./install.sh --install-prereqs\nOr by hand:\n${pending.steps.map((s) => `  ${formatCommand(s.argv)}`).join("\n")}`);
      return done(0, true);
    }
  } else lines.forEach((l) => ctx.out(l));
  const nonInteractive = consent !== "ask";
  for (const step of pending.steps) await runStep(ctx, step, nonInteractive);
  record(ctx, undefined);
  const after = done(pending.steps.length, false);
  for (const tool of after.stillMissing.filter((t) => !isRequired(t) || t === "fd")) {
    ctx.err(`warning: ${tool} is still not on PATH (installed to ~/.local/bin? add it to PATH)`);
  }
  return after;
}

/** The link-only note for extras whose tool is never installed by pi-setup. */
export function linkNotes(ctx: Ctx, extras: string[]): string[] {
  return extras.filter((id) => id in EXTRA_LINKS && !ctx.which(EXTRA_LINKS[id])).map((id) => {
    const def = TOOLS.find((t) => t.tool === EXTRA_LINKS[id])!;
    return `${id} needs ${def.tool}, which pi-setup does not install: ${def.link}`;
  });
}
