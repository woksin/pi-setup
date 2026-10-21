/**
 * ai-work-lifecycle — keeps disposable workspace handling explicit and safety-checked.
 * Static guidance uses a structured prompt section on every run so notifications
 * do not rewrite the cached system prefix; dynamic task notices stay in the UI.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const launcher = join(homedir(), ".local", "bin", "ai-work-lifecycle");
const DAY = 24 * 3600;
const guidance = "Before creating disposable task outputs, read the ai-work-lifecycle skill for the CLI, layout and cleanup limits. Global rules in AGENTS.md govern artifact placement and destructive-action safety.";

async function workRoot(ctx: ExtensionContext): Promise<string | undefined> {
  let directory = ctx.cwd;
  try {
    const result = await exec("git", ["--no-optional-locks", "-C", ctx.cwd, "rev-parse", "--show-toplevel"], { timeout: 5000, maxBuffer: 65536 });
    directory = result.stdout.trim();
  } catch {
    // Non-repository home sessions may also have a local .ai-work directory.
  }
  const root = join(directory, ".ai-work");
  try {
    const info = await lstat(root);
    return info.isDirectory() && !info.isSymbolicLink() ? root : undefined;
  } catch { return undefined; }
}

export default function (pi: ExtensionAPI) {
  // Identical structured guidance for user/custom runs; no forced prompt rewrite.
  // Dynamic unfinished-task state stays in the existing session_start UI notification.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["ai_work_lifecycle_guidance"] = guidance;
  });
  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    const root = await workRoot(ctx);
    ctx.ui.setStatus("ai-work-lifecycle", root ? "ai-work: /ai-work" : undefined);
    if (!root || event.reason === "reload") return;
    try {
      const result = await exec(launcher, ["--root", root, "unfinished", "--older-than", String(DAY)], { cwd: ctx.cwd, timeout: 30000, maxBuffer: 1048576 });
      const stale: { task: string; state: string; age_seconds: number }[] = JSON.parse(result.stdout).unfinished ?? [];
      if (!stale.length) return;
      const listed = stale.slice(0, 8).map((t) => `${t.task} (${t.state}, ${Math.floor(t.age_seconds / DAY)}d)`).join(", ");
      const repo = root.replace(/\/\.ai-work$/, "");
      ctx.ui.notify(`ai-work: ${stale.length} unfinished task(s) older than 24h in this repo: ${listed}${stale.length > 8 ? ", ..." : ""}. Nothing finishes automatically. If genuinely done: ai-work-lifecycle --repo ${repo} finish TASK (preview), then finish TASK --apply (or /ai-work finish TASK). To keep it: ai-work-lifecycle --repo ${repo} state TASK paused.`, "info");
    } catch { /* report only; never block startup */ }
  });
  // A session can exit, reload, fork or resume while its task is unfinished, and Pi
  // emits reason "quit" for signals, terminal close and print-mode errors too.
  // Deliberately do not mark completion, release worker leases or delete on shutdown.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("ai-work-lifecycle", undefined);
  });
  pi.registerCommand("ai-work", {
    description: "AI task workspaces: start/finish; status/plan/apply for registered outputs",
    handler: async (args, ctx) => {
      const [action = "status", task, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (!["start", "finish", "status", "plan", "apply"].includes(action) || extra.length || (task && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task)) || (["start", "finish"].includes(action) && !task)) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /ai-work start|finish <task>, or /ai-work status|plan|apply [task].", "warning");
        return;
      }
      const root = await workRoot(ctx);
      if (!root) {
        if (ctx.hasUI) ctx.ui.notify("No real .ai-work directory in this checkout; nothing to clean.", "info");
        return;
      }
      // No shell parsing; arbitrary command-line arguments are not accepted.
      if (action === "start" || action === "finish") {
        try {
          if (!ctx.hasUI) throw new Error("Use the CLI for non-interactive workspace changes.");
          const args = ["--root", root, action, task!, ...(action === "start" ? ["--owner-pid", String(process.pid)] : [])];
          const result = await exec(launcher, args, {cwd: ctx.cwd, timeout: 120000, maxBuffer: 33554432});
          if (result.stdout.length > 12000) throw new Error("Result too large to review here; use the CLI.");
          pi.sendMessage({customType: "ai-work-lifecycle", content: result.stdout, display: true}, {triggerTurn: false});
          if (action === "start") return;
          const preview = JSON.parse(result.stdout);
          if (preview.status === "blocked") { ctx.ui.notify(`Task cannot finish: ${preview.reason ?? "safety check blocked"}`, "warning"); return; }
          if (preview.status === "already-cleaned") { ctx.ui.notify("Task already cleaned.", "info"); return; }
          if (!["ready-to-finish", "eligible"].includes(preview.status)) throw new Error("Unexpected finish preview; nothing applied.");
          if (!await ctx.ui.confirm("Finish task and clean disposable outputs?", `Task: ${task}\nRoot: ${root}\nConfirm the task is complete and all workers have stopped. Only its registered cache/output files may be removed; keep/ is retained. Fresh safety checks still apply.`)) return;
          const applied = await exec(launcher, [...args, "--apply"], {cwd: ctx.cwd, timeout: 120000, maxBuffer: 33554432});
          pi.sendMessage({customType: "ai-work-lifecycle", content: applied.stdout.length > 12000 ? `${applied.stdout.slice(0, 12000)}\n[Full receipt remains in .ai-work/.lifecycle.]` : applied.stdout, display: true}, {triggerTurn: false});
        } catch (error) {
          if (ctx.hasUI) ctx.ui.notify(`AI work lifecycle stopped: ${String(error).slice(0, 1000)}`, "error");
          else throw error;
        }
        return;
      }
      const argv = ["--root", root, action === "status" ? "inventory" : "sweep", ...(task ? ["--task", task] : [])];
      try {
        if (action === "apply" && !ctx.hasUI) throw new Error("Apply requires interactive confirmation; use the explicit CLI procedure instead.");
        const preview = await exec(launcher, argv, { cwd: ctx.cwd, timeout: 120000, maxBuffer: 33554432 });
        const plan = JSON.parse(preview.stdout);
        if (!Array.isArray(plan.tasks) || !/^[a-f0-9]{64}$/.test(plan.fingerprint)) throw new Error("Invalid lifecycle plan; nothing applied.");
        const summary = JSON.stringify({root, fingerprint: plan.fingerprint, tasks: plan.tasks.map((t: any) => ({task: t.task, status: t.status, reason: t.reason, paths: t.paths, entries: t.entries})), note: plan.note}, null, 2);
        pi.sendMessage({ customType: "ai-work-lifecycle", content: summary.length > 12000 ? `${summary.slice(0, 12000)}\n[Display truncated; review the full plan with the CLI. Apply disabled here.]` : summary, display: true }, { triggerTurn: false });
        if (action !== "apply") return;
        if (summary.length > 12000) throw new Error("Plan too large for complete display; narrow to one task or review via CLI.");
        if (plan.tasks.some((t: any) => t.status === "blocked")) throw new Error("Blocked tasks remain; use /ai-work apply <task> to narrow the plan.");
        if (!plan.tasks.some((t: any) => t.status === "eligible")) { ctx.ui.notify("Nothing eligible to delete.", "info"); return; }
        const confirmed = await ctx.ui.confirm("Purge completed disposable artifacts?", `Root: ${root}\nOnly the exact registered paths shown above will be considered. Source, worktrees and unregistered files are not deleted. The reviewed fingerprint must still match and all safety checks run again.`);
        if (!confirmed) return;
        const applied = await exec(launcher, [...argv, "--apply", "--expect", plan.fingerprint], { cwd: ctx.cwd, timeout: 120000, maxBuffer: 33554432 });
        pi.sendMessage({ customType: "ai-work-lifecycle", content: applied.stdout.length > 12000 ? `${applied.stdout.slice(0, 12000)}\n[Display truncated; full receipts remain in .ai-work/.lifecycle.]` : applied.stdout, display: true }, { triggerTurn: false });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`AI work lifecycle stopped: ${detail.slice(0, 1000)}`, "error");
        else throw error;
      }
    },
  });
}
