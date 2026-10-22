import { join } from "node:path";
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
import { runUpdate } from "./update.ts";
import {
  chooseProfile, kimiNote, loadProfiles, overlayFor, pinnedModels, pinWarnings, profileNames, profilesDir,
} from "./profiles.ts";
import type { Choice } from "./profiles.ts";
import { summaryLines } from "./report.ts";
import { readSettings, resolveSettings } from "./settings.ts";
import type { ResolvedSettings } from "./settings.ts";
import { CANCEL, SetupError } from "./types.ts";
import type { Action, Ctx, Detection, ProfileMeta, Prompter } from "./types.ts";
import { collectChoices, confirmApply, resolveConflicts } from "./wizard.ts";

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

function requiredToolErrors(ctx: Ctx, detection: Detection, options: Options): string[] {
  const needed = ["python3", ...(options.skipNpm ? [] : ["npm"])];
  return needed
    .filter((tool) => !toolPath(detection, tool))
    .map((tool) => `${tool} is required but was not found on PATH; install it with: ${installHint(ctx.platform, tool)}`);
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
}

function resolveAll(
  ctx: Ctx, options: Options, detection: Detection,
  saved: Record<string, unknown>, answers: { user?: string; root?: string; profile?: string }, manifest: Manifest | undefined,
): Resolved {
  const piDir = join(ctx.home, ".pi", "agent");
  const settings = resolveSettings({
    flagUser: answers.user ?? options.user,
    flagRoot: answers.root ?? options.reposRoot,
    saved,
    detectedUser: detection.github.login,
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
  const choice = pickProfile(asked, activeBefore, ready, profiles, names, options.dryRun || options.plan);
  const profile = profiles.find((p) => p.name === choice.name);
  const { actions, conflicts } = reconcile(
    buildPlan({ repoDir: ctx.repoDir, home: ctx.home, settings, overlay: overlayFor(ctx.repoDir, choice.name, settings) }),
    manifest, ctx.home,
  );
  const kimi = options.dryRun || options.plan ? undefined : kimiNote(profile, ready);
  const warnings = [
    ...settings.warnings,
    ...detection.warnings,
    ...pinWarnings(pinnedModels(join(profilesDir(ctx.repoDir), choice.name)), ready, detection.catalog),
    ...(kimi ? [kimi] : []),
  ];
  return { settings, choice, actions, warnings, profile, ready, activeBefore, piDir, npm: needsNpm(actions, piDir, manifest, options.reinstallNpm), conflicts };
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
    return 1;
  }
  const options = parsed.options;
  if (options.help) {
    baseCtx.out(USAGE);
    return 0;
  }
  const interactive = isInteractive(options, baseCtx.env, baseCtx.stdinTTY, baseCtx.stdoutTTY);
  const ctx: Ctx = options.json ? { ...baseCtx, out: baseCtx.err } : baseCtx;
  let prompter = injected;
  if (interactive && !prompter) prompter = (await import("./prompter-clack.ts")).clackPrompter();
  try {
    if (options.command !== "install") return await runCommand(ctx, options, interactive ? prompter : undefined);
    return await execute(ctx, options, interactive ? prompter : undefined, baseCtx);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    ctx.err(error.message.startsWith("pi-setup:") || error.message.startsWith("Missing value") ? error.message : `pi-setup: ${error.message}`);
    return 1;
  }
}

async function runCommand(ctx: Ctx, options: Options, prompter: Prompter | undefined): Promise<number> {
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
  const toolErrors = requiredToolErrors(ctx, detection, options);
  if (toolErrors.length && !readOnly) throw new SetupError(toolErrors.join("\n"));

  let answers: { user?: string; root?: string; profile?: string } = {};
  if (prompter) {
    const profiles = loadProfiles(ctx.repoDir);
    const activeBefore = readActive(piDir);
    const initial = pickProfile(options, activeBefore, readyProviders(detection), profiles, names);
    const result = await collectChoices(prompter, { options, saved, detection, profiles, initial, home: ctx.home, repoDir: ctx.repoDir });
    if (result === CANCEL) return cancelled(ctx);
    answers = result;
  }
  const r = resolveAll(ctx, options, detection, saved, answers, manifest);
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
  const summary = summaryLines({ ...r, detection, kimi: readOnly ? undefined : kimiNote(r.profile, r.ready), skipNpm: options.skipNpm, probed: !readOnly });
  if (options.plan) return finish(ctx, baseCtx, options, r, detection, summary, 0);
  if (prompter && !(await confirmApply(prompter, summary))) return cancelled(ctx);

  const applyOptions: ApplyOptions = {
    dryRun: options.dryRun,
    skipNpm: options.skipNpm || options.dryRun,
    reinstallNpm: options.reinstallNpm,
    inheritNpm: !prompter && !options.json,
    profile: r.choice.name,
    activeBefore: r.activeBefore,
    spinner: prompter?.spinner(),
  };
  const result = await apply(ctx, r.actions, applyOptions, manifest);
  const shown = prompter || options.json ? [] : summary.filter((l) => l.startsWith("Profile:") || l.startsWith("Kimi") || l.startsWith("warning:"));
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
