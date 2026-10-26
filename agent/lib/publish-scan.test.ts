import assert from "node:assert/strict";
import { test } from "node:test";
import { scanPublication } from "./publish-scan.ts";
import { MAX_BYTES } from "./secret-mask.ts";

const context = { home: "/srv/operator", repoRoot: "/opt/source/project" };

function refused(text: string, kind: string, line = 1) {
	const result = scanPublication(text, context);
	assert.ok(result.count > 0);
	assert.ok(result.findings.some(finding => finding.kind === kind && finding.line === line));
	assert.deepEqual(Object.keys(result).sort(), ["count", "findings", "kinds"]);
	return result;
}

const privatePaths: [string, string][] = [
	["/srv/operator/private", "home-path"], ["/srv/operator", "home-path"],
	["/Users/alice/private", "home-path"], ["/home/runner/private", "home-path"],
	["/Users/user", "home-path"], ["/home/<user>/private", "home-path"],
	["/Users/<name>/private", "home-path"], ["/home/<user>suffix/private", "home-path"],
	["C:\\Users\\alice\\private", "home-path"],
	["C:/Users/alice/private", "home-path"], ["/Volumes/data/private", "volume-path"],
	["/var/folders/ab/file", "temp-path"], ["/private/var/folders/ab/file", "temp-path"],
	["/tmp/payload", "temp-path"], ["/private/tmp/payload", "temp-path"],
	[".ai-work/private/file", "work-folder"], ["/opt/source/project/file", "repo-root"],
	["~/.pi/auth.json", "pi-private"], ["$HOME/.pi/sessions/a", "pi-private"],
	["${HOME}/.pi/agent/policies/active.json", "pi-private"],
	["~/.pi/agent/lib-private/file", "pi-private"], ["~/.pi/agent/AGENTS.md/private", "pi-private"],
	["~/.pi/agent/lib/../auth.json", "path-traversal"],
	["~/.pi/agent/lib/./file", "path-traversal"],
	["~/.pi/agent/lib/%2e%2e/auth.json", "path-traversal"],
	["~/.pi/agent/lib\\..\\auth.json", "path-traversal"],
];
for (const [index, [text, kind]] of privatePaths.entries()) test(`refuses path category ${kind}: fixture ${index}`, () => {
	refused(text, kind);
});

test("URLs, Markdown adjacency and code fences are not scanner exemptions", () => {
	for (const source of [
		"https://example.invalid/?path=/Users/alice/private",
		"[link](https://example.invalid/#/Users/alice/private)",
		"https://example.invalid/)/Users/alice/private",
		"```text\n/Users/alice/private\n```",
		"https://example.invalid/?path=%2FUsers%2Falice%2Fprivate",
		"https://example.invalid/?path=%2fUsers%2falice%2fprivate&other=%ZZ",
	]) refused(source, "home-path", source.includes("\n") ? 2 : 1);
});

test("lowercase /users/ URL routes are public; only POSIX /Users/ homes are concrete", () => {
	for (const source of ["https://github.com/users/octocat/projects/1", "https://api.github.com/users/octocat", "[profile](https://github.com/users/octocat)"]) {
		assert.equal(scanPublication(source, context).count, 0, source);
	}
	refused("https://api.github.com/users/octocat and /Users/alice/private", "home-path");
	refused("https://example.invalid/?path=/Users/alice/private", "home-path");
});

test("once-decoded paths retain source lines including encoded newlines and Unicode", () => {
	const result = refused("😀\r\nhttps://example.invalid/?q=%F0%9F%98%80%0A%2FUsers%2Falice", "home-path", 2);
	assert.equal(result.count, 1);
	refused("https://example.invalid/?q=%7E%2F.pi%2Fagent%2Flib%2F%2E%2E%2Fauth.json", "path-traversal");
});

test("duplicate raw/decoded observations do not inflate counts; distinct paths do", () => {
	assert.equal(scanPublication("/Users/alice/file%20name", context).count, 1);
	const result = scanPublication("%2FUsers%2Falice%20%2FUsers%2Fbob", context);
	assert.equal(result.count, 2);
	assert.equal(result.findings.length, 2);
});

