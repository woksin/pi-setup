import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { setGuards } from "./guards.ts";
import { guardSelect } from "./orchestration.ts";
import { cratisRepo } from "./cratis-hooks-detect.test.ts";
import extension from "../extensions/secret-mask.ts";
import {
	commandRule, createHandlers, DEFAULTS, INPUT_NOTICE, loadConfig, logRedaction,
	MAX_BYTES, parseConfig, RUN_ANYWAY, scan, summary, isSecretKey,
} from "./secret-mask.ts";

const PK = "PRIVATE" + " KEY";
const MIX = "a1B2c3" + "d4e5f6";
const MIX2 = MIX + "g7";
const ABC1 = "abcdefg" + "hijk1";
const ABC2 = "1abcdefg" + "hijk";

const blocked = [
	...["pod", "pods", "po", "deploy", "deployment", "deployments", "sts", "statefulset", "statefulsets", "ds", "daemonset", "cronjob", "job", "secret", "secrets", "configmap", "cm"].flatMap(resource => [
		`kubectl --context prod get ${resource} -o json`, `kubectl -n prod describe ${resource}`,
	]),
	...["-o json", "-o yaml", "-ojson", "-oyaml", "-o=json", "--output=json", "--output=yaml", "--output json", "-o 'json'"].map(output => `kubectl get pods ${output}`),
	"kubectl get secret/name -o jsonpath='{.metadata.name}'",
	"(env)", "bash -c env", 'sh -c "env"', "kubectl exec app -- env", "kubectl exec app -- printenv",
	"docker exec app env", "docker exec app printenv", "cat ~/.kube/*", "kubectl config view --raw",
	"base64 -d < kubeconfig", "base64 -d < .env", "base64 -d < key.pem", "base64 --decode < ~/.kube/config",
	"cat ~/.ssh/id_*", "cat ~/.ssh/id_ed25519", "cat key.ppk",
	...["-o jsonpath='{.metadata.name}'", "-o yaml", "-ojson", "--output=json", "-o wide", "-o go-template=…", "-o custom-columns=KEY:.data.key", "-o custom-columns=NAME:.data.password", "-o name -o yaml"].map(output => `kubectl get secrets ${output}`),
	"kubectl get pods -o json | jq '.items[].metadata.name'", "kubectl get pods -o json; kubectl get pods -o name",
	"helm get values app", "helm get manifest app", "helm get all app",
	"docker inspect app", "docker compose config", "docker compose -f app.yml config",
	"printenv", "printenv TOKEN", "env", "env | sort", "set", "set | sort", "export -p",
	"gh secret list", "gh secret get TOKEN", "gh api repos/o/r/actions/secrets", "gh api /repos/o/r/actions/secrets/NAME", "gh auth token",
	"vault read secret/path", "vault kv get secret/path", "vault token lookup",
	"pulumi stack output --show-secrets", "pulumi config --show-secrets",
	"az keyvault secret show --name key", "az keyvault secret list --vault-name test",
	"aws secretsmanager get-secret-value --secret-id key", "aws ssm get-parameter --name key --with-decryption",
	"gcloud secrets versions access latest --secret key", "op read op://vault/item/password", "op item get key",
	"security find-generic-password -s item -w", "security find-internet-password -s item -w",
	...["cat", "less", "head", "tail", "bat", "more", "grep -r query", "grep -R query", "grep --recursive query"].map(reader => `${reader} ~/.aws/credentials`),
	...["~/.kube/config", "/tmp/kubeconfig-prod", "kubeconfig", ".env", ".env.production", "./.env.local", "/tmp/key.pem", "server.key", "id_rsa", "id_rsa.pub", "cert.pfx", "~/.aws/credentials", "~/.netrc", "~/.npmrc", "~/.docker/config.json", "auth.json", "prod-secrets.json", "secrets.yaml", "mysecrets.yml"].map(path => `cat '${path}'`),
];
for (const command of blocked) test(`blocks dumper: ${command}`, () => {
	const matched = commandRule(command);
	assert.ok(matched, command);
	assert.ok(matched.name);
	assert.ok(matched.alternative);
	assert.doesNotMatch(matched.alternative, /\n/);
});
const projected = [
	...["-o name", "-o jsonpath='{.items[*].spec.containers[*].image}'", "-ojsonpath='{.metadata.name}'", "-o custom-columns=NAME:.metadata.name", "-o go-template='{{.metadata.name}}'", "-o wide", "--output=jsonpath='{.metadata.name}'", "--output=custom-columns=NAME:.metadata.name"].map(output => `kubectl get pods ${output}`),
	"kubectl get secret", "kubectl get secrets", "kubectl get secret -o name", "kubectl get secrets --output=name",
	"kubectl get secrets -o custom-columns=NAME:.metadata.name", "kubectl get secret --output=custom-columns=NAME:.metadata.name",
	"kubectl config view", "base64 -d < harmless.txt", "cat key.pub", "cat BYPASS.txt",
	"kubectl get pods", "kubectl logs app", "kubectl rollout status deploy/app", "kubectl top pods", "kubectl get nodes -o json",
	"docker inspect --format '{{.Config.Image}}' app", "docker inspect app --format='{{.State.Status}}'",
	"docker compose config --services", "docker compose config --images", "docker ps",
	"env VAR=x cmd", "env VAR=x cmd | sort", "set -e", "export NAME=x", "printf hello",
	"helm status app", "gh auth status", "gh api repos/o/r", "vault status", "pulumi stack output",
	"az keyvault list", "aws ssm get-parameter --name key", "gcloud secrets versions describe latest --secret=key", "op item list",
	"security find-generic-password -s item", "security find-internet-password -s item",
	"cat README.md", "cat environment.ts", "cat file.json", "grep keyword .env", "grep -n query README.md",
];
for (const command of projected) test(`allows non-dumper/projection: ${command}`, () => assert.equal(commandRule(command), undefined));

