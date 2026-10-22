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
}

export interface WizardResult {
  user?: string;
  root?: string;
  profile?: string;
}

type Answer<T> = T | typeof CANCEL;

const savedString = (saved: Record<string, unknown>, key: string): string =>
  typeof saved[key] === "string" ? (saved[key] as string) : "";

async function askLogin(p: Prompter, input: WizardInput): Promise<Answer<string | undefined>> {
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

async function askRoot(p: Prompter, input: WizardInput): Promise<Answer<string | undefined>> {
  if (input.options.reposRoot) return undefined;
  const picked = await p.select<string>({
    message: "Where are your repositories?",
    options: rootOptions(input),
    initial: input.detection.candidates[0]?.path ?? savedString(input.saved, "reposRoot"),
  });
  if (p.isCancel(picked)) return CANCEL;
  if (picked) return picked;
  const typed = await p.text({ message: "Repositories root", initial: `${input.home}/repos`, validate: validateRoot(input) });
  return p.isCancel(typed) ? CANCEL : expandHome((typed as string).trim(), input.home);
}

async function askProfile(p: Prompter, input: WizardInput): Promise<Answer<string | undefined>> {
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

/** Ask only what detection and flags could not settle. Returns CANCEL when the user backs out. */
export async function collectChoices(p: Prompter, input: WizardInput): Promise<Answer<WizardResult>> {
  p.note(detectionLines(input.detection).join("\n"), "What I found");
  const user = await askLogin(p, input);
  if (p.isCancel(user)) return CANCEL;
  const root = await askRoot(p, input);
  if (p.isCancel(root)) return CANCEL;
  const profile = await askProfile(p, input);
  if (p.isCancel(profile)) return CANCEL;
  return { user: user as string | undefined, root: root as string | undefined, profile: profile as string | undefined };
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
