import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expand, type Config } from "./config.ts";
import type { LanesCtx } from "./ctx.ts";
import { messageName, parseMessageName, validId, validTopic } from "./names.ts";

export interface MessageRef { name: string; from: string; to: string[]; topic: string; at: Date }
export interface LaneBackend {
  readonly name: string;
  send(m: { from: string; to: string; topic: string; body: string }): Promise<MessageRef & { path: string }>;
  inbox(lane: string, opts?: { groups?: string[]; aliases?: string[] }): Promise<MessageRef[]>;
  list(filter?: { from?: string; to?: string; limit?: number }): Promise<MessageRef[]>;
  setStatus(lane: string, line: string): Promise<void>;
  unread(lane: string, opts?: { groups?: string[]; aliases?: string[] }): Promise<MessageRef[] | undefined>;
  status(lane: string): Promise<string | undefined>;
}
export function addressed(m: MessageRef, id: string): boolean {
  return m.to.some((to) => to === id || (`-${to}-`).includes(`-${id}-`));
}
export class FileBackend implements LaneBackend {
  readonly name = "file";
  readonly dir: string;
  readonly now: () => Date;
  readonly broadcast: string;
  constructor(dir: string, now: () => Date, broadcast = "ALL") {
    this.dir = dir; this.now = now; this.broadcast = broadcast;
  }
  async send(m: { from: string; to: string; topic: string; body: string }): Promise<MessageRef & { path: string }> {
    if (!validId(m.from) || !validId(m.to) || !validTopic(m.topic)) throw new Error("invalid message name");
    mkdirSync(this.dir, { recursive: true });
    const at = this.now();
    for (let i = 1; ; i++) {
      const name = messageName(m.from, m.to, m.topic, at, i);
      const path = join(this.dir, name);
      try { writeFileSync(path, m.body, { flag: "wx" }); return { name, from: m.from, to: [m.to], topic: m.topic, at, path }; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
  }
  async list(filter: { from?: string; to?: string; limit?: number } = {}): Promise<MessageRef[]> {
    let names: string[];
    try { names = readdirSync(this.dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const messages: MessageRef[] = [];
    for (const name of names) {
      const parsed = parseMessageName(name);
      if (!parsed) continue;
      const stat = statSync(join(this.dir, name));
      if (!stat.isFile()) continue;
      const ref = { name, ...parsed, at: stat.mtime };
      if (filter.from !== undefined && ref.from !== filter.from) continue;
      if (filter.to !== undefined && !addressed(ref, filter.to)) continue;
      messages.push(ref);
    }
    return messages.sort((a, b) => b.at.getTime() - a.at.getTime() || b.name.localeCompare(a.name)).slice(0, filter.limit);
  }
  async inbox(lane: string, opts: { groups?: string[]; aliases?: string[] } = {}): Promise<MessageRef[]> {
    const recipients = [lane, "ALL", this.broadcast, ...opts.groups || [], ...opts.aliases || []];
    return (await this.list()).filter((m) => ![lane, ...opts.aliases || []].includes(m.from) && recipients.some((id) => addressed(m, id)));
  }
  async setStatus(lane: string, line: string): Promise<void> {
    if (!validId(lane)) throw new Error("invalid lane id");
    const dir = join(this.dir, "status"); mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${lane}-${randomUUID()}.tmp`);
    writeFileSync(tmp, `${line}\n`, { flag: "wx" });
    renameSync(tmp, join(dir, `${lane}.status`));
  }
  async unread(lane: string, opts: { groups?: string[]; aliases?: string[] } = {}): Promise<MessageRef[] | undefined> {
    if (!validId(lane)) throw new Error("invalid lane id");
    let since: number;
    try { since = statSync(join(this.dir, `${lane}-inbox.marker`)).mtimeMs; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
    return (await this.inbox(lane, opts)).filter((m) => m.at.getTime() > since);
  }
  async status(lane: string): Promise<string | undefined> {
    if (!validId(lane)) throw new Error("invalid lane id");
    try { return readFileSync(join(this.dir, "status", `${lane}.status`), "utf8").split(/\r?\n/)[0]; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  }
}
export function backendFor(config: Config, ctx: LanesCtx, root: string): LaneBackend {
  return new FileBackend(expand(config.messages.dir, config, root, ctx.home), ctx.now, config.messages.broadcast);
}
