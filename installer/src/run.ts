import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runLanesFlow } from "./lanes-flow.ts";
import { applyGuided, applyPlain, guidedNotes, lanesOffered, offerLanesSetup } from "./finish.ts";
import type { ApplyRun } from "./finish.ts";
import { preapprovalDefault } from "./lanes/config.ts";
import { describe, needsNpm, readActive } from "./apply.ts";
import type { ApplyOptions } from "./apply.ts";
import { isInteractive, parseArgs, USAGE } from "./args.ts";
import type { Options } from "./args.ts";
import { detect, probeProvider, readyProviders, toolPath } from "./detect.ts";
import { buildPlan } from "./plan.ts";
import { backupsCommand } from "./backups.ts";
import { backupsDir, readManifest } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { applyTakes, diffText, reconcile } from "./reconcile.ts";
import type { KeepAction } from "./reconcile.ts";
import { EXTRA_TOOLS, installCommand } from "./prereqs.ts";
import { ensurePrereqs, linkNotes } from "./prereqs-run.ts";
import { missingLogins } from "./profiles.ts";
import { runUninstall } from "./uninstall.ts";
import { available, codesceneNotes, COMPONENTS, currentState, WEB_PACKAGES, detectDefaults, hintFor, resolveComponents } from "./components.ts";
import type { ComponentChoice } from "./components.ts";
import { wasOn } from "./retire.ts";
import { isService, planServices } from "./services.ts";
import type { ComponentRecord } from "./manifest.ts";
import type { ExtraRow } from "./wizard.ts";
import { installChecks, runDoctor, setupCmd } from "./doctor.ts";
import { finishHealth } from "./doctor-compact.ts";
import { logPath } from "./install-log.ts";
import { pythonVersionCheck } from "./doctor-probes.ts";
import { runUpdate } from "./update.ts";
import {
  chooseProfile, kimiNote, loadProfiles, overlayFor, pinnedModels, pinWarnings, profileNames, profilesDir,
} from "./profiles.ts";
import type { Choice } from "./profiles.ts";
import { KEPT_EDITS, summaryLines } from "./report.ts";
import { readSettings, resolveSettings } from "./settings.ts";
import type { ResolvedSettings } from "./settings.ts";
import { CANCEL, SetupError } from "./types.ts";
import type { Action, Ctx, Detection, ProfileMeta, Prompter } from "./types.ts";

import { resolveConflicts } from "./wizard.ts";
import { runRails } from "./rails.ts";
import { configureShellPath, missingBinDirs, pathEditLine, pathFixCommand, PATH_EDIT_DEFAULT, shellPath } from "./shell-path.ts";

const savedString = (saved: Record<string, unknown>, key: string): string =>
  typeof saved[key] === "string" ? (saved[key] as string) : "";

function pickProfile(
  options: Options, activeBefore: string | undefined, ready: Set<string>, profiles: ProfileMeta[], names: string[], readOnly = false,
): Choice {
  if (options.profile && options.profile !== "auto") {
    if (!names.includes(options.profile)) {
      throw new SetupError(`unknown profile '${options.profile}'. available: ${names.join(", ")}`);
    }
    return { name: options.profile, reason: "requested with --profile", provisional: false, source: "flag" };
  }
  if (options.profile !== "auto" && activeBefore && names.includes(activeBefore)) {
    return { name: activeBefore, reason: "keeping your active profile", provisional: false, source: "active" };
  }
  if (readOnly) {
    return { name: "balanced", reason: "provisional: the real install picks by logged-in providers", provisional: false, source: "chooser" };
  }
  return chooseProfile(ready, profiles);
}

function requiredToolErrors(ctx: Ctx, detection: Detection, options: Options, guided: boolean): string[] {
  const needed = ["python3", ...(options.skipNpm ? [] : ["npm"])];
  const errors = needed
    .filter((tool) => !toolPath(detection, tool))
    .map((tool) => `${tool} is required but was not found on PATH; install it with: ${installCommand(ctx, tool)}`);
  const python = detection.tools.find(tool => tool.name === "python3");
  if (!python?.path) return errors;
  const check = pythonVersionCheck(ctx, python.version);
  if (check.status !== "ok" && !options.json) ctx.err(`warning: ${check.detail}; install it with: ${check.fix}`);
  if (check.status === "ok" && !options.json && !guided) ctx.out(`✓ ${/^Python \d+\.\d+/.exec(check.detail)?.[0] ?? check.detail}`);
  return errors;
}