const clean = [
	"ordinary release text", "https://github.com/owner/repo/issues/39", "https://example.invalid/?q=public#section",
	"/tmp", "/private/tmp", ".ai-work", ".ai-work/", "~/.pi", "$HOME/.pi", "${HOME}/.pi",
	"/Users/<user>", "/home/<name>/", "/srv/operator-other/file", "/opt/source/project-other/file",
	... ["~", "$HOME", "${HOME}"].flatMap(root => [
		`${root}/.pi/agent/AGENTS.md`, `${root}/.pi/agent/AGENTS.subagent.md`,
		`${root}/.pi/agent/pi-phase/README.md`, `${root}/.pi/agent/lane-policy/README.md`,
		... ["agents", "extensions", "early-extensions", "lib", "workflows", "templates", "profiles", "bin"]
			.map(tree => `${root}/.pi/agent/${tree}/public.ts`),
	]),
];
for (const [index, text] of clean.entries()) test(`allows public/conceptual text fixture ${index}`, () => {
	assert.deepEqual(scanPublication(text, context), { kinds: [], count: 0, findings: [] });
});

test("concrete absolute homes are private even for a public symbolic subtree", () => {
	refused("/Users/alice/.pi/agent/lib/public.ts", "home-path");
	refused("/srv/operator/.pi/agent/AGENTS.md", "home-path");
});

test("context roots are literal, not regexes, and root slash is not a universal refusal", () => {
	assert.equal(scanPublication("/srv/operatorX/file", { home: "/srv/operator." }).count, 0);
	assert.equal(scanPublication("/srv/operator./file", { home: "/srv/operator." }).count, 1);
	assert.equal(scanPublication("public /usr/share/doc", { home: "/", repoRoot: "/" }).count, 0);
	assert.deepEqual(scanPublication("/home/alice/repo/file", { home: "/home/alice", repoRoot: "/home/alice/repo" }).kinds, ["home-path"]);
	assert.deepEqual(scanPublication("/home/bob", { home: "/srv/operator", repoRoot: "/home/alice/repo" }).kinds, ["home-path"]);
	assert.deepEqual(scanPublication("/srv/operator/file", { home: "/srv/operator", repoRoot: "/srv/operator/repo" }).kinds, ["home-path"]);
	assert.deepEqual(scanPublication("/opt/source/project/file", { home: "/srv/operator", repoRoot: "/opt/source/project" }).kinds, ["repo-root"]);
});

test("provider and secret-named values reuse the outbound scanner without an allowlist", () => {
	const token = ["gh", "p_", "a1".repeat(20)].join("");
	refused(token, "github-token");
	refused(`https://example.invalid/?q=${token}`, "github-token");
	refused(`password='${["Syn", "7thetic!only"].join("")}'`, "connection-string");
	const aws = ["AK", "IA", "Z1".repeat(8)].join("");
	for (const value of [token, aws]) {
		for (const marker of [`[REDACTED:${value}]`, `[REDACTED:${value}`, `[REDACTED:aws-key]${value}`]) {
			const result = refused(marker, "untrusted-redaction-marker");
			assert.ok(result.kinds.includes(value === token ? "github-token" : "aws-key"));
			assert.ok(!JSON.stringify(result).includes(value));
		}
	}
});

test("diagnostics are bounded and value-free without concealing total refusal count", () => {
	const result = scanPublication(Array.from({ length: 35 }, () => "/Users/alice/private").join("\n"), context);
	assert.equal(result.count, 35);
	assert.equal(result.findings.length, 20);
	assert.deepEqual(result.findings[19], { kind: "home-path", line: 20 });
	assert.doesNotMatch(JSON.stringify(result), /alice|private|Users/);
});

test("UTF-8 byte budget fails closed before path processing", () => {
	assert.deepEqual(scanPublication("é".repeat(MAX_BYTES / 2 + 1), context), {
		count: 1, kinds: ["too-large"], findings: [{ kind: "too-large", line: 1 }],
	});
	assert.equal(scanPublication("a".repeat(MAX_BYTES), context).count, 0);
});
