import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { argsOf, expandedCommands } from "../extensions/wait-guard.ts";

export const ACTIONS = ["push", "pr-create", "pr-merge", "issue-write", "pr-comment"] as const;
export type Action = typeof ACTIONS[number];
export interface Binding { session: string; lane: string; branch: string; actions: Action[] }
export interface Grant { session: string; action: Action; target: string; expires: number }
export interface Repository {
	common: string;
	slug: string;
	coordinator: string;
	bindings: Binding[];
	writers: { session: string; branch: string; actions: Action[] }[];
	grants: Grant[];
}
export interface Policy { version: 1; repositories: Repository[]; forbidden: string[] }
export interface Identity { common: string; root: string; branch: string }
export interface Context { cwd: string; session: string }
export type Loaded = { policy: Policy; error?: undefined } | { policy?: undefined; error: string };
export const policyPath = () => join(homedir(), ".pi/agent/lane-policy/policy.json");
export const emptyPolicy = (): Policy => ({ version: 1, repositories: [], forbidden: ["Studio/#659", "Studio/#664"] });
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && !/[\x00-\x1f]/.test(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(text);
const actions = (x: unknown): x is Action[] => strings(x) && x.every(a => ACTIONS.includes(a as Action));
const unique = (xs: string[]) => new Set(xs).size === xs.length;
export function validatePolicy(x: unknown): asserts x is Policy {
	if (!object(x) || x.version !== 1 || !strings(x.forbidden) || !Array.isArray(x.repositories)) throw new Error("invalid policy schema");
	for (const r of x.repositories) {
		if (!object(r) || !text(r.common) || !isAbsolute(r.common) || !text(r.slug) || !/^[\w.-]+\/[\w.-]+$/.test(r.slug) || !text(r.coordinator)
			|| !Array.isArray(r.bindings) || !Array.isArray(r.writers) || !Array.isArray(r.grants)) throw new Error("invalid repository policy");
		for (const b of r.bindings) if (!object(b) || !text(b.session) || !text(b.lane) || !text(b.branch) || !actions(b.actions)) throw new Error("invalid binding");
		for (const w of r.writers) if (!object(w) || !text(w.session) || !text(w.branch) || !actions(w.actions) || !r.bindings.some((b: Binding) => b.session === w.session && b.branch === w.branch && w.actions.every((a: Action) => b.actions.includes(a)))) throw new Error("invalid writer");
		for (const g of r.grants) if (!object(g) || !text(g.session) || !actions([g.action]) || !text(g.target) || !Number.isSafeInteger(g.expires) || g.expires <= 0 || !r.bindings.some((b: Binding) => b.session === g.session && b.actions.includes(g.action))) throw new Error("invalid grant");
		if (!unique(r.bindings.map((b: Binding) => b.session)) || !unique(r.writers.map((w: any) => `${w.branch}:${w.actions.join(",")}`))) throw new Error("duplicate binding/writer");
		for (const a of ACTIONS) if (!unique(r.writers.filter((w: any) => w.actions.includes(a)).map((w: any) => w.branch))) throw new Error("multiple writers");
	}
	if (!unique(x.repositories.map((r: Repository) => r.common)) || !unique(x.repositories.map((r: Repository) => r.slug.toLowerCase()))) throw new Error("duplicate repository");
}
export function loadPolicy(file = policyPath()): Loaded {
	try {
		const policy: unknown = JSON.parse(readFileSync(file, "utf8"));
		validatePolicy(policy);
		return { policy };
	} catch (error: any) {
		if (error.code === "ENOENT") return { policy: emptyPolicy() };
		return { error: "Lane policy unreadable or invalid; protected operations fail closed." };
	}
}
/** Immediate exclusive lock; never steal a lock based on age or PID. CAS after operator confirmation. */
export function savePolicy(policy: Policy, expected: string, file = policyPath()): void {
	validatePolicy(policy);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const lock = openSync(`${file}.lock`, "wx", 0o600);
	let temp: string | undefined;
	try {
		const loaded = loadPolicy(file);
		if (loaded.error || JSON.stringify(loaded.policy) !== expected) throw new Error("Policy changed or became unreadable; inspect status and retry.");
		temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		const fd = openSync(temp, "wx", 0o600);
		try { writeFileSync(fd, `${JSON.stringify(policy, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temp, file);
		temp = undefined;
	} finally {
		if (temp) unlinkSync(temp);
		closeSync(lock);
		unlinkSync(`${file}.lock`);
	}
}
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500, maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] }).trim();
}
export function identity(cwd: string): Identity | undefined {
	try {
		const common = realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
		const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
		let branch = "";
		try { branch = git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* detached HEAD has no branch authority */ }
		return { common, root, branch };
	} catch { return undefined; }
}
function canonical(path: string): string {
	let at = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(at) && dirname(at) !== at) { suffix.unshift(basename(at)); at = dirname(at); }
	try { return join(realpathSync(at), ...suffix); } catch { return resolve(path); }
}
export function policyFile(path: string, cwd: string): boolean {
	const candidate = canonical(resolve(cwd, path.replace(/^~(?=\/)/, homedir())));
	const dir = canonical(dirname(policyPath()));
	const agent = dirname(dir);
	const sources = ["lib/lane-policy.ts", "extensions/lane-policy.ts", "extensions/guards.ts"].map(p => canonical(join(agent, p)));
	return candidate === dir || candidate.startsWith(`${dir}${sep}`) || sources.includes(candidate);
}
function enrolled(policy: Policy, ctx: Context, id = identity(ctx.cwd)): boolean {
	return policy.repositories.some(r => r.common === id?.common || r.bindings.some(b => b.session === ctx.session) || r.coordinator === ctx.session);
}
export function opaqueReason(ctx: Context | undefined, file = policyPath(), input = ""): string | undefined {
	const loaded = loadPolicy(file);
	if (loaded.error) return loaded.error;
	const policy = loaded.policy!;
	if ((!ctx && policy.repositories.length > 0) || (ctx && enrolled(policy, ctx)) || policy.repositories.some(r => input.toLowerCase().includes(r.slug.toLowerCase()) || input.includes(r.common))) return "Lane policy: opaque execution/delegation is blocked in enrolled scope; use an attributable direct command.";
}
function permit(r: Repository, ctx: Context, action: Action, branch: string, target: string): string | undefined {
	const binding = r.bindings.find(b => b.session === ctx.session && b.branch === branch && b.actions.includes(action));
	if (!binding) return `Lane policy: session is not bound for ${action} on ${r.slug}:${branch}.`;
	if (!r.writers.some(w => w.session === ctx.session && w.branch === branch && w.actions.includes(action))) return `Lane policy: session is not the writer for ${action} on ${branch}.`;
	if (!r.grants.some(g => g.session === ctx.session && g.action === action && g.target === target && g.expires > Date.now())) return `Lane policy: no unexpired ${action} grant for ${target}.`;
}
const localGit = new Set(["status", "diff", "log", "show", "rev-parse", "symbolic-ref", "ls-files", "ls-tree", "blame", "grep", "add", "commit", "restore", "reset", "checkout", "switch", "branch", "fetch", "merge", "rebase", "cherry-pick", "stash", "worktree", "tag", "remote"]);
const safePrograms = new Set(["echo", "printf", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "true", "false", "test", "["]);
const protectedBranch = (branch: string) => /^(main|master|develop|development|integration|release(?:\/.*)?)$/.test(branch);
const forbidden = (policy: Policy, command: string) => policy.forbidden.some(x => command.toLowerCase().includes(x.toLowerCase()) || new RegExp(`(?:^|[^0-9])${x.split("#").at(-1)}(?:[^0-9]|$)`).test(command) && /studio/i.test(command));
function option(args: string[], long: string, short: string): string | undefined {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === long || args[i] === short) values.push(args[++i] ?? "");
		else if (args[i].startsWith(`${long}=`)) values.push(args[i].slice(long.length + 1));
		else if (args[i].startsWith(short) && args[i] !== short) values.push(args[i].slice(short.length));
	}
	return values.length === 1 ? values[0] : values.length ? "?" : undefined;
}
function gitCommand(policy: Policy, ctx: Context, raw: string[], namedScope: boolean): string | undefined {
	const args = [...raw];
	let cwd = ctx.cwd;
	while (args[0] === "-C") { args.shift(); const dir = args.shift(); if (!dir) return "Lane policy: missing git -C directory."; cwd = resolve(cwd, dir); }
	const id = identity(cwd);
	const repo = policy.repositories.find(r => r.common === id?.common);
	const scoped = !!repo || enrolled(policy, ctx) || namedScope;
	if (args[0] !== "push") {
		if (scoped && (!localGit.has(args[0]) || args.some(a => /^(?:--exec|--upload-pack|--receive-pack|--config-env)(?:=|$)/.test(a)))) return "Lane policy: unsupported git command/options in enrolled scope.";
		return;
	}
	if (!repo) return scoped ? "Lane policy: push target repository is not enrolled/resolved." : undefined;
	// A single explicit origin refspec is the supported slice. Never infer push.default, remote.push or aliases.
	const flags = args.slice(1).filter(a => a.startsWith("-"));
	if (flags.some(a => !["-u", "--set-upstream", "--force-with-lease"].includes(a))) return "Lane policy: unsupported/ambiguous push options.";
	const positional = args.slice(1).filter(a => !a.startsWith("-"));
	if (positional.length !== 2 || positional[0] !== "origin") return "Lane policy: use git push origin <branch>:<branch> (one explicit refspec).";
	let slug: string;
	try { slug = git(cwd, "remote", "get-url", "--push", "--all", "origin"); } catch { return "Lane policy: cannot resolve origin push URL."; }
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(slug);
	if (!match || match[1].toLowerCase() !== repo.slug.toLowerCase()) return "Lane policy: origin push URL does not match enrolled GitHub repository.";
	const spec = positional[1].split(":");
	const source = spec[0] === "HEAD" ? id?.branch : spec[0].replace(/^refs\/heads\//, "");
	const target = (spec[1] ?? spec[0]).replace(/^refs\/heads\//, "");
	if (spec.length > 2 || !source || source !== target || /[+*^~]/.test(source) || protectedBranch(target)) return "Lane policy: push must name the same non-integration writer branch at source and destination.";
	return permit(repo, ctx, "push", source, target);
}
function ghCommand(policy: Policy, ctx: Context, raw: string[], command: string, namedScope: boolean): string | undefined {
	const args = [...raw];
	let cwd = ctx.cwd;
	if (args[0] === "-R" || args[0] === "--repo") { const pair = args.splice(0, 2); args.push(...pair); }
	const explicit = option(args, "--repo", "-R");
	const id = identity(cwd);
	const repo = explicit ? policy.repositories.find(r => r.slug.toLowerCase() === explicit.toLowerCase()) : policy.repositories.find(r => r.common === id?.common);
	const scoped = !!repo || enrolled(policy, ctx) || namedScope;
	const [kind, verb] = args;
	const read = (kind === "pr" && ["view", "list", "diff", "checks", "status"].includes(verb)) || (kind === "issue" && ["view", "list", "status"].includes(verb)) || (kind === "run" && ["view", "list", "watch"].includes(verb));
	if (read) return;
	if (!scoped) return;
	if (kind === "api") return "Lane policy: gh api is opaque in enrolled scope (including GraphQL); use a supported direct gh command.";
	const action: Action | undefined = kind === "pr" && verb === "create" ? "pr-create" : kind === "pr" && verb === "merge" ? "pr-merge" : kind === "pr" && verb === "comment" ? "pr-comment" : kind === "issue" ? "issue-write" : undefined;
	if (!action || !repo || !id || id.common !== repo.common || !explicit) return "Lane policy: unsupported GitHub operation, mismatched repository or missing exact --repo owner/repo.";
	if (forbidden(policy, `${repo.slug} ${command}`)) return "Lane policy: forbidden target is closed; no grant can authorize it.";
	const branch = option(args, "--head", "-H") ?? id.branch;
	if (!branch || protectedBranch(branch)) return "Lane policy: missing/non-writer branch.";
	if (action === "pr-create") return permit(repo, ctx, action, branch, branch);
	const target = args[2];
	if (!target || !/^\d+$/.test(target)) return "Lane policy: use an explicit numeric PR/issue target.";
	// Merge is only accepted with an explicit head branch identity; no network lookup or inferred PR head.
	if (action === "pr-merge") return "Lane policy: PR merge is not implemented in this first slice; no local grant enables it.";
	return permit(repo, ctx, action, branch, target);
}
export function assessCommand(command: string, ctx: Context, file = policyPath()): string | undefined {
	const loaded = loadPolicy(file);
	const commands = expandedCommands(command, 0, true);
	if (loaded.error) return loaded.error;
	const policy = loaded.policy!;
	const namedScope = policy.repositories.some(r => command.toLowerCase().includes(r.slug.toLowerCase()) || command.includes(r.common)) || commands.some(words => {
		const args = argsOf(words, "git");
		let cwd = ctx.cwd;
		for (let i = 0; args?.[i] === "-C" && args[i + 1]; i += 2) cwd = resolve(cwd, args[i + 1]);
		return cwd !== ctx.cwd && policy.repositories.some(r => r.common === identity(cwd)?.common);
	});
	let actor = { ...ctx };
	let scoped = enrolled(policy, actor) || namedScope;
	if (policyFile(command, ctx.cwd) || command.includes(dirname(policyPath())) || /\.pi\/agent\/(?:lane-policy|lib\/lane-policy\.ts|extensions\/(?:lane-policy|guards)\.ts)/.test(command)) return "Lane policy: policy files can only be changed through /lane-policy.";
	for (const words of commands) {
		const cd = argsOf(words, "cd");
		if (cd) {
			const paths = cd.filter(a => !["-P", "-L", "--"].includes(a));
			if (paths.length !== 1 || /[$`~]/.test(paths[0]) || paths[0] === "-") return policy.repositories.length ? "Lane policy: unresolved cd with enrolled repositories." : undefined;
			actor.cwd = resolve(actor.cwd, paths[0]);
			scoped ||= enrolled(policy, actor);
			continue;
		}
		// Expansions, environment overrides and redirects cannot be attributed reliably.
		if (scoped && (/[$`<>]|\b(?:eval|source|sudo|env|xargs|find|ssh|curl|wget)\b|(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(command) || words.some(w => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)))) return "Lane policy: dynamic/opaque shell execution is unsupported in enrolled scope.";
		const gitArgs = argsOf(words, "git");
		const ghArgs = argsOf(words, "gh");
		let reason: string | undefined;
		if (gitArgs) reason = gitCommand(policy, actor, gitArgs, namedScope);
		else if (ghArgs) reason = ghCommand(policy, actor, ghArgs, command, namedScope);
		else if (scoped && ![...safePrograms].some(p => argsOf(words, p))) reason = "Lane policy: opaque command blocked in enrolled scope.";
		if (reason) return reason;
	}
}

/** Only invoked by the operator slash-command boundary, never by tool calls. */
export function mutate(policy: Policy, words: string[], ctx: Context, id: Identity): void {
	const [verb, ...args] = words;
	let repo = policy.repositories.find(r => r.common === id.common);
	const override = args.at(-1) === "--override";
	if (override) args.pop();
	if (verb === "bootstrap") {
		if (repo || args.length !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(args[0])) throw new Error("Usage: bootstrap owner/repo (unenrolled repository only)");
		policy.repositories.push({ common: id.common, slug: args[0], coordinator: ctx.session, bindings: [], writers: [], grants: [] });
		return;
	}
	if (!repo) throw new Error("Repository is not enrolled; bootstrap first.");
	if (repo.coordinator !== ctx.session && !override) throw new Error("Only this repository's coordinator may mutate policy (operator --override requires confirmation).");
	if (verb === "coordinator" && args.length === 1) { repo.coordinator = args[0]; return; }
	if (verb === "forbid" && args.length === 1) { policy.forbidden.push(args[0]); return; }
	if (verb === "clear-forbidden" && args.length === 1) { policy.forbidden = policy.forbidden.filter(target => target !== args[0]); return; }
	if (verb === "enroll" && args.length === 4) {
		const [session, lane, branch, list] = args;
		const allowed = list.split(",") as Action[];
		if (!actions(allowed) || protectedBranch(branch)) throw new Error("Invalid actions or integration branch.");
		if (repo.bindings.some(b => b.session === session)) throw new Error("Session already enrolled; revoke it first.");
		repo.bindings.push({ session, lane, branch, actions: allowed }); return;
	}
	if (verb === "writer" && args.length === 3) {
		const [session, branch, list] = args;
		const allowed = list.split(",") as Action[];
		if (!actions(allowed)) throw new Error("Invalid actions.");
		if (repo.writers.some(w => w.branch === branch && w.actions.some(a => allowed.includes(a)))) throw new Error("Writer already assigned; revoke writer first.");
		repo.writers.push({ session, branch, actions: allowed }); return;
	}
	if (verb === "grant" && args.length === 5) {
		const [session, action, target, ttl, confirm] = args;
		if (!actions([action]) || !/^\d+$/.test(ttl) || +ttl < 1 || +ttl > 60 || confirm !== "minutes") throw new Error("Usage: grant session action exact-target 1..60 minutes");
		if (forbidden(policy, `${repo.slug} ${target}`)) throw new Error("Forbidden target cannot be granted.");
		repo.grants.push({ session, action: action as Action, target, expires: Date.now() + +ttl * 60000 }); return;
	}
	if (verb === "revoke" && args.length === 2) {
		const [kind, session] = args;
		if (!["session", "writer", "grants"].includes(kind)) throw new Error("Usage: revoke session|writer|grants session-id");
		repo.grants = repo.grants.filter(g => g.session !== session);
		if (kind !== "grants") repo.writers = repo.writers.filter(w => w.session !== session);
		if (kind === "session") repo.bindings = repo.bindings.filter(b => b.session !== session);
		return;
	}
	throw new Error("Unknown command/arguments. Use /lane-policy help.");
}
