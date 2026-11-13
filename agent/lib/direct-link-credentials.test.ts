// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// Credential reads are isolated fixtures; the subprocess test uses a fake keychain executable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DirectCredentials, isForbiddenSecretPath, scrubChildEnv } from "./direct-link-credentials.ts";
import { tempDir } from "./test-tmp.ts";
for (const mode of [0o644, 0o400, 0o666, 0o700, 0o1600]) test(`interface file mode ${mode.toString(8)} refused`, async () => {
	const path = join(tempDir("direct-link-mode-"), "token"); writeFileSync(path, "FAKE_INTERFACE_TOKEN"); chmodSync(path, mode);
	const credentials = new DirectCredentials();
	await assert.rejects(credentials.interfaceToken(path), { message: "Direct interface token unavailable" });
	assert.deepEqual(credentials.secretsToMask(), []);
});
test("symlinks, directories, missing files and whitespace tokens refused with fixed errors", async () => {
	const root = tempDir("direct-link-files-"); const file = join(root, "file");
	writeFileSync(file, "FAKE TOKEN", { mode: 0o600 }); symlinkSync(file, join(root, "link")); mkdirSync(join(root, "dir"));
	for (const name of ["file", "link", "dir", "missing"]) await assert.rejects(new DirectCredentials().interfaceToken(join(root, name)), { message: "Direct interface token unavailable" });
});
test("PAT environment override requires explicit test mode", async () => {
	let called = 0;
	const credentials = new DirectCredentials();
	const runSecurity = async (args: string[]) => {
		called++; assert.deepEqual(args, ["find-generic-password", "-s", "direct-pat", "-a", "direct-link", "-w"]); return "dpat_FAKE_KEYCHAIN\n";
	};
	assert.equal(await credentials.pat({ env: { DIRECT_PAT: "dpat_FAKE_ENV" }, runSecurity }), "dpat_FAKE_KEYCHAIN");
	assert.equal(await credentials.pat({ env: { DIRECT_PAT: "dpat_FAKE_ENV", DIRECT_LINK_TEST: "1" }, runSecurity }), "dpat_FAKE_ENV");
	assert.equal(called, 1);
});
test("keychain errors and malformed values never appear in error messages", async () => {
	for (const runSecurity of [async () => { throw new Error("dpat_FAKE0000"); }, async () => "Bearer FAKE"]) {
		await assert.rejects(new DirectCredentials().pat({ env: {}, runSecurity }), { message: "Direct PAT unavailable" });
	}
});
test("read credentials feed masking and exact interface paths feed the guard", async () => {
	const path = join(tempDir("direct-link-allowed-"), "interface"); writeFileSync(path, "FAKE_INTERFACE_TOKEN\n", { mode: 0o600 });
	const credentials = new DirectCredentials();
	assert.equal(await credentials.interfaceToken(path), "FAKE_INTERFACE_TOKEN");
	await credentials.pat({ env: { DIRECT_LINK_TEST: "1", DIRECT_PAT: "dpat_FAKE0000" } });
	assert.deepEqual(credentials.secretsToMask(), ["FAKE_INTERFACE_TOKEN", "dpat_FAKE0000"]);
	assert.equal(credentials.isForbiddenSecretPath(path), true);
});
test("one-shot proof file is consumed, unlinked, masked and removed from env", async () => {
	const worktree = tempDir("direct-link-worktree-"); const path = join(tempDir("direct-link-proof-"), "proof");
	writeFileSync(path, "FAKE_PROOF", { mode: 0o600 });
	const env = { DIRECT_LINK_LAUNCH_PROOF_FILE: path }; const credentials = new DirectCredentials();
	assert.equal(await credentials.launchProof({ env, worktree }), "FAKE_PROOF");
	assert.equal(existsSync(path), false); assert.equal(env.DIRECT_LINK_LAUNCH_PROOF_FILE, undefined);
	assert.deepEqual(credentials.secretsToMask(), ["FAKE_PROOF"]); assert.equal(credentials.isForbiddenSecretPath(path), true);
	writeFileSync(path, "FAKE_PROOF", { mode: 0o600 }); env.DIRECT_LINK_LAUNCH_PROOF_FILE = path;
	await assert.rejects(credentials.launchProof({ env, worktree }), { message: "Direct launch proof unavailable" });
});
test("legacy proof env is never read, even as a fallback", async () => {
	const env: Record<string, string | undefined> = {};
	Object.defineProperty(env, "DIRECT_LINK_LAUNCH_PROOF", { configurable: true, get() { assert.fail("must not read raw proof env"); } });
	await assert.rejects(new DirectCredentials().launchProof({ env, worktree: process.cwd() }), { message: "Direct launch proof unavailable" });
	assert.equal("DIRECT_LINK_LAUNCH_PROOF" in env, false);
});
test("proof files inside cwd/worktree, through symlinks, or with wrong mode are refused", async () => {
	const worktree = tempDir("direct-link-root-"); const outside = tempDir("direct-link-outside-");
	const inside = join(worktree, "proof"); const wrongMode = join(outside, "wrong"); const link = join(outside, "link");
	writeFileSync(inside, "FAKE_PROOF", { mode: 0o600 }); writeFileSync(wrongMode, "FAKE_PROOF", { mode: 0o600 }); chmodSync(wrongMode, 0o644); symlinkSync(inside, link);
	for (const path of [inside, wrongMode, link, join(outside, "missing"), outside]) {
		await assert.rejects(new DirectCredentials().launchProof({ env: { DIRECT_LINK_LAUNCH_PROOF_FILE: path }, worktree }), { message: "Direct launch proof unavailable" });
	}
	await assert.rejects(new DirectCredentials().launchProof({ env: { DIRECT_LINK_LAUNCH_PROOF_FILE: inside }, worktree: outside, cwd: worktree }));
});
test("every child environment is an allow-listed copy without launch metadata or other secrets", () => {
	const env = { DIRECT_PAT: "dpat_FAKE0000", DIRECT_LINK_LAUNCH_PROOF: "FAKE_PROOF", DIRECT_LINK_LAUNCH_PROOF_FILE: "/fake/proof", DIRECT_TOKEN: "FAKE", DIRECT_SECRET: "FAKE", DIRECT_PASSWORD: "FAKE", DIRECT_DPAT: "FAKE", DIRECT_LINK_SESSION: "session-fake", DIRECT_LINK_HARNESS: "pi", PATH: "/fake/bin", OTHER_TOKEN: "FAKE_OTHER" };
	assert.deepEqual(scrubChildEnv(env), { PATH: "/fake/bin" });
	assert.equal(env.DIRECT_LINK_LAUNCH_PROOF, "FAKE_PROOF");
});
test("insecure proof files are unlinked even when location or mode validation fails", async () => {
	const worktree = tempDir("direct-link-invalid-proof-");
	for (const [directory, mode] of [[worktree, 0o600], [tempDir("direct-link-mode-proof-"), 0o644]] as const) {
		const path = join(directory, "proof"); writeFileSync(path, "FAKE_PROOF", { mode }); chmodSync(path, mode);
		await assert.rejects(new DirectCredentials().launchProof({ env: { DIRECT_LINK_LAUNCH_PROOF_FILE: path }, worktree }));
		assert.equal(existsSync(path), false);
	}
});
test("keychain subprocess receives only the same allow-list as bash and git", async () => {
	const bin = tempDir("direct-link-security-");
	const executable = join(bin, "security");
	writeFileSync(executable, '#!/bin/sh\n[ -z "$DIRECT_PAT$DIRECT_LINK_LAUNCH_PROOF_FILE$DIRECT_LINK_SESSION$GH_TOKEN$NODE_OPTIONS" ] || exit 1\nprintf "dpat_FAKE_CHILD"\n', { mode: 0o700 });
	const keys = ["PATH", "DIRECT_PAT", "DIRECT_LINK_LAUNCH_PROOF_FILE", "DIRECT_LINK_SESSION", "GH_TOKEN", "NODE_OPTIONS"];
	const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	try {
		Object.assign(process.env, { PATH: bin, DIRECT_PAT: "dpat_FAKE_PARENT", DIRECT_LINK_LAUNCH_PROOF_FILE: "/fake/proof", DIRECT_LINK_SESSION: "fake-session", GH_TOKEN: "FAKE_GH", NODE_OPTIONS: "FAKE_OPTIONS" });
		assert.equal(await new DirectCredentials().pat(), "dpat_FAKE_CHILD");
	} finally {
		for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
	}
});
test("runner stores, keychain references, PAT files and injected patterns are forbidden", () => {
	for (const path of ["~/.config/direct/credentials/pat", "~/.config/direct/run/proof", "~/Library/Application Support/Direct/credentials", "~/Library/Application Support/Direct/run/proof", "keychain:direct-runner", "~/Library/Keychains/login.keychain-db", "~/.config/direct/runner-credentials.json", "~/Library/Application Support/Direct/runner-secret", "~/.config/direct/pat", "~/.config/direct/interface-token"]) assert.equal(isForbiddenSecretPath(path), true, path);
	assert.equal(isForbiddenSecretPath("~/safe/code.ts"), false);
	assert.equal(isForbiddenSecretPath("~/custom/store", { patterns: [/custom\/store/g] }), true);
	assert.equal(isForbiddenSecretPath("~/custom/pat", { secretPaths: ["/fake-home/custom/pat"], home: "/fake-home" }), true);
});
