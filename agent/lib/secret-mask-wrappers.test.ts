import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { outboundReason } from "./secret-mask.ts";

const secret = "ghp_" + "A".repeat(40);
const direct = "publication must be a direct gh command so its payload can be scanned";
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "publication-wrappers-"));
	writeFileSync(join(dir, "f"), "Public notes");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function kind(command: string, expected: string): string {
	const reason = outboundReason(command, dir);
	assert.ok(reason?.includes(`(${expected})`), `${command}: ${reason}`);
	assert.ok(!reason.includes(secret));
	return reason;
}

for (const wrapper of ["eval", "bash -c"]) {
	test(`reviewer repro: ${wrapper} cannot hide a notes file from the raw scan`, () => {
		writeFileSync(join(dir, "f"), secret);
		const reason = kind(`${wrapper} "gh release create v1 --notes-file f"`, "github-token");
		assert.ok(reason.includes(direct));
	});
}

for (const flag of ["--body-file f", "--body-file=f", "--body-file 'f'", '--body-file="f"', "-F f", "-Ff", "-F=f", "--notes-file f", "--notes-file='f'", "'--notes-file' 'f'"]) {
	test(`raw file discovery independent of execution parsing: ${flag}`, () => {
		writeFileSync(join(dir, "f"), secret);
		kind(`eval "gh release create v1 ${flag}"`, "github-token");
	});
}

test("raw file values support quoted spaces and inspect later flag occurrences", () => {
	writeFileSync(join(dir, "private notes.md"), secret);
	kind("bash -c 'gh release create v1 --notes-file \"private notes.md\"'", "github-token");
	kind("eval 'gh release create v1 --notes-file f --body-file \"private notes.md\"'", "github-token");
	kind("eval 'gh release create v1 --notes-file f -Fprivate'", "outbound-file-unreadable");
});

const wrappers = [
	'eval "gh gist create f"',
	'bash -c "gh gist create f"',
	'sh -c "gh gist create f"',
	'zsh -c "gh gist create f"',
	'/bin/bash -lc "gh gist create f"',
	'$(gh gist create f)',
	'`gh gist create f`',
	'printf f | xargs gh gist create',
	'env -S "gh gist create f"',
	'env --split-string="gh gist create f"',
	'source publish.sh; gh gist create f',
	'. publish.sh; gh gist create f',
	'FLAG=x command source publish.sh; gh gist create f',
	'exec gh gist create f',
	'nohup gh gist create f',
	'timeout 5 gh gist create f',
	'sudo gh gist create f',
	'"eval" "gh gist create f"',
];
for (const command of wrappers) {
	test(`execution wrapper is refused: ${command}`, () => {
		writeFileSync(join(dir, "f"), secret);
		assert.ok(kind(command, "outbound-wrapper-unscannable").includes(direct));
	});
}

test("file-flag stdin is refused independently of literal pipe/heredoc parsing", () => {
	for (const command of ["gh pr create --body-file -", "gh issue comment 1 -F-", "gh pr review 1 -F=-", "gh release create vX --notes-file=-"]) {
		kind(command, "outbound-stdin-unscannable");
		kind(`printf Public | ${command}`, "outbound-stdin-unscannable");
		kind(`${command} <<'EOF'\nPublic\nEOF`, "outbound-stdin-unscannable");
	}
});

test("normal direct publishing, GH assignments and a literal cd remain usable", () => {
	mkdirSync(join(dir, ".ai-work"));
	writeFileSync(join(dir, ".ai-work", "pr-body.md"), "Public PR summary");
	for (const command of [
		"gh pr create --body-file .ai-work/pr-body.md",
		'gh issue comment 2 --body "Public notes"',
		"gh release create vX --notes-file f",
		"GH_REPO=o/r gh issue comment 2 --body Public",
		"env GH_REPO=o/r gh pr create --body-file .ai-work/pr-body.md",
		"GH_HOST=github.com gh release create vX --notes-file f",
	]) assert.equal(outboundReason(command, dir), undefined, command);
	mkdirSync(join(dir, "nested"));
	writeFileSync(join(dir, "nested", "f"), "Public notes");
	assert.equal(outboundReason("cd nested && GH_REPO=o/r gh release create vX --notes-file f", dir), undefined);
	writeFileSync(join(dir, "nested", "f"), secret);
	kind("cd nested && gh release create vX --notes-file f", "github-token");
});

test("literal direct gist stdin remains supported without payload-file flags", () => {
	for (const command of ["echo Public | gh gist create -", "printf '%s\\n' Public | gh gist create -", "cat <<'EOF' | gh gist create -\nPublic\nEOF"]) {
		assert.equal(outboundReason(command, dir), undefined, command);
	}
});
