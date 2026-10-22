import assert from "node:assert/strict";
import test from "node:test";
import { InputRing, matchQuote, RING_SIZE } from "../src/verbatim.ts";

test("an exact substring passes and returns the full input", () => {
	const ring = new InputRing();
	ring.push("Q-42: wait for the OAuth fix, then ship", "interactive");
	assert.equal(matchQuote(ring, "wait for the OAuth fix"), "Q-42: wait for the OAuth fix, then ship");
});

test("whitespace is normalised, case is not", () => {
	const ring = new InputRing();
	ring.push("use   option\n  B  please", "interactive");
	assert.ok(matchQuote(ring, "use option B please"));
	assert.ok(matchQuote(ring, "  option   B "));
	assert.equal(matchQuote(ring, "Use option B"), null);
});

test("input from extension and rpc sources is ignored", () => {
	const ring = new InputRing();
	ring.push("approved by L0", "extension");
	ring.push("approved by rpc", "rpc");
	assert.equal(ring.size, 0);
	assert.equal(matchQuote(ring, "approved"), null);
});

test("the ring keeps only the last 10 inputs", () => {
	const ring = new InputRing();
	for (let i = 0; i < 12; i++) ring.push(`item${String.fromCharCode(97 + i)}z here`, "interactive");
	assert.equal(ring.size, RING_SIZE);
	assert.equal(matchQuote(ring, "itemaz"), null);
	assert.equal(matchQuote(ring, "itembz"), null);
	assert.equal(matchQuote(ring, "itemcz"), "itemcz here");
	assert.equal(matchQuote(ring, "itemlz"), "itemlz here");
});

test("a quote shorter than two characters, or empty, never matches", () => {
	const ring = new InputRing();
	ring.push("y", "interactive");
	ring.push("yes please", "interactive");
	assert.equal(matchQuote(ring, "y"), null);
	assert.equal(matchQuote(ring, "   "), null);
	assert.ok(matchQuote(ring, "yes"));
});
