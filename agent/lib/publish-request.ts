import { basename } from "node:path";

export const MAX_STRING_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
type Body = { body: string; bodyFile?: never } | { bodyFile: string; body?: never };
type OptionalBody = Body | { body?: never; bodyFile?: never };
type BodyOrTitle = Body | ({ title: string } & OptionalBody);
type Target = { repo: string; number: number };
type Create = Body & { repo: string; title: string; labels?: string[]; assignees?: string[] };
type Comment = Body & Target & { editLast?: boolean; createIfNone?: boolean };
type Edit = BodyOrTitle & Target & { title?: string; addLabels?: string[]; removeLabels?: string[]; addAssignees?: string[]; removeAssignees?: string[] };
export type ApiField = { name: string; value: string | number | boolean | null; file?: never } | { name: string; file: string; value?: never };
export type PublishRequest =
	| (Create & { kind: "issue-create" })
	| (Create & { kind: "pr-create"; base?: string; head?: string; draft?: boolean; reviewers?: string[] })
	| (Comment & { kind: "issue-comment" | "pr-comment" })
	| (Edit & { kind: "issue-edit" })
	| (Edit & { kind: "pr-edit"; base?: string; addReviewers?: string[]; removeReviewers?: string[] })
	| (OptionalBody & Target & { kind: "issue-close"; reason?: "completed" | "not-planned" })
	| (OptionalBody & Target & { kind: "pr-close"; deleteBranch?: boolean })
	| (OptionalBody & Target & { kind: "issue-reopen" | "pr-reopen" })
	| (Target & { kind: "pr-review" } & ((OptionalBody & { event: "approve" }) | (Body & { event: "comment" | "request-changes" })))
	| (OptionalBody & Target & { kind: "pr-merge"; strategy: "merge" | "squash" | "rebase"; subject?: string; deleteBranch?: boolean; auto?: boolean; matchHeadCommit?: string })
	| (Body & { kind: "release-create"; repo: string; tag: string; title?: string; target?: string; draft?: boolean; prerelease?: boolean })
	| (BodyOrTitle & { kind: "release-notes"; repo: string; tag: string; title?: string })
	| { kind: "gist-create"; files: string[]; description?: string; public?: boolean }
	| { kind: "gist-edit"; gistId: string; files?: string[]; description?: string; removeFiles?: string[] }
	| (OptionalBody & { kind: "api"; endpoint: string; method: "POST" | "PATCH" | "PUT" | "DELETE"; fields?: ApiField[] })
	| { kind: "check"; files: string[] };

