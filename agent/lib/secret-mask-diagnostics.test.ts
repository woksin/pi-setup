import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import type { Finding } from "./secret-mask-diagnostics.ts";
import { normalize } from "node:path";
import { renderDiagnostics, resultNotice, sanitizeRequestedPath } from "./secret-mask-diagnostics.ts";
import { scan } from "./secret-mask.ts";

const sensitive = (text: string) => {
	const result = scan(text);
	return result.skipped || result.count > 0;
};
const path = (value: unknown, cwd?: string) => sanitizeRequestedPath(value, sensitive, cwd, "/home/tester");

test("notice contains only category, start line, count and unknown provenance", () => {
	assert.equal(renderDiagnostics(1, [{ kind: "connection-string", line: 10 }]),
		"[secret-mask] 1 value(s) redacted: connection-string at output line 10 (provenance unknown). Rotate them; do not try to recover them.");
	const findings = Array.from({ length: 50 }, (_, i) => ({ kind: "env-value", line: i + 1 }));
	const notice = renderDiagnostics(50, findings);
	assert.match(notice, /30 additional redaction\(s\): locations omitted/);
	assert.ok(Buffer.byteLength(notice) <= 4096);
	assert.doesNotMatch(notice, /offset|column|prefix|hash|length|end|value=/);
});

test("requested paths are lexical, bounded and home-prefix aware", () => {
	assert.equal(path("@~/project/file.ts"), "~/project/file.ts");
	assert.equal(path("file.ts", "/home/tester/project"), "~/project/file.ts");
	assert.equal(path("/home/tester-sibling/file.ts"), "/home/tester-sibling/file.ts");
	assert.equal(path("relative"), undefined);
	assert.equal(path(42), undefined);
	assert.equal(path("x".repeat(4097)), "[path omitted]");
	assert.equal(path("/" + "x".repeat(200)), "[path omitted]");
});

test("sensitive and display-injecting segments disappear whole, without allowlists", () => {
	const token = "ghp_" + "a".repeat(36);
	assert.equal(path(`/project/${token}/file`), "[path omitted]");
	assert.equal(path("file", `/project/${token}`), "[path omitted]");
	assert.equal(path("/project/password=synthetic!value/tail-fragment/file"), "[path omitted]");
	for (const segment of ["bad\ntext", "bad\u001btext", "bad\u202etext", "[fake]", "bad(text)"]) {
		assert.equal(path(`/project/${segment}/file`), "/project/[omitted]/file");
	}
	assert.equal(sanitizeRequestedPath("/cross/segment", value => value.includes("cross/segment")), "[path omitted]");
	assert.equal(sanitizeRequestedPath("/safe", () => { throw new Error("synthetic"); }), "[path omitted]");
});

test("raw requested paths cannot launder credentials through lexical normalization", () => {
	const raw = "/project/https://synthetic-user:synthetic-pass@example.invalid/file";
	assert.equal(sensitive(raw), true);
	assert.equal(sensitive(normalize(raw)), false);
	for (const requested of [raw, "@" + raw, raw + "/../../clean", "~" + raw]) {
		assert.equal(path(requested, "/project"), "[path omitted]");
	}
});

test("raw resolution contexts are checked before normalization or home shortening", () => {
	const context = "/project/https://synthetic-user:synthetic-pass@example.invalid";
	assert.equal(sensitive(context), true);
	assert.equal(sensitive(normalize(context)), false);
	assert.equal(sanitizeRequestedPath("file", sensitive, context, "/home/tester"), "[path omitted]");
	assert.equal(sanitizeRequestedPath("~/file", sensitive, "/project", context), "[path omitted]");
	assert.equal(sanitizeRequestedPath("file", sensitive, context, context), "[path omitted]");
	assert.equal(sanitizeRequestedPath("/safe/file", sensitive, "/project", context), "[path omitted]");
	assert.equal(sanitizeRequestedPath("~/file", sensitive, "/project", "/" + "x".repeat(4097)), "[path omitted]");
});

test("complete-path detection is repeated after segment removal", () => {
	const detects = (value: string) => value.includes("first") || value.includes("second/third");
	assert.equal(sanitizeRequestedPath("/first/second/third", detects), "[path omitted]");
});

test("diagnostics are independent of value length, prefix and surrounding text", () => {
	const notices = ["synthetic!one", "different-longer!synthetic-two"].map(value => {
		const result = scan(`surrounding-sentinel\nUnusualSecretField: '${value}'`, [], { diagnostics: true });
		return resultNotice(result, { toolName: "bash", input: { command: "command-sentinel" } }, { sensitive, fallback: () => "fallback" });
	});
	assert.equal(notices[0], notices[1]);
	assert.doesNotMatch(notices[0], /synthetic|different|surrounding|UnusualSecretField|command-sentinel|prefix|length|hash/);
	const notice = renderDiagnostics(20, Array.from({ length: 20 }, () => ({ kind: "connection-string", line: Number.MAX_SAFE_INTEGER })), true);
	assert.ok(Buffer.byteLength(notice) < 4096);
});

