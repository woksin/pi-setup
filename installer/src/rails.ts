import { readyProviders } from "./detect.ts";
import { chooseProfile } from "./profiles.ts";
import { CANCEL, PROVIDER_IDS, PROVIDER_LABELS } from "./types.ts";
import type { ProviderState, Prompter } from "./types.ts";
import { askComponents, askLogin, askPreapproval, askProfile, askRoot } from "./wizard.ts";
import type { WizardInput, WizardResult } from "./wizard.ts";

export type RailsMode = "recommended" | "custom";
export interface RailsReview {
  summary(): string[];
  files(): string[];
  changes: boolean;
  conflicts: number;
  /** Resolve per-file decisions, updating the review without writing anything. */
  decideConflicts(): Promise<boolean>;
}
export interface RailsInput extends WizardInput {
  installed: boolean;
  activeProfile?: string;
  review(answers: WizardResult): RailsReview;
  /** Re-check one login (through ctx.run in production, injected in tests). Omitted: the logins step is status only. */
  probe?(id: string): Promise<ProviderState>;
  /** Find a command on PATH right now (ctx.which); used to notice pi installed while the step is open. */
  which?(name: string): string | undefined;
  /** Dry-run and plan never run pi probes. */
  readOnly?: boolean;
  /** Review line for the PATH edit; omitted when PATH already has both directories. */
  pathLine?: string;
  /** Whether the PATH edit starts ticked (PATH_EDIT_DEFAULT, or --edit-shell-profile). */
  pathDefault?: boolean;
}
interface Step {
  id: string;
  title: string;
  needed(mode: RailsMode, input: WizardInput): boolean;
  run(p: Prompter, input: RailsInput, state: WizardResult, customise: boolean): Promise<boolean>;
}

const saved = (input: WizardInput, key: string): string =>
  typeof input.saved[key] === "string" ? input.saved[key] as string : "";
const rootFor = (input: WizardInput, state: WizardResult = {}): string =>
  state.root || input.options.reposRoot || saved(input, "reposRoot") || input.detection.candidates[0]?.path || `${input.home}/repos`;

/** The chooser's pick follows the logins as they are now; a flag, the active profile or the user's pick stays. */
function initialFor(input: RailsInput, state: WizardResult): WizardInput["initial"] {
  if (state.profile) return { name: state.profile, reason: "you picked it", provisional: false, source: "prompt" };
  if (input.initial.source !== "chooser" || input.readOnly) return input.initial;
  return chooseProfile(readyProviders(input.detection), input.profiles);
}

function currentInput(input: RailsInput, state: WizardResult): RailsInput {
  const rows = input.extras;
  return {
    ...input,
    saved: { ...input.saved, ...(state.user ? { githubUser: state.user } : {}), ...(state.root ? { reposRoot: state.root } : {}) },
    detection: state.root ? { ...input.detection, candidates: [{ path: state.root, score: 0 }, ...input.detection.candidates.filter((c) => c.path !== state.root)] } : input.detection,
    initial: initialFor(input, state),
    extras: rows ? (root) => rows(root).map((row) => ({ ...row, initial: state.components?.[row.id] ?? row.initial })) : undefined,
    preapproveMcp: state.preapproveMcp ?? input.preapproveMcp,
  };
}

async function you(p: Prompter, input: RailsInput, state: WizardResult): Promise<boolean> {
  const login = saved(input, "githubUser") || input.detection.github.login || "not found";
  p.note(`GitHub login: ${login} — used for your scheduled-job names and to find your repos`, "You");
  const answer = await askLogin(p, input);
  if (answer === CANCEL) return false;
  if (answer !== undefined) state.user = answer;
  return true;
}

async function repos(p: Prompter, input: RailsInput, state: WizardResult): Promise<boolean> {
  p.note(`${rootFor(input)} — where lanes and Cratis checks look`, "Repositories");
  const answer = await askRoot(p, input);
  if (answer === CANCEL) return false;
  if (answer !== undefined) state.root = answer;
  return true;
}

const ROLES: Record<string, string> = {
  anthropic: "main model in most profiles",
  "openai-codex": "coding in most profiles",
  "kimi-coding": "optional, research",
};
const PI_INSTALL = "npm install -g @earendil-works/pi-coding-agent";
const LOGIN_HOWTO = "Open another terminal, run pi, type /login and pick the providers you have. Then come back here.";

