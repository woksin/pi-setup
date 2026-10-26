import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLICATION_REASON, publicationGuard, publicationInput } from "./publish-guard.ts";
import publishGuard from "../extensions/publish-guard.ts";
import { setGuards } from "./guards.ts";

const writes = [
	"gh issue create", "gh pr comment 1 --body x", "gh issue reopen 1 --comment x", "gh pr reopen 1 -cmessage",
	"gh issue edit 1 -tTitle", "gh pr review 1 -abtext", "gh pr merge 1 --subject=Title", "gh issue close 1 -Ffile",
	"gh release create v1", "gh release edit v1", "gh gist create file", "gh gist edit abc", "gh alias import file", "gh alias set foo '!script'",
	"gh --repo o/r issue create", "gh -Ro/r pr create", "gh --hostname github.com api repos/o/r -XPOST",
	"gh api repos/o/r -XPOST", "gh api repos/o/r --method=patch", "gh api repos/o/r -fX=x", "gh api repos/o/r -Fkey=@file", "gh api repos/o/r --input file",
	"gh api graphql -XGET", "gh api /graphql", "gh --unknown issue create",
	"/usr/bin/gh issue comment 1", "command -- gh issue create", "exec -a gh /usr/bin/gh pr create", "nohup gh pr create", "rtk proxy gh issue create",
	"A='gh prose' gh issue create", "env -u HOME gh issue create", "env -uHOME gh issue create", "env --unset=HOME gh issue create",
	"env -C /tmp gh issue create", "env --chdir=/tmp gh issue create", "env -i X=y -- /usr/bin/gh issue create", "env -- command gh issue create",
	"if true; then gh issue comment 39 --repo o/r --body /Users/alice/private; fi", "if gh issue create; then :; fi", "if false; then :; elif true; then gh pr create; fi",
	"if false; then :; else gh pr create; fi", "while true; do gh issue comment 39 --repo o/r --body x; done", "until false; do gh issue create; break; done",
	"for n in 1 2; do gh issue create; done", "if ! gh issue create; then :; fi", "! gh issue create", "{ gh issue create; }", "time gh issue create", "if true; then A=1 env gh issue create; fi",
	"gh is\\\nsue create", "echo safe; gh issue create", "pi-publish --help; gh issue create", "echo $(gh issue create)",
];
for (const [index, command] of writes.entries()) test(`literal gh publication fixture ${index}`, () => assert.equal(publicationGuard(command), "gh-publication"));
const safe = [
	"gh issue view 1", "gh issue close 1", "gh pr merge 1", "gh pr reopen 1", "gh issue edit 1 --add-label triaged", "gh api repos/o/r",
	"gh api repos/o/r -XGET -fX=x", "gh api repos/o/r --method=get --input file", "gh --help", "env --help", "command -v gh",
	"git commit -m 'Document node spawning gh issue comment'", "rg 'gh issue create' .", "env NOTE='gh issue comment' git status",
	"if true; then echo 'gh issue create'; fi", "for word in gh issue create; do echo $word; done", "while read x; do printf '%s' $x; done", "if gh issue view 1; then :; fi",
	"curl -sXGET https://api.github.com/repos/o/r", "curl -sH 'X-A: -d' https://api.github.com/repos/o/r", "curl -sd x https://example.invalid/api", "wget -qO out https://api.github.com/repos/o/r",
	"cat > payload <<'EOF'\ngh issue create\nEOF", "printf '%s' 'curl -XPOST https://api.github.com'", "echo 'env -S gh issue create'",
	"node -e 'spawn(\"gh\", [\"issue\", \"create\"])'", "bash -c 'gh issue create'", "eval 'gh issue create'", "xargs gh issue create", "./publish-script",
	"printf '%s' `gh issue create`", "pi-publish check --file file", "pi-publish issue-comment --repo o/r --number 1 --body-file file",
	"curl -d https://api.github.com https://example.invalid", "curl -XGET https://api.github.com/repos/o/r", "wget --method=HEAD https://api.github.com/repos/o/r",
	"curl -d x https://api.github.com.evil.invalid", "curl -d x https://example.invalid/api.github.com", "curl -d x https://api.github.com@evil.invalid",
];
for (const [index, command] of safe.entries()) test(`data/read/explicit non-goal fixture ${index}`, () => assert.equal(publicationGuard(command), undefined));
const http = [
	"curl -sX POST -sd '{}' https://api.github.com/repos/o/r", "curl -sXPOST https://api.github.com/repos/o/r", "curl -sd'{}' https://api.github.com/repos/o/r",
	"curl -sSd x https://api.github.com/repos/o/r", "curl -sFfile=@path https://uploads.github.com/x", "curl -sT file https://uploads.github.com/x", "curl -sH 'A: b' -d x https://api.github.com/x",
	"curl -XPOST https://api.github.com/repos/o/r", "curl --request=PATCH https://api.github.com/repos/o/r", "curl -ddata https://api.github.com:443/repos/o/r",
	"curl --json '{}' --url=https://api.github.com/repos/o/r", "curl -Ffile=@path https://uploads.github.com/repos/o/r/releases/1/assets",
	"curl -Tfile https://uploads.github.com/path", "curl --data-binary=@file https://api.github.com/path", "curl -X$METHOD https://api.github.com/path",
	"wget --post-data=x https://api.github.com/path", "wget --post-file file https://api.github.com/path", "wget --body-data=x https://api.github.com/path",
	"wget --body-file=file --method=PATCH https://api.github.com/path", "wget --method POST https://api.github.com/path",
];
for (const [index, command] of http.entries()) test(`literal direct HTTP publication fixture ${index}`, () => assert.equal(publicationGuard(command), "http-publication"));
for (const command of ["env -S 'gh issue create'", "env --split-string='git status'", "env --unknown git status", "env -u"]) test("unsupported env execution is fixed and conservative", () => assert.equal(publicationGuard(command), "unsupported-env"));

