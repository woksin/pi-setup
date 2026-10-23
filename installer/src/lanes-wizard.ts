import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandHome } from "./settings.ts";
import { CANCEL, type Prompter } from "./types.ts";
import type { Checkout } from "./repos-scan.ts";
export interface Issue { number: number; title: string; mine: boolean }
export interface LanesInput {
  dir?: string; existingIdsFor?: (dir: string) => string[]; reposRoot: string; existingIds: string[]; checkouts: Checkout[];
  issues: (repo: string) => Promise<Issue[] | undefined>; home: string;
}
export interface LanesChoice { dir: string; lanes: { id: string; repo: string; path: string; issue?: number; goal?: string }[] }
export async function collectLanes(p: Prompter, input: LanesInput): Promise<LanesChoice | typeof CANCEL> {
  let dir = input.dir;
  if (!dir) {
    const initial = join(input.reposRoot, ".lanes");
    const answer = await p.select({ message: "Workspace folder", initial, options: [
      { value: initial, label: initial, hint: existsSync(join(initial, "lanes.json")) ? "existing" : "new" }, { value: "other", label: "Other…" },
    ] });
    if (p.isCancel(answer)) return CANCEL;
    if (answer === "other") {
      const path = await p.text({ message: "Workspace folder (absolute or ~/)", validate: (v) => isAbsolute(expandHome(v, input.home)) ? undefined : "Use an absolute path or ~/" });
      if (p.isCancel(path)) return CANCEL;
      dir = expandHome(path as string, input.home);
    } else dir = answer as string;
  }
  const repos = await p.multiselect({ message: "Repositories for lanes", initial: [], options: input.checkouts.map((c) => ({ value: c.path, label: c.repo, hint: c.path })) });
  if (p.isCancel(repos)) return CANCEL;
  if (!(repos as string[]).length) { p.note("No repositories selected."); return CANCEL; }
  const ids = new Set(input.existingIdsFor?.(dir) ?? input.existingIds); const lanes: LanesChoice["lanes"] = [];
  for (const path of repos as string[]) {
    const checkout = input.checkouts.find((c) => c.path === path)!;
    const issues = await input.issues(checkout.repo); let issue: number | undefined;
    if (issues?.length) {
      const answer = await p.select({ message: `Work for ${checkout.repo}`, initial: "goal", options: [
        ...[...issues].sort((a, b) => Number(b.mine) - Number(a.mine)).slice(0, 15).map((i) => ({ value: String(i.number), label: `#${i.number} ${i.title}`.slice(0, 60) })),
        { value: "goal", label: "Type a goal…" }, { value: "skip", label: "Skip this repository" },
      ] });
      if (p.isCancel(answer)) return CANCEL;
      if (answer === "skip") continue;
      if (answer !== "goal") issue = Number(answer);
    } else p.note(`No issues available for ${checkout.repo}; type a goal instead.`);
    let goal: string | undefined;
    if (!issue) {
      const answer = await p.text({ message: `Goal for ${checkout.repo}`, validate: (v) => v.trim() ? undefined : "Required" });
      if (p.isCancel(answer)) return CANCEL;
      goal = (answer as string).trim();
    }
    let n = 1; while (ids.has(`L${n}`)) n++;
    const id = `L${n}`; ids.add(id); lanes.push({ ...checkout, id, ...(issue ? { issue } : { goal }) });
  }
  if (!lanes.length) { p.note("No lanes selected."); return CANCEL; }
  p.note([`Folder: ${dir}`, ...lanes.map((l) => `${l.id}  ${l.repo}  ${l.issue ? `issue #${l.issue}` : `goal: ${l.goal}`}`), `Worktrees: ${join(input.reposRoot, ".worktrees")}`].join("\n"), "Preview");
  const confirmed = await p.confirm({ message: "Create these lanes?", initial: true });
  return !p.isCancel(confirmed) && confirmed === true ? { dir, lanes } : CANCEL;
}