const a = "A".repeat(40);
const positives: [string, string][] = [
	["private-key", "-----BEGIN " + PK + "-----\nlocal-fixture-material\n-----END " + PK + "-----"],
	["private-key", "-----BEGIN RSA " + PK + "-----\nlocal-fixture-material\n-----END RSA " + PK + "-----"],
	["private-key", "-----BEGIN ENCRYPTED " + PK + "-----\nlocal-fixture-material\n-----END ENCRYPTED " + PK + "-----"],
	["anthropic-key", `sk-ant-${a}`],
	...["", "proj-", "live-", "test-"].map(prefix => ["openai-key", `sk-${prefix}12${a}`] as [string, string]),
	...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map(prefix => ["github-token", prefix + a] as [string, string]),
	["aws-key", `AKIA${"A".repeat(16)}`], ["aws-key", `aws_secret_access_key = ${a}`],
	["google-key", `AIza${"A".repeat(35)}`],
	...["a", "b", "p", "r", "s"].map(prefix => ["slack", `xox${prefix}-${a}`] as [string, string]),
	["slack", `https://hooks.slack.com/services/${a}`],
	["jwt", `eyJ${a}.eyJ${a}.${a}`],
	...["s", "r"].flatMap(prefix => ["live", "test"].map(mode => ["stripe", `${prefix}k_${mode}_${a}`] as [string, string])),
	["mollie", `live_${a}`], ["mollie", `test_${a}`], ["sendgrid", `SG.${a}.${a}`],
	["url-credentials", "mongodb+srv://admin:local-fixture-password@db.local/test"],
	["url-credentials", "https://user:abc@example.invalid"],
	...["password", "pwd", "accountkey", "sharedaccesskey", "sharedaccesssignature", "sig", "client_secret", "clientsecret", "secret", "token", "api_key", "api-key", "apikey", "access_key", "access-key", "auth_token", "auth-token"].map(key => ["connection-string", `${key}="a1B2c3d4e5f6"`] as [string, string]),
	["connection-string", '"MONGODB_PASSWORD": "' + MIX + '"'],
	["connection-string", "Password='" + MIX + "';Server=local"],
	["kube-data", '{"users":[{"name":"local","user":{"token":"abc","password":"def","client-key-data":"ghi","client-certificate-data":"jkl"}}]}'],
	["kube-data", 'users:\n- name: local\n  user:\n    client-key-data: abc\n    client-certificate-data: "def"\n    token: ghi\n    password: jkl\ncontexts: []\n'],
	["kube-data", `{"apiVersion":"v1","kind":"Secret","data":{"fixture":"${a}="}}`],
	["kube-data", `{"items":[{"data":{"fixture":"${a}="},"kind":"Secret"}],"kind":"List"}`],
	["kube-data", `kind: Secret\ndata:\n  fixture: ${a}=\n`],
	["kube-data", `apiVersion: v1\ndata:\n  fixture: ${a}=\nkind: Secret\n`],
];
for (const [kind, input] of positives) test(`redacts ${kind}: ${input.slice(0, 65).replaceAll("\n", " ")}`, () => {
	const result = scan(input);
	assert.ok(result.count >= 1, input);
	assert.deepEqual(result.kinds, [kind]);
	assert.ok(result.text.includes(`[REDACTED:${kind}]`));
	assert.deepEqual(scan(result.text), { text: result.text, count: 0, kinds: [], skipped: false });
	if (kind === "private-key") {
		assert.match(result.text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
		assert.match(result.text, /-----END [A-Z ]*PRIVATE KEY-----/);
		assert.doesNotMatch(result.text, /local-fixture-material/);
	}
});
const negatives = [
	"-----BEGIN PUBLIC KEY-----\npublic-material\n-----END PUBLIC KEY-----", "-----BEGIN " + PK + "-----",
	"sk-ant-short", "sk-short", "sk-proj-short", "ghp_short", "github_pat_short", "AKIA123", "aws_secret_access_key = [REDACTED:aws-key]",
	"AIzaSHORT", "xoxb-short", "https://hooks.slack.com/other", "eyJshort.eyJshort.short", "sk_live_short", "rk_test_short", "live_short", "test_short", "SG.short.short",
	"https://example.invalid", "https://user:ab@example.invalid", "password: string", "token = os.environ[\"X\"]", "token = process.env.TOKEN", "token = os.getenv('TOKEN')",
	... ["***", "<placeholder>", "${LONG_VARIABLE}", "$LONG_VARIABLE", "REDACTED", "changeme", "example", "null", "true", "false", "string", "number", "somevalue", "identifier", "[REDACTED:connection-string]"].map(value => `password = ${value}`),
	'{"token":"shortname","password":"string"}', '{"kind":"ConfigMap","data":{"fixture":"' + a + '"}}',
	'{"kind":"Secret","data":{"fixture":"short"}}', '{"kind":"Secret","stringData":{"fixture":"' + a + '"}}',
	'users:\n- name: local\n  user:\n    token: [REDACTED:kube-data]\nother:\n  password: short\n',
	`kind: ConfigMap\ndata:\n  fixture: ${a}\n`,
	"[REDACTED:private-key] [REDACTED:anthropic-key] [REDACTED:jwt]",
];
for (const text of negatives) test(`leaves negative intact: ${text.slice(0, 65).replaceAll("\n", " ")}`, () => {
	assert.deepEqual(scan(text), { text, count: 0, kinds: [], skipped: false });
});

test("URL redaction preserves scheme, username, host and path", () => {
	assert.equal(scan("mongodb://admin:abc@local/db").text, "mongodb://admin:[REDACTED:url-credentials]@local/db");
});
test("connection redaction preserves key, quotes, separators and unrelated values", () => {
	assert.equal(scan('"MONGODB_PASSWORD": "' + MIX + '", "name": "local"').text,
		'"MONGODB_PASSWORD": "[REDACTED:connection-string]", "name": "local"');
});
test("YAML Secret detection does not cross document boundaries", () => {
	const input = `data:\n  fixture: ${a}\nkind: Secret\n---\nkind: ConfigMap\ndata:\n  fixture: ${a}\n`;
	const result = scan(input);
	assert.equal(result.count, 1);
	assert.equal(result.text, `data:\n  fixture: [REDACTED:kube-data]\nkind: Secret\n---\nkind: ConfigMap\ndata:\n  fixture: ${a}\n`);
});
test("overlapping recognizers count a value once with its specific kind", () => {
	const result = scan(`token=sk-ant-${a};api_key=sk_live_${a}`);
	assert.equal(result.count, 2);
	assert.deepEqual(result.kinds, ["anthropic-key", "stripe"]);
});
test("allowlist regexes match candidate values only, not keys or commands", () => {
	assert.equal(scan("password=L13-LOCAL-FAKE-fixture", ["^L13-LOCAL-FAKE"]).count, 0);
	assert.equal(scan("password=L13-LOCAL-FAKE-fixture", ["password"]).count, 1);
	assert.equal(scan(`token=sk-ant-${a}`, ["^sk-ant-"]).count, 0);
	assert.equal(scan(`token=sk-ant-${a}`, ["["]).count, 1);
	assert.ok(commandRule("printenv"));
});
test("cap applies in UTF-8 bytes, not code units; boundary itself is scanned", () => {
	assert.equal(scan("x".repeat(MAX_BYTES)).skipped, false);
	assert.equal(scan("x".repeat(MAX_BYTES + 1)).skipped, true);
	assert.equal(scan("é".repeat(MAX_BYTES / 2 + 1)).skipped, true);
});

const secretNames = [
	"password", "passwd", "pass", "pwd", "secret", "token", "apikey", "api_key", "accesskey", "access_key",
	"secretkey", "secret_key", "clientsecret", "client_secret", "privatekey", "private_key", "credential", "credentials",
	"connectionstring", "connection_string", "accountkey", "sharedaccesskey", "sas", "sig", "MONGODB_PASSWORD",
	"SmtpPassword", "SMTP_PASS", "AdminPassword", "S3_SECRET_KEY", "Chronicle__ClientSecret", "apiKey", "connectionString", "SharedAccessSignature",
];
for (const name of secretNames) test(`secret key segments and env values: ${name}`, () => {
	assert.equal(isSecretKey(name), true);
	for (const input of [
		`{"name":"${name}","value":"Pr0dMongo!pass"}`,
		`{ \n "value" : "Pr0dMongo!pass" , \t "name" : "${name}" }`,
		`- name: ${name}\n  value: Pr0dMongo!pass\n`,
		`  - value: "Pr0dMongo!pass"\n    name: ${name}\n`,
	]) {
		const result = scan(input);
		assert.equal(result.count, 1, input);
		assert.deepEqual(result.kinds, ["env-value"]);
		assert.equal(result.text, input.replace("Pr0dMongo!pass", "[REDACTED:env-value]"));
		assert.equal(scan(result.text).count, 0);
	}
	assert.equal(scan(`"${name}": "Pr0d!pass"`).count, 1);
});
for (const name of ["BYPASS", "bypass", "SomeBYPASS", "compass", "passwordless", "tokenizer", "secretariat", "PUBLIC_NAME"]) test(`not a secret key segment: ${name}`, () => {
	assert.equal(isSecretKey(name), false);
	for (const input of [`{"name":"${name}","value":"Pr0dMongo!pass"}`, `- name: ${name}\n  value: Pr0dMongo!pass\n`, `"${name}": "Pr0d!pass"`]) assert.equal(scan(input).count, 0);
});
test("env values do not cross object/list boundaries; short values and allowlists work", () => {
	assert.equal(scan('{"name":"PASSWORD"},{"value":"abc"}').count, 0);
	assert.equal(scan('- name: PASSWORD\n- value: abc\n').count, 0);
	assert.equal(scan('- name: PASSWORD\n  other: x\n  value: abc\n').count, 0);
	assert.equal(scan('{"name":"PASSWORD","value":"abc"}').text, '{"name":"PASSWORD","value":"[REDACTED:env-value]"}');
	assert.equal(scan('{"name":"PASSWORD","value":"abc"}', ["^abc$"]).count, 0);
	assert.equal(scan('{"name":"\\u0050ASSWORD","value":"abc"}').count, 1);
	assert.doesNotThrow(() => scan('{"name":"bad\\q","value":"abc"}'));
});
for (const code of [
	"const apiKey = config.apiKey;", "const secret = getSecret(name);", "const sig = computeSignature(payload);",
	'request.headers["x-access-key"]', "const token = credentials[0];", "secret = (getSecret(name));",
	"secret = " + "unquotedIdentifier12345;", "token = computeSignature(payload, other);", "token = Record<string, unknown>",
	'"token": "abcdefghijklmnopqrstuvwxyz"', '"token": "String"', "token = SomeExtremelyLongConfigurationType",
]) test(`source expression stays intact: ${code}`, () => assert.equal(scan(code).text, code));
for (const input of ['apiKey = "' + "d8f7a6s5" + 'd4f3g2h1"', '"AdminPassword": "Pr0d!pass"', 'secret="' + "VeryLongMixed" + 'CaseSecretLiteral"', 'token = 12345678']) test(`secret-like connection literal: ${input}`, () => {
	assert.equal(scan(input).count, 1);
	assert.deepEqual(scan(input).kinds, ["connection-string"]);
});
for (const [input, value] of [
	["MONGODB_PASSWORD=" + MIX2, MIX2],
	["DB_PASS=hunter22", "hunter22"],
	["PASSWORD=" + ABC1, ABC1],
	["PASSWORD=" + ABC2, ABC2],
	["kind: Secret\ndata:\n  MONGODB_PASSWORD: " + MIX2 + "\n", MIX2],
	["data:\n  DB_PASS: hunter22\n", "hunter22"],
	["docker run -e X_PASSWORD=" + MIX2 + " app", MIX2],
]) test(`bare credential value is masked: ${input.replaceAll("\n", " ")}`, () => {
	const expected = input.replace(value, "[REDACTED:connection-string]");
	assert.equal(scan(input).text, expected);
	assert.equal(scan(expected).count, 0);
	const f = fixture();
	assert.equal(f.handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: input }] }, f.ctx)!.content[0].text,
		expected + "\n" + summary(1, ["connection-string"]));
});
for (const input of [
	"PASSWORD=changeme", "password = getPassword()", "secret = secretValue", "API_KEY=abc",
	"const secret = getSecret(name)", "password: options.password", "token = Bearer", "token = process_env",
	"secret = identifier12345;", "secret = identifier12345,", "PASSWORD=abcdefg1", "PASSWORD=1abcdefg",
]) test(`bare code/placeholder/short token stays intact: ${input}`, () => assert.equal(scan(input).text, input));
test("incomplete PEM in truncated JSON is hidden through end of text by scan and result handler", () => {
	const input = '{"key":"-----BEGIN RSA ' + PK + '-----\\nlocal-fixture-material\\ntruncated';
	const expected = '{"key":"-----BEGIN RSA ' + PK + '-----[REDACTED:private-key]';
	assert.equal(scan(input).text, expected);
	assert.equal(scan(expected).count, 0);
	const f = fixture();
	assert.equal(f.handlers.toolResult({ toolName: "read", content: [{ type: "text", text: input }] }, f.ctx)!.content[0].text,
		expected + "\n" + summary(1, ["private-key"]));
});
test("over-limit PEM and JSON/YAML Secret data are hidden, never left as raw base64", () => {
	const payload = "A".repeat(70000);
	for (const input of [
		`-----BEGIN ${PK}-----${payload}-----END ${PK}-----tail`,
		`{"data":{"fixture":"${payload}"},"kind":"Secret"}`,
		`data:\n  fixture: ${payload}\nkind: Secret\n`,
	]) {
		const result = scan(input);
		assert.equal(result.count, 1);
		assert.ok(!result.text.includes(payload));
		assert.equal(scan(result.text).count, 0);
	}
});
test("already-masked fields cannot exempt other raw values in oversized Secret data", () => {
	const payload = "A".repeat(70000);
	const input = `{"kind":"Secret","data":{"old":"[REDACTED:kube-data]","fixture":"${payload}"}}`;
	const result = scan(input);
	assert.ok(result.count > 0);
	assert.ok(!result.text.includes(payload));
	assert.ok(result.text.includes("[REDACTED:kube-data]"));
	assert.equal(scan(result.text).count, 0);
});
test("OpenAI recognition requires a 24-character body and two digits, not lowercase package names", () => {
	for (const body of ["learn", "test-utils", "a".repeat(40), "lowercase-package-word-with-1digit", "12" + "a".repeat(21)]) assert.equal(scan("sk-" + body).count, 0);
	assert.equal(scan("sk-12" + "a".repeat(22)).text, "[REDACTED:openai-key]");
	assert.equal(scan("sk-proj-12" + "a".repeat(22)).count, 1);
	assert.equal(scan("sk-proj-12" + "a".repeat(21)).count, 0);
});
test("Mollie needs 30 characters and a literal boundary, not a code identifier suffix", () => {
	for (const input of [`test_${"a".repeat(29)}`, `mytest_${a}`, `local.test_${a}`, `(live_${a}`]) assert.equal(scan(input).count, 0);
	for (const prefix of ["", " ", "\n", '"', "'", "=", ":"]) assert.equal(scan(prefix + "test_" + "a".repeat(30)).count, 1);
});
// The bound guards against catastrophic backtracking (seconds to minutes), not against a busy machine:
// these inputs scan in 5-40 ms when idle, but a loaded host or CI runner can push one past 300 ms.
test("one MiB adversarial inputs scan in well under two seconds each", () => {
	const size = 1024 * 1024;
	for (const fragment of ["-----BEGIN " + PK + "-----\n", '{"kind":"Secret","data":{}}\n', "[REDACTED:", " \n", "A", "x-"]) {
		const input = fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size);
		const start = performance.now();
		scan(input);
		const elapsed = performance.now() - start;
		assert.ok(elapsed < 2000, `${JSON.stringify(fragment)} took ${elapsed.toFixed(1)} ms`);
	}
});
test("tool-call failures log only an event and fail open; result masking still runs", async () => {
	const f = fixture({ hasUI: false });
	let fail = true;
	const handlers = createHandlers({ role: () => "main", config: () => {
		if (fail) { fail = false; throw new Error("sensitive failure text"); }
		return { ...DEFAULTS };
	}, error: event => { f.errors.push(event); }, record: () => {} });
	assert.equal(await handlers.toolCall({ toolName: "bash", input: { command: "printenv" } }, f.ctx), undefined);
	assert.deepEqual(f.errors, ["tool-call-failed"]);
	assert.match(handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: `sk-ant-${a}` }] }, f.ctx)!.content[0].text!, /REDACTED/);
});
test("wiring covers tool results/input but does not pretend user_bash has completed output", () => {
	const names: string[] = [];
	extension({ on: (name: string) => { names.push(name); } } as any);
	assert.deepEqual(names, ["session_start", "tool_call", "tool_result", "input"]);
});

