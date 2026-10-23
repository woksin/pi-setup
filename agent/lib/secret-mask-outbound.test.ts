import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHandlers, DEFAULTS, MAX_BYTES, outboundReason } from "./secret-mask.ts";

let dir: string;
const secret = "ghp_" + "A".repeat(40);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "outbound-test-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

for (const group of ["issue", "pr", "gist", "release"]) {
	const verbs = ["gist", "release"].includes(group) ? ["create", "edit"] : ["comment", "create", "edit"];
	for (const verb of verbs) {
		test(`scans inline publication text: gh ${group} ${verb}`, () => {
			for (const flag of ["--body", "-b", "--notes", "--title"]) {
				const reason = outboundReason(`gh ${group} ${verb} 1 ${flag} '${secret}'`, dir);
				assert.match(reason!, /GitHub publication blocked \(github-token\)/);
				assert.ok(!reason!.includes(secret));
			}
		});
	}
}
for (const path of ["/Users/alice/repo", "/home/alice/repo", ".ai-work/notes.md", "~/.pi/agent"]) {
	test(`blocks internal path class: ${path}`, () => {
		const reason = outboundReason(`gh pr create --title='${path}'`, dir);
		assert.match(reason!, /internal-path/);
		assert.ok(!reason!.includes(path));
	});
}
for (const flag of ["--body-file", "-F", "--notes-file"]) {
	test(`scans contents of ${flag} files relative to cwd, not the filename`, () => {
		const file = "public text.md";
		writeFileSync(join(dir, file), secret);
		assert.match(outboundReason(`gh release edit v1 ${flag} '${file}'`, dir)!, /github-token/);
		writeFileSync(join(dir, file), "See /home/alice/private");
		assert.match(outboundReason(`gh issue create ${flag}='${file}'`, dir)!, /internal-path/);
		writeFileSync(join(dir, file), "Safe public text");
		assert.equal(outboundReason(`gh pr comment 1 ${flag} '${join(dir, file)}'`, dir), undefined);
	});
}

test("inline equals, compact short flags, wrappers and compound commands are scanned", () => {
	for (const command of [
		`gh -R o/r issue create --body=${secret}`,
		`env X=x command gh pr edit 1 -b${secret}`,
		`printf safe && gh issue comment 1 --body '${secret}'`,
		`gh issue view 1; gh gist create --title '${secret}'`,
		`gh pr create --body 'safe\n${secret}'`,
	]) assert.match(outboundReason(command, dir)!, /github-token/);
	writeFileSync(join(dir, "text.md"), secret);
	assert.match(outboundReason("gh pr comment 1 -Ftext.md", dir)!, /github-token/);
});

test("unreadable, stdin and oversized files fail closed without exposing paths", () => {
	for (const file of ["absent.md", "."]) {
		assert.match(outboundReason(`gh issue create --body-file '${file}'`, dir)!, /outbound-file-unreadable/);
	}
	assert.match(outboundReason("gh issue create --body-file -", dir)!, /outbound-stdin-unscannable/);
	writeFileSync(join(dir, "big.md"), "a".repeat(MAX_BYTES + 1));
	assert.match(outboundReason("gh release create v1 --notes-file big.md", dir)!, /outbound-payload-too-large/);
	assert.match(outboundReason("gh issue create --body", dir)!, /outbound-value-missing/);
});

test("unrelated commands, read-only gh and safe public text are unchanged", () => {
	for (const command of [
		`gh issue view 1 --body '${secret}'`,
		`gh api repos/o/r --title '${secret}'`,
		"gh issue create --title 'Fix bug' --body 'Public explanation'",
	]) assert.equal(outboundReason(command, dir), undefined);
});

test("outbound scan reuses credential recognizers including private keys and assignments", () => {
	const key = "-----BEGIN " + "PRIVATE KEY-----\nfixture\n-----END " + "PRIVATE KEY-----";
	assert.match(outboundReason(`gh pr create --body '${key}'`, dir)!, /private-key/);
	assert.match(outboundReason(`gh pr create --body 'PASSWORD=a1B2c3d4e5f6'`, dir)!, /connection-string|env-secret/);
});

test("handler blocks publication before Cratis delegation or UI approval; guard switch still works", async () => {
	const ctx: any = { cwd: dir, hasUI: true, sessionManager: { getSessionId: () => "test" } };
	let off = false;
	const handlers = createHandlers({
		config: () => ({ ...DEFAULTS }), role: () => "main", guardOff: () => off,
		cratisSecrets: () => { throw new Error("must not delegate publication"); },
		error: () => { throw new Error("must not fail open"); },
	});
	const event = { toolName: "bash", input: { command: `gh pr create --body '${secret}'` } };
	assert.equal((await handlers.toolCall(event, ctx))?.block, true);
	off = true;
	assert.equal(await handlers.toolCall(event, ctx), undefined);
});
