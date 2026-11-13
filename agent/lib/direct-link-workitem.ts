// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

// Claim payload validation. Direct text is data, never session authority.
export interface LaunchInputs { workHandle: string; session: string; launchProof: string }
export function parseLaunchInputs(payload: unknown): LaunchInputs {
	try {
		const p = object(payload, ["workHandle", "session", "launchProof"]);
		const workHandle = text(p.workHandle); const session = text(p.session); const launchProof = text(p.launchProof);
		if ([workHandle, session, launchProof].some((value) => /\s/.test(value))) throw new Error();
		if (containsCredential({ workHandle, session })) throw new Error();
		return { workHandle, session, launchProof };
	} catch { throw new Error("Invalid Direct launch inputs"); }
}
export interface Untrusted<T> { readonly kind: "untrusted"; readonly value: T }
export interface Subject { repository: string; issue: string | number; workId: string; journeyId: string; stage: string }
export interface WorkItem {
	workHandle: string; claimId: string; epoch: number; leaseUntil: string; heartbeatEvery: number;
	subject: Subject; title: string; brief: Untrusted<string>; acceptanceCriteria: Untrusted<string[]>;
	baseBranch: string; suggestedBranch: string; gateNames: string[]; grantExpiresAt: string;
}
const CREDENTIAL = /dpat_[A-Za-z0-9_-]*|Bearer\s+\S*|ghp_[A-Za-z0-9_]*|github_pat_[A-Za-z0-9_]*|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|(?<![A-Za-z0-9+/])(?!(?:[0-9a-f]{64})(?=$|[^A-Za-z0-9+/]))[A-Za-z0-9+/]{64,}={0,2}(?=$|[^A-Za-z0-9+/])/i;
export function maskWorkCredentials(value: unknown, secrets: readonly string[] = []): unknown {
	if (typeof value === "string") {
		let text = value.replace(new RegExp(CREDENTIAL.source, "gi"), "[REDACTED:direct]");
		for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED:direct]");
		return text;
	}
	if (Array.isArray(value)) return value.map(item => maskWorkCredentials(item, secrets));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskWorkCredentials(item, secrets)]));
	return value;
}
const CREDENTIAL_FIELD = /token|password|secret|credential|authorization|private.?key|api.?key/i;
export function containsCredential(value: unknown): boolean {
	if (typeof value === "string") return CREDENTIAL.test(value);
	if (Array.isArray(value)) return value.some(containsCredential);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, item]) => CREDENTIAL_FIELD.test(key) || CREDENTIAL.test(key) || containsCredential(item));
}
export function renderUntrusted(value: Untrusted<unknown>): string {
	return "```untrusted-data\n" + JSON.stringify(value.value).replaceAll("`", "\\u0060") + "\n```";
}
function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	return !Array.isArray(value);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Invalid work payload");
	if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error("Unknown work payload field");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Invalid work payload text");
	return value;
}
function texts(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("Invalid work payload list");
	return value.map(text);
}
function future(value: unknown, now: number): string {
	const date = text(value);
	if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(date) || !(Date.parse(date) > now)) throw new Error("Expired or invalid work lifetime");
	return date;
}
function epoch(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid work epoch");
	return value as number;
}
function heartbeatInterval(value: unknown): number {
	if (typeof value !== "number") throw new Error("Invalid heartbeat interval");
	if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid heartbeat interval");
	return value;
}
function issueRef(value: unknown): string | number {
	if (typeof value !== "number") return text(value);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid work payload text");
	return value;
}
export function parseWorkItem(payload: unknown, now = Date.now()): WorkItem {
	const claim = object(maskWorkCredentials(payload), ["claimId", "epoch", "leaseUntil", "heartbeatEvery", "payload"]);
	const p = object(claim.payload, ["workHandle", "subject", "title", "brief", "acceptanceCriteria", "baseBranch", "suggestedBranch", "gateNames", "grantExpiresAt"]);
	const s = object(p.subject, ["repository", "issue", "workId", "journeyId", "stage"]);
	const issue = issueRef(s.issue);
	return {
		workHandle: text(p.workHandle), claimId: text(claim.claimId), epoch: epoch(claim.epoch),
		leaseUntil: future(claim.leaseUntil, now), heartbeatEvery: heartbeatInterval(claim.heartbeatEvery),
		subject: { repository: text(s.repository), issue, workId: text(s.workId), journeyId: text(s.journeyId), stage: text(s.stage) },
		title: text(p.title), brief: { kind: "untrusted", value: text(p.brief) },
		acceptanceCriteria: { kind: "untrusted", value: texts(p.acceptanceCriteria) },
		baseBranch: text(p.baseBranch), suggestedBranch: text(p.suggestedBranch), gateNames: texts(p.gateNames),
		grantExpiresAt: future(p.grantExpiresAt, now),
	};
}
