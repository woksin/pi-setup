import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { argsOf, expandedCommands } from "../extensions/wait-guard.ts";
import { isGuardOff } from "./guards.ts";

export const ACTIONS = ["push", "pr-create", "pr-merge", "issue-write", "pr-comment"] as const;
export type Action = typeof ACTIONS[number];
export interface Binding { session: string; lane: string; branch: string; actions: Action[] }
export interface Grant { session: string; action: Action; target: string; expires: number; revision: number }
export interface Acknowledgement { session: string; common: string; revision: number }
export interface Repository {
	common: string;
	slug: string;
	coordinator: string;
	bindings: Binding[];
	writers: { session: string; branch: string; actions: Action[] }[];
	grants: Grant[];
}
export interface Policy { version: 1; revision: number; acknowledgements: Acknowledgement[]; repositories: Repository[]; forbidden: string[] }
export interface Identity { common: string; root: string; branch: string }
export interface Context { cwd: string; session: string }
export type Loaded = { policy: Policy; error?: undefined } | { policy?: undefined; error: string };
export const policyPath = () => join(homedir(), ".pi/agent/lane-policy/policy.json");
export const emptyPolicy = (): Policy => ({ version: 1, revision: 0, acknowledgements: [], repositories: [], forbidden: [] });
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && !/[\x00-\x1f]/.test(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(text);
const actions = (x: unknown): x is Action[] => strings(x) && x.every(a => ACTIONS.includes(a as Action));
const unique = (xs: string[]) => new Set(xs).size === xs.length;
export function validatePolicy(x: unknown): asserts x is Policy {
	if (!object(x) || x.version !== 1 || !Number.isSafeInteger(x.revision) || x.revision < 0 || !Array.isArray(x.acknowledgements) || !strings(x.forbidden) || !Array.isArray(x.repositories)) throw new Error("invalid policy schema");
	for (const ack of x.acknowledgements) if (!object(ack) || !text(ack.session) || !text(ack.common) || !Number.isSafeInteger(ack.revision) || ack.revision < 0 || ack.revision > x.revision) throw new Error("invalid acknowledgement");
	if (!unique(x.acknowledgements.map((a: Acknowledgement) => JSON.stringify([a.common, a.session])))) throw new Error("duplicate acknowledgement");
	for (const r of x.repositories) {
		if (!object(r) || !text(r.common) || !isAbsolute(r.common) || !text(r.slug) || !/^[\w.-]+\/[\w.-]+$/.test(r.slug) || !text(r.coordinator)
			|| !Array.isArray(r.bindings) || !Array.isArray(r.writers) || !Array.isArray(r.grants)) throw new Error("invalid repository policy");
		for (const b of r.bindings) if (!object(b) || !text(b.session) || !text(b.lane) || !text(b.branch) || !actions(b.actions)) throw new Error("invalid binding");
		for (const w of r.writers) if (!object(w) || !text(w.session) || !text(w.branch) || !actions(w.actions) || !r.bindings.some((b: Binding) => b.session === w.session && b.branch === w.branch && w.actions.every((a: Action) => b.actions.includes(a)))) throw new Error("invalid writer");
		for (const g of r.grants) if (!object(g) || !text(g.session) || !actions([g.action]) || !text(g.target) || !Number.isSafeInteger(g.expires) || g.expires <= 0 || !Number.isSafeInteger(g.revision) || g.revision < 1 || g.revision > x.revision || !r.bindings.some((b: Binding) => b.session === g.session && b.actions.includes(g.action))) throw new Error("invalid grant");
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
		const previous = loaded.policy!;
		const authority = (p: Policy) => JSON.stringify({ ...p, acknowledgements: [] });
		if (policy.revision !== previous.revision + 1 && !(policy.revision === previous.revision && authority(policy) === authority(previous))) throw new Error("Authority changes require the next policy revision; only ACK updates may keep it unchanged.");
		temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		const fd = openSync(temp, "wx", 0o600);
		try { writeFileSync(fd, `${JSON.stringify(policy, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		renameSync(temp, file);
		temp = undefined;
		try {
			const directory = openSync(dirname(file), "r");
			try { fsyncSync(directory); } finally { closeSync(directory); }
		} catch (error: any) {
			// Some filesystems cannot fsync directories; the file itself was synced before rename.
			if (!["EINVAL", "ENOTSUP"].includes(error.code)) throw error;
		}
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
	const sources = ["guards.json", "lib/lane-policy.ts", "lib/guards.ts", "extensions/lane-policy.ts", "extensions/guards.ts"].map(p => canonical(join(agent, p)));
	return candidate === dir || candidate.startsWith(`${dir}${sep}`) || sources.includes(candidate);
}
function scopedRepository(policy: Policy, ctx?: Context): Repository | undefined {
	const id = ctx && identity(ctx.cwd);
	return policy.repositories.find(r => r.common === id?.common) ?? policy.repositories.find(r => r.bindings.some(b => b.session === ctx?.session) || r.coordinator === ctx?.session);
}
function denial(policy: Policy, repo: Repository | undefined, ctx: Context | undefined, action: string, branch: string, reason: string): string {
	const writer = repo?.writers.find(w => w.branch === branch && w.actions.includes(action as Action)) ?? repo?.writers.find(w => w.actions.includes(action as Action));
	const lane = repo?.bindings.find(b => b.session === writer?.session)?.lane;
	const owner = writer ? `${lane ?? writer.session} (${writer.session}, branch ${writer.branch})` : `none assigned for ${action}; operator/coordinator ${repo?.coordinator ?? "unresolved"}`;
	return `Lane policy r${policy.revision}: ${reason} Requested ${action} on ${repo?.slug ?? "unresolved repo"}:${branch || "unknown branch"}; writer=${owner}. ${lane ? `send branch+SHA to ${lane}` : "Hand off branch+SHA to the train writer/operator"}.`;
}
export function tamperReason(ctx: Context, file = policyPath()): string {
	const loaded = loadPolicy(file);
	return loaded.error ? "Lane policy runknown: unreadable policy; operator repair required; model policy/source tampering is forbidden." : denial(loaded.policy!, scopedRepository(loaded.policy!, ctx), ctx, "policy-write", "", "Model policy/source writes are forbidden; use operator /lane-policy.");
}
/** Capability names only: do not treat arbitrary non-GitHub MCP tools as publication. */
export function mcpReason(ctx: Context | undefined, name: string, server = "", input = "", file = policyPath()): string | undefined {
	if (isGuardOff("lane-policy")) return;
	const capability = `${server} ${name}`;
	if (!/(?:github|\bgh\b)/i.test(capability) || !/(?:write|create|update|edit|delete|merge|push|comment|review|close|reopen|submit|release|mutation|workflow.*run|run.*(?:cancel|rerun))/i.test(capability)) return;
	const loaded = loadPolicy(file);
	if (loaded.error) return "Lane policy runknown: GitHub write denied; operator must repair unreadable policy and identify the train writer.";
	const policy = loaded.policy!;
	const repo = scopedRepository(policy, ctx) ?? policy.repositories.find(r => input.toLowerCase().includes(r.slug.toLowerCase()) || input.includes(r.common));
	const action = /merge/i.test(capability) ? "pr-merge" : /(?:pull|pr).*create|create.*(?:pull|pr)/i.test(capability) ? "pr-create" : /issue/i.test(capability) ? "issue-write" : /push/i.test(capability) ? "push" : "pr-comment";
	if (repo || (!ctx && policy.repositories.length)) return denial(policy, repo, ctx, action, ctx ? identity(ctx.cwd)?.branch ?? "" : "", "GitHub-write MCP capability is deny-only; use a supported direct publication command.");
}
function permit(policy: Policy, r: Repository, ctx: Context, action: Action, branch: string, target: string): string | undefined {
	const deny = (why: string) => denial(policy, r, ctx, action, branch, why);
	const binding = r.bindings.find(b => b.session === ctx.session && b.branch === branch && b.actions.includes(action));
	if (!binding) return deny(`Session is not bound for ${action}.`);
	if (!r.writers.some(w => w.session === ctx.session && w.branch === branch && w.actions.includes(action))) return deny(`Session is not the writer for ${action}.`);
	if (!r.grants.some(g => g.session === ctx.session && g.action === action && g.target === target && g.revision === policy.revision && g.expires > Date.now())) return deny(`No current-revision unexpired ${action} grant for ${target}.`);
}
const protectedBranch = (branch: string) => /^(main|master|develop|development|integration|release(?:\/.*)?)$/.test(branch);
const forbidden = (policy: Policy, slug: string, target: string) => policy.forbidden.some(x => x.toLowerCase() === `${slug}/#${target}`.toLowerCase());
function option(args: string[], long: string, short: string): string | undefined {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === long || args[i] === short) values.push(args[++i] ?? "");
		else if (args[i].startsWith(`${long}=`)) values.push(args[i].slice(long.length + 1));
		else if (args[i].startsWith(short) && args[i] !== short) values.push(args[i].slice(short.length));
	}
	return values.length === 1 ? values[0] : values.length ? "?" : undefined;
}
interface GitTarget { cwd: string; args: string[]; targeted: boolean; error?: string }
/** One parser for attribution AND enforcement: attached/repeated -C is real Git syntax. */
function gitTarget(raw: string[], initial: string): GitTarget {
	const args = [...raw];
	let cwd = initial, targeted = false;
	while (args[0]?.startsWith("-")) {
		const flag = args.shift()!;
		if (["--no-pager", "--paginate", "-p", "-P", "--no-optional-locks"].includes(flag)) continue;
		if (!flag.startsWith("-C")) return { cwd, args, targeted, error: "unsupported Git global targeting/configuration options" };
		const path = flag === "-C" ? args.shift() : flag.slice(2);
		if (path === undefined || /[$`~]/.test(path)) return { cwd, args, targeted: true, error: "unresolved git -C directory" };
		cwd = resolve(cwd, path); targeted = true;
	}
	return { cwd, args, targeted };
}
/** Publication setup is authority too: writing aliases or push URL rewrites cannot be a local-work escape. */
function protectedGitConfigWrite(raw: string[]): boolean {
	const { args } = gitTarget(raw, ".");
	const key = /^(?:alias(?:\.|$)|remote\..*\.pushurl(?:=|$)|url\..*\.pushInsteadOf(?:=|$))/i;
	if (args[0] !== "config") return raw.some(a => /^-c(?:alias\.|remote\..*\.pushurl=|url\..*\.pushInsteadOf=)/i.test(a)) || raw.includes("-c") && raw.some(a => key.test(a));
	const config = args.slice(1);
	if (!config.some(a => key.test(a))) return false;
	const reading = ["get", "list", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"].includes(config[0]);
	const writing = config.some(a => ["set", "unset", "--add", "--replace-all", "--unset", "--unset-all", "--remove-section", "--rename-section"].includes(a));
	return writing || !reading && !(config.length === 1 && !config[0].includes("=") && key.test(config[0]));
}
function gitPublication(raw: string[]): boolean {
	return /\b(?:push|send-pack|http-push)\b/i.test(raw.join(" ")) || protectedGitConfigWrite(raw);
}
function gitCommand(policy: Policy, ctx: Context, raw: string[], namedScope: boolean): string | undefined {
	if (!gitPublication(raw)) return;
	const targetContext = gitTarget(raw, ctx.cwd);
	const { args, cwd } = targetContext;
	const id = identity(cwd);
	if (targetContext.targeted && !id) return denial(policy, scopedRepository(policy, ctx), ctx, "push", "", "Publication target directory cannot be resolved; use an attributable direct command.");
	const repo = policy.repositories.find(r => r.common === id?.common);
	const scoped = !!repo || !!scopedRepository(policy, ctx) || namedScope;
	if (!scoped) return;
	const deny = (why: string, branch = id?.branch ?? "") => denial(policy, repo ?? scopedRepository(policy, ctx), ctx, "push", branch, why);
	if (targetContext.error) return deny(targetContext.error);
	if (args.length === 2 && args[0] === "stash" && args[1] === "push") return;
	if (args[0] !== "push") return deny("Git publication tokens/configuration outside direct push are deny-only (only exact stash push is exempt); hand off to the train writer/operator.");
	if (!repo) return deny("Push target repository is not enrolled/resolved.");
	const flags = args.slice(1).filter(a => a.startsWith("-"));
	if (flags.some(a => !["-u", "--set-upstream", "--force-with-lease"].includes(a))) return deny("Unsupported/ambiguous push options.");
	const positional = args.slice(1).filter(a => !a.startsWith("-"));
	if (positional.length !== 2 || positional[0] !== "origin") return deny("Use git push origin <branch>:<branch> (one explicit refspec).");
	let slug: string;
	try { slug = git(cwd, "remote", "get-url", "--push", "--all", "origin"); } catch { return deny("Cannot resolve origin push URL."); }
	const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(slug);
	if (!match || match[1].toLowerCase() !== repo.slug.toLowerCase()) return deny("Origin push URL does not match enrolled GitHub repository.");
	const spec = positional[1].split(":");
	const source = spec[0] === "HEAD" ? id?.branch : spec[0].replace(/^refs\/heads\//, "");
	const target = (spec[1] ?? spec[0]).replace(/^refs\/heads\//, "");
	if (spec.length > 2 || !source || source !== target || /[+*^~]/.test(source) || protectedBranch(target)) return deny("Push must name the same non-integration writer branch at source and destination.", target);
	return permit(policy, repo, ctx, "push", source, target);
}
function apiFields(args: string[]): boolean {
	return args.some(a => /^(-[fF]|--(?:raw-)?field(?:=|$))/.test(a));
}
function apiInput(args: string[]): boolean {
	return args.some(a => /^--input(?:=|$)/.test(a));
}
function apiMutation(args: string[]): boolean {
	if (args.some(a => /(?:^|\/)graphql$/i.test(a)) || apiInput(args)) return true;
	const method = option(args, "--method", "-X");
	return method ? method.toUpperCase() !== "GET" : apiFields(args);
}
/** Default-deny GH classification: unknown verbs, aliases, extensions and future routes are writes. */
function ghRead(args: string[]): boolean {
	const [kind, verb] = args;
	if (kind === "api") return option(args, "--method", "-X")?.toUpperCase() === "GET" && !apiMutation(args) && !apiFields(args);
	if (kind === "search" || kind === "auth" && verb === "status") return true;
	return ["pr", "issue", "run", "release", "workflow", "repo"].includes(kind) && ["view", "list", "status", "diff", "checks", "watch"].includes(verb);
}
function ghAction(args: string[]): string | undefined {
	if (ghRead(args)) return;
	const [kind, verb] = args;
	if (kind === "pr") return `pr-${verb ?? "write"}`;
	if (kind === "issue") return ["edit", "close", "reopen", "comment", "delete", "transfer", "pin", "unpin", "develop", "lock", "unlock"].includes(verb) ? "issue-write" : `issue-${verb ?? "write"}`;
	return `${kind ?? "github"}-write`;
}
function ghArguments(raw: string[]): string[] {
	const args = [...raw], prefix: string[] = [];
	while (args[0] === "-R" || args[0] === "--repo" || /^(?:--repo=|-R.)/.test(args[0] ?? "")) {
		const flag = args.shift()!;
		prefix.push(flag);
		if (flag === "-R" || flag === "--repo") prefix.push(args.shift() ?? "");
	}
	return [...args, ...prefix];
}
function ghCommand(policy: Policy, ctx: Context, raw: string[], namedScope: boolean): string | undefined {
	const args = ghArguments(raw);
	const action = ghAction(args);
	if (!action) return;
	const explicit = option(args, "--repo", "-R");
	const id = identity(ctx.cwd);
	const repo = explicit ? policy.repositories.find(r => r.slug.toLowerCase() === explicit.toLowerCase()) : policy.repositories.find(r => r.common === id?.common);
	const current = scopedRepository(policy, ctx);
	if (!repo && !current && !namedScope) return;
	const branch = option(args, "--head", "-H") ?? id?.branch ?? "";
	const deny = (why: string) => denial(policy, repo ?? current, ctx, action, branch, why);
	if (action === "pr-merge") return deny("PR merge is deny-only: hand off to the train writer/operator; no local grant enables merge.");
	if (!["pr-create", "pr-comment", "issue-write"].includes(action)) return deny(`${action} has no supported scoped grant in this slice; hand off to the train writer/operator.`);
	if (!repo || !id || id.common !== repo.common || !explicit) return deny("Mismatched repository or missing exact --repo owner/repo.");
	if (!branch || protectedBranch(branch)) return deny("Missing/non-writer branch.");
	if (action === "pr-create") return permit(policy, repo, ctx, action, branch, branch);
	const target = args[2];
	if (!target || !/^\d+$/.test(target)) return deny("Use an explicit numeric PR/issue target; issue creation has no supported grant.");
	if (forbidden(policy, repo.slug, target)) return deny("Forbidden target is closed; no grant can authorize it.");
	return permit(policy, repo, ctx, action as Action, branch, target);
}
/** Lexical cooperative coverage: script bodies/files and dynamically constructed tokens are not a sandbox. */
function publicationToken(text: string): boolean {
	return /\b(?:push|send-pack|http-push|gh)\b|\bpr\s+(?:create|merge|edit|close|reopen|comment|review|ready)\b|\bissue\s+(?:create|edit|close|reopen|comment|delete|transfer|pin|unpin|lock|unlock|develop)\b|\brelease\s+(?:create|edit|delete|upload)\b|\bworkflow\s+(?:run|disable|enable)\b|\brun\s+(?:rerun|cancel|delete)\b/i.test(text)
		|| /(?:alias\.[\w.-]+\s*(?:=|\s)|remote\.[^\s]+\.pushurl|url\.[^\s]+\.pushInsteadOf)/i.test(text);
}
const AUTHORITY_TEXT = /\.pi\/agent\/(?:lane-policy|guards\.json|lib\/(?:lane-policy|guards)\.ts|extensions\/(?:lane-policy|guards)\.ts)/;
// Shell programs that only read their file operands (output redirection is checked separately).
const SHELL_READERS = ["cat", "head", "tail", "wc", "stat", "ls", "grep", "rg", "echo", "printf", "pwd", "readlink", "jq", "diff", "cmp", "shasum", "sha256sum", "md5", "file", "sort", "uniq", "cut"];
// Commands that may sit next to a heredoc whose body merely mentions an authority path.
const DATA_COMMANDS = [...SHELL_READERS, "tee", "mkdir", "mv", "cp", "cd", "touch", "date", "true", "test", "["];
// fd duplication/closing and /dev/null redirections write nothing.
const HARMLESS_REDIRECT = /(?:\d+|&)?>>?[ \t]*(?:&(?:\d+|-)|\/dev\/null)(?=[\s;&|)]|$)/g;
function authority(word: string, cwd: string): boolean {
	return word.includes(dirname(policyPath())) || AUTHORITY_TEXT.test(word) || policyFile(word, cwd) || (word.includes("=") && policyFile(word.slice(word.indexOf("=") + 1), cwd));
}
/** Literal write destinations under a `.ai-work/` directory (lane messages, state, notes) are never authority writes. */
function aiWorkDestination(path: string, cwd: string): boolean {
	return !/[$`*?\[\]{}]/.test(path) && !path.split("/").includes("..") && /(?:^|\/)\.ai-work\//.test(path) && !authority(path, cwd);
}
/** Split redirections off a simple command: `>` targets (null if any target is not allowed) and the remaining words. */
function redirections(words: string[], cwd: string, checkTargets: boolean): string[] | null {
	const rest: string[] = [];
	for (let k = 0; k < words.length; k++) {
		if (words[k] === "<") { k++; continue; } // input redirection reads
		if (words[k] === ">") {
			while (words[k + 1] === ">") k++;
			const target = words[++k];
			if (checkTargets && (target === undefined || !aiWorkDestination(target, cwd))) return null;
			continue;
		}
		rest.push(words[k]);
	}
	return rest;
}
function shellCommandSafe(words: string[], cwd: string): boolean {
	const rest = redirections(words, cwd, true);
	if (!rest) return false;
	if (!rest.length || SHELL_READERS.some(p => argsOf(rest, p))) return true;
	const operands = (p: string) => argsOf(rest, p)?.filter(w => !w.startsWith("-"));
	const tee = operands("tee");
	if (tee) return tee.every(w => aiWorkDestination(w, cwd));
	const cp = operands("cp");
	if (cp) return !argsOf(rest, "cp")!.some(w => /^(?:-[a-zA-Z]*t|--target)/.test(w)) && cp.length >= 2 && aiWorkDestination(cp[cp.length - 1], cwd);
	for (const p of ["mkdir", "touch", "mv", "cd"]) {
		const args = operands(p);
		if (args) return !args.some(w => authority(w, cwd));
	}
	return false;
}
function tampering(command: string, ctx: Context): boolean {
	const commands = expandedCommands(command.replace(HARMLESS_REDIRECT, " "), 0, true);
	const words = commands.flat().some(w => authority(w, ctx.cwd));
	if (!words && !command.includes(dirname(policyPath())) && !AUTHORITY_TEXT.test(command)) return false;
	// Mentioned only in heredoc bodies or comments: data, unless a command could execute it.
	if (!words) return commands.some(w => { const rest = redirections(w, ctx.cwd, false)!; return rest.length > 0 && !DATA_COMMANDS.some(p => argsOf(rest, p)); });
	// Authority files are read-only to shell tools. Unknown writers (links, downloads, dd,
	// interpreters, patches, etc.) do not need individual mutation-verb exceptions. Writes
	// whose destination is under `.ai-work/` are allowed.
	return commands.some(w => !shellCommandSafe(w, ctx.cwd));
}
export function assessCommand(command: string, ctx: Context, file = policyPath(), depth = 0): string | undefined {
	if (isGuardOff("lane-policy")) return;
	if (tampering(command, ctx)) return tamperReason(ctx, file);
	const commands = expandedCommands(command, 0, true);
	const loaded = loadPolicy(file);
	if (loaded.error) return publicationToken(command) ? "Lane policy runknown: publication denied; operator must repair unreadable policy and identify the train writer." : undefined;
	const policy = loaded.policy!;
	if (!policy.repositories.length) return;
	const namedScope = commands.some(words => {
		const raw = argsOf(words, "git");
		if (raw) {
			const target = gitTarget(raw, ctx.cwd);
			return !!target.error && gitPublication(raw) || target.targeted && policy.repositories.some(r => r.common === identity(target.cwd)?.common);
		}
		const gh = argsOf(words, "gh");
		return !!gh && policy.repositories.some(r => gh.some(a => a.toLowerCase().includes(r.slug.toLowerCase())));
	});
	if (publicationToken(command) && /\|\s*(?:\S*\/)?(?:sh|bash|zsh|dash|node|python[\d.]*|perl|ruby|sed|xargs|env)\b/.test(command) && (scopedRepository(policy, ctx) || namedScope)) return denial(policy, scopedRepository(policy, ctx), ctx, /\bpush\b/.test(command) ? "push" : "publication", identity(ctx.cwd)?.branch ?? "", "Piped execution contains a publication token; use an attributable direct command.");
	let actor = { ...ctx };
	let unresolvedCwd = false;
	for (const words of commands) {
		const cd = argsOf(words, "cd");
		if (cd) {
			const paths = cd.filter(a => !["-P", "-L", "--"].includes(a));
			if (paths.length !== 1 || /[$`~]/.test(paths[0]) || paths[0] === "-") unresolvedCwd = true;
			else actor.cwd = resolve(actor.cwd, paths[0]);
			continue;
		}
		const gitArgs = argsOf(words, "git"), ghArgs = argsOf(words, "gh");
		const scoped = !!scopedRepository(policy, actor) || namedScope;
		const action = /\bpush\b/.test(words.join(" ")) ? "push" : /\bpr\s+create\b/.test(words.join(" ")) ? "pr-create" : /\bpr\s+merge\b/.test(words.join(" ")) ? "pr-merge" : "publication";
		const deny = (why: string) => denial(policy, scopedRepository(policy, actor), actor, action, identity(actor.cwd)?.branch ?? "", why);
		const directPublication = gitArgs ? gitPublication(gitArgs) : ghArgs ? !!ghAction(ghArguments(ghArgs)) : false;
		if (directPublication) {
			if (unresolvedCwd || words.some(w => /^(?:GIT_[\w]+|GH_REPO|GH_HOST)=/.test(w)) || /\benv\b.*(?:--chdir|\s-C)/.test(command) || /[$`<>]/.test(command)) return deny("Publication has unresolved cwd/environment/expansion/redirection; use an attributable direct command.");
			const reason = gitArgs ? gitCommand(policy, actor, gitArgs, namedScope) : ghCommand(policy, actor, ghArgs!, namedScope);
			if (reason) return reason;
			continue;
		}
		if (gitArgs || ghArgs || !scoped || !publicationToken(words.join(" "))) continue;
		if (["echo", "printf", "cat", "grep", "rg"].some(p => argsOf(words, p))) continue; // incidental quoted text is not execution
		// A literal shell/eval payload can use the same assessor and exact grants. Other opaque code
		// containing publication tokens cannot be attributed safely and must hand off.
		const shell = ["sh", "bash", "zsh", "dash"].map(p => argsOf(words, p)).find(Boolean);
		const evalArgs = argsOf(words, "eval");
		const payload = shell?.find((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(shell[i - 1])) ?? evalArgs?.join(" ");
		if (payload && depth < 4) {
			const inner = expandedCommands(payload, 0, true);
			if (inner.some(w => argsOf(w, "git") || argsOf(w, "gh"))) {
				const reason = assessCommand(payload, actor, file, depth + 1);
				if (reason) return reason;
				continue;
			}
		}
		return deny("Opaque execution contains a publication token without an attributable matching writer+grant; use a supported direct command.");
	}
}

/** Only invoked by the operator slash-command boundary, never by tool calls. */
function mutateAuthority(policy: Policy, words: string[], ctx: Context, id: Identity): void {
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
		if (forbidden(policy, repo.slug, target)) throw new Error("Forbidden target cannot be granted.");
		repo.grants.push({ session, action: action as Action, target, expires: Date.now() + +ttl * 60000, revision: policy.revision }); return;
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

/** Every authority change invalidates prior grants; ACKs are visibility only, not authority. */
export function mutate(policy: Policy, words: string[], ctx: Context, id: Identity): void {
	const next = structuredClone(policy);
	next.revision++;
	mutateAuthority(next, words, ctx, id);
	validatePolicy(next);
	Object.assign(policy, next);
}
export function acknowledge(policy: Policy, ctx: Context, id: Identity, revision: number): void {
	if (revision !== policy.revision) throw new Error("ACK must name the current policy revision; inspect status and retry.");
	const repo = policy.repositories.find(r => r.common === id.common);
	if (!repo || !(repo.coordinator === ctx.session || repo.bindings.some(b => b.session === ctx.session))) throw new Error("Only an explicitly bound session or coordinator may ACK this repository.");
	policy.acknowledgements = policy.acknowledgements.filter(a => a.common !== id.common || a.session !== ctx.session);
	policy.acknowledgements.push({ common: id.common, session: ctx.session, revision });
}
/** Bounded current context, rederived after restart/compaction; never an authorization cache. */
export function policyContext(ctx: Context): string | undefined {
	const loaded = loadPolicy();
	if (loaded.error) return loaded.error;
	const policy = loaded.policy!;
	if (!policy.repositories.length) return;
	const id = identity(ctx.cwd);
	const repos = policy.repositories.filter(r => r.common === id?.common || r.coordinator === ctx.session || r.bindings.some(b => b.session === ctx.session));
	if (!repos.length) return;
	const details = repos.slice(0, 3).map(r => {
		const b = r.bindings.find(b => b.session === ctx.session);
		const ack = policy.acknowledgements.find(a => a.common === r.common && a.session === ctx.session);
		const visibility = !ack ? "missing" : ack.revision === policy.revision ? "current" : `stale r${ack.revision}`;
		const writer = r.writers.filter(w => w.session === ctx.session).map(w => `${w.branch}:${w.actions.join(",")}`).join(";") || "none";
		return `${r.slug}: ACK=${visibility}, lane=${b?.lane ?? "unbound"}, branch=${b?.branch ?? "none"}, writer=${writer}`;
	});
	return `Lane policy r${policy.revision} (${isGuardOff("lane-policy") ? "OFF by operator" : "on"}). ${details.join(" | ")}. ACK is visibility only; only current-revision, unexpired exact grants authorize publication. /lane-policy status; /lane-policy ack ${policy.revision}.`.slice(0, 1800);
}
