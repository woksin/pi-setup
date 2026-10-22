import { PROVIDER_IDS, PROVIDER_LABELS } from "./types.ts";
import type { Action, Detection, ProfileMeta } from "./types.ts";
import type { Choice } from "./profiles.ts";
import type { ResolvedSettings } from "./settings.ts";

const USER_SOURCES = { flag: "from --user", saved: "saved in user.json", detected: "from gh", prompt: "you typed it" };
const ROOT_SOURCES = { flag: "from --repos-root", saved: "saved in user.json", scan: "best match found", default: "default", prompt: "you typed it" };

export function countActions(actions: Action[]): { added: number; changed: number; register: number; links: number } {
  const installs = actions.filter((a): a is Extract<Action, { op: "install" }> => a.op === "install");
  return {
    added: installs.filter((a) => !a.existed).length,
    changed: installs.filter((a) => a.existed).length,
    register: actions.filter((a) => a.op === "register").length,
    links: actions.filter((a) => a.op === "symlink").length,
  };
}

export function detectionLines(detection: Detection): string[] {
  const lines = [`OS: ${detection.os}`];
  lines.push(`Tools: ${detection.tools.map((t) => `${t.name} ${t.path ? "✓" : "✗"}`).join(", ")}`);
  const github = detection.github;
  lines.push(`GitHub: ${github.login ? `${github.login}${github.host ? ` on ${github.host}` : ""}` : "no login found"}`);
  lines.push(
    "Providers: " +
      PROVIDER_IDS.map((id) => `${PROVIDER_LABELS[id]} ${symbol(detection.providers[id]?.status)}`).join(", "),
  );
  return lines;
}

function symbol(status: string | undefined): string {
  if (status === "ready") return "✓";
  return status === "not_ready" ? "✗" : "?";
}

export function summaryLines(args: {
  settings: ResolvedSettings;
  detection: Detection;
  choice: Choice;
  profile: ProfileMeta | undefined;
  actions: Action[];
  npm: boolean;
  skipNpm: boolean;
  kimi: string | undefined;
  warnings: string[];
}): string[] {
  const { settings, choice, actions } = args;
  const counts = countActions(actions);
  const lines = [
    `GitHub login: ${settings.githubUser} (${USER_SOURCES[settings.userSource]})`,
    `Repositories root: ${settings.reposRoot} (${ROOT_SOURCES[settings.rootSource]})`,
    ...detectionLines(args.detection),
    `Profile: ${choice.name} (${choice.reason})${choice.provisional ? " [provisional]" : ""}`,
  ];
  if (args.profile?.summary) lines.push(args.profile.summary);
  if (args.kimi) lines.push(args.kimi);
  lines.push(
    `Files: ${counts.added} new, ${counts.changed} changed${counts.register ? ", register pi-questions" : ""}`,
    `npm install: ${args.skipNpm ? "skipped (--skip-npm)" : args.npm ? "yes" : "up to date"}`,
  );
  for (const warning of args.warnings.filter((w) => w !== args.kimi)) lines.push(`warning: ${warning}`);
  return lines;
}