interface Resolved {
  settings: ResolvedSettings;
  choice: Choice;
  actions: Action[];
  warnings: string[];
  profile: ProfileMeta | undefined;
  ready: Set<string>;
  activeBefore: string | undefined;
  piDir: string;
  npm: boolean;
  conflicts: KeepAction[];
  components: ComponentChoice;
  records: Record<string, ComponentRecord>;
  componentNotes: string[];
}

const flagMap = (options: Options): Record<string, boolean> => ({
  ...Object.fromEntries(options.with.map((id) => [id, true])),
  ...Object.fromEntries(options.without.map((id) => [id, false])),
});

/** Initial values for the wizard question and the rows for components that cannot be chosen here. */
function extraRows(
  ctx: Ctx, options: Options, saved: Record<string, unknown>, detection: Detection, manifest: Manifest | undefined,
): (root: string) => ExtraRow[] {
  const flags = flagMap(options);
  return (root) => {
    const detected = detectDefaults(ctx, detection, root);
    const initial = resolveComponents({ flags, saved: manifest?.components, current: currentState(ctx), detected, interactive: true });
    return COMPONENTS.map((def) => {
      const why = available(def.id, ctx);
      return {
        id: def.id, label: def.label, hint: hintFor(def, initial[def.id].on), initial: initial[def.id].on,
        unavailable: why === true ? undefined : why, fixed: def.id in flags,
      };
    });
  };
}

function savedPreapproval(ctx: Ctx): boolean {
  return preapprovalDefault(join(ctx.home, ".local/share/pi-setup/lanes/templates"));
}

function resolveAll(
  ctx: Ctx, options: Options, detection: Detection,
  saved: Record<string, unknown>, answers: { user?: string; root?: string; profile?: string; components?: Record<string, boolean>; preapproveMcp?: boolean },
  manifest: Manifest | undefined, prompted = false,
): Resolved {
  const piDir = join(ctx.home, ".pi", "agent");
  const settings = resolveSettings({
    flagUser: answers.user ?? options.user,
    flagRoot: answers.root ?? options.reposRoot,
    saved,
    detectedUser: detection.github.login,
    scanRoot: prompted ? detection.candidates[0]?.path : undefined,
    home: ctx.home,
    repoDir: ctx.repoDir,
    readOnly: options.dryRun || options.plan,
  });
  if (answers.user) settings.userSource = answers.user === savedString(saved, "githubUser") ? "saved" : "prompt";
  if (answers.root) settings.rootSource = "prompt";
  const names = profileNames(ctx.repoDir);
  const profiles = loadProfiles(ctx.repoDir);
  const activeBefore = readActive(piDir);
  const ready = readyProviders(detection);
  const asked = answers.profile ? { ...options, profile: answers.profile } : options;
  const picked = pickProfile(asked, activeBefore, ready, profiles, names, options.dryRun || options.plan);
  const choice: Choice = answers.profile ? { name: picked.name, reason: "you picked it", provisional: false, source: "prompt" } : picked;
  const profile = profiles.find((p) => p.name === choice.name);
  const components = resolveComponents({
    flags: flagMap(options), answers: answers.components, saved: manifest?.components, current: currentState(ctx),
    detected: detectDefaults(ctx, detection, settings.reposRoot), interactive: Boolean(answers.components) || isInteractive(options, ctx.env, ctx.stdinTTY, ctx.stdoutTTY),
  });
  const componentNotes: string[] = [];
  const notes: string[] = [];
  for (const def of COMPONENTS) {
    const why = available(def.id, ctx);
    if (why === true) continue;
    if (components[def.id].on && components[def.id].source === "flag") notes.push(`warning: ${def.label} is not available here (${why})`);
    components[def.id] = { on: false, source: components[def.id].source };
  }
  const on = Object.fromEntries(Object.entries(components).map(([id, c]) => [id, c.on]));
  const built = reconcile(
    buildPlan({
      repoDir: ctx.repoDir, home: ctx.home, settings, overlay: overlayFor(ctx.repoDir, choice.name, settings),
      components: on, which: ctx.which, notes,
      preapproveMcp: savedPreapproval(ctx) || options.preapproveMcp || answers.preapproveMcp === true,
      drop: on.web === false ? (manifest?.json[".pi/agent/settings.json"]?.ops ?? []).flatMap((o) => (o.op === "array-add" && o.key === "packages" && WEB_PACKAGES.includes(o.value as string) ? [o.value as string] : [])) : [],
      activate: COMPONENTS.map((c) => c.id).filter((id) => on[id] && !wasOn(manifest, currentState(ctx), id)),
    }),
    manifest, ctx.home,
  );
  const { conflicts } = built;
  const serviceOn = Object.fromEntries(Object.entries(on).filter(([id]) => isService(id)));
  const services = planServices(ctx, manifest, serviceOn);
  const actions = [...built.actions, ...services.actions];
  const records: Record<string, ComponentRecord> = { ...services.records };
  for (const def of COMPONENTS.filter((c) => !c.service)) records[def.id] = { on: on[def.id] };
  componentNotes.push(...notes, ...services.notes);
  if (on.codescene) componentNotes.push(...codesceneNotes(ctx));
  const kimi = options.dryRun || options.plan ? undefined : kimiNote(profile, ready);
  const warnings = [
    ...settings.warnings,
    ...componentNotes.filter((n) => n.startsWith("warning:")).map((n) => n.slice(9)),
    ...detection.warnings,
    ...pinWarnings(pinnedModels(join(profilesDir(ctx.repoDir), choice.name)), ready, detection.catalog),
    ...(kimi ? [kimi] : []),
  ];
  return { settings, choice, actions, warnings, profile, ready, activeBefore, piDir, npm: needsNpm(actions, piDir, manifest, options.reinstallNpm), conflicts, components, records, componentNotes: componentNotes.filter((n) => !n.startsWith("warning:")) };
}

