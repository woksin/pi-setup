/** Atomic session-to-lane identity map, shared by the extension and CLI. */
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJson } from "./store.ts";

export const LANE_NAME_RE = /^[A-Z][A-Za-z0-9-]{1,15}$/;

export interface LaneRecord { lane: string; sessionId: string; setBy: string; at: string }

function laneFile(home: string, sessionId: string): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) throw new Error("invalid session id");
	return join(home, "lanes", `${sessionId}.json`);
}

export function setLane(home: string, sessionId: string, lane: string, setBy: string): void {
	if (!LANE_NAME_RE.test(lane)) throw new Error("invalid lane id: use 2-16 letters, digits or hyphens, starting with an uppercase letter");
	atomicWrite(laneFile(home, sessionId), { lane, sessionId, setBy, at: new Date().toISOString() });
}

export function clearLane(home: string, sessionId: string): void {
	try {
		unlinkSync(laneFile(home, sessionId));
	} catch (e: any) {
		if (e.code !== "ENOENT") throw e;
	}
}

export function mappedLane(home: string, sessionId: string): LaneRecord | undefined {
	try {
		const record = readJson<LaneRecord>(laneFile(home, sessionId));
		return record.sessionId === sessionId && LANE_NAME_RE.test(record.lane) ? record : undefined;
	} catch {
		return undefined;
	}
}

export function listLanes(home: string): LaneRecord[] {
	let names: string[];
	try {
		names = readdirSync(join(home, "lanes"));
	} catch (e: any) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
	return names.filter(f => f.endsWith(".json")).sort()
		.map(f => mappedLane(home, f.slice(0, -5))).filter((r): r is LaneRecord => !!r);
}