test("heredoc terminators are exact: premature terminator false positives and swallowed trailing publications", () => {
	const publication = "gh issue comment 39 --repo o/r --body /Users/alice/private";
	assert.equal(publicationGuard(`cat <<'EOF'\n  EOF\ncat <<'INNER'\nEOF\n${publication}`), "gh-publication");
	assert.equal(publicationGuard(`cat <<'EOF'\n  EOF\n${publication}\nEOF`), undefined);
	assert.equal(publicationGuard(`cat <<EOF\nEOF \n${publication}\nEOF`), undefined);
	assert.equal(publicationGuard(`cat <<-EOF\n\tbody\n\tEOF\n${publication}`), "gh-publication");
	assert.equal(publicationGuard(`cat <<EOF\n\tEOF\n${publication}\nEOF`), undefined);
	assert.equal(publicationGuard(`cat <<'EOF'\nbody\nEOF\n${publication}`), "gh-publication");
});

test("job and nested tool shapes inspect only explicit command/check fields", () => {
	assert.equal(publicationInput("job_watch", { check: "gh issue create" }), "gh-publication");
	assert.equal(publicationInput("job_start", { command: "gh issue create" }), "gh-publication");
	assert.equal(publicationInput("multi_tool_use.parallel", { tool_uses: [{ recipient_name: "functions.bash", parameters: { command: "gh issue create" } }] }), "gh-publication");
	assert.equal(publicationInput("write", { content: "gh issue create" }), undefined);
	assert.equal(publicationInput("publish", { body: "gh issue create" }), undefined);
});

test("extension respects the explicit publish switch and never includes command text in refusal", async () => {
	let handler: any;
	publishGuard({ on: (_name: string, callback: unknown) => { handler = callback; } } as any);
	setGuards("publish", false);
	try {
		const event = { toolName: "bash", input: { command: "gh issue comment 1 --body private-value" } };
		assert.deepEqual(await handler(event), { block: true, reason: PUBLICATION_REASON });
		setGuards("publish", true);
		assert.equal(await handler(event), undefined);
	} finally { setGuards("publish", false); }
});