function jsonReport(r: Resolved, detection: Detection, exitCode: number): string {
  return JSON.stringify({
    settings: { ...r.settings },
    detection: { ...detection, catalog: detection.catalog ? [...detection.catalog].sort() : null },
    profile: { name: r.choice.name, reason: r.choice.reason, provisional: r.choice.provisional, source: r.choice.source },
    actions: r.actions.filter((a) => a.op !== "adopt").map((a) => ({ op: a.op, path: a.path })),
    warnings: r.warnings,
    exitCode,
  });
}

export async function main(argv: string[], baseCtx: Ctx, injected?: Prompter): Promise<number> {
  const parsed = parseArgs(argv, baseCtx.cwd);
  if (!parsed.ok) {
    baseCtx.err(parsed.error);
    return (argv[0] === "install" ? argv[1] : argv[0]) === "doctor" ? 2 : 1;
  }
  const options = parsed.options;
  if (options.help) {
    baseCtx.out(USAGE);
    return 0;
  }
  const interactive = isInteractive(options, baseCtx.env, baseCtx.stdinTTY, baseCtx.stdoutTTY);
  const ctx: Ctx = { ...baseCtx, noLaunchd: options.noLaunchd, out: options.json ? baseCtx.err : baseCtx.out };
  let prompter = injected;
  if (interactive && !prompter) prompter = (await import("./prompter-clack.ts")).clackPrompter();
  try {
    if (options.command !== "install") return await runCommand(ctx, options, interactive ? prompter : undefined, baseCtx);
    return await execute(ctx, options, interactive ? prompter : undefined, baseCtx);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    ctx.err(error.message.startsWith("pi-setup:") || error.message.startsWith("Missing value") ? error.message : `pi-setup: ${error.message}`);
    return options.command === "doctor" ? 2 : 1;
  }
}

async function runCommand(ctx: Ctx, options: Options, prompter: Prompter | undefined, baseCtx: Ctx): Promise<number> {
  if (options.command === "lanes") return runLanesFlow(ctx, options, prompter);
  if (options.command === "doctor") return runDoctor(ctx, options, baseCtx, prompter);
  if (options.command === "uninstall") return runUninstall(ctx, options, prompter);
  if (options.command === "update") return runUpdate(ctx, options, prompter);
  return backupsCommand(ctx, options.sub, options.keep, options.dryRun);
}

function offComponents(ctx: Ctx, r: Resolved, manifest: Manifest | undefined): string[] {
  return COMPONENTS.map((c) => c.id).filter((id) => !r.components[id].on && wasOn(manifest, currentState(ctx), id));
}

