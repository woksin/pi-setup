import type { Detection, ProfileMeta, Prompter } from "./types.ts";
import type { Choice } from "./profiles.ts";
import type { Options } from "./args.ts";
import { detectionLines } from "./report.ts";
import { expandHome, normalizeRoot, validLogin } from "./settings.ts";
import { CANCEL, SetupError } from "./types.ts";

export interface WizardInput {
  options: Options;
  saved: Record<string, unknown>;
  detection: Detection;
  profiles: ProfileMeta[];
  initial: Choice;
  home: string;
  repoDir: string;
  /** The extras for a repositories root: initial value and why, or the reason one is unavailable. Omitted: no question. */
  extras?: (root: string) => ExtraRow[];
  /** Saved trust choice from installed defaults or the current coordination folder. */
  preapproveMcp?: boolean;
}

export interface ExtraRow {
  id: string;
  label: string;
  hint: string;
  initial: boolean;
  /** Why it cannot be chosen here. */
  unavailable?: string;
  /** Set by --with / --without: not asked. */
  fixed?: boolean;
}

export interface WizardResult {
  preapproveMcp?: boolean;
  /** Extras the user chose; only the ids that were asked. */
  components?: Record<string, boolean>;
  user?: string;
  root?: string;
  profile?: string;
}

type Answer<T> = T | typeof CANCEL;

const savedString = (saved: Record<string, unknown>, key: string): string =>
  typeof saved[key] === "string" ? (saved[key] as string) : "";

export async function askLogin(p: Prompter, input: WizardInput): Promise<Answer<string | undefined>> {
  if (input.options.user) return undefined;
  const known = savedString(input.saved, "githubUser") || input.detection.github.login || "";
  if (known) {
    const keep = await p.confirm({ message: `Use GitHub login ${known}?`, initial: true });
    if (p.isCancel(keep)) return CANCEL;
    if (keep === true) return known;
  }
  const typed = await p.text({
    message: "GitHub login",
    initial: known,
    validate: (value) => (validLogin(value.trim()) ? undefined : "Enter a valid GitHub login"),
  });
  return p.isCancel(typed) ? CANCEL : (typed as string).trim();
}

function rootOptions(input: WizardInput): { value: string; label: string; hint?: string }[] {
  const saved = savedString(input.saved, "reposRoot");
  const list = input.detection.candidates.map((c) => ({ value: c.path, label: c.path, hint: `${c.score} repositories` }));
  if (saved && !list.some((c) => c.value === saved)) list.push({ value: saved, label: saved, hint: "saved" });
  list.push({ value: "", label: "Other…", hint: "type a path" });
  return list;
}

function validateRoot(input: WizardInput): (value: string) => string | undefined {
  return (value) => {
    try {
      normalizeRoot(value.trim() || "x", input.home, input.repoDir);
      return value.trim() ? undefined : "Enter a path";
    } catch (error) {
      return error instanceof SetupError ? error.message : String(error);
    }
  };
}

/** Accepting the pre-selected root is not "typing it": leave it to the saved or scanned source. */
function keepsDefaultRoot(input: WizardInput, picked: string): boolean {
  const saved = savedString(input.saved, "reposRoot");
  const initial = input.detection.candidates[0]?.path ?? saved;
  return picked === initial && (!saved || saved === picked);
}

export async function askRoot(p: Prompter, input: WizardInput): Promise<Answer<string | undefined>> {
  if (input.options.reposRoot) return undefined;
  const picked = await p.select<string>({
    message: "Where are your repositories?",
    options: rootOptions(input),
    initial: input.detection.candidates[0]?.path ?? savedString(input.saved, "reposRoot"),
  });
  if (p.isCancel(picked)) return CANCEL;
  if (picked) return keepsDefaultRoot(input, picked) ? undefined : picked;
  const typed = await p.text({ message: "Repositories root", initial: `${input.home}/repos`, validate: validateRoot(input) });
  return p.isCancel(typed) ? CANCEL : expandHome((typed as string).trim(), input.home);
}

export async function askProfile(p: Prompter, input: WizardInput): Promise<Answer<string | undefined>> {
  if (input.options.profile && input.options.profile !== "auto") return undefined;
  const { initial } = input;
  const answer = await p.select<"keep" | "change">({
    message: `Profile ${initial.name}: ${initial.reason}`,
    options: [{ value: "keep", label: "Looks right" }, { value: "change", label: "Change…" }],
    initial: "keep",
  });
  if (p.isCancel(answer)) return CANCEL;
  if (answer === "keep") return undefined;
  const chosen = await p.select<string>({
    message: "Pick a profile",
    options: input.profiles.map((m) => ({ value: m.name, label: m.name, hint: m.summary })),
    initial: initial.name,
  });
  return p.isCancel(chosen) ? CANCEL : chosen;
}