function loginLines(input: RailsInput): string {
  const lines = PROVIDER_IDS.map((id) => {
    const status = input.detection.providers[id]?.status;
    const mark = status === "ready" ? "✓" : status === "not_ready" ? "✗" : "?";
    return `${PROVIDER_LABELS[id]} ${mark} (${ROLES[id]})`;
  });
  if (input.which && piMissing(input)) lines.push("", `pi is not installed yet. Install it with: ${PI_INSTALL}`);
  return lines.join("\n");
}

const piMissing = (input: RailsInput): boolean => !input.detection.tools.find((t) => t.name === "pi")?.path;

function refreshPi(input: RailsInput): void {
  const path = input.which?.("pi");
  const tools = input.detection.tools;
  const known = tools.find((t) => t.name === "pi");
  if (known) known.path = path;
  else tools.push({ name: "pi", path });
}

async function recheck(input: RailsInput): Promise<void> {
  refreshPi(input);
  const probed = await Promise.all(PROVIDER_IDS.map(async (id) => [id, await input.probe!(id)] as const));
  for (const [id, state] of probed) input.detection.providers[id] = state;
}

function loginChoice(input: RailsInput, missingPi: boolean): Parameters<Prompter["select"]>[0] & { options: { value: "continue" | "login"; label: string; hint?: string }[] } {
  const none = readyProviders(input.detection).size === 0;
  return {
    message: missingPi ? "Install pi first" : "Log in to your AI providers",
    options: [
      { value: "continue", label: "Continue", hint: none ? "installs now; log in later" : "use what is logged in" },
      { value: "login", label: missingPi ? "Check again" : "Log in now, then check again", hint: missingPi ? PI_INSTALL : LOGIN_HOWTO },
    ],
    initial: none ? "login" : "continue",
  };
}

/** Show each login, offer to log in and check again until the user continues. */
async function logins(p: Prompter, input: RailsInput): Promise<boolean> {
  if (!input.probe || input.readOnly) {
    p.note(loginLines(input), "AI logins");
    return true;
  }
  for (;;) {
    const missingPi = Boolean(input.which && piMissing(input));
    p.note(loginLines(input), "AI logins");
    const answer = await p.select(loginChoice(input, missingPi));
    if (p.isCancel(answer)) return false;
    if (answer === "continue") return true;
    if (!missingPi) p.note(LOGIN_HOWTO, "Log in");
    await recheck(input);
  }
}

async function profile(p: Prompter, input: RailsInput, state: WizardResult): Promise<boolean> {
  const answer = await askProfile(p, input);
  if (answer === CANCEL) return false;
  if (answer !== undefined) state.profile = answer;
  return true;
}

async function extras(p: Prompter, input: RailsInput, state: WizardResult, customise: boolean): Promise<boolean> {
  const root = rootFor(input, state);
  const components = customise ? await askComponents(p, input, root) : undefined;
  if (components === CANCEL) return false;
  if (components) state.components = { ...state.components, ...components };
  const trust = await askPreapproval(p, input, root, state.components);
  if (trust === CANCEL) return false;
  state.preapproveMcp = trust;
  return true;
}

function needsTrust(input: WizardInput): boolean {
  const row = input.extras?.(rootFor(input)).find((r) => r.id === "lanes");
  return Boolean(row?.initial && !row.unavailable && !input.options.preapproveMcp && !input.preapproveMcp);
}

const STEPS: Step[] = [
  { id: "you", title: "You", needed: (mode, i) => !i.options.user && (mode === "custom" || !(saved(i, "githubUser") || i.detection.github.login)), run: you },
  { id: "repos", title: "Repositories", needed: (mode, i) => mode === "custom" && !i.options.reposRoot, run: repos },
  { id: "logins", title: "AI logins", needed: (mode, i) => mode === "custom" || readyProviders(i.detection).size === 0, run: logins },
  { id: "profile", title: "Profile", needed: (mode, i) => mode === "custom" && (!i.options.profile || i.options.profile === "auto"), run: profile },
  { id: "extras", title: "Extras", needed: (mode, i) => needsTrust(i) || (mode === "custom" && Boolean(i.extras?.(rootFor(i)).some((r) => !r.fixed && !r.unavailable))), run: extras },
];

function header(p: Prompter, index: number, total: number, title: string): void {
  if (p.step) p.step(index, total, title);
  else p.note(`Step ${index} of ${total} · ${title}`);
}

async function conflicts(p: Prompter, review: RailsReview): Promise<boolean> {
  if (!review.conflicts) return true;
  const answer = await p.select({
    message: `${review.conflicts} ${review.conflicts === 1 ? "file" : "files"} you edited`,
    options: [{ value: "keep", label: "Keep yours (recommended)" }, { value: "decide", label: "Decide per file" }],
    initial: "keep",
  });
  if (p.isCancel(answer)) return false;
  return answer !== "decide" || await review.decideConflicts();
}