function hasChanges(ctx: Ctx, options: Options, r: Resolved, manifest: Manifest | undefined): boolean {
  return r.actions.some((a) => a.op === "keep" ? a.write : a.op !== "adopt" && a.op !== "chmod-x") ||
    offComponents(ctx, r, manifest).length > 0 || (r.npm && !options.skipNpm);
}

function summarize(r: Resolved, detection: Detection, options: Options, guided: boolean): string[] {
  const readOnly = options.dryRun || options.plan;
  return summaryLines({ ...r, detection, kimi: readOnly ? undefined : kimiNote(r.profile, r.ready), skipNpm: options.skipNpm, probed: !readOnly, withDetection: !guided, components: r.components, componentNotes: r.componentNotes });
}

interface GuidedInput {
  ctx: Ctx; options: Options; detection: Detection; saved: Record<string, unknown>;
  manifest: Manifest | undefined; p: Prompter; toolErrors: string[];
}

function addToolWarnings(r: Resolved, detection: Detection, toolErrors: string[], ctx: Ctx): void {
  r.warnings.push(...toolErrors);
  if (!toolPath(detection, "pi")) r.warnings.push(`pi was not found on PATH; install it with: ${installCommand(ctx, "pi")}`);
}

async function guidedResolution({ ctx, options, detection, saved, manifest, p, toolErrors }: GuidedInput): Promise<{ r: Resolved; editPath: boolean } | typeof CANCEL> {
  const profiles = loadProfiles(ctx.repoDir);
  const activeBefore = readActive(join(ctx.home, ".pi/agent"));
  const initial = pickProfile(options, activeBefore, readyProviders(detection), profiles, profileNames(ctx.repoDir));
  let resolved: Resolved | undefined;
  const result = await runRails(p, {
    options, saved, detection, profiles, initial, home: ctx.home, repoDir: ctx.repoDir,
    installed: Boolean(manifest), activeProfile: activeBefore,
    probe: (id) => probeProvider(ctx, id), which: ctx.which, readOnly: options.dryRun || options.plan,
    extras: extraRows(ctx, options, saved, detection, manifest), preapproveMcp: savedPreapproval(ctx),
    pathLine: pathEditLine(ctx), pathDefault: PATH_EDIT_DEFAULT || options.editShellProfile,
    review: (answers) => {
      const r = resolveAll(ctx, options, detection, saved, answers, manifest, true);
      addToolWarnings(r, detection, toolErrors, ctx);
      resolved = r;
      return {
        summary: () => summarize(r, detection, options, true),
        files: () => r.actions.map(describe).filter((line): line is string => line !== undefined),
        changes: hasChanges(ctx, options, r, manifest), conflicts: r.conflicts.length,
        decideConflicts: async () => {
          const takes = await resolveConflicts(p, r.conflicts, (c) => diffText(ctx, c));
          if (takes === CANCEL) return false;
          r.actions = applyTakes(r.actions, takes);
          return true;
        },
      };
    },
  });
  return result === CANCEL ? CANCEL : { r: resolved!, editPath: result.editPath };
}

