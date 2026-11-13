// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// Read only the person's PAT and the daemon interface token; errors never echo secrets.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export type RunSecurity = (args: string[]) => Promise<string>;
export const runnerSecretPatterns = [
	/keychain:|runner[-_.]?(?:secret|credential)/i, /(?:^|\/)Library\/Keychains(?:\/|$)/i,
	/(?:^|\/)(?:\.config|Library)\/.*(?:direct[-_/])?(?:pat|interface[-_]?token)(?:\.[^/]*)?$/i,
	/(?:^|\/)(?:\.config|Library)\/.*(?:runner.*(?:secret|credential|token)|(?:secret|credential).*runner)/i,
	/(?:^|\/)(?:\.config\/direct|Library\/(?:Application Support\/)?Direct)\/(?:credentials?|run)(?:\/|$)/i,
];
export interface CredentialOptions {
	runSecurity?: RunSecurity; env?: Record<string, string | undefined>; service?: string; account?: string;
}
const security: RunSecurity = async (args) => (await promisify(execFile)("security", args, { env: scrubChildEnv(process.env), timeout: 2000 })).stdout;
export interface ProofOptions { env?: Record<string, string | undefined>; cwd?: string; worktree: string }
const CHILD_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "TZ", "SystemRoot", "COMSPEC", "PATHEXT"]);
export function scrubChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(env).filter(([key]) => CHILD_KEYS.has(key) || /^LC_[A-Z_]+$/.test(key)));
}
const inside = (root: string, path: string) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`)); };
export class DirectCredentials {
	#secrets = new Set<string>();
	#paths = new Set<string>();
	#proofRead = false;
	async pat(options: CredentialOptions = {}): Promise<string> {
		try {
			const env = options.env ?? process.env;
			const value = env.DIRECT_LINK_TEST === "1" && env.DIRECT_PAT !== undefined
				? env.DIRECT_PAT : await (options.runSecurity ?? security)(["find-generic-password", "-s", options.service ?? "direct-pat", "-a", options.account ?? "direct-link", "-w"]);
			const pat = value.trim();
			if (!/^dpat_[A-Za-z0-9_-]+$/.test(pat)) throw new Error();
			this.#secrets.add(pat);
			return pat;
		} catch { throw new Error("Direct PAT unavailable"); }
	}
	async launchProof(options: ProofOptions): Promise<string> {
		try {
			const env = options.env ?? process.env;
			const path = this.#takeProofPath(env);
			const proof = await this.#proofFile(path, options);
			if (!proof || /\s/.test(proof)) throw new Error();
			this.#secrets.add(proof);
			return proof;
		} catch { throw new Error("Direct launch proof unavailable"); }
	}
	#takeProofPath(env: Record<string, string | undefined>): string {
		const path = env.DIRECT_LINK_LAUNCH_PROOF_FILE;
		delete env.DIRECT_LINK_LAUNCH_PROOF; delete env.DIRECT_LINK_LAUNCH_PROOF_FILE;
		if (this.#proofRead) throw new Error();
		this.#proofRead = true;
		if (!path) throw new Error();
		return path;
	}
	async #proofFile(path: string, options: ProofOptions): Promise<string> {
		this.#paths.add(resolve(path));
		return this.#ownerFile(path, async () => {
			const canonical = await realpath(path);
			this.#paths.add(canonical);
			const roots = await Promise.all([realpath(options.cwd ?? process.cwd()), realpath(options.worktree)]);
			if (roots.some((root) => inside(root, canonical))) throw new Error();
		}, true);
	}
	async #ownerFile(path: string, validate = async () => {}, consume = false): Promise<string> {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			await validate();
			const stat = await file.stat();
			if (!stat.isFile()) throw new Error();
			if ((stat.mode & 0o7777) !== 0o600) throw new Error();
			if (stat.uid !== process.getuid?.()) throw new Error();
			return (await file.readFile("utf8")).trim();
		} finally {
			try { await file.close(); } finally { if (consume) await unlink(path); }
		}
	}
	async interfaceToken(path: string): Promise<string> {
		this.#paths.add(resolve(path));
		try {
			const token = await this.#ownerFile(path);
			if (!token || /\s/.test(token)) throw new Error();
			this.#secrets.add(token);
			return token;
		} catch { throw new Error("Direct interface token unavailable"); }
	}
	secretsToMask(): string[] { return [...this.#secrets]; }
	isForbiddenSecretPath(path: string, patterns = runnerSecretPatterns): boolean {
		return isForbiddenSecretPath(path, { patterns, secretPaths: [...this.#paths] });
	}
}
export function isForbiddenSecretPath(path: string, options: { patterns?: RegExp[]; secretPaths?: string[]; home?: string } = {}): boolean {
	const home = options.home ?? homedir();
	const expand = (p: string) => p.startsWith("~/") ? resolve(home, p.slice(2)) : resolve(p);
	const normalized = expand(path);
	if (options.secretPaths?.some((p) => expand(p) === normalized)) return true;
	return (options.patterns ?? runnerSecretPatterns).some((pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(normalized));
}