export class InvalidRequest extends Error {
	readonly code = "invalid-request";
	constructor() { super("publish: invalid-request"); }
}
const invalid = (): never => { throw new InvalidRequest(); };
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
const repo = (value: unknown) => text(value) && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
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
const stringProperty = (validate: (value: unknown) => boolean = text): Property => ({ validate, schema: { type: "string", maxLength: MAX_STRING_BYTES } });
const arrayProperty = (validate: (value: unknown) => boolean): Property => ({ validate: list(validate), schema: { type: "array", maxItems: 100, items: { type: "string", maxLength: MAX_STRING_BYTES } } });
const enumProperty = (...values: string[]): Property => ({ validate: enumeration(...values), schema: { type: "string", enum: values } });
const properties: Record<string, Property> = {
	repo: stringProperty(repo), number: { validate: number, schema: { type: "integer", minimum: 1 } },
	title: stringProperty(), body: stringProperty(), bodyFile: stringProperty(filename), subject: stringProperty(), description: stringProperty(),
	base: stringProperty(identifier), head: stringProperty(identifier), target: stringProperty(identifier), tag: stringProperty(identifier),
	gistId: stringProperty(value => text(value) && /^[a-fA-F0-9]+$/.test(value)), endpoint: stringProperty(endpoint),
	matchHeadCommit: stringProperty(value => text(value) && /^[a-fA-F0-9]{40}$/.test(value)),
	event: enumProperty("approve", "comment", "request-changes"), strategy: enumProperty("merge", "squash", "rebase"),
	reason: enumProperty("completed", "not-planned"), method: enumProperty("POST", "PATCH", "PUT", "DELETE"),
};
for (const name of ["labels", "assignees", "reviewers", "addLabels", "removeLabels", "addAssignees", "removeAssignees", "addReviewers", "removeReviewers"]) properties[name] = arrayProperty(value => text(value) && value.length > 0 && !/[\p{Cc}]/u.test(value));
for (const name of ["draft", "editLast", "createIfNone", "deleteBranch", "auto", "prerelease", "public"]) properties[name] = { validate: bool, schema: { type: "boolean" } };
properties.files = arrayProperty(filename);
properties.removeFiles = arrayProperty(publicFilename);
properties.fields = { validate: list(apiField), schema: { type: "array", maxItems: 100, items: { oneOf: [
	{ type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string", pattern: "^[A-Za-z0-9_.\\[\\]]+$" }, value: { type: ["string", "number", "boolean", "null"], maxLength: MAX_STRING_BYTES } } },
	{ type: "object", additionalProperties: false, required: ["name", "file"], properties: { name: { type: "string", pattern: "^[A-Za-z0-9_.\\[\\]]+$" }, file: { type: "string" } } },
] } } };
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
	api: contract("endpoint method", `${body} fields`), check: contract("files"),
};
const REQUIRED_BODY_KINDS = ["issue-create", "pr-create", "issue-comment", "pr-comment", "release-create"];
const EDIT_KINDS = ["issue-edit", "pr-edit", "release-notes"];
const requiredOne = (...keys: string[]) => ({ anyOf: keys.map(key => ({ required: [key] })) });
function schemaConstraints(kind: string): RecordValue[] {
	const constraints: RecordValue[] = [{ not: { required: ["body", "bodyFile"] } }];
	if (REQUIRED_BODY_KINDS.includes(kind)) constraints.push(requiredOne("body", "bodyFile"));
	if (EDIT_KINDS.includes(kind)) constraints.push(requiredOne("title", "body", "bodyFile"));
	if (["gist-create", "check"].includes(kind)) constraints.push({ properties: { files: { minItems: 1 } } });
	return [...constraints, ...conditionalSchema(kind)];
}
function conditionalSchema(kind: string): RecordValue[] {
	if (kind === "pr-review") return [{ anyOf: [{ properties: { event: { const: "approve" } } }, ...requiredOne("body", "bodyFile").anyOf] }];
	if (kind.endsWith("-comment")) return [{ if: { required: ["createIfNone"], properties: { createIfNone: { const: true } } }, then: { required: ["editLast"], properties: { editLast: { const: true } } } }];
	if (kind === "gist-edit") return [{ anyOf: [{ required: ["description"] }, ...["files", "removeFiles"].map(key => ({ required: [key], properties: { [key]: { minItems: 1 } } }))] }];
	return [];
}
export const publishRequestSchema = { type: "object", additionalProperties: false, properties: {
	kind: { type: "string", enum: Object.keys(contracts) }, ...Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, property.schema])),
}, required: ["kind"], oneOf: Object.entries(contracts).map(([kind, shape]) => ({
	required: ["kind", ...shape.required], additionalProperties: false, type: "object", allOf: schemaConstraints(kind),
	properties: Object.fromEntries(["kind", ...shape.required, ...shape.optional].map(key => [key, key === "kind" ? { const: kind } : properties[key].schema])),
})) };
function validateShape(input: RecordValue): void {
	if (typeof input.kind !== "string" || !own(contracts, input.kind)) invalid();
	const shape = contracts[input.kind as PublishRequest["kind"]];
	const allowed = new Set(["kind", ...shape.required, ...shape.optional]);
	if (Object.keys(input).some(key => !allowed.has(key))) invalid();
	if (shape.required.some(key => !own(input, key))) invalid();
	for (const key of Object.keys(input).filter(key => key !== "kind")) {
		if (!properties[key].validate(input[key])) invalid();
	}
}
function needsBody(input: RecordValue): boolean {
	if (REQUIRED_BODY_KINDS.includes(input.kind as string)) return true;
	return input.kind === "pr-review" && input.event !== "approve";
}
function validateBody(input: RecordValue): void {
	const hasBody = own(input, "body") || own(input, "bodyFile");
	if (own(input, "body") && own(input, "bodyFile")) invalid();
	if (needsBody(input) && !hasBody) invalid();
	if (input.createIfNone === true && input.editLast !== true) invalid();
}
function validateEdit(input: RecordValue): void {
	if (!EDIT_KINDS.includes(input.kind as string)) return;
	if (!["title", "body", "bodyFile"].some(key => own(input, key))) invalid();
}
function gistChanges(input: RecordValue): boolean {
	return own(input, "description") || ["files", "removeFiles"].some(key => (input[key] as unknown[] | undefined)?.length);
}
function validateGist(input: RecordValue): void {
	if (!["gist-create", "gist-edit"].includes(input.kind as string)) return;
	if ((input.files as string[] | undefined)?.some(file => !publicFilename(basename(file)))) invalid();
	if (input.kind === "gist-edit" && !gistChanges(input)) invalid();
}
function validateChanges(input: RecordValue): void {
	validateEdit(input); validateGist(input);
	if (!["gist-create", "check"].includes(input.kind as string)) return;
	if ((input.files as unknown[]).length === 0) invalid();
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
	return value;
}
/** Returns a detached immutable request; failures never retain received values. */
export function validateRequest(value: unknown): PublishRequest {
	try {
		if (!record(value)) invalid();
		validateShape(value); validateBody(value); validateChanges(value);
		const encoded = JSON.stringify(value);
		if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) invalid();
		const detached = JSON.parse(encoded);
		validateShape(detached); validateBody(detached); validateChanges(detached);
		return freeze(detached) as PublishRequest;
	} catch { throw new InvalidRequest(); }
}

