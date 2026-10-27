import { PROVIDER_IDS, PROVIDER_LABELS } from "./types.ts";
import type { Action, Detection, ProfileMeta } from "./types.ts";
import { COMPONENTS } from "./components.ts";
import type { ComponentChoice } from "./components.ts";
import type { Choice } from "./profiles.ts";
import type { ResolvedSettings } from "./settings.ts";

const USER_SOURCES = { flag: "from --user", saved: "saved in user.json", detected: "from gh", prompt: "you typed it", placeholder: "placeholder, pass --user" };
const ROOT_SOURCES = { flag: "from --repos-root", saved: "saved in user.json", scan: "best match found", default: "default", prompt: "you typed it" };

export function countActions(actions: Action[]): { added: number; changed: number; kept: number; register: number; links: number } {
  const installs = actions.filter((a): a is Extract<Action, { op: "install" }> => a.op === "install");
  return {
    added: installs.filter((a) => !a.existed).length,
    changed: installs.filter((a) => a.existed).length,
    kept: actions.filter((a) => a.op === "keep").length,
    register: actions.filter((a) => a.op === "register").length,
    links: actions.filter((a) => a.op === "symlink").length,
  };
}

export function detectionLines(detection: Detection, probed = true): string[] {
  const lines = [`OS: ${detection.os}`];
  lines.push(`Tools: ${detection.tools.map((t) => `${t.name} ${t.path ? "✓" : "✗"}`).join(", ")}`);
  const github = detection.github;
  lines.push(`GitHub: ${github.login ? `${github.login}${github.host ? ` on ${github.host}` : ""}` : "no login found"}`);
  if (!probed) lines.push("Providers: not probed in dry-run (pi probes can write state)");
  else lines.push(
    "Providers: " +
      PROVIDER_IDS.map((id) => `${PROVIDER_LABELS[id]} ${symbol(detection.providers[id]?.status)}`).join(", "),
  );
  return lines;
}

function symbol(status: string | undefined): string {
  if (status === "ready") return "✓";
  return status === "not_ready" ? "✗" : "?";
}

export const KEPT_EDITS = "kept your edits; `pi-profile save` to adopt them into the profile";

export function summaryLines(args: {
  settings: ResolvedSettings;
  detection: Detection;
  choice: Choice;
  profile: ProfileMeta | undefined;
  actions: Action[];
  probed: boolean;
  /** False in the guided flow, which already showed "What I found". */
  withDetection?: boolean;
  npm: boolean;
  skipNpm: boolean;
  kimi: string | undefined;
  warnings: string[];
  components?: ComponentChoice;
  componentNotes?: string[];
}): string[] {
  const { settings, choice, actions } = args;
  const counts = countActions(actions);
  const lines = [
    `GitHub login: ${settings.githubUser} (${USER_SOURCES[settings.userSource]})`,
    `Repositories root: ${settings.reposRoot} (${ROOT_SOURCES[settings.rootSource]})`,
    ...(args.withDetection === false ? [] : detectionLines(args.detection, args.probed)),
    `Profile: ${choice.name} (${choice.reason})${choice.provisional ? " [provisional]" : ""}`,
  ];
  if (args.profile?.summary) lines.push(args.profile.summary);
  if (args.kimi) lines.push(args.kimi);
  lines.push(
    `Files: ${counts.added} new, ${counts.changed} changed${counts.kept ? `, ${counts.kept} kept (changed by you)` : ""}${counts.register ? ", register pi-questions" : ""}`,
    `npm install: ${args.skipNpm ? "skipped (--skip-npm)" : args.npm ? "yes" : "up to date"}`,
  );
  if (args.components) {
    const word = (id: string): string => `${COMPONENTS.find((c) => c.id === id)?.label} ${args.components?.[id]?.on ? "on" : "off"}`;
    lines.push(`Extras: ${COMPONENTS.map((c) => word(c.id)).join(", ")}`);
  }
  const kept = actions.filter((a) => a.op === "keep");
  if (kept.some((a) => /\/\.pi\/agent\/(agents\/[^/]+\.md|workflows\/[^/]+\.js)$/.test(a.path))) {
    lines.push(KEPT_EDITS);
  }
  if (kept.some((a) => a.op === "keep" && a.noMarkers)) {
    lines.push("AGENTS.md has no pi-profile routing markers, so it is reconciled as a whole file; the new version is in AGENTS.md.pi-setup-new");
  }
  lines.push(...(args.componentNotes ?? []));
  for (const warning of args.warnings.filter((w) => w !== args.kimi)) lines.push(`warning: ${warning}`);
  return lines;
}

export interface NextSteps {
  /** ~/.local/bin or ~/.pi/agent/bin was not on PATH before this run. */
  pathMissing: boolean;
  pathEdited: boolean;
  logins: string[];
  lanesOffered: boolean;
  /** Path of a Homebrew the bootstrap just installed; the shell profile needs its shellenv line. */
  brewShellenv?: string;
}

/** The guided flow's "What's next" note, one action per line. */
export function whatsNextLines(next: NextSteps): string[] {
  const lines: string[] = [];
  if (next.pathMissing) {
    lines.push(next.pathEdited ? "Open a new terminal so the PATH change takes effect." : "Add ~/.local/bin and ~/.pi/agent/bin to PATH, then open a new terminal.");
  }
  if (next.brewShellenv) lines.push(`Add to your shell profile: eval "$(${next.brewShellenv} shellenv)"`);
  lines.push("Start pi: pi");
  if (next.logins.length) lines.push(`Log in: in pi, type /login for ${next.logins.join(", ")}`);
  lines.push("Switch profile: pi-profile list, or ./install.sh --profile <name>");
  lines.push("Check health any time: ./install.sh doctor");
  if (next.lanesOffered) lines.push("Optional: set up a coordinator and lanes (offered next; or later with ./install.sh lanes)");
  return lines;
}