async function changeStep(p: Prompter, input: RailsInput, state: WizardResult, steps: Step[]): Promise<boolean> {
  const editable = STEPS.filter((step) => step.needed("custom", input));
  const answer = await p.select({
    message: "Change which step?",
    options: [...editable.map((step) => ({ value: step.id, label: step.title })), { value: "review", label: "Back to Review" }],
    initial: editable[0]?.id ?? "review",
  });
  if (p.isCancel(answer)) return false;
  const step = editable.find((s) => s.id === answer);
  if (!step) return true;
  const index = steps.findIndex((s) => s.id === step.id);
  if (index >= 0) header(p, index + 1, steps.length + 1, step.title);
  else p.note(step.title, "Change a step");
  return step.run(p, currentInput(input, state), state, true);
}

interface Session { p: Prompter; input: RailsInput; state: WizardResult; steps: Step[]; path: { on: boolean } }

async function prepareReview({ p, input, state }: Session): Promise<RailsReview | typeof CANCEL | null> {
  const review = input.review(state);
  if (input.installed && !review.changes) return null;
  return await conflicts(p, review) ? review : CANCEL;
}

async function editReview(session: Session): Promise<RailsReview | typeof CANCEL | null> {
  const { p, input, state, steps } = session;
  if (!await changeStep(p, input, state, steps)) return CANCEL;
  return prepareReview(session);
}

async function reviewChoice({ p, steps, input, path }: Session, review: RailsReview): Promise<unknown> {
  header(p, steps.length + 1, steps.length + 1, "Review");
  const pathRow = input.pathLine ? ["", `[${path.on ? "x" : " "}] ${input.pathLine}`] : [];
  p.note([...review.summary(), ...pathRow].join("\n"), "Review");
  return p.select({
    message: "Review",
    options: [
      { value: "install", label: "Install (recommended)" }, { value: "change", label: "Change a step…" },
      ...(input.pathLine ? [{ value: "path", label: path.on ? "Don't change my shell profile" : "Add the PATH entries after all" }] : []),
      { value: "files", label: "Show every file" }, { value: "cancel", label: "Cancel" },
    ],
    initial: "install",
  });
}

async function reviewLoop(session: Session): Promise<boolean> {
  const { p } = session;
  let review = await prepareReview(session);
  if (review === null) session.path.on = false; // Review was skipped, so nothing was shown to opt in to.
  while (review && review !== CANCEL) {
    const answer = await reviewChoice(session, review);
    if (p.isCancel(answer) || answer === "cancel") return false;
    if (answer === "install") return true;
    if (answer === "path") {
      session.path.on = !session.path.on;
      continue;
    }
    if (answer === "files") {
      p.note(review.files().join("\n"), "Every file");
      continue;
    }
    review = await editReview(session);
  }
  return review !== CANCEL;
}

/** The interactive engine: gather choices, review without writing, then let run.ts apply. */
export async function runRails(p: Prompter, input: RailsInput): Promise<(WizardResult & { mode: RailsMode; editPath: boolean }) | typeof CANCEL> {
  const installed = input.installed ? `pi-setup is installed (profile ${input.activeProfile ?? input.initial.name}). This updates it.` : "pi-setup sets up pi with our agents, profiles and tools.";
  p.note(`${installed}\nNothing is written until you confirm.\nCtrl-C quits at any time.`, "Welcome");
  const mode = await p.select<RailsMode>({
    message: "How do you want to set up?",
    options: [
      { value: "recommended", label: input.installed ? "Update with your current choices (recommended)" : "Use our recommended setup", hint: "detects everything, asks only what it must" },
      { value: "custom", label: input.installed ? "Change settings step by step" : "Customise step by step" },
    ],
    initial: "recommended",
  });
  if (p.isCancel(mode)) return CANCEL;
  const selected = mode as RailsMode;
  const steps = STEPS.filter((step) => step.needed(selected, input));
  const state: WizardResult = {};
  for (const [index, step] of steps.entries()) {
    header(p, index + 1, steps.length + 1, step.title);
    if (!await step.run(p, currentInput(input, state), state, selected === "custom")) return CANCEL;
  }
  const path = { on: Boolean(input.pathLine) && input.pathDefault === true };
  if (!await reviewLoop({ p, input, state, steps, path })) return CANCEL;
  return { ...state, mode: selected, editPath: path.on };
}
