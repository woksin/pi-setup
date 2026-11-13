// Copyright (c) Cratis. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { DirectCredentials } from "./direct-link-credentials.ts";
import { containsCredential } from "./direct-link-workitem.ts";
import type { Artifact, Report } from "./direct-link-report.ts";
import { protocol } from "./direct-link-mcp.ts";
import type { Release, WorkState } from "./direct-link-mcp.ts";

// Deliberately do not inherit credentials, launch metadata, shell startup hooks, or loader options.
const CHILD_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "TERM", "COLORTERM", "TZ", "SystemRoot", "COMSPEC", "PATHEXT"]);
export function childEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(env).filter(([key]) => CHILD_KEYS.has(key) || /^LC_[A-Z_]+$/.test(key)));
}
export function maskDirect<T>(value: T, secrets: readonly string[]): T {
	if (typeof value === "string") {
		let text = value.replace(/dpat_[A-Za-z0-9_-]+/g, "[REDACTED:direct]");
		for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED:direct]");
		return text as T;
	}
	if (Array.isArray(value)) return value.map(item => maskDirect(item, secrets)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [maskDirect(key, secrets), maskDirect(item, secrets)])) as T;
	return value;
}
function strings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
	return [];
}
export function directToolDenied(input: unknown, cwd: string, credentials: DirectCredentials, protectedPaths: readonly string[]): boolean {
	const forbidden = (path: string) => {
		const expanded = path.startsWith("~/") ? resolve(process.env.HOME ?? "", path.slice(2)) : resolve(cwd, path);
		let canonical = expanded;
		try { canonical = realpathSync(expanded); } catch { /* Also guard literal paths that no longer exist. */ }
		return [expanded, canonical].some(p => credentials.isForbiddenSecretPath(p) || protectedPaths.includes(p));
	};
	return strings(input).some(text => {
		if (containsCredential(text) || credentials.secretsToMask().some(secret => text.includes(secret))) return true;
		if (/\bsecurity\s+(?:find|dump|export)|\b(?:printenv|env)\b|\bexport\s+-p\b|\bgh\s+pr\s+create\b/i.test(text)) return true;
		if (protectedPaths.some(path => text.includes(path))) return true;
		return [text, ...text.split(/[\s'"=;|&<>()[\]{}]+/)].filter(Boolean).some(forbidden);
	});
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function artifactFromResult(event: { isError?: boolean; details?: unknown }): Artifact | undefined {
	if (event.isError) return;
	const details = object(event.details);
	const source = object(details.directArtifact ?? details);
	const artifact: Artifact = {};
	for (const key of ["branch", "sha", "prUrl", "buildResult"] as const) {
		if (typeof source[key] === "string" && source[key].trim()) artifact[key] = source[key];
	}
	if (!Object.keys(artifact).length || containsCredential(artifact)) return;
	return artifact;
}
function reportFields(kind: unknown): string[] {
	if (kind === "progress") return ["plan", "completed", "note"];
	if (kind === "artifact") return ["branch", "sha", "prUrl", "buildResult"];
	return [];
}
function stringList(value: unknown): boolean {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}
function validField(key: string, value: unknown): boolean {
	if (value === undefined) return true;
	if (key === "plan" || key === "completed") return stringList(value);
	return typeof value === "string";
}
function allowedField(key: string, value: unknown, fields: string[]): boolean {
	return key === "kind" || (fields.includes(key) && validField(key, value));
}
export function parseReport(value: unknown): Report {
	const input = object(value);
	const fields = reportFields(input.kind);
	if (!fields.length) throw new Error("Invalid Direct report");
	if (containsCredential(input)) throw new Error("Invalid Direct report");
	if (!Object.entries(input).every(([key, item]) => allowedField(key, item, fields))) throw new Error("Invalid Direct report");
	return structuredClone(input) as unknown as Report;
}
export function parseSubmission(value: unknown): { report: Report; state?: WorkState; outcome?: Release["outcome"] } {
	const { state, outcome, ...facts } = object(value);
	if (state !== undefined && !protocol.states.includes(state as WorkState)) throw new Error("Invalid Direct state");
	if (outcome !== undefined && !protocol.outcomes.includes(outcome as Release["outcome"])) throw new Error("Invalid Direct outcome");
	return { report: parseReport(facts), state: state as WorkState | undefined, outcome: outcome as Release["outcome"] | undefined };
}
export function deliveryEvidence(artifact: Artifact): boolean {
	return !!artifact.branch?.trim() && /^[a-f0-9]{40,64}$/i.test(artifact.sha ?? "") && !!artifact.buildResult?.trim();
}