export interface PayloadSource { label: string; source: { text: string } | { file: string }; basename?: string }
export interface PayloadSlot { payload: number; use: "file" | "text"; prefix: string }
export interface OutboundText { label: string; text: string }
export interface GhPlan {
	argv: (string | PayloadSlot)[]; payloads: PayloadSource[]; outbound: OutboundText[];
	authority: { kind: PublishRequest["kind"]; ghArgs: string[]; repo?: string; number?: number; base?: string; head?: string };
	requestBytes: number;
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
		if (own(request, key)) { plan.argv.push(`--${flag}=${request[key]}`); plan.outbound.push({ label: key, text: request[key] as string }); }
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
		if (request.kind === "check") { plan.payloads.push(source); return; }
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
	if (family === "api") return ["api", request.endpoint as string, `--method=${request.method}`, "--hostname=github.com"];
	const argv = [family, action === "notes" ? "edit" : action];
	for (const key of ["number", "tag", "gistId"]) if (own(request, key)) argv.push(String(request[key]));
	for (const key of ["event", "strategy"]) if (own(request, key)) argv.push(`--${request[key]}`);
	return argv;
}
/** Payload slots are deliberately not source paths. Only the capture core can materialize them. */
export function toGhPlan(value: PublishRequest): GhPlan {
	const request = validateRequest(value) as unknown as RecordValue;
	const plan: GhPlan = { argv: command(request), payloads: [], outbound: [], requestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"), authority: {
		kind: request.kind as PublishRequest["kind"], ghArgs: [],
		...Object.fromEntries(["repo", "number", "base", "head"].filter(key => own(request, key)).map(key => [key, request[key]])),
	} };
	if (request.kind === "api") plan.outbound.push({ label: "endpoint", text: request.endpoint as string });
	for (const key of ["tag", "gistId"]) if (own(request, key)) plan.outbound.push({ label: key, text: request[key] as string });
	addOptions(request, plan); addBody(request, plan); addFiles(request, plan); addFields(request, plan);
	plan.authority.ghArgs = plan.argv.map(arg => typeof arg === "string" ? arg : `${arg.prefix}publication-payload`);
	return plan;
}

const cliScalars: Record<string, string> = Object.fromEntries(["repo", "number", "title", "body", "bodyFile", "base", "head", "event", "strategy", "subject", "matchHeadCommit", "reason", "tag", "target", "gistId", "description", "endpoint", "method"].map(key => [key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), key]));
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
		if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ kind: "help" });
		const result: RecordValue = { kind: argv[0] };
		for (let index = 1; index < argv.length;) index += cliOption({ result, argv, index });
		return validateRequest(result);
	} catch { throw new InvalidRequest(); }
}
