/** Inactive shared capture/scan/send core. Admission belongs to the tool/CLI integrations. */
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { scanPublication } from "./publish-scan.ts";
import type { PublicationContext, PublicationScan } from "./publish-scan.ts";
import { InvalidRequest, MAX_REQUEST_BYTES, MAX_STRING_BYTES, toGhPlan, validateRequest } from "./publish-request.ts";
import type { GhPlan, PayloadSource, PayloadSlot } from "./publish-request.ts";

export type PublishCode = "published" | "scan-clean" | "invalid-request" | "unsupported-platform" | "payload-unreadable" | "payload-too-large" | "payload-not-utf8" | "scan-refused" | "gh-unavailable" | "gh-failed" | "gh-timeout" | "cancelled" | "gh-output-limit" | "cleanup-failed" | "payload-not-found" | "payload-symlink" | "payload-not-file" | "payload-permission" | "host-unauthenticated";
export interface PublishResult { code: PublishCode; text: string; isError: boolean; detail?: string; diagnostics?: { source: string; count: number; findings: PublicationScan["findings"] } }
interface FileStat { size: number; isFile(): boolean }
export interface CaptureHandle {
	stat(): Promise<FileStat>;
	read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}
export interface PublisherIO {
	open(path: string, flags: number): Promise<CaptureHandle>;
	mkdtemp(prefix: string): Promise<string>;
	mkdir(path: string, options: { mode: number }): Promise<unknown>;
	chmod(path: string, mode: number): Promise<void>;
	writeFile(path: string, bytes: Buffer, options: { mode: number; flag: string }): Promise<void>;
	rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<FileStat>;
	access(path: string, mode: number): Promise<void>;
}
export interface PublisherChild {
	stdout: Readable | null; stderr: Readable | null;
	once(event: string, listener: (...args: any[]) => void): unknown;
	on(event: string, listener: (...args: any[]) => void): unknown;
	kill(signal: "SIGKILL"): boolean;
}
export interface PublisherAdapters {
	io?: Partial<PublisherIO>;
	spawn?: (executable: string, argv: string[], options: SpawnOptions) => PublisherChild;
	clock?: { after(milliseconds: number, callback: () => void): () => void };
	platform?: NodeJS.Platform;
	temporaryRoot?: () => string;
	env?: NodeJS.ProcessEnv;
}
export interface PublisherContext { home?: string; repoRoot?: string; cwd?: string; signal?: AbortSignal }
interface Runtime {
	io: PublisherIO; spawn: NonNullable<PublisherAdapters["spawn"]>; clock: NonNullable<PublisherAdapters["clock"]>;
	platform: NodeJS.Platform; temporaryRoot: () => string; env: NodeJS.ProcessEnv;
	context: PublisherContext; scanContext: PublicationContext;
}
class Failure extends Error {
	readonly code: PublishCode;
	readonly diagnostics?: PublishResult["diagnostics"];
	readonly detail?: string;
	constructor(code: PublishCode, diagnostics?: PublishResult["diagnostics"], detail?: string) {
		super(`publish: ${code}`); this.code = code; this.diagnostics = diagnostics;
		this.detail = detail ?? (code === "gh-failed" ? "exit=none category=unclassified; do not retry blindly" : undefined);
	}
}
function result(code: PublishCode, diagnostics?: PublishResult["diagnostics"], detail?: string): PublishResult {
	const success = code === "published" || code === "scan-clean";
	return { code, text: success ? (code === "published" ? "published" : "scan clean") : `publish: ${code}`, isError: !success, ...(diagnostics ? { diagnostics } : {}), ...(detail ? { detail } : {}) };
}
function runtime(context: PublisherContext, adapters: PublisherAdapters): Runtime {
	return {
		io: { ...fs, ...adapters.io }, spawn: adapters.spawn ?? nodeSpawn,
		clock: adapters.clock ?? { after: (milliseconds, callback) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } },
		platform: adapters.platform ?? process.platform, temporaryRoot: adapters.temporaryRoot ?? tmpdir,
		env: adapters.env ?? process.env, context, scanContext: { home: context.home ?? homedir(), repoRoot: context.repoRoot },
	};
}
function cancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Failure("cancelled");
}
function captureFlags(platform: NodeJS.Platform): number {
	if (!["darwin", "linux"].includes(platform)) throw new Failure("unsupported-platform");
	if (!constants.O_NONBLOCK || !constants.O_NOFOLLOW) throw new Failure("unsupported-platform");
	return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
}
function boundedSize(size: number, limit: number): void {
	if (!Number.isSafeInteger(size) || size < 0) throw new Failure("payload-unreadable");
	if (size > limit) throw new Failure("payload-too-large");
}
function checkStat(stat: FileStat): void {
	if (!stat.isFile()) throw new Failure("payload-not-file");
	boundedSize(stat.size, MAX_STRING_BYTES);
}
function checkRead(read: { bytesRead: number; capacity: number }): void {
	if (!Number.isInteger(read.bytesRead)) throw new Failure("payload-unreadable");
	if (read.bytesRead < 0) throw new Failure("payload-unreadable");
	if (read.bytesRead > read.capacity) throw new Failure("payload-unreadable");
}
async function readBounded(handle: CaptureHandle, signal?: AbortSignal): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	while (size <= MAX_STRING_BYTES) {
		cancelled(signal);
		const buffer = Buffer.alloc(Math.min(65536, MAX_STRING_BYTES + 1 - size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
		cancelled(signal);
		checkRead({ bytesRead, capacity: buffer.length });
		if (bytesRead === 0) break;
		size += bytesRead;
		boundedSize(size, MAX_STRING_BYTES);
		chunks.push(buffer.subarray(0, bytesRead));
	}
	return Buffer.concat(chunks, size);
}
const OPEN_ERRORS: Record<string, PublishCode> = {
	ENOENT: "payload-not-found", ENOTDIR: "payload-not-found", ELOOP: "payload-symlink",
	EISDIR: "payload-not-file", EACCES: "payload-permission", EPERM: "payload-permission",
};
function displayPath(path: string, run: Runtime): string {
	const absolute = resolve(run.context.cwd ?? process.cwd(), path), home = run.scanContext.home.replace(/\/+$/, "");
	const displayed = home && (absolute === home || absolute.startsWith(home + "/")) ? "~" + absolute.slice(home.length) : absolute;
	return displayed.replace(/[\p{Cc}\p{Cf}]/gu, "?").slice(0, 300);
}
function openErrorCode(error: unknown): PublishCode {
	if (!error || typeof error !== "object") return "payload-unreadable";
	if (!("code" in error)) return "payload-unreadable";
	const errno = error.code;
	if (typeof errno !== "string") return "payload-unreadable";
	return Object.hasOwn(OPEN_ERRORS, errno) ? OPEN_ERRORS[errno] : "payload-unreadable";
}
function unreadableDetail(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const errno = error.code;
	if (typeof errno !== "string") return undefined;
	if (/^E[A-Z0-9_]{2,19}$/.exec(errno)?.[0] !== errno) return undefined;
	return `code=${errno}`;
}
async function openCapture(path: string, flags: number, run: Runtime): Promise<CaptureHandle> {
	try { return await run.io.open(resolve(run.context.cwd ?? process.cwd(), path), flags); }
	catch (error) {
		const code = openErrorCode(error);
		throw new Failure(code, undefined, code === "payload-unreadable" ? unreadableDetail(error) : displayPath(path, run));
	}
}
function captureFailure(error: unknown, path: string, run: Runtime): Failure {
	if (!(error instanceof Failure)) return new Failure("payload-unreadable", undefined, unreadableDetail(error));
	if (error.detail || error.code === "payload-unreadable") return error;
	return error.code.startsWith("payload-") ? new Failure(error.code, error.diagnostics, displayPath(path, run)) : error;
}
async function captureFile(path: string, run: Runtime): Promise<Buffer> {
	cancelled(run.context.signal);
	const flags = captureFlags(run.platform);
	try {
		const handle = await openCapture(path, flags, run);
		try {
			cancelled(run.context.signal); checkStat(await handle.stat());
			const bytes = await readBounded(handle, run.context.signal);
			checkStat(await handle.stat()); cancelled(run.context.signal);
			return bytes;
		} finally { await handle.close(); }
	} catch (error) { throw captureFailure(error, path, run); }
}
function decoded(bytes: Buffer): string {
	try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
	catch { throw new Failure("payload-not-utf8"); }
}
function inspect(source: { label: string; text: string }, run: Runtime): void {
	cancelled(run.context.signal);
	const scan = scanPublication(source.text, run.scanContext);
	if (scan.count) throw new Failure("scan-refused", { source: source.label, count: scan.count, findings: scan.findings });
}
async function capture(plan: GhPlan, run: Runtime): Promise<Buffer[]> {
	plan.outbound.forEach(source => inspect(source, run));
	const cache = new Map<string, Buffer>(), captured: Buffer[] = [];
	let total = plan.requestBytes;
	for (const payload of plan.payloads) {
		cancelled(run.context.signal);
		const bytes = await captureSource(payload, cache, run);
		total += bytes.length;
		boundedSize(total, MAX_REQUEST_BYTES);
		inspect({ label: payload.label, text: decoded(bytes) }, run);
		captured.push(bytes);
	}
	return captured;
}
async function captureSource(payload: PayloadSource, cache: Map<string, Buffer>, run: Runtime): Promise<Buffer> {
	if ("text" in payload.source) return Buffer.from(payload.source.text, "utf8");
	const path = resolve(run.context.cwd ?? process.cwd(), payload.source.file);
	if (!cache.has(path)) cache.set(path, await captureFile(path, run));
	return cache.get(path)!;
}
async function snapshots(state: { dir: string; plan: GhPlan; bytes: Buffer[] }, run: Runtime): Promise<string[]> {
	const paths: string[] = [];
	for (const [index, payload] of state.plan.payloads.entries()) {
		cancelled(run.context.signal);
		const directory = join(state.dir, String(index));
		await run.io.mkdir(directory, { mode: 0o700 });
		const path = join(directory, payload.basename ?? "payload");
		await run.io.writeFile(path, state.bytes[index], { mode: 0o600, flag: "wx" });
		await run.io.chmod(path, 0o600);
		paths.push(path);
	}
	return paths;
}
async function executableCandidate(candidate: string, io: PublisherIO): Promise<string | undefined> {
	try {
		const path = await io.realpath(candidate);
		if (!isAbsolute(path)) return undefined;
		if (!(await io.stat(path)).isFile()) return undefined;
		await io.access(path, constants.X_OK);
		return path;
	} catch { return undefined; }
}
async function ghExecutable(run: Runtime): Promise<string> {
	for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/bin/gh"]) {
		cancelled(run.context.signal);
		const executable = await executableCandidate(candidate, run.io);
		if (executable) return executable;
	}
	throw new Failure("gh-unavailable");
}
const ENTERPRISE_TOKENS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const ENV_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", ...ENTERPRISE_TOKENS];
/** A non-default host never receives an env token: gh may use only its stored per-host credential. */
function environment(env: NodeJS.ProcessEnv, host?: string): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = { ...env, GH_HOST: host ?? "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat" };
	delete child.GH_DEBUG; delete child.DEBUG; delete child.GH_REPO;
	for (const name of host ? ENV_TOKENS : ENTERPRISE_TOKENS) delete child[name];
	return child;
}
/** Without GH_HOST, `gh auth status --hostname` checks local config and does not contact an unconfigured host. */
function preflightEnvironment(env: NodeJS.ProcessEnv, host: string): NodeJS.ProcessEnv {
	const child = environment(env, host);
	delete child.GH_HOST;
	return child;
}
function materialize(slot: PayloadSlot, state: { bytes: Buffer[]; paths: string[] }): string {
	return slot.prefix + (slot.use === "file" ? state.paths[slot.payload] : decoded(state.bytes[slot.payload]));
}
const OUTPUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 16 * 1024;
const GH_CATEGORIES = [
	["rate-limit", /rate limit|secondary rate|HTTP 429|abuse detection/i],
	["auth", /HTTP 40[13]|bad credentials|authentication|gh auth login|not logged in|requires authentication|resource not accessible|SAML/i],
	["not-found", /HTTP 404|not found|could not resolve to a/i],
	["validation", /HTTP 422|validation failed|unprocessable|invalid (?:input|request)/i],
	["network", /HTTP 5\d\d|timeout|timed out|no such host|connection (?:refused|reset)|dial tcp|ECONN|EOF|TLS|could not resolve host|error connecting to|check your internet connection/i],
] as const;
type GhCategory = typeof GH_CATEGORIES[number][0] | "unclassified";
const GH_ADVICE: Record<GhCategory, string> = {
	"rate-limit": "retry once, then stop", network: "retry once, then stop",
	auth: "do not retry; check gh auth status",
	"not-found": "do not retry; fix the request (repo, number, fields)", validation: "do not retry; fix the request (repo, number, fields)",
	unclassified: "do not retry blindly",
};
function classifyStderr(text: string): GhCategory {
	return GH_CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0] ?? "unclassified";
}
function watchStream(stream: Readable | null, stop: (code: PublishCode) => void, capture?: (chunk: Buffer | string) => void): void {
	let bytes = 0;
	stream?.on("data", (chunk: Buffer | string) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > OUTPUT_LIMIT) stop("gh-output-limit");
		else capture?.(chunk);
	});
	stream?.on("error", () => stop("gh-failed"));
}
function messageText(text: string): string {
	return text.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
}
function jsonStrings(text: string): string[] {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return []; }
	const pending = [value], strings: string[] = [];
	while (pending.length) {
		const next = pending.pop();
		if (typeof next === "string") { strings.push(next); continue; }
		if (!next || typeof next !== "object") continue;
		for (const nested of Object.values(next)) pending.push(nested);
	}
	return strings;
}
/** Reflection candidates come from the scanned plan and captured bytes, never a second file read. */
function reflectionTexts(plan: GhPlan, bytes: Buffer[]): string[] {
	const texts = plan.outbound.filter(source => source.text.length >= 4 || source.label.startsWith("fields[")).map(source => source.text);
	for (const payload of bytes) {
		const text = decoded(payload);
		texts.push(text);
		for (const value of jsonStrings(text)) texts.push(value);
	}
	return [...new Set(texts.flatMap(text => text.split(/\r?\n/)).map(messageText).filter(text => text.length > 0))];
}
function ghMessage(stderr: string, reflect: string[], run: Runtime): string {
	const lines = stderr.split(/\r?\n/), first = lines.findIndex(line => /^gh: .+/.test(line));
	if (first < 0) return "";
	const candidates = [lines[first].replace(/^gh: /, "").replace(/ \(HTTP \d{3}\)$/, "")];
	for (const line of lines.slice(first + 1, first + 4)) {
		if (!line.trim()) break;
		candidates.push(line);
	}
	return candidates.map(messageText).filter(line => {
		if (!line || reflect.some(text => line.includes(text))) return false;
		return scanPublication(line, run.scanContext).count === 0;
	}).map(line => line.slice(0, 120)).join(" ").slice(0, 400);
}
function ghDetail(stderr: string, reflect: string[], run: Runtime): string {
	const status = stderr.match(/HTTP (\d{3})/)?.[1], message = ghMessage(stderr, reflect, run);
	return [status ? `status=${status}` : "", message ? `message=${JSON.stringify(message)}` : ""].filter(Boolean).join("; ");
}
function childFailure(state: { code: number | null; failure?: PublishCode; stderr: string; reflect?: string[]; run: Runtime }): Failure | undefined {
	if (state.failure) return new Failure(state.failure);
	if (state.code === 0) return undefined;
	const category = classifyStderr(state.stderr);
	const exit = Number.isInteger(state.code) && state.code! >= 0 && state.code! <= 255 ? state.code : "none";
	const detail = state.code === null || !state.reflect ? "" : ghDetail(state.stderr, state.reflect, state.run);
	return new Failure("gh-failed", undefined, `exit=${exit} category=${category}${detail ? `; ${detail}` : ""}; ${GH_ADVICE[category]}`);
}
function stderrCapture() {
	let text = "", remaining = STDERR_LIMIT;
	const decoder = new TextDecoder();
	return {
		append(chunk: Buffer | string) {
			if (!remaining) return;
			const bytes = (typeof chunk === "string" ? Buffer.from(chunk) : chunk).subarray(0, remaining);
			remaining -= bytes.length; text += decoder.decode(bytes, { stream: true });
		},
		take() { const captured = text + decoder.decode(); text = ""; return captured; },
	};
}
function monitor(child: PublisherChild, run: Runtime, reflect?: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		let failure: PublishCode | undefined;
		const stderr = stderrCapture();
		const stop = (code: PublishCode) => {
			if (failure) return;
			failure = code;
			try { child.kill("SIGKILL"); } catch { /* Still await close before cleanup. */ }
		};
		const abort = () => stop("cancelled");
		const cancelTimer = run.clock.after(120000, () => stop("gh-timeout"));
		child.on("error", () => stop("gh-failed"));
		child.once("close", (code: number | null) => {
			cancelTimer(); run.context.signal?.removeEventListener("abort", abort);
			const error = childFailure({ code, failure, stderr: stderr.take(), reflect, run });
			if (error) reject(error); else resolve();
		});
		watchStream(child.stdout, stop); watchStream(child.stderr, stop, stderr.append);
		run.context.signal?.addEventListener("abort", abort, { once: true });
		if (run.context.signal?.aborted) abort();
	});
}
async function runGh(argv: () => string[], env: NodeJS.ProcessEnv, run: Runtime, reflect?: string[]): Promise<void> {
	const executable = await ghExecutable(run);
	cancelled(run.context.signal);
	const args = argv();
	try {
		const child = run.spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env, cwd: run.context.cwd });
		await monitor(child, run, reflect);
	} catch (error) { if (error instanceof Failure) throw error; throw new Failure("gh-failed"); }
}
async function send(plan: GhPlan, state: { bytes: Buffer[]; paths: string[] }, run: Runtime): Promise<void> {
	await runGh(() => plan.argv.map(arg => typeof arg === "string" ? arg : materialize(arg, state)), environment(run.env, plan.host), run, reflectionTexts(plan, state.bytes));
}
/** A non-default host must already hold a stored gh credential; output is discarded, failure is a fixed code. */
async function hostPreflight(host: string, run: Runtime): Promise<void> {
	try { await runGh(() => ["auth", "status", `--hostname=${host}`], preflightEnvironment(run.env, host), run); }
	catch (error) { throw error instanceof Failure && error.code === "gh-failed" ? new Failure("host-unauthenticated") : error; }
}
function failed(error: unknown): PublishResult {
	if (error instanceof InvalidRequest) return result("invalid-request", undefined, error.detail);
	if (error instanceof Failure) return result(error.code, error.diagnostics, error.detail);
	return result("payload-unreadable", undefined, unreadableDetail(error));
}
async function cleanup(state: { directory?: string; outcome: PublishResult }, io: PublisherIO): Promise<PublishResult> {
	if (!state.directory) return state.outcome;
	try { await io.rm(state.directory, { recursive: true, force: true }); }
	catch { return result("cleanup-failed"); }
	return state.outcome;
}
/** Captures once and sends only scanned bytes. Not an authority decision or same-user sandbox. */
export async function publish(value: unknown, context: PublisherContext = {}, adapters: PublisherAdapters = {}): Promise<PublishResult> {
	const run = runtime(context, adapters);
	let directory: string | undefined;
	let outcome: PublishResult;
	try {
		cancelled(context.signal);
		const request = validateRequest(value), plan = toGhPlan(request);
		captureFlags(run.platform);
		const bytes = await capture(plan, run);
		cancelled(context.signal);
		if (request.kind === "check") return result("scan-clean");
		if (plan.host) await hostPreflight(plan.host, run);
		cancelled(context.signal);
		directory = await run.io.mkdtemp(join(run.temporaryRoot(), "pi-publish-"));
		await run.io.chmod(directory, 0o700);
		const paths = await snapshots({ dir: directory, plan, bytes }, run);
		await send(plan, { bytes, paths }, run);
		outcome = result("published");
	} catch (error) { outcome = failed(error); }
	return cleanup({ directory, outcome }, run.io);
}
