import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { outboundReason } from "./secret-mask.ts";

const secret = "ghp_" + "A".repeat(40);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "whole-publication-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function blocked(command: string, kind = "github-token"): void {
	const reason = outboundReason(command, dir);
	assert.ok(reason?.includes(`(${kind})`), `${command}: ${reason}`);
	assert.ok(!reason.includes(secret));
}

test("reviewer repro: a hyphenated heredoc delimiter cannot consume the publication after it", () => {
	blocked(`cat <<END-NOTES\nHarmless notes\nEND-NOTES\ngh release create v1 -n '${secret}'`);
	blocked("cat <<END-NOTES\nHarmless notes\nEND-NOTES\ngh release create v1 -n '/Users/alice/private'", "internal-path");
});

test("secret scanning covers every line even after malformed or unterminated heredocs", () => {
	for (const header of ["<<END-NOTES", "<<'BROKEN", "<<< public", "<<'END NOTES'"]) {
		blocked(`cat ${header}\nEND\ngh release create v1 -n '${secret}'`);
	}
});

test("secret scanning does not depend on recognizing executable shell constructs", () => {
	for (const command of [
		`printf '%s' "$(printf '${secret}')"; gh release create v1 -n Public`,
		`printf '%s' \`printf '${secret}'\`; gh pr review 1 --approve`,
		`eval "gh release create v1 -n '${secret}'"`,
		`eval "printf '${secret}'"; gh issue close 1 --comment Public`,
		`printf 'gh pr create --body ${secret}'`,
		`cat <<'EOF'\ngh release create v1 -n '${secret}'\nEOF`,
	]) blocked(command);
});

for (const [group, verbs] of Object.entries({ gist: ["create", "edit"], release: ["create", "edit"], issue: ["comment", "create", "edit", "close"], pr: ["comment", "create", "edit", "close", "review"] })) {
	for (const verb of verbs) {
		test(`whole-command scan is active for gh ${group} ${verb}`, () => {
			blocked(`eval "gh ${group} ${verb} public"; printf '${secret}'`);
		});
	}
}

test("publication mentions with quoted words or line continuations also scan all text", () => {
	blocked(`eval "gh 'release' 'create' v1"; printf '${secret}'`);
	blocked(`gh \\\nrelease \\\ncreate v1 -n Public; printf '${secret}'`);
});

test("local-path checks remain payload-only, not whole-command", () => {
	assert.equal(outboundReason("cd /Users/alice/work && gh release create v1 -n Public", dir), undefined);
	assert.equal(outboundReason("printf '/home/alice/work'; gh issue create --body Public", dir), undefined);
	assert.equal(outboundReason("cat <<END-NOTES\n/Users/alice/private\nEND-NOTES\ngh release create v1 -n Public", dir), undefined);
	blocked("gh release create v1 -n '/Users/alice/private'", "internal-path");
});

for (const delimiter of ["END-NOTES", "'END-NOTES'", '"END-NOTES"', "v1.2-notes!"]) {
	test(`full heredoc delimiter, exact terminator: ${delimiter}`, () => {
		const end = delimiter.replace(/['"]/g, "");
		assert.equal(outboundReason(`gh gist create - <<${delimiter}\nPublic\n${end}`, dir), undefined);
		blocked(`gh gist create - <<${delimiter}\nPublic\n${end} suffix`, "outbound-heredoc-unscannable");
	});
}

test("unterminated and unsupported heredocs fail closed even when not feeding gh", () => {
	for (const command of [
		"cat <<END-NOTES\nPublic\nEND\ngh release create v1 -n Public",
		"cat <<'BROKEN\ngh release create v1 -n Public",
		"cat <<'END NOTES'\nPublic\nEND NOTES\ngh release create v1 -n Public",
		"cat <<EOF'EXTRA'\nPublic\nEOFEXTRA\ngh release create v1 -n Public",
		"cat <<\\EOF\nPublic\nEOF\ngh release create v1 -n Public",
		"gh release create v1 -n Public <<< input",
	]) blocked(command, "outbound-heredoc-unscannable");
});

test("combined gist switches still scan positional payload files", () => {
	writeFileSync(join(dir, "notes.md"), "Public");
	for (const flags of ["-pw", "-wp"]) {
		assert.equal(outboundReason(`gh gist create ${flags} notes.md`, dir), undefined);
	}
	writeFileSync(join(dir, "notes.md"), secret);
	blocked("gh gist create -pw notes.md");
	blocked("gh gist edit abc123 -pw notes.md");
});

test("flag-only gist edits do not synthesize stdin but still scan referenced files", () => {
	writeFileSync(join(dir, "notes.md"), "Public");
	for (const flags of ["--add notes.md", "-anotes.md", "--remove old.md", "--desc Public", "--desc=Public --remove old.md", "--filename notes.md", "-pw", ""]) {
		assert.equal(outboundReason(`gh gist edit abc123 ${flags}`, dir), undefined, flags);
	}
	writeFileSync(join(dir, "notes.md"), secret);
	blocked("gh gist edit abc123 --add notes.md");
	blocked("gh gist edit abc123 --desc Public --add notes.md");
});

test("gist edit still scans or refuses stdin when it is actually supplied", () => {
	assert.equal(outboundReason("printf Public | gh gist edit abc123 --filename notes.md", dir), undefined);
	blocked(`printf '${secret}' | gh gist edit abc123 --filename notes.md`);
	blocked("generate-notes | gh gist edit abc123 --filename notes.md", "outbound-stdin-unscannable");
	blocked("gh gist edit abc123 -", "outbound-stdin-unscannable");
	blocked("gh gist edit abc123 --filename notes.md <<'EOF'\n/Users/alice/private\nEOF", "internal-path");
});
