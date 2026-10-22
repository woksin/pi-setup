import assert from "node:assert/strict";
import test from "node:test";
import { ask } from "../src/actions.ts";
import { candidates, linkTokens, score, tokens, WINDOW_DAYS } from "../src/dedup.ts";
import { validateDraft } from "../src/model.ts";
import { answerItem } from "../src/actions.ts";
import { asker, seed, tempDir } from "./helpers.ts";

const draft = (title: string, extra: Record<string, unknown> = {}) => validateDraft({ kind: "question", title, body: "", ...extra });

test("normalisation: case, punctuation, stopwords and crude stemming", () => {
	assert.deepEqual([...tokens("Should we ship the Releases, now?!")].sort(), ["now", "releas", "ship"].sort());
	assert.deepEqual([...tokens("Merging Pulls")], ["merg", "pull"]);
});

test("link tokens come from issue and PR URLs, owner/repo#n and bare #n", () => {
	const l = linkTokens("see https://github.com/Cratis/Chronicle/pull/12 and Cratis/Chronicle#13, also #14");
	assert.deepEqual([...l].sort(), ["#14", "cratis/chronicle#12", "cratis/chronicle#13"]);
});

test("same title with different case and punctuation is refused", t => {
	const home = tempDir(t);
	const a = seed(home, { title: "Release v2 now?" });
	const res = ask(home, draft("release V2, NOW!"), asker());
	assert.ok("refused" in res);
	assert.deepEqual(res.refused.candidates.map(c => c.item.id), [a.id]);
	assert.deepEqual(res.refused.missing, [a.id]);
});

test("a shared link plus a moderate overlap is refused; without the link it passes", t => {
	const home = tempDir(t);
	seed(home, { title: "Backport the retry fix to release branch", links: ["o/r#12"] });
	const mine = { title: "Backport retry fix", body: "", links: ["https://github.com/o/r/issues/12"], repo: "o/r" };
	const item = seed(tempDir(t), { title: "Backport the retry fix to release branch", links: ["o/r#12"] });
	assert.ok(score(mine, item) >= 0.5);
	assert.ok(score({ ...mine, links: [] }, item) < 0.7);
	assert.ok("refused" in ask(home, draft("Backport retry fix", { links: ["https://github.com/o/r/issues/12"] }), asker()));
});

test("unrelated titles pass", t => {
	const home = tempDir(t);
	seed(home, { title: "Release v2 now" });
	const res = ask(home, draft("Pick a database engine"), asker());
	assert.ok("ok" in res);
});

test("distinctFrom must cover every candidate and records them as related", t => {
	const home = tempDir(t);
	const first = ask(home, draft("Enable feature flag alpha"), asker());
	assert.ok("ok" in first);
	const second = ask(home, draft("Enable the feature flag alpha", { distinctFrom: [(first as any).ok.item.id] }), asker());
	assert.ok("ok" in second);
	assert.deepEqual((second as any).ok.item.related, [(first as any).ok.item.id]);
	assert.match((second as any).ok.item.history[0].text, /distinct from Q-1/);
	// A third near-copy must cover both candidates.
	const partial = ask(home, draft("Enable feature flag alpha now", { distinctFrom: ["Q-1"] }), asker());
	assert.ok("refused" in partial);
	assert.deepEqual(partial.refused.missing, ["Q-2"]);
	const full = ask(home, draft("Enable feature flag alpha now", { distinctFrom: ["Q-1", "q2"] }), asker());
	assert.ok("ok" in full);
});

test("decided items within 180 days come back with their answer; older ones do not", t => {
	const home = tempDir(t);
	const now = Date.now();
	const item = seed(home, { title: "Which license do we use", options: [{ key: "a", text: "MIT" }] }, {}, now - 100 * 86_400_000);
	answerItem(home, item.id, { kind: "user", sessionId: "u" }, { text: "MIT it is", by: "u", via: "command", option: "a" }, now - 100 * 86_400_000);
	const res = ask(home, draft("Which license do we use?"), asker(), now);
	assert.ok("refused" in res);
	assert.equal(res.refused.candidates[0].item.answer?.text, "MIT it is");
	assert.match((res as any).refused && JSON.stringify(res.refused.candidates[0].item.status), /decided/);
	const later = now + (WINDOW_DAYS - 100 + 1) * 86_400_000;
	assert.ok("ok" in ask(home, draft("Which license do we use?"), asker(), later));
});

test("scope: other repos are ignored, global items are compared; withdrawn items are ignored", t => {
	const home = tempDir(t);
	seed(home, { title: "Rotate the signing key" }, { repo: "other/repo" });
	assert.ok("ok" in ask(home, draft("Rotate the signing key"), asker()));
	const home2 = tempDir(t);
	ask(home2, draft("Rotate the signing key", { global: true }), asker());
	assert.ok("refused" in ask(home2, draft("Rotate the signing key"), asker()));
});

test("near misses (0.35 to 0.5) are reported, not refused", t => {
	const home = tempDir(t);
	const found = candidates([seed(tempDir(t), { title: "alpha beta gamma delta" })], { title: "alpha beta gamma epsilon zeta eta", body: "", links: [], repo: "o/r" }, Date.now());
	assert.equal(found.candidates.length, 0);
	assert.equal(found.nearMisses.length, 1);
	assert.ok(found.nearMisses[0].score >= 0.35 && found.nearMisses[0].score < 0.5);
});
