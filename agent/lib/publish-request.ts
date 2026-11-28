import { basename } from "node:path";

export const MAX_STRING_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
type Body = { body: string; bodyFile?: never } | { bodyFile: string; body?: never };
type OptionalBody = Body | { body?: never; bodyFile?: never };
type BodyOrTitle = Body | ({ title: string } & OptionalBody);
/** Optional GitHub Enterprise host; absent means github.com (the single default representation). */
type Hosted = { host?: string };
type Target = Hosted & { repo: string; number: number };
type Create = Body & Hosted & { repo: string; title: string; labels?: string[]; assignees?: string[] };
type Comment = Body & Target & { editLast?: boolean; createIfNone?: boolean };
type IssueEdit = OptionalBody & Target & { title?: string; addLabels?: string[]; removeLabels?: string[]; addAssignees?: string[]; removeAssignees?: string[] };
export type ApiField = { name: string; value: string | number | boolean | null; file?: never } | { name: string; file: string; value?: never };
export type PublishRequest =
	| (Create & { kind: "issue-create" })
	| (Create & { kind: "pr-create"; base?: string; head?: string; draft?: boolean; reviewers?: string[] })
	| (Comment & { kind: "issue-comment" | "pr-comment" })
	| (IssueEdit & { kind: "issue-edit" })
	| (IssueEdit & { kind: "pr-edit"; base?: string; addReviewers?: string[]; removeReviewers?: string[] })
	| (OptionalBody & Target & { kind: "issue-close"; reason?: "completed" | "not-planned" })
	| (OptionalBody & Target & { kind: "pr-close"; deleteBranch?: boolean })
	| (OptionalBody & Target & { kind: "issue-reopen" | "pr-reopen" })
	| (Target & { kind: "pr-review" } & ((OptionalBody & { event: "approve" }) | (Body & { event: "comment" | "request-changes" })))
	| (OptionalBody & Target & { kind: "pr-merge"; strategy: "merge" | "squash" | "rebase"; subject?: string; deleteBranch?: boolean; auto?: boolean; matchHeadCommit?: string })
	| (Body & Hosted & { kind: "release-create"; repo: string; tag: string; title?: string; target?: string; draft?: boolean; prerelease?: boolean })
	| (BodyOrTitle & Hosted & { kind: "release-notes"; repo: string; tag: string; title?: string })
	| { kind: "gist-create"; files: string[]; description?: string; public?: boolean }
	| { kind: "gist-edit"; gistId: string; files?: string[]; description?: string; removeFiles?: string[] }
	| (OptionalBody & Hosted & { kind: "api"; endpoint: string; method: "POST" | "PATCH" | "PUT" | "DELETE"; fields?: ApiField[] })
	| ({ kind: "check" } & ({ files: string[]; bodyFile?: never } | { bodyFile: string; files?: never }));

