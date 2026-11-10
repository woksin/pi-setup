import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { backendFor, type MessageRef } from "../backend.ts";
import { saveConfig, UsageError, type Config } from "../config.ts";
import type { LanesCtx } from "../ctx.ts";
import { validId } from "../names.ts";
import { alive, descendants } from "../processes.ts";
import { idleMinutes, laneTarget, piIn } from "../sessions.ts";
import { clean, closedLine } from "../status-line.ts";
import { shellQuote } from "../terminal.ts";
import { tryRemove } from "./close-remove.ts";
import { nudge } from "./nudge.ts";
function closeBody(id: string, to: string | undefined, reason: string | undefined, unread: MessageRef[] | undefined): string {
  const body = [`Lane ${id} is closed.${to ? ` Reassigned to ${to}.` : ""}${reason ? ` Reason: ${clean(reason)}` : ""}`, "",
    `${to ? `${to}: pick up` : "Pick up"} the work and any unread messages of ${id}. No message file was moved or edited.`, ""];
  if (unread === undefined) body.push(`Unread inbox of ${id}: none known (${id}-inbox.marker does not exist).`);
  else if (unread.length) body.push(`Unread inbox files of ${id} (newer than ${id}-inbox.marker):`, ...unread.map((m) => `- ${m.name}`));
  else body.push(`Unread inbox files of ${id}: none.`);
  return `${body.join("\n")}\n`;
}
interface Session { id: string; pid: number; cwd: string }
const BUSY_CHILD = /^(dotnet|vstest.*|testhost.*|npm|yarn|pnpm|pi-phase|git|docker|make)$/i;
const isBusyChild = (cmd: string): boolean => /\bpi-phase run\b/.test(cmd) || BUSY_CHILD.test(basename(cmd.split(/\s+/)[0]));

/** Why the session must not be quit right now, or undefined when it is idle. */
async function quitRefusal(session: Session, ctx: LanesCtx): Promise<string | undefined> {
  const busy = (await descendants(ctx, session.pid)).filter(isBusyChild);
  if (busy.length) return `busy children: ${busy.join(" ")}`;
  const age = idleMinutes(session.cwd, ctx);
  return age !== undefined && age < 3 ? "session wrote less than 180s ago" : undefined;
}

async function awaitExit(pid: number, ctx: LanesCtx): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await (ctx.sleep ? ctx.sleep(1000) : new Promise((done) => setTimeout(done, 1000)));
    if (!await alive(ctx, pid)) return true;
  }
  return false;
}

async function quit(session: Session, c: Config, root: string, ctx: LanesCtx): Promise<boolean> {
  const refusal = await quitRefusal(session, ctx);
  if (refusal) { ctx.err(`REFUSED: ${refusal}`); return false; }
  if (await nudge(session.id, "/quit", {}, c, root, ctx) !== 0) return false;
  if (await awaitExit(session.pid, ctx)) return true;
  ctx.err(`REFUSED: pi ${session.pid} did not quit`); return false;
}
const gitAnswered = (r: { code: number; timedOut?: boolean; stdout: string }): boolean => r.code === 0 && !r.timedOut && r.stdout.trim() !== "";
async function removalHint(cwd: string, ctx: LanesCtx): Promise<{ text: string; clone?: string }> {
  if (!existsSync(cwd)) return { text: "worktree already removed; no removal hint" };
  const common = await ctx.run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 10000 });
  if (!gitAnswered(common)) throw new Error("cannot find clone for worktree removal hint");
  const dir = dirname(common.stdout.trim()); const clone = shellQuote(dir); const wt = shellQuote(cwd);
  return { text: `when merged, remove the worktree: git -C ${clone} worktree unlock ${wt} && git -C ${clone} worktree remove ${wt}`, clone: dir };
}
function persistClosed(c: Config, root: string, record: { id: string; reason: string; by: string; at: Date }): void {
  c.lanes.find(l => l.id === record.id)!.closed = { reason: record.reason, by: record.by, at: record.at.toISOString() };
  try { saveConfig(root, c); }
  catch (error) { throw new Error(`cannot write closed state to lanes.json: ${(error as Error).message}`); }
}
const isValidOther = (candidate: string, id: string): boolean => validId(candidate) && candidate !== id;
const isKnownParty = (candidate: string, c: Config): boolean => candidate === c.coordinator.id || c.lanes.some((l) => l.id === candidate);

