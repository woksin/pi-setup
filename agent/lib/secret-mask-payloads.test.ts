import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { outboundReason } from "./secret-mask.ts";

const secret = "ghp_" + "A".repeat(40);
let dir: string;
let previousCdPath: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "public-payload-"));
	previousCdPath = process.env.CDPATH;
	delete process.env.CDPATH;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (previousCdPath === undefined) delete process.env.CDPATH;
	else process.env.CDPATH = previousCdPath;
});
function blocked(command: string, kind = "github-token"): void {
	const reason = outboundReason(command, dir);
	assert.ok(reason?.includes(`(${kind})`), `${command}: ${reason}`);
	assert.ok(!reason.includes(secret));
	assert.ok(!reason.includes("/Users/alice/private"));
}

for (const verb of ["create", "edit"]) {
	test(`release ${verb}: all notes flags, including compact and equals forms`, () => {
		for (const flag of ["-n", "--notes"]) blocked(`gh release ${verb} v1 ${flag} '/Users/alice/private'`, "internal-path");
		for (const notes of [`-n${secret}`, `-n=${secret}`, `--notes=${secret}`]) blocked(`gh release ${verb} v1 ${notes}`);
		writeFileSync(join(dir, "notes.md"), secret);
		for (const file of ["-F notes.md", "-Fnotes.md", "-F=notes.md", "--notes-file notes.md", "--notes-file=notes.md"]) blocked(`gh release ${verb} v1 ${file}`);
	});
	test(`gist ${verb}: scan positional files, not just option text`, () => {
		writeFileSync(join(dir, "safe.md"), "Public text");
		writeFileSync(join(dir, "private notes.md"), secret);
		const command = `gh gist ${verb}${verb === "edit" ? " abc123" : ""}`;
		blocked(`${command} 'private notes.md'`);
		blocked(`${command} '${join(dir, "private notes.md")}'`);
		blocked(`${command} safe.md 'private notes.md'`);
		assert.equal(outboundReason(`${command} safe.md`, dir), undefined);
	});
}

const stdinCommands = [
	"gh gist create -", "gh gist edit abc123 -", "gh gist create --filename public.txt",
];
for (const command of stdinCommands) {
	test(`literal stdin and unknown stdin: ${command}`, () => {
		blocked(`printf '%s\\n' '${secret}' | ${command}`);
		blocked(`echo '${secret}' | ${command}`);
		assert.equal(outboundReason(`printf '%s\\n' 'Public text' | ${command}`, dir), undefined);
		assert.equal(outboundReason(`echo -n 'Public text' | ${command}`, dir), undefined);
		blocked(command, "outbound-stdin-unscannable");
		blocked(`cat private.txt | ${command}`, "outbound-stdin-unscannable");
		blocked(`printf '%s' "$TOKEN" | ${command}`, "outbound-stdin-unscannable");
		blocked(`${command} < private.txt`, "outbound-stdin-unscannable");
	});
}

test("implicit gist stdin is scanned with --filename, -f and no filename override", () => {
	for (const args of ["", "--filename public.txt", "--filename=public.txt", "-f public.txt", "-fpublic.txt"]) {
		blocked(`printf '%s' '${secret}' | gh gist create ${args}`);
		assert.equal(outboundReason(`printf 'Public text' | gh gist create ${args}`, dir), undefined);
	}
	blocked("gh gist create --filename public.txt", "outbound-stdin-unscannable");
});

