import assert from "node:assert/strict";
import test from "node:test";
import { completeIds, parseAnswer, parseClose, parseDate, parseDecide, parseDefer, parseQ, parseQuestions } from "../src/commands.ts";
import { seed, tempDir } from "./helpers.ts";

const ok = (r: any) => {
	assert.ok("ok" in r, JSON.stringify(r));
	return r.ok;
};

test("/questions forms", () => {
	assert.deepEqual(ok(parseQuestions("")), { mode: "open" });
	assert.deepEqual(ok(parseQuestions(" all ")), { mode: "all" });
	assert.deepEqual(ok(parseQuestions("decided")), { mode: "decided" });
	assert.deepEqual(ok(parseQuestions("repo")), { mode: "repo" });
	assert.deepEqual(ok(parseQuestions("search oauth fix")), { mode: "search", terms: "oauth fix" });
	assert.ok("error" in parseQuestions("search"));
	assert.ok("error" in parseQuestions("bogus"));
});

test("/answer, /decide, /defer, /close accept 42, Q-42 and q42", () => {
	for (const id of ["42", "Q-42", "q42"]) {
		assert.deepEqual(ok(parseAnswer(`${id} wait for the fix`)), { id: "Q-42", op: "answer", text: "wait for the fix" });
	}
	assert.ok("error" in parseAnswer("42"));
	assert.ok("error" in parseAnswer("nope text"));
	assert.deepEqual(ok(parseDecide("7 B because cheaper")), { id: "Q-7", op: "decide", option: "B", text: "because cheaper" });
	assert.deepEqual(ok(parseDecide("7 2")), { id: "Q-7", op: "decide", option: "2", text: "" });
	assert.ok("error" in parseDecide("7"));
	assert.deepEqual(ok(parseClose("7")), { id: "Q-7", op: "close", text: "" });
	assert.deepEqual(ok(parseClose("7 not needed")), { id: "Q-7", op: "close", text: "not needed" });
});

test("/defer with and without a date", () => {
	const withDate = ok(parseDefer("3 2099-05-06 after launch"));
	assert.equal(withDate.until, parseDate("2099-05-06"));
	assert.equal(withDate.text, "after launch");
	assert.deepEqual(ok(parseDefer("3 later please")), { id: "Q-3", op: "defer", text: "later please" });
	assert.deepEqual(ok(parseDefer("3")), { id: "Q-3", op: "defer", text: "" });
	assert.ok("error" in parseDefer("3 2099-13-40"));
	assert.equal(parseDate("2099-02-30"), null);
});

test("/q forms", () => {
	assert.deepEqual(ok(parseQ("5")), { id: "Q-5", op: "show" });
	assert.deepEqual(ok(parseQ("5 reopen")), { id: "Q-5", op: "reopen" });
	assert.deepEqual(ok(parseQ("5 comment see the PR")), { id: "Q-5", op: "comment", text: "see the PR" });
	assert.deepEqual(ok(parseQ("5 answer yes")), { id: "Q-5", op: "answer", text: "yes" });
	assert.deepEqual(ok(parseQ("5 decide A why")), { id: "Q-5", op: "decide", option: "A", text: "why" });
	assert.equal(ok(parseQ("5 defer 2099-01-02")).op, "defer");
	assert.deepEqual(ok(parseQ("5 close")), { id: "Q-5", op: "close", text: "" });
	assert.ok("error" in parseQ("5 comment"));
	assert.ok("error" in parseQ("5 frobnicate"));
	assert.ok("error" in parseQ(""));
});

test("completion offers open ids only", t => {
	const home = tempDir(t);
	const a = seed(home, { title: "alpha topic" });
	seed(home, { title: "zebra matter" });
	const items = [a, { ...seed(tempDir(t), { title: "done thing" }), id: "Q-9", status: "closed" as const }];
	assert.deepEqual(completeIds(items, "")!.map(x => x.value), ["Q-1"]);
	assert.deepEqual(completeIds(items, "q1")!.map(x => x.value), ["Q-1"]);
	assert.equal(completeIds(items, "9"), null);
	assert.equal(completeIds(items, "1 more"), null);
});