/** Validates the options and returns the reassignment target and sender. */
function parseClose(id: string, opts: Record<string, string>, c: Config, ctx: LanesCtx): { to: string | undefined; from: string } {
  if (!c.lanes.some((l) => l.id === id)) throw new UsageError(`not a lane: ${id}`);
  const to = opts["reassign-to"];
  const from = opts.from || ctx.env.PI_ORCH_ID || c.coordinator.id;
  if (to && !isValidOther(to, id)) throw new UsageError("--reassign-to must be a valid id different from the closed lane");
  if (!validId(from)) throw new UsageError("invalid sender id");
  if (to && !isKnownParty(to, c)) ctx.err(`unknown reassignment target: ${to}`);
  return { to, from };
}

interface Closing { id: string; to: string | undefined; from: string; reason: string | undefined }

/** Records the closure on the backend (status line, passive notice, optional wake). */
async function announce(closing: Closing, unread: MessageRef[] | undefined, backend: ReturnType<typeof backendFor>, ctx: LanesCtx, at: Date): Promise<void> {
  const { id, to, from, reason } = closing;
  const line = closedLine(to, reason, at);
  await backend.setStatus(id, line);
  const topic = `lane-closed-${id.toLowerCase()}`;
  const message = await backend.postPassive({ topic, body: closeBody(id, to, reason, unread) });
  ctx.out(`${id}: ${line}`); ctx.out(message.path);
  if (!to || to === from) return;
  const wake = await backend.send({ from, to, topic, body: `Lane ${id} closed, pick up its work; details in ${message.name}\n` });
  ctx.out(wake.path);
}

/** Runs the worktree removal (unless kept) and prints its status; true when the worktree is gone. */
async function removeWorktree(id: string, cwd: string, clone: string | undefined, keep: boolean, ctx: LanesCtx): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  const status = keep ? "worktree left: --keep-worktree" : await tryRemove(id, cwd, clone, ctx);
  ctx.out(status);
  return status.startsWith("worktree removed");
}

async function stopSession(id: string, session: Session | undefined, quitRequested: boolean, c: Config, root: string, ctx: LanesCtx): Promise<boolean> {
  if (!session) return true;
  if (!quitRequested) { ctx.err(`${id} is still running; type /quit in its session or use --quit`); return true; }
  return quit(session, c, root, ctx);
}

export async function close(id: string, opts: Record<string, string>, c: Config, root: string, ctx: LanesCtx): Promise<number> {
  const { to, from } = parseClose(id, opts, c, ctx);
  const target = laneTarget(id, c, root, ctx);
  const hint = await removalHint(target.cwd, ctx);
  const backend = backendFor(c, ctx, root);
  const unread = await backend.unread(id, { groups: target.lane?.group ? [target.lane.group] : [] });
  const pid = existsSync(target.cwd) ? await piIn(target.cwd, ctx) : undefined;
  if (!await stopSession(id, pid ? { id, pid, cwd: target.cwd } : undefined, Boolean(opts.quit), c, root, ctx)) return 1;
  const at = ctx.now();
  persistClosed(c, root, { id, reason: opts.reason || "", by: from, at });
  await announce({ id, to, from, reason: opts.reason }, unread, backend, ctx, at);
  if (await removeWorktree(id, target.cwd, hint.clone, Boolean(opts["keep-worktree"]), ctx)) return 0;
  ctx.out(hint.text);
  return 0;
}
