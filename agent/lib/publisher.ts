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

export type PublishCode = "published" | "scan-clean" | "invalid-request" | "unsupported-platform" | "payload-unreadable" | "payload-too-large" | "payload-not-utf8" | "scan-refused" | "gh-unavailable" | "gh-failed" | "gh-timeout" | "cancelled" | "gh-output-limit" | "cleanup-failed";
export interface PublishResult { code: PublishCode; text: string; isError: boolean; diagnostics?: { source: string; count: number; findings: PublicationScan["findings"] } }
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
	constructor(code: PublishCode, diagnostics?: PublishResult["diagnostics"]) {
		super(`publish: ${code}`); this.code = code; this.diagnostics = diagnostics;
	}
}
function result(code: PublishCode, diagnostics?: PublishResult["diagnostics"]): PublishResult {
	const success = code === "published" || code === "scan-clean";
	return { code, text: success ? (code === "published" ? "published" : "scan clean") : `publish: ${code}`, isError: !success, ...(diagnostics ? { diagnostics } : {}) };
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
	if (!stat.isFile()) throw new Failure("payload-unreadable");
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
async function captureFile(path: string, run: Runtime): Promise<Buffer> {
	cancelled(run.context.signal);
	const flags = captureFlags(run.platform);
	try {
		const handle = await run.io.open(resolve(run.context.cwd ?? process.cwd(), path), flags);
		try {
			cancelled(run.context.signal); checkStat(await handle.stat());
			const bytes = await readBounded(handle, run.context.signal);
			checkStat(await handle.stat()); cancelled(run.context.signal);
			return bytes;
		} finally { await handle.close(); }
	} catch (error) { if (error instanceof Failure) throw error; throw new Failure("payload-unreadable"); }
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
function environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = { ...env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat" };
	delete child.GH_DEBUG; delete child.DEBUG;
	return child;
}
function materialize(slot: PayloadSlot, state: { bytes: Buffer[]; paths: string[] }): string {
	return slot.prefix + (slot.use === "file" ? state.paths[slot.payload] : decoded(state.bytes[slot.payload]));
}
const OUTPUT_LIMIT = 256 * 1024;
function watchStream(stream: Readable | null, stop: (code: PublishCode) => void): void {
	let bytes = 0;
	stream?.on("data", (chunk: Buffer | string) => {
		bytes += Buffer.byteLength(chunk);
		if (bytes > OUTPUT_LIMIT) stop("gh-output-limit");
	});
	stream?.on("error", () => stop("gh-failed"));
}
function childFailure(state: { code: number | null; failure?: PublishCode }): Failure | undefined {
	if (state.failure) return new Failure(state.failure);
	if (state.code !== 0) return new Failure("gh-failed");
	return undefined;
}
function monitor(child: PublisherChild, run: Runtime): Promise<void> {
	return new Promise((resolve, reject) => {
		let failure: PublishCode | undefined;
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
			const error = childFailure({ code, failure });
			if (error) reject(error); else resolve();
		});
		watchStream(child.stdout, stop); watchStream(child.stderr, stop);
		run.context.signal?.addEventListener("abort", abort, { once: true });
		if (run.context.signal?.aborted) abort();
	});
}
async function send(plan: GhPlan, state: { bytes: Buffer[]; paths: string[] }, run: Runtime): Promise<void> {
	const executable = await ghExecutable(run);
	cancelled(run.context.signal);
	const argv = plan.argv.map(arg => typeof arg === "string" ? arg : materialize(arg, state));
	try {
		const child = run.spawn(executable, argv, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: environment(run.env), cwd: run.context.cwd });
		await monitor(child, run);
	} catch (error) { if (error instanceof Failure) throw error; throw new Failure("gh-failed"); }
}
function failed(error: unknown): PublishResult {
	if (error instanceof InvalidRequest) return result("invalid-request");
	if (error instanceof Failure) return result(error.code, error.diagnostics);
	return result("payload-unreadable");
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
		cancelled(context.signal);
		directory = await run.io.mkdtemp(join(run.temporaryRoot(), "pi-publish-"));
		await run.io.chmod(directory, 0o700);
		const paths = await snapshots({ dir: directory, plan, bytes }, run);
		await send(plan, { bytes, paths }, run);
		outcome = result("published");
	} catch (error) { outcome = failed(error); }
	return cleanup({ directory, outcome }, run.io);
}