test("direct and piped literal heredocs are scanned; their bodies are not commands", () => {
	for (const command of ["gh gist create -"]) {
		blocked(`${command} <<'EOF'\n${secret}\nEOF`);
		blocked(`cat <<'EOF' | ${command}\n${secret}\nEOF`);
		blocked(`${command} <<EOF\n${secret}\nEOF`);
		assert.equal(outboundReason(`${command} <<'EOF'\nPublic text\nEOF`, dir), undefined);
		assert.equal(outboundReason(`cat <<-"EOF" | ${command}\n\tPublic text\n\tEOF`, dir), undefined);
	}
	assert.equal(outboundReason("gh gist create - <<'EOF'\nUse $PATH as an example\nEOF", dir), undefined);
	blocked("gh gist create - <<EOF\n$TOKEN\nEOF", "outbound-stdin-unscannable");
	blocked(`gh gist create - <<EOF\nghp_\\\n${"A".repeat(40)}\nEOF`, "outbound-stdin-unscannable");
	blocked("gh gist create - <<'EOF'\nUnterminated", "outbound-heredoc-unscannable");
	blocked(`# <<EOF\ngh release create v1 -n '${secret}'\nEOF`);
	assert.equal(outboundReason("cat <<'EOF'\ngh release create v1 -n private\nEOF", dir), undefined);
});

test("unsupported printf transformations and nonliteral producers are refused", () => {
	for (const producer of ["printf '%b' '\\x67hp_hidden'", "printf '\\x67hp_hidden'", "echo -e '\\x67hp_hidden'", "generate-notes"]) {
		blocked(`${producer} | gh gist create -`, "outbound-stdin-unscannable");
	}
	blocked("printf '%s' `generate-notes` | gh gist create -", "outbound-wrapper-unscannable");
	assert.equal(outboundReason("printf '100%% public' | gh gist create -", dir), undefined);
});

test("PR reviews and issue/PR close comments scan short, long and compact flags", () => {
	for (const body of [`-b '${secret}'`, `--body=${secret}`, `-b${secret}`]) blocked(`gh pr review 1 ${body}`);
	writeFileSync(join(dir, "review.md"), secret);
	for (const file of ["-F review.md", "-Freview.md", "--body-file=review.md"]) blocked(`gh pr review 1 ${file}`);
	for (const group of ["issue", "pr"]) {
		for (const comment of [`-c '${secret}'`, `--comment=${secret}`, `-c${secret}`]) blocked(`gh ${group} close 1 ${comment}`);
	}
});

test("body and gist files resolve after a literal cd with &&", () => {
	mkdirSync(join(dir, "nested"));
	writeFileSync(join(dir, "notes.md"), "Public text");
	writeFileSync(join(dir, "nested", "notes.md"), secret);
	for (const command of ["gh issue create -F notes.md", "gh pr review 1 --body-file notes.md", "gh release create v1 --notes-file notes.md", "gh gist create notes.md"]) {
		assert.equal(outboundReason(command, dir), undefined);
		blocked(`cd nested && ${command}`);
		blocked(`cd '${join(dir, "nested")}' && ${command}`);
	}
});

test("uncertain cwd refuses relative files instead of scanning the wrong file", () => {
	writeFileSync(join(dir, "notes.md"), "Public text");
	for (const prefix of ["cd nested;", "cd nested ||", "cd \"$TARGET\" &&", "cd nested && false;", "eval 'cd nested';", "cd \"$TARGET\" && cd nested &&", "cd ~ &&", "cd nest* &&", "CDPATH=/tmp cd nested &&", "printf safe | cd nested &&"]) {
		blocked(`${prefix} gh issue create -F notes.md`, "outbound-cwd-unscannable");
	}
	assert.equal(outboundReason(`cd "$TARGET" && gh issue create -F '${join(dir, "notes.md")}'`, dir), undefined);
	process.env.CDPATH = "/unknown";
	blocked("cd nested && gh issue create -F notes.md", "outbound-cwd-unscannable");
});

test("computed words cannot conceal a publication value or file", () => {
	blocked(`gh release create v1 -n "ghp_\\\n${"A".repeat(40)}"`, "outbound-value-unscannable");
	for (const file of ["*.md", "~/.private/notes", "$NOTES", "notes{a,b}.md"]) {
		blocked(`gh gist create '${file}'`, "outbound-file-unscannable");
	}
});