test("read paths ignore value allowlists and malformed arguments; failures use legacy fallback", () => {
	const token = "ghp_" + "a".repeat(36);
	const result = scan("password: 'synthetic!one'", [], { diagnostics: true });
	const options = { sensitive, fallback: () => "legacy fallback", cwd: "/project" };
	assert.match(resultNotice(result, { toolName: "read", input: { path: `/project/${token}/file` } }, options), /Read request: \[path omitted\]/);
	for (const input of [undefined, {}, { path: 42 }]) {
		assert.doesNotMatch(resultNotice(result, { toolName: "read", input }, options), /Read request/);
	}
	const event = { toolName: "read", get input(): Record<string, unknown> { throw new Error("synthetic"); } };
	assert.equal(resultNotice(result, event, options), "legacy fallback");
});

test("named credential notices use fixed vocabulary and read-only sanitized spec-path hints", () => {
	const value = "Ab12Cd34Ef56Gh78";
	const result = scan(`public const string ClientSecret = "${value}";`, [], { diagnostics: true });
	const options = { sensitive, fallback: () => "fallback" };
	for (const requested of [
		"/repo/Foo.Integration.Specs/given/Fixture.cs", "/repo/Foo.Specs/Fixture.cs", "/repo/Foo.Tests/Fixture.cs",
		... ["specs", "tests", "__tests__", "fixtures", "given"].map(segment => `/repo/${segment}/Fixture.cs`),
	]) {
		const notice = resultNotice(result, { toolName: "read", input: { path: requested } }, options);
		assert.match(notice, /connection-string at output line 1 \(provenance unknown\) \(named credential field\)/);
		assert.match(notice, /Requested path looks like test\/spec code \(path only; this does not show the value is harmless; rotate if it is real\)/);
		for (const forbidden of [value, value.slice(0, 6), createHash("sha256").update(value).digest("hex"), "ClientSecret"]) {
			assert.ok(!notice.includes(forbidden), forbidden);
		}
		assert.doesNotMatch(notice, /prefix|length|hash|value=/);
	}
	for (const requested of ["/repo/src/Foo/Fixture.cs", "/repo/contest/Fixture.cs", "/repo/specs-file/Fixture.cs"]) {
		assert.doesNotMatch(resultNotice(result, { toolName: "read", input: { path: requested } }, options), /Requested path looks/);
	}
	assert.doesNotMatch(resultNotice(result, { toolName: "bash", input: { path: "/repo/tests/Fixture.cs", command: "cat tests/Fixture.cs" } }, options), /Requested path looks|Read request/);
});

test("spec hints inspect only sanitized paths and never disclose hidden path segments", () => {
	const result = scan("ClientSecret = 'Ab12Cd34Ef56Gh78'", [], { diagnostics: true });
	const token = "ghp_" + "a".repeat(36);
	const options = { sensitive, fallback: () => "fallback" };
	const notice = resultNotice(result, { toolName: "read", input: { path: `/repo/tests/${token}/Fixture.cs` } }, options);
	assert.match(notice, /Read request: \[path omitted\]/);
	assert.ok(!notice.includes(token));
	assert.doesNotMatch(notice, /Requested path looks/);
	const hiddenSegment = resultNotice(result, { toolName: "read", input: { path: "/repo/bad\ntests/Fixture.cs" } }, options);
	assert.match(hiddenSegment, /Read request: \/repo\/\[omitted\]\/Fixture.cs/);
	assert.doesNotMatch(hiddenSegment, /Requested path looks|bad|\ntests/);
});

test("forged credential metadata is omitted rather than rendered", () => {
	const notice = renderDiagnostics(1, [{ kind: "connection-string", line: 1, via: "forged-sentinel" } as unknown as Finding]);
	assert.doesNotMatch(notice, /forged-sentinel|named credential field|output line/);
	assert.match(notice, /1 additional redaction\(s\): locations omitted/);
});

test("renderer accepts only a fixed category vocabulary and valid line numbers", () => {
	const notice = renderDiagnostics(2, [{ kind: "synthetic-sentinel", line: 1 }, { kind: "env-value", line: NaN }]);
	assert.doesNotMatch(notice, /synthetic-sentinel|NaN/);
	assert.match(notice, /2 additional redaction\(s\): locations omitted/);
});