async function execute(ctx: Ctx, options: Options, prompter: Prompter | undefined, baseCtx: Ctx): Promise<number> {
  const piDir = join(ctx.home, ".pi", "agent");
  const saved = readSettings(join(piDir, "user.json"));
  const manifest = readManifest(piDir);
  const readOnly = options.dryRun || options.plan;
  const names = profileNames(ctx.repoDir);
  if (options.profile && options.profile !== "auto" && !names.includes(options.profile)) {
    throw new SetupError(`unknown profile '${options.profile}'. available: ${names.join(", ")}`);
  }
  prompter?.intro("pi-setup");
  const fresh = !manifest && !existsSync(piDir);
  const required = ["gh", "jq", "rg", "fd", "python3", "git", ...(options.skipNpm ? [] : ["npm"])];
  await ensurePrereqs(ctx, options, prompter, { tools: required, pi: true, fresh });
  const spin = prompter?.spinner();
  spin?.start("Looking around…");
  const known = Boolean(options.user || savedString(saved, "githubUser"));
  const knownRoot = Boolean(options.reposRoot || savedString(saved, "reposRoot"));
  const detection = await detect(ctx, {
    needLogin: !known,
    wantGithubDetails: Boolean(prompter),
    needScan: Boolean(prompter) || !knownRoot,
    probePi: !readOnly,
    login: options.user || savedString(saved, "githubUser") || undefined,
  });
  spin?.stop("Looked around");
  const toolErrors = requiredToolErrors(ctx, detection, options, Boolean(prompter));
  if (toolErrors.length && !readOnly) throw new SetupError(toolErrors.join("\n"));

  const guided = prompter ? await guidedResolution({ ctx, options, detection, saved, manifest, p: prompter, toolErrors }) : undefined;
  if (guided === CANCEL) return cancelled(ctx);
  const r = guided?.r ?? resolveAll(ctx, options, detection, saved, {}, manifest);
  // A fresh machine gets the PATH line by default (the profile is backed up first); an update never edits it unasked.
  const editPath = guided ? guided.editPath : !options.noEditShellProfile && (options.editShellProfile || fresh);
  const better = detection.candidates[0]?.path;
  if (!prompter && r.settings.rootSource === "default" && better && better !== r.settings.reposRoot) {
    ctx.out(`pi-setup: repos root defaulted to ~/repos; detected ${better}; pass --repos-root ${better} to use it`);
  }
  if (!prompter) addToolWarnings(r, detection, toolErrors, ctx);
  const summary = summarize(r, detection, options, Boolean(prompter));
  const chosen = Object.keys(r.components).filter((id) => r.components[id].on);
  await ensurePrereqs(ctx, options, prompter, { tools: chosen.flatMap((id) => EXTRA_TOOLS[id] ?? []), pi: false, fresh });
  for (const note of linkNotes(ctx, chosen)) ctx.err(`note: ${note}`);
  if (options.plan) {
    configureShellPath(ctx, editPath, true);
    return finish({ ctx, baseCtx, options, r, detection, lines: summary, code: 0 });
  }
  const off = offComponents(ctx, r, manifest);

  const plainReal = !prompter && !options.json && !options.dryRun;
  const applyOptions: ApplyOptions = {
    dryRun: options.dryRun,
    skipNpm: options.skipNpm || options.dryRun,
    reinstallNpm: options.reinstallNpm,
    inheritNpm: !prompter && !options.json && !plainReal,
    profile: r.choice.name,
    activeBefore: r.activeBefore,
    components: r.records,
    quiet: Boolean(prompter) || plainReal,
  };
  const pathMissing = missingBinDirs(ctx).length > 0;
  const run: ApplyRun = { ctx, options, r, applyOptions, manifest, off, editPath };
  const result = prompter ? await applyGuided(run, prompter) : await applyPlain(run);
  const noLogins = plainReal && r.ready.size === 0;
  const shown = prompter || options.json ? [] : summary
    .filter((l) => l.startsWith("Profile:") || (l.startsWith("Kimi") && !noLogins) || (l.startsWith("warning:") && !(noLogins && l.includes("no models yet"))) || l === KEPT_EDITS || l.startsWith("AGENTS.md has no") || r.componentNotes.includes(l))
    .map((l) => (l.startsWith("Profile:") && noLogins && !r.choice.source.startsWith("flag") ? `Profile: ${r.choice.name} (final choice after you log in)` : l));
  let done: string | undefined;
  if (result.code === 0 && plainReal && !options.plan) {
    const end = plainFinish({ ctx, options, detection, r, wrote: result.wrote, editPath, pathMissing, piDir });
    shown.push(...end.lines);
    done = end.done;
  }
  const offer = lanesOffered(r, options, result.code === 0);
  let pending = 0;
  if (prompter && result.code === 0 && !options.dryRun) {
    pending = guidedNotes(prompter, { ctx, options, detection, profile: r.profile, ready: r.ready, pathMissing, editPath, offerLanes: offer });
  }
  if (prompter && offer) await offerLanesSetup(ctx, options, prompter);
  return finish({ ctx, baseCtx, options, r, detection, lines: shown, code: result.code, prompter, wrote: result.wrote, pending, done });
}

interface PlainEnd { ctx: Ctx; options: Options; detection: Detection; r: Resolved; wrote: boolean; editPath: boolean; pathMissing: boolean; piDir: string }

const pathInProfile = (ctx: Ctx): boolean => {
  try { return readFileSync(shellPath(ctx).file, "utf8").split("\n").includes(shellPath(ctx).snippet); } catch { return false; }
};

