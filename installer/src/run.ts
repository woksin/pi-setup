import { join } from "node:path";
import { existsSync } from "node:fs";
import { runLanesFlow } from "./lanes-flow.ts";
import { preapprovalDefault } from "./lanes/config.ts";
import { apply, needsNpm, readActive } from "./apply.ts";
import type { ApplyOptions } from "./apply.ts";
import { isInteractive, parseArgs, USAGE } from "./args.ts";
import type { Options } from "./args.ts";
import { detect, installHint, readyProviders, toolPath } from "./detect.ts";
import { buildPlan } from "./plan.ts";
import { backupsCommand } from "./backups.ts";
import { readManifest } from "./manifest.ts";
import type { Manifest } from "./manifest.ts";
import { applyTakes, diffText, reconcile } from "./reconcile.ts";
import type { KeepAction } from "./reconcile.ts";
import { runUninstall } from "./uninstall.ts";
import { available, codesceneNotes, COMPONENTS, currentState, WEB_PACKAGES, detectDefaults, hintFor, resolveComponents } from "./components.ts";
import type { ComponentChoice } from "./components.ts";
import { retire, wasOn } from "./retire.ts";
import { isService, planServices, syncServices } from "./services.ts";
import type { ComponentRecord } from "./manifest.ts";
import type { ExtraRow } from "./wizard.ts";
import { installSummary, runDoctor } from "./doctor.ts";
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
import { collectChoices, confirmApply, resolveConflicts } from "./wizard.ts";
import { configureShellPath } from "./shell-path.ts";

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
    .map((tool) => `${tool} is required but was not found on PATH; install it with: ${installHint(ctx.platform, tool)}`);
  const python = detection.tools.find(tool => tool.name === "python3");
  if (!python?.path) return errors;
  const check = pythonVersionCheck(ctx, python.version);
  if (check.status !== "ok" && !options.json) ctx.err(`warning: ${check.detail}; install it with: ${check.fix}`);
  if (check.status === "ok" && !options.json && !guided) ctx.out(check.detail);
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
  if (options.command === "doctor") return runDoctor(ctx, options, baseCtx);
  if (options.command === "uninstall") return runUninstall(ctx, options, prompter);
  if (options.command === "update") return runUpdate(ctx, options, prompter);
  return backupsCommand(ctx, options.sub, options.keep, options.dryRun);
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

  let answers: { user?: string; root?: string; profile?: string; components?: Record<string, boolean>; preapproveMcp?: boolean } = {};
  if (prompter) {
    const profiles = loadProfiles(ctx.repoDir);
    const activeBefore = readActive(piDir);
    const initial = pickProfile(options, activeBefore, readyProviders(detection), profiles, names);
    const result = await collectChoices(prompter, { options, saved, detection, profiles, initial, home: ctx.home, repoDir: ctx.repoDir,
      extras: extraRows(ctx, options, saved, detection, manifest), preapproveMcp: savedPreapproval(ctx) });
    if (result === CANCEL) return cancelled(ctx);
    answers = result;
  }
  const r = resolveAll(ctx, options, detection, saved, answers, manifest, Boolean(prompter));
  if (prompter && r.conflicts.length) {
    const takes = await resolveConflicts(prompter, r.conflicts, (c) => diffText(ctx, c));
    if (takes === CANCEL) return cancelled(ctx);
    r.actions = applyTakes(r.actions, takes);
  }
  const better = detection.candidates[0]?.path;
  if (!prompter && r.settings.rootSource === "default" && better && better !== r.settings.reposRoot) {
    ctx.out(`pi-setup: repos root defaulted to ~/repos; detected ${better}; pass --repos-root ${better} to use it`);
  }
  r.warnings.push(...toolErrors.map((e) => e));
  if (!toolPath(detection, "pi")) r.warnings.push(`pi was not found on PATH; install it with: ${installHint(ctx.platform, "pi")}`);
  const summary = summaryLines({ ...r, detection, kimi: readOnly ? undefined : kimiNote(r.profile, r.ready), skipNpm: options.skipNpm, probed: !readOnly, withDetection: !prompter, components: r.components, componentNotes: r.componentNotes });
  if (options.plan) {
    configureShellPath(ctx, options.editShellProfile, true);
    return finish(ctx, baseCtx, options, r, detection, summary, 0);
  }
  const off = COMPONENTS.map((c) => c.id).filter((id) => !r.components[id].on && wasOn(manifest, currentState(ctx), id));
  const changes = r.actions.some((a) => a.op !== "adopt" && a.op !== "chmod-x") || off.length > 0 || (r.npm && !options.skipNpm);
  if (prompter && changes && !(await confirmApply(prompter, summary))) return cancelled(ctx);

  const applyOptions: ApplyOptions = {
    dryRun: options.dryRun,
    skipNpm: options.skipNpm || options.dryRun,
    reinstallNpm: options.reinstallNpm,
    inheritNpm: !prompter && !options.json,
    profile: r.choice.name,
    activeBefore: r.activeBefore,
    spinner: prompter?.spinner(),
    components: r.records,
    quiet: Boolean(prompter),
  };
  const live = await retire(ctx, piDir, manifest, off, options.dryRun);
  const result = await apply(ctx, r.actions, applyOptions, live);
  if (result.code === 0) await syncServices(ctx, r.records, new Set(r.actions.filter((a) => a.op === "install").map((a) => a.path)), options.dryRun);
  if (result.code === 0) configureShellPath(ctx, options.editShellProfile, readOnly);
  const shown = prompter || options.json ? [] : summary.filter((l) => l.startsWith("Profile:") || l.startsWith("Kimi") || l.startsWith("warning:") || l === KEPT_EDITS || l.startsWith("AGENTS.md has no") || r.componentNotes.includes(l));
  if (result.code === 0 && !options.dryRun && !options.plan && !options.json) shown.push(...await installSummary(ctx, detection, piDir));
  if (prompter && result.code === 0 && !options.dryRun && !options.plan && r.components.lanes.on && !existsSync(join(r.settings.reposRoot, ".lanes/lanes.json"))) {
    const answer = await prompter.confirm({ message: "Set up a coordinator and lanes now?", initial: false });
    if (!prompter.isCancel(answer) && answer === true) {
      try {
        if (await runLanesFlow(ctx, { ...options, dir: "" }, prompter, true) !== 0) ctx.err("Lanes setup was not completed; run ./install.sh lanes to continue.");
      } catch (error) { ctx.err(`Lanes setup was not completed: ${(error as Error).message}`); }
    }
  }
  return finish(ctx, baseCtx, options, r, detection, shown, result.code, prompter, result.wrote);
}

function cancelled(ctx: Ctx): number {
  ctx.err("Cancelled; nothing written.");
  return 1;
}

function finish(
  ctx: Ctx, baseCtx: Ctx, options: Options, r: Resolved, detection: Detection, lines: string[], code: number,
  prompter?: Prompter, wrote = true,
): number {
  if (options.json) {
    baseCtx.out(jsonReport(r, detection, code));
    return code;
  }
  for (const line of lines) (line.startsWith("warning:") ? ctx.err : ctx.out)(line);
  if (code === 0) {
    const readOnly = options.plan || options.dryRun;
    const kept = r.actions.filter((a) => a.op === "keep").length;
    const upToDate = `Everything up to date.${kept ? ` ${kept} file(s) you changed were kept.` : ""}`;
    const done = readOnly ? "Nothing was written." : wrote ? "Done. Restart pi (or /reload)." : upToDate;
    const hint = r.choice.provisional && !readOnly && wrote ? ` ${r.choice.reason}.` : "";
    if (prompter) prompter.outro(`${done}${hint}`);
    else ctx.out(`${done}${hint}`);
  }
  return code;
}
