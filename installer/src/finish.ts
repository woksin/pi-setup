import { join } from "node:path";
import { apply } from "./apply.ts";
import type { ApplyOptions, ApplyResult } from "./apply.ts";
import type { Options } from "./args.ts";
import { compactChecks, installChecks } from "./doctor.ts";
import type { ComponentRecord, Manifest } from "./manifest.ts";
import { missingLogins } from "./profiles.ts";
import { whatsNextLines } from "./report.ts";
import { retire } from "./retire.ts";
import { syncServices } from "./services.ts";
import { configureShellPath, missingBinDirs } from "./shell-path.ts";
import type { Action, Ctx, Detection, ProfileMeta, Prompter } from "./types.ts";

/** What the apply step needs from the resolved install; run.ts passes its Resolved straight in. */
export interface ApplyRun {
  ctx: Ctx;
  options: Options;
  r: { actions: Action[]; records: Record<string, ComponentRecord> };
  applyOptions: ApplyOptions;
  manifest: Manifest | undefined;
  off: string[];
  editPath: boolean;
}

const installedPaths = (r: ApplyRun["r"]): Set<string> => new Set(r.actions.filter((a) => a.op === "install").map((a) => a.path));

export async function applyPlain({ ctx, options, r, applyOptions, manifest, off, editPath }: ApplyRun): Promise<ApplyResult> {
  const live = await retire(ctx, join(ctx.home, ".pi", "agent"), manifest, off, options.dryRun);
  const result = await apply(ctx, r.actions, applyOptions, live);
  if (result.code === 0) {
    await syncServices(ctx, r.records, installedPaths(r), options.dryRun);
    configureShellPath(ctx, editPath, options.dryRun || options.plan);
  }
  return result;
}

type Spin = ReturnType<Prompter["spinner"]>;

async function applySteps(run: ApplyRun, quiet: Ctx, spin: Spin): Promise<ApplyResult> {
  const { ctx, options, r, applyOptions, manifest, off, editPath } = run;
  const live = await retire(quiet, join(ctx.home, ".pi", "agent"), manifest, off, options.dryRun);
  const result = await apply(quiet, r.actions, { ...applyOptions, spinner: spin }, live);
  if (result.code !== 0) return result;
  if (Object.values(r.records).some((c) => c.on && c.service?.managed)) spin.message?.("Setting up schedules");
  await syncServices(quiet, r.records, installedPaths(r), options.dryRun);
  if (editPath && missingBinDirs(ctx).length) spin.message?.("Adding PATH entries");
  configureShellPath(quiet, editPath, options.dryRun, true);
  return result;
}

const spinnerEnd = (result: ApplyResult | undefined, dryRun: boolean): string =>
  result?.code !== 0 ? "Install did not finish" : dryRun ? "Dry run finished" : "Installed";

/** Apply behind one spinner; anything the steps print is held until the spinner stops so the screen stays clean. */
export async function applyGuided(run: ApplyRun, p: Prompter): Promise<ApplyResult> {
  const { ctx } = run;
  const held: { out: string[]; err: string[] } = { out: [], err: [] };
  const quiet: Ctx = { ...ctx, out: (line) => held.out.push(line), err: (line) => held.err.push(line) };
  const spin = p.spinner();
  spin.start("Backing up your current files");
  let result: ApplyResult | undefined;
  try {
    result = await applySteps(run, quiet, spin);
  } finally {
    spin.stop(spinnerEnd(result, run.options.dryRun));
    held.out.forEach((line) => ctx.out(line));
    held.err.forEach((line) => ctx.err(line));
  }
  return result;
}

export interface GuidedEnd {
  ctx: Ctx;
  options: Options;
  detection: Detection;
  profile: ProfileMeta | undefined;
  ready: Set<string>;
  pathMissing: boolean;
  editPath: boolean;
  offerLanes: boolean;
}

/** The "Still to finish" and "What's next" notes; returns how many things are left. */
export function guidedNotes(p: Prompter, e: GuidedEnd): number {
  const pathEdited = e.editPath && e.pathMissing;
  const compact = compactChecks(installChecks(e.ctx, e.detection), { home: e.ctx.home, skipNpm: e.options.skipNpm, pathEdited });
  if (compact.lines.length) p.note(compact.lines.join("\n"), "Still to finish");
  const logins = [...new Set([...missingLogins(e.profile, e.ready), ...compact.logins])];
  p.note(whatsNextLines({ pathMissing: e.pathMissing, pathEdited, logins, lanesOffered: e.offerLanes, brewShellenv: e.ctx.env.PI_SETUP_BREW_SHELLENV }).join("\n"), "What's next");
  return compact.count;
}

export function lanesOffered(
  r: { components: { lanes: { on: boolean } }; settings: { reposRoot: string } }, options: Options, ok: boolean,
): boolean {
  return ok && !options.dryRun && !options.plan && r.components.lanes.on;
}