/** The unattended finish: one health line, what is left for the person (numbered, each with the exact command), and one closing line. */
function plainFinish(e: PlainEnd): { lines: string[]; done: string } {
  const { ctx, detection, r } = e;
  const home = setupCmd(ctx);
  const kept = r.actions.filter((a) => a.op === "keep").length;
  const health = finishHealth(installChecks(ctx, detection), { home: ctx.home, skipNpm: e.options.skipNpm, pathEdited: false, githubLogin: Boolean(detection.github.host), pathTodo: e.pathMissing });
  const logins = [...new Set([...missingLogins(r.profile, r.ready), ...health.logins])];
  const steps: string[] = [];
  if (e.pathMissing) {
    steps.push(e.editPath || pathInProfile(ctx)
      ? "Open a new terminal (or run: exec $SHELL -l) so pi is on your PATH."
      : `Put the tools on your PATH: ${pathFixCommand(ctx)}, then open a new terminal.`);
  }
  if (ctx.env.PI_SETUP_BREW_SHELLENV) steps.push(`Add to your shell profile: eval "$(${ctx.env.PI_SETUP_BREW_SHELLENV} shellenv)"`);
  if (!detection.github.host) steps.push("Log in to GitHub: gh auth login");
  if (health.npmSkipped) steps.push(`Install the pi packages you skipped: ${home}`);
  if (health.pending) steps.push(`Review the files you changed: each has a new version next to it ending in .pi-setup-new`);
  if (logins.length) {
    steps.push(`Log in to your AI providers: start pi, then type /login for ${logins.join(", ")}`);
    steps.push(`After logging in, run: ${home} --profile auto`);
  }
  steps.push("Start with: pi");
  const backups = readdirSyncSafe(backupsDir(e.piDir));
  const lines = [
    e.wrote ? (backups.length ? `Replaced files are backed up in ~/.pi/agent/.pi-setup/backups/. Undo any time: ${home} uninstall` : `Nothing needed backing up. Undo any time: ${home} uninstall`) : "",
    health.line, ...health.problems.map((p) => `  ✖ ${p}`),
    ...(health.optional.length ? [`Optional, not installed: ${health.optional.join(", ")} (${home} doctor for how)`] : []),
    ...(e.wrote || health.todos ? ["", "Next steps:", ...steps.map((s, i) => `  ${i + 1}. ${s}`)] : []),
    "", `Full log: ${logPath(ctx).replace(ctx.home, "~")}`,
  ].filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""));
  const done = health.problems.length ? `Setup is in place, but ${health.problems.length} problem(s) need attention (see above).`
    : e.wrote ? (steps.length > 1 ? `Setup finished. Next: follow steps 1–${steps.length} above.` : "Setup finished. Start with: pi")
      : `Everything up to date.${kept ? ` ${kept} file(s) you changed were kept.` : ""}`;
  return { lines, done };
}

const readdirSyncSafe = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

function cancelled(ctx: Ctx): number {
  ctx.err("Cancelled; nothing written.");
  return 1;
}

interface FinishInput {
  ctx: Ctx; baseCtx: Ctx; options: Options; r: Resolved; detection: Detection; lines: string[]; code: number;
  prompter?: Prompter; wrote?: boolean; pending?: number; done?: string;
}

function finish({ ctx, baseCtx, options, r, detection, lines, code, prompter, wrote = true, pending = 0, done: closing }: FinishInput): number {
  if (options.json) {
    baseCtx.out(jsonReport(r, detection, code));
    return code;
  }
  for (const line of lines) (line.startsWith("warning:") ? ctx.err : ctx.out)(line);
  if (code === 0) {
    const readOnly = options.plan || options.dryRun;
    const kept = r.actions.filter((a) => a.op === "keep").length;
    const upToDate = `${prompter ? "Everything is up to date." : "Everything up to date."}${kept ? ` ${kept} file(s) you changed were kept.` : ""}`;
    const done = closing ?? (options.dryRun ? `Dry run: nothing changed. Next: ${setupCmd(ctx)}` : readOnly ? "Nothing was written." : wrote ? "Done. Restart pi (or /reload)." : upToDate);
    const hint = r.choice.provisional && !readOnly && wrote ? ` ${r.choice.reason}.` : "";
    if (prompter && pending && !readOnly) prompter.outro(`Installed, with ${pending} ${pending === 1 ? "thing" : "things"} to finish: see "Still to finish" above.`);
    else if (prompter) prompter.outro(`${done}${hint}`);
    else ctx.out(`${done}${hint}`);
  }
  return code;
}