export async function askComponents(p: Prompter, input: WizardInput, root: string): Promise<Answer<Record<string, boolean> | undefined>> {
  const rows = input.extras?.(root) ?? [];
  const missing = rows.filter((r) => r.unavailable && !r.fixed);
  if (missing.length) p.note(missing.map((r) => `${r.label}: not available (${r.unavailable})`).join("\n"), "Extras not available here");
  const asked = rows.filter((r) => !r.unavailable && !r.fixed);
  if (asked.length === 0) return undefined;
  const picked = await p.multiselect<string>({
    message: "Extras",
    options: asked.map((r) => ({ value: r.id, label: r.label, hint: r.hint })),
    initial: asked.filter((r) => r.initial).map((r) => r.id),
  });
  if (p.isCancel(picked)) return CANCEL;
  const chosen = new Set(picked as string[]);
  return Object.fromEntries(asked.map((r) => [r.id, chosen.has(r.id)]));
}

function lanesEnabled(input: WizardInput, root: string, components?: Record<string, boolean>): boolean {
  const row = input.extras?.(root).find((r) => r.id === "lanes");
  if (row?.unavailable) return false;
  return Boolean(components?.lanes ?? row?.initial);
}

/** The lanes trust choice belongs to Extras, including when lanes is fixed by a flag. */
export async function askPreapproval(
  p: Prompter, input: WizardInput, root: string, components?: Record<string, boolean>,
): Promise<Answer<boolean | undefined>> {
  if (!lanesEnabled(input, root, components)) return undefined;
  if (input.options.preapproveMcp || input.preapproveMcp) return true;
  const answer = await p.confirm({ message: "Preapprove project MCP servers? This trusts project MCP server definitions in added repositories.", initial: false });
  return p.isCancel(answer) ? CANCEL : answer === true;
}

/** Ask only what detection and flags could not settle. Returns CANCEL when the user backs out. */
export async function collectChoices(p: Prompter, input: WizardInput): Promise<Answer<WizardResult>> {
  p.note(detectionLines(input.detection).join("\n"), "What I found");
  const user = await askLogin(p, input);
  if (p.isCancel(user)) return CANCEL;
  const root = await askRoot(p, input);
  if (p.isCancel(root)) return CANCEL;
  const profile = await askProfile(p, input);
  if (p.isCancel(profile)) return CANCEL;
  const reposRoot = (root as string | undefined) || input.options.reposRoot || savedString(input.saved, "reposRoot") ||
    input.detection.candidates[0]?.path || `${input.home}/repos`;
  const components = await askComponents(p, input, reposRoot);
  if (p.isCancel(components)) return CANCEL;
  const preapproveMcp = await askPreapproval(p, input, reposRoot, components as Record<string, boolean> | undefined);
  if (preapproveMcp === CANCEL) return CANCEL;
  return {
    ...(preapproveMcp === undefined ? {} : { preapproveMcp }),
    user: user as string | undefined, root: root as string | undefined, profile: profile as string | undefined,
    ...(components ? { components: components as Record<string, boolean> } : {}),
  };
}

export async function confirmApply(p: Prompter, summary: string[]): Promise<boolean> {
  p.note(summary.join("\n"), "Plan");
  const answer = await p.confirm({ message: "Apply?", initial: true });
  return !p.isCancel(answer) && answer === true;
}

const TAKE = "take";

/**
 * Ask, per user-changed file, what to do. Returns the paths to overwrite (with a backup);
 * every other conflict stays kept. CANCEL when the user backs out.
 */
export async function resolveConflicts<C extends { path: string; newPath: string }>(
  p: Prompter, conflicts: C[], showDiff: (c: C) => Promise<string>,
): Promise<Set<string> | typeof CANCEL> {
  const takes = new Set<string>();
  let keepRest = false;
  for (const conflict of conflicts) {
    if (keepRest) break;
    let withDiff = true;
    for (;;) {
      const options: { value: "keep" | "take" | "diff" | "keep-all"; label: string }[] = [
        { value: "keep", label: `Keep mine (new version goes to ${conflict.newPath})` },
        { value: TAKE, label: "Take the new version (yours is backed up)" },
        ...(withDiff ? [{ value: "diff" as const, label: "Show the diff" }] : []),
        { value: "keep-all", label: "Keep mine for all remaining" },
      ];
      const answer = await p.select({ message: `${conflict.path} changed since install`, options, initial: "keep" });
      if (p.isCancel(answer)) return CANCEL;
      if (answer === "diff") {
        p.note(await showDiff(conflict), conflict.path);
        withDiff = false;
        continue;
      }
      if (answer === TAKE) takes.add(conflict.path);
      if (answer === "keep-all") keepRest = true;
      break;
    }
  }
  return takes;
}