function temporary(run: (directory: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "secret-mask-test-"));
	try { run(directory); } finally { rmSync(directory, { recursive: true }); }
}
test("missing, malformed and invalid config retains safe defaults; valid fields honored", () => temporary(directory => {
	const file = join(directory, "config.json");
	assert.deepEqual(loadConfig(file), DEFAULTS);
	writeFileSync(file, "invalid");
	assert.deepEqual(loadConfig(file), DEFAULTS);
	for (const value of [null, [], false, { enabled: "false", scope: "bad", allowlist: true }]) assert.deepEqual(parseConfig(value), DEFAULTS);
	writeFileSync(file, JSON.stringify({ enabled: false, scope: "main", blockCommands: false, redactResults: false, redactInput: false, allowlist: ["fixture", 4] }));
	assert.deepEqual(loadConfig(file), { enabled: false, scope: "main", blockCommands: false, redactResults: false, redactInput: false, allowlist: ["fixture"] });
	writeFileSync(file, "{}");
	assert.deepEqual(loadConfig(file), DEFAULTS);
}));
test("audit log contains exactly metadata, never text or values", () => temporary(directory => {
	const file = join(directory, "log.jsonl");
	logRedaction("session", "bash", ["anthropic-key"], 2, file);
	logRedaction("session", "input", ["url-credentials"], 1, file);
	const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(rows.length, 2);
	assert.deepEqual(Object.keys(rows[0]), ["at", "session", "tool", "kinds", "count"]);
	assert.equal(rows[0].session, "session");
	assert.equal(rows[0].tool, "bash");
	assert.deepEqual(rows[0].kinds, ["anthropic-key"]);
	assert.equal(rows[0].count, 2);
	assert.ok(Number.isFinite(Date.parse(rows[0].at)));
}));