export class InvalidRequest extends Error {
	readonly code = "invalid-request";
	readonly detail?: string;
	constructor(detail?: string) { super("publish: invalid-request"); if (detail) this.detail = detail; }
}
export const API_REPO_HINT = "kind api takes the repository in `endpoint`; remove `repo`.";
const invalid = (detail?: string): never => { throw new InvalidRequest(detail); };
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
	if (!value) return false;
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return false;
	return [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.isWellFormed() && Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES;
}
function identifier(value: unknown): boolean {
	return text(value) && /^[A-Za-z0-9_./:@+\-]+$/.test(value) && !value.startsWith("-") && !value.split("/").includes("..");
}
function filename(value: unknown): boolean {
	return text(value) && value.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
function publicFilename(value: unknown): boolean {
	return filename(value) && value !== "." && value !== ".." && !/^[-]|[/\\]/.test(value as string);
}
function endpoint(value: unknown): boolean {
	if (!text(value)) return false;
	if (!value || value.startsWith("-")) return false;
	let path: string;
	try { path = decodeURIComponent(value); } catch { return false; }
	if (path.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
	return !/[\s\p{Cc}\p{Cf}\\]/u.test(path) && !path.split(/[/?#]/).includes("..");
}
const list = (item: (value: unknown) => boolean) => (value: unknown): boolean =>
	Array.isArray(value) && value.length <= 100 && value.every(item);
const enumeration = (...values: unknown[]) => (value: unknown) => values.includes(value);
const bool = (value: unknown) => typeof value === "boolean";
const number = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const repo = (value: unknown) => text(value) && /^[A-Za-z0-9][A-Za-z0-9-]*\/(?:\.github|[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.test(value);
const HOST_MAX_LENGTH = 253;
/**
 * Lowercase ASCII DNS name with at least one dot: no IP-like final label, no IDN (xn--), no port/path/userinfo.
 * Subdomains of github.com are refused: gh resolves them to github.com, so they would bypass host-qualified keys.
 */
const HOST_PATTERN = "^(?!(?:[a-z0-9-]+\\.)+github\\.com$)(?!(?:[a-z0-9-]*\\.)*xn--)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?![0-9]+$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";
const hostname = (value: unknown) => text(value) && value.length <= HOST_MAX_LENGTH && new RegExp(HOST_PATTERN, "u").test(value);
const DEFAULT_HOST = "github.com";
const fieldName = (value: unknown) => text(value) && /^[A-Za-z0-9_.\[\]]+$/.test(value);
function primitive(value: unknown): boolean {
	if (value === null) return true;
	if (text(value) || bool(value)) return true;
	return typeof value === "number" && Number.isFinite(value);
}
function apiField(value: unknown): boolean {
	if (!record(value)) return false;
	if (!fieldName(value.name)) return false;
	if (Object.keys(value).length !== 2) return false;
	if (own(value, "file")) return filename(value.file);
	return own(value, "value") && primitive(value.value);
}
interface Property { validate: (value: unknown) => boolean; schema: RecordValue }
const stringProperty = (validate: (value: unknown) => boolean = text): Property => ({ validate, schema: { type: "string" } });
const arrayProperty = (validate: (value: unknown) => boolean): Property => ({ validate: list(validate), schema: { type: "array", items: { type: "string" } } });
const enumProperty = (...values: string[]): Property => ({ validate: enumeration(...values), schema: { type: "string", enum: values } });
const properties: Record<string, Property> = {
	repo: stringProperty(repo), number: { validate: number, schema: { type: "integer", minimum: 1 } },
	title: stringProperty(), body: stringProperty(), bodyFile: stringProperty(filename), subject: stringProperty(), description: stringProperty(),
	base: stringProperty(identifier), head: stringProperty(identifier), target: stringProperty(identifier), tag: stringProperty(identifier),
	gistId: stringProperty(value => text(value) && /^[a-fA-F0-9]+$/.test(value)), endpoint: stringProperty(endpoint),
	matchHeadCommit: stringProperty(value => text(value) && /^[a-fA-F0-9]{40}$/.test(value)),
	event: enumProperty("approve", "comment", "request-changes"), strategy: enumProperty("merge", "squash", "rebase"),
	reason: enumProperty("completed", "not-planned"), method: enumProperty("POST", "PATCH", "PUT", "DELETE"),
	host: { validate: hostname, schema: { type: "string" } },
};
for (const name of ["labels", "assignees", "reviewers", "addLabels", "removeLabels", "addAssignees", "removeAssignees", "addReviewers", "removeReviewers"]) properties[name] = arrayProperty(value => text(value) && value.length > 0 && !/[\p{Cc}]/u.test(value));
for (const name of ["draft", "editLast", "createIfNone", "deleteBranch", "auto", "prerelease", "public"]) properties[name] = { validate: bool, schema: { type: "boolean" } };
properties.files = arrayProperty(filename);
properties.removeFiles = arrayProperty(publicFilename);
properties.fields = { validate: list(apiField), schema: { type: "array", items: {
	type: "object", additionalProperties: false, required: ["name"], properties: {
		name: { type: "string" }, value: { type: ["string", "number", "boolean", "null"] }, file: { type: "string" },
	},
} } };
interface Contract { required: string[]; optional: string[] }
const contract = (required: string, optional = ""): Contract => ({ required: required.split(" ").filter(Boolean), optional: optional.split(" ").filter(Boolean) });
const body = "body bodyFile", edits = "title addLabels removeLabels addAssignees removeAssignees";
const contracts: Record<PublishRequest["kind"], Contract> = {
	"issue-create": contract("repo title", `${body} labels assignees`),
	"pr-create": contract("repo title", `${body} labels assignees base head draft reviewers`),
	"issue-comment": contract("repo number", `${body} editLast createIfNone`),
	"pr-comment": contract("repo number", `${body} editLast createIfNone`),
	"issue-edit": contract("repo number", `${body} ${edits}`),
	"pr-edit": contract("repo number", `${body} ${edits} base addReviewers removeReviewers`),
	"issue-close": contract("repo number", `${body} reason`), "pr-close": contract("repo number", `${body} deleteBranch`),
	"issue-reopen": contract("repo number", body), "pr-reopen": contract("repo number", body),
	"pr-review": contract("repo number event", body),
	"pr-merge": contract("repo number strategy", `${body} subject deleteBranch auto matchHeadCommit`),
	"release-create": contract("repo tag", `${body} title target draft prerelease`),
	"release-notes": contract("repo tag", `${body} title`),
	"gist-create": contract("files", "description public"), "gist-edit": contract("gistId", "files description removeFiles"),
	api: contract("endpoint method", `${body} fields`), check: contract("", "files bodyFile"),
};
// `host` qualifies a repository (or an api call); gist-* and check have no repository and reject it.
for (const [kind, shape] of Object.entries(contracts)) if (shape.required.includes("repo") || kind === "api") shape.optional.push("host");
const REQUIRED_BODY_KINDS = ["issue-create", "pr-create", "issue-comment", "pr-comment", "release-create"];
export const APPEND_ONLY_REASON = "Issues and comments are append-only: do not edit issue bodies/titles or existing comments; append a new event comment instead. PR descriptions remain editable.";
const ISSUE_METADATA = ["addLabels", "removeLabels", "addAssignees", "removeAssignees"];
const PR_EDIT_METADATA = [...ISSUE_METADATA, "addReviewers", "removeReviewers"];
/** `gh gist edit` takes single-valued --add/--remove/--desc, so one edit means exactly one operation with one value. */
const GIST_EDIT_OPERATIONS = ["description", "files", "removeFiles"];
export const publishRequestSchema = { type: "object", additionalProperties: false, properties: {
	kind: { type: "string", enum: Object.keys(contracts) }, ...Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, property.schema])),
}, required: ["kind"] };
/** Compact required-field guidance generated from the runtime contracts. */
export function kindSummary(): string {
	const groups = new Map<string, string[]>();
	for (const [kind, shape] of Object.entries(contracts)) {
		const required = kind === "check" ? "files or bodyFile" : shape.required.join(",");
		const kinds = groups.get(required) ?? [];
		kinds.push(kind); groups.set(required, kinds);
	}
	return [...groups].map(([required, kinds]) => `${kinds.join("/")}:${required}`).join("; ");
}
/** Static contract text: never includes caller-supplied values or unknown field names. */
export function kindContract(kind: PublishRequest["kind"]): string {
	if (!own(contracts, kind)) return invalid();
	if (kind === "check") return "check requires: non-empty files or bodyFile (only one)";
	const shape = contracts[kind];
	const body = REQUIRED_BODY_KINDS.includes(kind) ? "; body or bodyFile" : "";
	const edit = kind === "pr-edit" ? "; at least one of title/body/bodyFile or a non-empty metadata change"
		: kind === "release-notes" ? "; at least one of title/body/bodyFile for edits" : "";
	return `${kind} requires: ${shape.required.join(", ")}${body}${edit}; optional: ${shape.optional.join(", ")}`;
}
function unknownFieldsDetail(keys: string[], kind: PublishRequest["kind"], contract: string): string {
	if (kind === "api" && keys.includes("repo")) return API_REPO_HINT;
	const known = keys.filter(key => own(properties, key)), count = keys.length - known.length;
	return [known.length ? `unknown field for ${kind}: ${known.join(", ")}` : "", count ? `unknown fields: ${count}` : "", contract].filter(Boolean).join("; ");
}
function validateShape(input: RecordValue): void {
	const suppliedKind = input.kind;
	if (typeof suppliedKind !== "string" || !own(contracts, suppliedKind)) invalid(`kind must be one of: ${Object.keys(contracts).join(", ")}`);
	const kind = suppliedKind as PublishRequest["kind"];
	const shape = contracts[kind], contract = kindContract(kind);
	const allowed = new Set(["kind", ...shape.required, ...shape.optional]);
	const unknown = Object.keys(input).filter(key => !allowed.has(key));
	if (unknown.length) invalid(unknownFieldsDetail(unknown, kind, contract));
	const missing = shape.required.filter(key => !own(input, key));
	if (missing.length) invalid(`missing: ${missing.join(", ")}; ${contract}`);
	for (const key of Object.keys(input).filter(key => key !== "kind")) {
		if (!properties[key].validate(input[key])) {
			const values = properties[key].schema.enum as string[] | undefined;
			invalid(`invalid value: ${key}${values ? `; allowed: ${values.join(", ")}` : ""}; ${contract}`);
		}
	}
}
function validateTarget(input: RecordValue): void {
	if (typeof input.target !== "string" || !/^[0-9a-fA-F]{4,39}$/.test(input.target)) return;
	invalid(`target looks like an abbreviated commit SHA; use the full 40-character SHA or a branch name; ${kindContract(input.kind as PublishRequest["kind"])}`);
}
function validateFields(input: RecordValue): void {
	if (!(input.fields as ApiField[] | undefined)?.some(field => /\[\]\[/.test(field.name))) return;
	invalid(`fields cannot build arrays of objects (name with [][key]); send the whole body as JSON in a bodyFile with no fields; ${kindContract(input.kind as PublishRequest["kind"])}`);
}
function needsBody(input: RecordValue): boolean {
	if (REQUIRED_BODY_KINDS.includes(input.kind as string)) return true;
	return input.kind === "pr-review" && input.event !== "approve";
}
function validateBody(input: RecordValue): void {
	const hasBody = own(input, "body") || own(input, "bodyFile");
	const kind = input.kind as PublishRequest["kind"], contract = kindContract(kind);
	if (own(input, "body") && own(input, "bodyFile")) invalid(`body and bodyFile are mutually exclusive; ${contract}`);
	if (needsBody(input) && !hasBody) invalid(`${kind} needs body or bodyFile; ${contract}`);
	if (input.createIfNone === true && input.editLast !== true) invalid();
}
function hasMetadata(input: RecordValue, keys: string[]): boolean {
	return keys.some(key => (input[key] as string[] | undefined)?.length);
}
function hasTextEdit(input: RecordValue): boolean {
	return ["title", "body", "bodyFile"].some(key => own(input, key));
}
function validateEdit(input: RecordValue): void {
	if (input.kind === "issue-edit" && !hasMetadata(input, ISSUE_METADATA)) invalid();
	if (input.kind === "pr-edit" && !(hasTextEdit(input) || hasMetadata(input, PR_EDIT_METADATA))) invalid();
	if (input.kind === "release-notes" && !hasTextEdit(input)) invalid();
}
function gistChanges(input: RecordValue): boolean {
	const present = GIST_EDIT_OPERATIONS.filter(key => own(input, key));
	if (present.length !== 1) return false;
	return present[0] === "description" || (input[present[0]] as unknown[]).length === 1;
}
function validateGist(input: RecordValue): void {
	if (!["gist-create", "gist-edit"].includes(input.kind as string)) return;
	if ((input.files as string[] | undefined)?.some(file => !publicFilename(basename(file)))) invalid();
	if (input.kind === "gist-edit" && !gistChanges(input)) invalid();
}
function validateCheck(input: RecordValue): void {
	if (input.kind !== "check") return;
	const files = input.files as unknown[] | undefined;
	if (own(input, "bodyFile") ? files !== undefined : !files?.length) invalid(kindContract("check"));
}
function validateChanges(input: RecordValue): void {
	validateEdit(input); validateGist(input); validateCheck(input);
	if (input.kind === "gist-create" && (input.files as unknown[]).length === 0) invalid();
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
	return value;
}
/** Classify API targets without allowing encoded paths or enterprise prefixes to bypass the rule. */
function apiTarget(input: RecordValue): { path: string; query: URLSearchParams } {
	const endpoint = decodeURIComponent(input.endpoint as string).replace(/^\/+/, "").replace(/^api\/v3\//i, "");
	const [path, query = ""] = endpoint.split("?", 2);
	const normalized = path.split("#", 1)[0].split("/").filter(part => part && part !== ".").join("/").replace(/^api\/v3\//i, "");
	return { path: normalized.toLowerCase(), query: new URLSearchParams(query) };
}
function issueTextField(name: string): boolean {
	return /^(body|title)(?:\[|$)/i.test(name);
}
function validateApiAppendOnly(input: RecordValue, payload: string | undefined, source: string): void {
	const { path, query } = apiTarget(input);
	const fields = input.fields as ApiField[] | undefined;
	if (/^(patch|put|delete)$/i.test(input.method as string)) {
		if (/^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/comments\/[^/]+$/.test(path)
			|| /^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews\/[^/]+$/.test(path)) invalid(APPEND_ONLY_REASON);
		if (/^(patch|put)$/i.test(input.method as string) && /^repos\/[^/]+\/[^/]+\/issues\/[^/]+$/.test(path)) {
			if ([...query.keys(), ...(fields ?? []).map(field => field.name)].some(issueTextField)) invalid(APPEND_ONLY_REASON);
			if (payload !== undefined && source === "body") {
				let body: unknown;
				try { body = JSON.parse(payload); } catch { invalid(APPEND_ONLY_REASON); }
				if (!record(body) || Object.keys(body).some(issueTextField)) invalid(APPEND_ONLY_REASON);
			}
		}
	}
	// GraphQL exposes the same edits; inspect inline fields and captured JSON/file bytes too.
	if (path === "graphql") {
		let captured = payload ?? "";
		try { captured = JSON.stringify(JSON.parse(captured)); } catch { /* query file may be plain GraphQL */ }
		const text = [captured, ...query.values(), ...(fields ?? []).map(field => "value" in field ? String(field.value) : "")].join("\n");
		if (/\b(?:updateIssue|(?:update|delete)(?:IssueComment|PullRequestReviewComment|PullRequestReview))\b/.test(text)) invalid(APPEND_ONLY_REASON);
	}
}
/** Enforced both for structured input and again on the immutable captured API body. */
export function validateAppendOnly(input: RecordValue, payload?: string, source = "body"): void {
	if (input.kind === "issue-edit" && ["title", "body", "bodyFile"].some(key => own(input, key))) invalid(APPEND_ONLY_REASON);
	if (input.editLast === true) invalid(APPEND_ONLY_REASON);
	if (input.kind === "api") validateApiAppendOnly(input, payload ?? (typeof input.body === "string" ? input.body : undefined), source);
}
/** Returns a detached immutable request; failures never retain received values. */
export function validateRequest(value: unknown): PublishRequest {
	try {
		if (!record(value)) invalid();
		validateShape(value); validateAppendOnly(value); validateBody(value); validateChanges(value); validateTarget(value); validateFields(value);
		const encoded = JSON.stringify(value);
		if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) invalid();
		const detached = JSON.parse(encoded);
		validateShape(detached); validateAppendOnly(detached); validateBody(detached); validateChanges(detached); validateTarget(detached); validateFields(detached);
		if (detached.host === DEFAULT_HOST) delete detached.host;
		return freeze(detached) as PublishRequest;
	} catch (error) { throw error instanceof InvalidRequest ? error : new InvalidRequest(); }
}

export interface PayloadSource { label: string; source: { text: string } | { file: string }; basename?: string }
export interface PayloadSlot { payload: number; use: "file" | "text"; prefix: string }
export interface OutboundText { label: string; text: string }
export interface GhCommand {
	argv: (string | PayloadSlot)[];
	expect?: readonly string[];
	onLastOutput?: string;
	skipIfBlank?: number;
	postsCloseComment?: true;
}
export interface GhPlan extends GhCommand {
	followups?: GhCommand[];
	payloads: PayloadSource[]; outbound: OutboundText[];
	authority: { kind: PublishRequest["kind"]; ghArgs: string[]; repo?: string; host?: string; number?: number; base?: string; head?: string };
	requestBytes: number;
	/** Non-default GitHub host; absent means github.com. */
	host?: string;
}
/** gh's native HOST/OWNER/REPO form when a non-default host is set; the canonical authority key everywhere. */
function qualifiedRepo(request: RecordValue): string {
	return own(request, "host") ? `${request.host}/${request.repo}` : request.repo as string;
}
const scalarFlags: Record<string, string> = { repo: "repo", title: "title", base: "base", head: "head", target: "target", subject: "subject", matchHeadCommit: "match-head-commit", reason: "reason", description: "desc" };
const arrayFlags: Record<string, string> = { labels: "label", assignees: "assignee", reviewers: "reviewer", addLabels: "add-label", removeLabels: "remove-label", addAssignees: "add-assignee", removeAssignees: "remove-assignee", addReviewers: "add-reviewer", removeReviewers: "remove-reviewer", removeFiles: "remove" };
const booleanFlags: Record<string, string> = { draft: "draft", editLast: "edit-last", createIfNone: "create-if-none", deleteBranch: "delete-branch", auto: "auto", prerelease: "prerelease", public: "public" };
function payload(plan: GhPlan, source: PayloadSource, prefix: string, use: PayloadSlot["use"] = "file"): void {
	plan.argv.push({ payload: plan.payloads.length, use, prefix }); plan.payloads.push(source);
}
function addBody(request: RecordValue, plan: GhPlan): void {
	if (!own(request, "body") && !own(request, "bodyFile")) return;
	const source = own(request, "body") ? { text: request.body as string } : { file: request.bodyFile as string };
	const kind = request.kind as string;
	if (kind.endsWith("-close") || kind.endsWith("-reopen")) { payload(plan, { label: "body", source }, "--comment=", "text"); return; }
	const flag = kind.startsWith("release-") ? "notes-file" : "body-file";
	payload(plan, { label: "body", source }, `--${kind === "api" ? "input" : flag}=`);
	if (kind === "api") plan.argv.push("--header=Content-Type: application/json");
}
function scalarOptions(request: RecordValue, plan: GhPlan): void {
	for (const [key, flag] of Object.entries(scalarFlags)) {
		if (!own(request, key)) continue;
		// gh spells the close reason "not planned" (with a space); the typed request uses "not-planned".
		const value = key === "reason" && request[key] === "not-planned" ? "not planned" : key === "repo" ? qualifiedRepo(request) : request[key];
		plan.argv.push(`--${flag}=${value}`); plan.outbound.push({ label: key, text: value as string });
	}
}
function arrayOptions(request: RecordValue, plan: GhPlan): void {
	for (const [key, flag] of Object.entries(arrayFlags)) {
		for (const value of request[key] as string[] ?? []) { plan.argv.push(`--${flag}=${value}`); plan.outbound.push({ label: key, text: value }); }
	}
}
function addOptions(request: RecordValue, plan: GhPlan): void {
	scalarOptions(request, plan); arrayOptions(request, plan);
	for (const [key, flag] of Object.entries(booleanFlags)) if (request[key] === true) plan.argv.push(`--${flag}`);
}
function addFiles(request: RecordValue, plan: GhPlan): void {
	(request.files as string[] | undefined)?.forEach((file, index) => {
		const name = basename(file), label = `files[${index}]`;
		const source = { label, source: { file }, basename: name };
		plan.outbound.push({ label, text: name });
		payload(plan, source, request.kind === "gist-edit" ? "--add=" : "");
	});
}
function addFields(request: RecordValue, plan: GhPlan): void {
	(request.fields as ApiField[] | undefined)?.forEach((field, index) => {
		const label = `fields[${index}]`;
		plan.outbound.push({ label, text: field.name });
		if (own(field, "file")) { payload(plan, { label, source: { file: field.file! } }, `--field=${field.name}=@`); return; }
		const value = String(field.value);
		plan.outbound.push({ label, text: value });
		plan.argv.push(`--${typeof field.value === "string" ? "raw-field" : "field"}=${field.name}=${value}`);
	});
}
function command(request: RecordValue): string[] {
	const [family, action] = (request.kind as string).split("-");
	if (family === "check") return [];
	if (family === "api") return ["api", request.endpoint as string, `--method=${request.method}`, `--hostname=${request.host ?? DEFAULT_HOST}`];
	const argv = [family, action === "notes" ? "edit" : action];
	for (const key of ["number", "tag", "gistId"]) if (own(request, key)) argv.push(String(request[key]));
	for (const key of ["event", "strategy"]) if (own(request, key)) argv.push(`--${request[key]}`);
	return argv;
}
function rest(plan: GhPlan, endpoint: string, method: "GET" | "POST" | "PATCH" | "DELETE"): string[] {
	plan.outbound.push({ label: "endpoint", text: endpoint });
	return ["api", endpoint, `--method=${method}`, `--hostname=${plan.host ?? DEFAULT_HOST}`];
}
function setCommands(plan: GhPlan, commands: GhCommand[]): void {
	const [first, ...followups] = commands;
	if (!first) return;
	Object.assign(plan, first);
	if (followups.length) plan.followups = followups;
}
function useRestForIssueClose(request: Extract<PublishRequest, { kind: "issue-close" }>, plan: GhPlan): void {
	const endpoint = `repos/${request.repo}/issues/${request.number}`;
	const reason = request.reason === "not-planned" ? "not_planned" : request.reason;
	const commands: GhCommand[] = [{
		argv: [...rest(plan, endpoint, "GET"), '--jq=if has("pull_request") then "pr" else .state end'],
		expect: ["open", "closed", "pr"],
	}];
	const body = plan.argv.find(arg => typeof arg !== "string");
	if (body) {
		// Do not append another comment to an already closed issue.
		commands.push({ argv: [...rest(plan, `${endpoint}/comments`, "POST"), "--silent",
			{ ...body, use: "file", prefix: "--field=body=@" }], onLastOutput: "open", skipIfBlank: body.payload, postsCloseComment: true });
	}
	const patch = [...rest(plan, endpoint, "PATCH"), "--raw-field=state=closed"];
	let confirmation = '--jq=.state == "closed"';
	if (reason) {
		plan.outbound.push({ label: "state_reason", text: reason });
		patch.push(`--raw-field=state_reason=${reason}`);
		confirmation += ` and .state_reason == "${reason}"`;
	}
	commands.push({ argv: [...patch, confirmation], expect: ["true"], onLastOutput: reason ? undefined : "open" });
	setCommands(plan, commands);
}
/** REST can apply description/title/base together without gh pr edit's classic Projects query. */
function useRestForPrBodyEdit(request: RecordValue, plan: GhPlan): void {
	const body = plan.argv.find(arg => typeof arg !== "string");
	if (!body) return;
	plan.argv = [...rest(plan, `repos/${request.repo}/pulls/${request.number}`, "PATCH"),
		"--silent", { ...body, prefix: "--field=body=@" }];
	for (const key of ["title", "base"]) if (own(request, key)) plan.argv.push(`--raw-field=${key}=${request[key]}`);
}
function metadata(request: RecordValue, key: string): string[] {
	return request[key] as string[] | undefined ?? [];
}
function nativePrMetadata(request: RecordValue): boolean {
	// Keep gh's account aliases and qualified teams it must resolve, not literal REST logins/slugs.
	if ([...metadata(request, "addAssignees"), ...metadata(request, "removeAssignees")].some(value => value.startsWith("@"))) return true;
	const owner = (request.repo as string).split("/")[0].toLowerCase();
	if ([...metadata(request, "addReviewers"), ...metadata(request, "removeReviewers")].some(value => {
		const parts = value.split("/");
		return parts.length > 1 && (parts.length !== 2 || parts[0].toLowerCase() !== owner || !parts[1]);
	})) return true;
	// An endpoint path segment must not be interpreted as navigation.
	return metadata(request, "removeLabels").some(value => value.split(/[/\\]/).some(segment => segment === "." || segment === ".."));
}
function reviewerFields(values: string[], plan: GhPlan): string[] {
	return values.map(value => {
		const index = value.indexOf("/");
		if (index < 0) return `--raw-field=reviewers[]=${value}`;
		const slug = value.slice(index + 1);
		plan.outbound.push({ label: "team_reviewers", text: slug });
		return `--raw-field=team_reviewers[]=${slug}`;
	});
}
function useRestForPrMetadata(request: RecordValue, plan: GhPlan): void {
	if (nativePrMetadata(request)) return;
	const repo = `repos/${request.repo}`, issue = `${repo}/issues/${request.number}`, pr = `${repo}/pulls/${request.number}`;
	const commands: GhCommand[] = [];
	// The issue endpoints also accept ordinary issues; confirm this target is a PR before using them.
	if (hasMetadata(request, ISSUE_METADATA)) commands.push({ argv: [...rest(plan, pr, "GET"), "--silent"] });
	const add = (path: string, method: "POST" | "DELETE", fields: string[]) => {
		commands.push({ argv: [...rest(plan, path, method), "--silent", ...fields] });
	};
	for (const label of metadata(request, "removeLabels")) add(`${issue}/labels/${encodeURIComponent(label)}`, "DELETE", []);
	const labels = metadata(request, "addLabels");
	if (labels.length) add(`${issue}/labels`, "POST", labels.map(value => `--raw-field=labels[]=${value}`));
	for (const [action, method] of [["remove", "DELETE"], ["add", "POST"]] as const) {
		const assignees = metadata(request, `${action}Assignees`), reviewers = metadata(request, `${action}Reviewers`);
		if (assignees.length) add(`${issue}/assignees`, method, assignees.map(value => `--raw-field=assignees[]=${value}`));
		if (reviewers.length) add(`${pr}/requested_reviewers`, method, reviewerFields(reviewers, plan));
	}
	setCommands(plan, commands);
}
function applyTransport(request: PublishRequest, plan: GhPlan): void {
	if (request.kind === "issue-close") useRestForIssueClose(request, plan);
	if (request.kind !== "pr-edit") return;
	if (!hasTextEdit(request) && !request.base) useRestForPrMetadata(request, plan);
	else if (!hasMetadata(request, PR_EDIT_METADATA)) useRestForPrBodyEdit(request, plan);
}
function addHost(request: RecordValue, plan: GhPlan): void {
	const host = request.host as string;
	plan.host = host; plan.authority.host = host;
	if (own(request, "repo")) plan.authority.repo = qualifiedRepo(request);
	plan.outbound.push({ label: "host", text: host });
}
/** Payload slots are deliberately not source paths. Only the capture core can materialize them. */
export function toGhPlan(value: PublishRequest): GhPlan {
	const validated = validateRequest(value), request = validated as unknown as RecordValue;
	const plan: GhPlan = { argv: command(request), payloads: [], outbound: [], requestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"), authority: {
		kind: request.kind as PublishRequest["kind"], ghArgs: [],
		...Object.fromEntries(["repo", "number", "base", "head"].filter(key => own(request, key)).map(key => [key, request[key]])),
	} };
	if (validated.kind === "check") {
		plan.payloads = validated.bodyFile !== undefined
			? [{ label: "body", source: { file: validated.bodyFile } }]
			: validated.files.map((file, index) => ({ label: `files[${index}]`, source: { file } }));
		return plan;
	}
	if (own(request, "host")) addHost(request, plan);
	if (request.kind === "api") plan.outbound.push({ label: "endpoint", text: request.endpoint as string });
	for (const key of ["tag", "gistId"]) if (own(request, key)) plan.outbound.push({ label: key, text: request[key] as string });
	addOptions(request, plan); addBody(request, plan); addFiles(request, plan); addFields(request, plan);
	// Admission stays on the original typed operation, not the transport commands.
	plan.authority.ghArgs = plan.argv.map(arg => typeof arg === "string" ? arg : `${arg.prefix}publication-payload`);
	applyTransport(validated, plan);
	return plan;
}

const cliScalars: Record<string, string> = Object.fromEntries(["repo", "number", "title", "body", "bodyFile", "base", "head", "event", "strategy", "subject", "matchHeadCommit", "reason", "tag", "target", "gistId", "description", "endpoint", "method", "host"].map(key => [key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), key]));
const cliArrays: Record<string, string> = { label: "labels", assignee: "assignees", reviewer: "reviewers", "add-label": "addLabels", "remove-label": "removeLabels", "add-assignee": "addAssignees", "remove-assignee": "removeAssignees", "add-reviewer": "addReviewers", "remove-reviewer": "removeReviewers", file: "files", "remove-file": "removeFiles", "field-json": "fields" };
function booleanOption(result: RecordValue, key: string): void {
	if (own(result, key)) invalid();
	result[key] = true;
}
function scalarOption(result: RecordValue, option: { key: string; value: string }): void {
	if (own(result, option.key)) invalid();
	if (option.key === "number" && !/^[1-9][0-9]*$/.test(option.value)) invalid();
	result[option.key] = option.key === "number" ? Number(option.value) : option.value;
}
function cliOption(state: { result: RecordValue; argv: readonly string[]; index: number }): number {
	const { result, argv, index } = state, flag = argv[index];
	if (!flag.startsWith("--")) invalid();
	const name = flag.slice(2), boolean = Object.keys(booleanFlags).find(key => booleanFlags[key] === name);
	if (boolean) { booleanOption(result, boolean); return 1; }
	const key = cliScalars[name] ?? cliArrays[name];
	if (!key || index + 1 >= argv.length) invalid();
	const value = argv[index + 1];
	if (own(cliArrays, name)) {
		const items = (result[key] ??= []) as unknown[];
		items.push(name === "field-json" ? JSON.parse(value) : value);
	} else scalarOption(result, { key, value });
	return 2;
}
export function parseCli(argv: readonly string[]): PublishRequest | { kind: "help" } {
	try {
		if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return Object.freeze({ kind: "help" });
		const result: RecordValue = { kind: argv[0] };
		for (let index = 1; index < argv.length;) index += cliOption({ result, argv, index });
		return validateRequest(result);
	} catch (error) { throw error instanceof InvalidRequest ? error : new InvalidRequest(); }
}
