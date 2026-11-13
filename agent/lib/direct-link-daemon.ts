// Accept means the person's own daemon accepted, not proof of a human click.
import { protocol } from "./direct-link-mcp.ts";
import type { Fetch } from "./direct-link-mcp.ts";
export interface Offer { offerId: string; workHandle: string; title: string; repository: string; harness: string; expiresAt: string; state: string }
export interface RunnerSession { session: string; workHandle: string; harness: string; state: string }
export interface PersonConfirmation { person: true }
export class DirectDaemon {
	#url: URL; #token: string; #fetch: Fetch;
	constructor(url: string, interfaceToken: string, fetch: Fetch) {
		try {
			const endpoint = new URL(url);
			if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.hostname !== protocol.daemonHost) throw new Error();
			if (endpoint.username || endpoint.password) throw new Error();
			this.#url = endpoint; this.#token = interfaceToken; this.#fetch = fetch;
		} catch { throw new Error("Direct daemon must use IPv4 loopback"); }
	}
	async #call<T>(path: string, body?: object): Promise<T> {
		try {
			const response = await this.#fetch(new URL(path, this.#url).href, {
				method: body === undefined ? "GET" : "POST", redirect: "error",
				headers: { "Content-Type": "application/json", [protocol.interfaceHeader]: this.#token },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (!response.ok || response.redirected) throw new Error();
			return await response.json() as T;
		} catch { throw new Error("Direct daemon request refused"); }
	}
	#offerPath(template: string, offerId: string): string { return template.replace("{offerId}", encodeURIComponent(offerId)); }
	listOffers(): Promise<Offer[]> { return this.#call(protocol.paths.offers); }
	accept(offerId: string, confirmation: PersonConfirmation): Promise<{ state: string }> {
		if (confirmation?.person !== true) return Promise.reject(new Error("Person confirmation required"));
		return this.#call(this.#offerPath(protocol.paths.accept, offerId), {});
	}
	decline(offerId: string, reason?: string): Promise<{ state: string }> {
		return this.#call(this.#offerPath(protocol.paths.decline, offerId), reason === undefined ? {} : { reason });
	}
	runnerState(): Promise<RunnerSession[]> { return this.#call(protocol.paths.sessions); }
}