function fixture(options: { hasUI?: boolean; orchestrated?: boolean; guardOff?: boolean; choice?: string; config?: Partial<typeof DEFAULTS> } = {}) {
	const records: unknown[][] = [], decisions: unknown[][] = [], errors: string[] = [], notices: unknown[][] = [], selections: unknown[][] = [];
	const config = { ...DEFAULTS, ...options.config };
	const ctx: any = {
		hasUI: options.hasUI ?? true, cwd: "/tmp", sessionManager: { getSessionId: () => "test-session" },
		ui: { notify: (...args: unknown[]) => notices.push(args), select: async (...args: unknown[]) => { selections.push(args); return options.choice; } },
	};
	const handlers = createHandlers({
		config: () => config, role: () => "main", guardOff: () => options.guardOff ?? false,
		orchestrated: () => options.orchestrated ?? false,
		select: async (ui, guard, title, choices, fallback, opts) => {
			const directory = mkdtempSync(join(tmpdir(), "secret-mask-dialog-test-"));
			try {
				return await guardSelect(ui, guard, title, choices, fallback, { ...opts, env: {
					PI_ORCH_MODE_FILE: join(directory, "no-mode-file"), PI_ORCH_REPO_ROOT: directory,
					PI_ORCH_MESSAGES_DIR: join(directory, "no-messages"), PI_GUARD_DECISIONS_LOG: join(directory, "decisions.jsonl"),
				} });
			} finally { rmSync(directory, { recursive: true }); }
		},
		record: (...args: unknown[]) => { records.push(args); }, decision: (...args: unknown[]) => { decisions.push(args); },
		error: event => { errors.push(event); },
	});
	const call = (command = "printenv", toolName = "bash") => handlers.toolCall({ toolName, input: { command } }, ctx);
	return { handlers, ctx, records, decisions, errors, notices, selections, config, call };
}
test("orchestrated sessions block without prompting, with or without UI", async () => {
	for (const hasUI of [true, false]) {
		const f = fixture({ hasUI, orchestrated: true });
		assert.equal((await f.call())?.block, true);
		assert.equal(f.selections.length, 0);
		assert.deepEqual(f.decisions, [["secrets", "deny", "environment"]]);
	}
});
test("headless sessions block without prompting", async () => {
	const f = fixture({ hasUI: false });
	assert.equal((await f.call())?.block, true);
	assert.equal(f.selections.length, 0);
});
test("interactive prompts allow only explicit Run anyway; cancellation and Block deny", async () => {
	for (const choice of [RUN_ANYWAY, "Block", undefined]) {
		const f = fixture({ choice });
		const result = await f.call();
		assert.equal(result?.block, choice === RUN_ANYWAY ? undefined : true);
		assert.equal(f.selections.length, 1);
		const [title, choices, opts] = f.selections[0] as any[];
		assert.match(title, /^secret-mask: environment/);
		assert.deepEqual(choices, [RUN_ANYWAY, "Block"]);
		assert.equal(opts.timeout, 60_000);
		assert.ok(opts.signal instanceof AbortSignal);
	}
});
test("unresponsive UI defaults to deny after 60 s", async () => {
	const f = fixture();
	f.ctx.ui.select = async () => new Promise(() => {});
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const result = f.call();
		mock.timers.tick(60_000);
		assert.equal((await result)?.block, true);
	} finally { mock.timers.reset(); }
});
test("a failed dialog fails open without discarding downstream redaction", async () => {
	const f = fixture();
	f.ctx.ui.select = async () => { throw new Error("UI unavailable"); };
	assert.equal(await f.call(), undefined);
	assert.deepEqual(f.errors, ["tool-call-failed"]);
	assert.equal(f.handlers.input({ text: `sk-ant-${a}` }, f.ctx)?.text, "[REDACTED:anthropic-key]");
});
test("command allowlist never bypasses blocking; non-bash and harmless commands are ignored", async () => {
	const f = fixture({ hasUI: false, config: { allowlist: [".*"] } });
	assert.equal((await f.call())?.block, true);
	assert.equal(await f.call("printenv", "other"), undefined);
	assert.equal(await f.call("kubectl get pods -o name"), undefined);
});
test("guard-off bypasses blocking but never result/input redaction", async () => {
	const f = fixture({ guardOff: true, orchestrated: true });
	assert.equal(await f.call(), undefined);
	assert.equal(f.selections.length, 0);
	assert.equal(f.handlers.toolResult({ toolName: "read", content: [{ type: "text", text: `sk-ant-${a}` }] }, f.ctx)?.content[0].text?.includes("[REDACTED:anthropic-key]"), true);
	assert.equal(f.handlers.input({ text: `sk-ant-${a}` }, f.ctx)?.action, "transform");
});
test("registered secrets guard really supports process overrides, without changing persisted config", async () => {
	const key = Symbol.for("pi.guards");
	const previous = (globalThis as any)[key];
	try {
		setGuards("secrets", true);
		const f = fixture({ hasUI: false });
		const handlers = createHandlers({ config: () => ({ ...DEFAULTS }), record: () => {}, decision: () => {}, role: () => "main" });
		assert.equal(await handlers.toolCall({ toolName: "bash", input: { command: "printenv" } }, f.ctx), undefined);
		assert.equal(handlers.input({ text: `sk-ant-${a}` }, f.ctx)?.text, "[REDACTED:anthropic-key]");
	} finally {
		if (previous === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = previous;
	}
});
test("every tool and text part is scanned, with one notice/log per result and non-text preserved", () => {
	for (const toolName of ["bash", "read", "write", "edit", "mcp:test"]) {
		const f = fixture();
		const image = { type: "image", data: "unchanged" };
		const input = { toolName, content: [{ type: "text", text: `sk-ant-${a}` }, image, { type: "text", text: `https://u:abc@local/` }] };
		const result = f.handlers.toolResult(input, f.ctx)!;
		assert.equal(result.content[1], image);
		assert.equal(result.content[0].text, "[REDACTED:anthropic-key]");
		assert.equal(result.content[2].text, `https://u:[REDACTED:url-credentials]@local/\n${summary(2, ["anthropic-key", "url-credentials"])}`);
		assert.equal(f.notices.length, 1);
		assert.deepEqual(f.records, [["test-session", toolName, ["anthropic-key", "url-credentials"], 2]]);
		assert.equal(f.handlers.toolResult({ toolName, content: result.content }, f.ctx), undefined);
		assert.equal(f.notices.length, 1);
		assert.equal(input.content[0].text, `sk-ant-${a}`, "original content is not mutated");
	}
});
test("input contract transforms text, preserves attached images by omission, and notifies exactly", () => {
	const f = fixture();
	assert.deepEqual(f.handlers.input({ text: `hello sk-ant-${a}` }, f.ctx), { action: "transform", text: "hello [REDACTED:anthropic-key]" });
	assert.deepEqual(f.notices, [[INPUT_NOTICE, "warning"]]);
	assert.equal(f.handlers.input({ text: "hello" }, f.ctx), undefined);
	assert.equal(f.handlers.input({ text: "[REDACTED:anthropic-key]" }, f.ctx), undefined);
});
test("notification or audit failure cannot discard redacted result/input patches", () => {
	const f = fixture();
	f.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
	const handlers = createHandlers({ config: () => ({ ...DEFAULTS }), role: () => "main",
		record: () => { throw new Error("disk unavailable"); }, error: event => { f.errors.push(event); } });
	assert.match(handlers.toolResult({ toolName: "read", content: [{ type: "text", text: `sk-ant-${a}` }] }, f.ctx)!.content[0].text!, /REDACTED/);
	assert.equal(handlers.input({ text: `sk-ant-${a}` }, f.ctx)?.text, "[REDACTED:anthropic-key]");
	assert.deepEqual(f.errors, ["audit-failed", "notify-failed", "audit-failed", "notify-failed"]);
});
test("headless redaction still logs without notifying", () => {
	const f = fixture({ hasUI: false });
	assert.ok(f.handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: `sk-ant-${a}` }] }, f.ctx));
	assert.ok(f.handlers.input({ text: `sk-ant-${a}` }, f.ctx));
	assert.equal(f.records.length, 2);
	assert.equal(f.notices.length, 0);
});
test("oversized parts are skipped/logged once but other parts are still redacted", () => {
	const f = fixture();
	const huge = "x".repeat(MAX_BYTES + 1);
	for (let i = 0; i < 2; i++) {
		const result = f.handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: huge }, { type: "text", text: `sk-ant-${a}` }] }, f.ctx)!;
		assert.equal(result.content[0].text, huge);
		assert.match(result.content[1].text!, /REDACTED/);
	}
	assert.deepEqual(f.errors, ["part-over-2MiB-skipped"]);
});
test("config flags are independent; enabled false and excluded scope disable all hooks", async () => {
	for (const config of [{ enabled: false }, { scope: "off" as const }, { scope: "subagents" as const }]) {
		const f = fixture({ config });
		assert.equal(await f.call(), undefined);
		assert.equal(f.handlers.input({ text: `sk-ant-${a}` }, f.ctx), undefined);
		assert.equal(f.handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: `sk-ant-${a}` }] }, f.ctx), undefined);
	}
	const f = fixture({ config: { blockCommands: false, redactInput: false, redactResults: false } });
	assert.equal(await f.call(), undefined);
	assert.equal(f.handlers.input({ text: `sk-ant-${a}` }, f.ctx), undefined);
	assert.equal(f.handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: `sk-ant-${a}` }] }, f.ctx), undefined);
});

test("layering: with the Cratis secrets hook the local block stands down (redaction stays); without it, it blocks as before", async () => {
	const withHook = cratisRepo();
	const without = cratisRepo({ scripts: ["cratis-guard-store-mutations.sh"] });
	try {
		const on = fixture({ hasUI: false });
		on.ctx.cwd = withHook.sub;
		assert.equal(await on.call(), undefined); // cratis-guard-secrets.sh owns blocking; CRATIS_HOOKS_ALLOW_SECRET_READS is the switch
		assert.deepEqual(on.decisions, [["secrets", "stand-down:cratis-hook", "environment"]]);
		const redacted = on.handlers.toolResult({ toolName: "bash", content: [{ type: "text", text: "token: ghp_" + "a".repeat(36) }] }, on.ctx);
		assert.ok(redacted, "redaction still runs");
		assert.ok(!JSON.stringify(redacted).includes("ghp_" + "a".repeat(36)));
		const off = fixture({ hasUI: false });
		off.ctx.cwd = without.sub;
		assert.equal((await off.call())?.block, true);
	} finally { withHook.cleanup(); without.cleanup(); }
});
