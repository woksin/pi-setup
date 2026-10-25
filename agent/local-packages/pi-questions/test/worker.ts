// Child process for concurrency tests: node test/worker.ts create|comment <home> <count> <tag|id>
import { ask, commentItem } from "../src/actions.ts";
import { validateDraft } from "../src/model.ts";
import { RESEARCH } from "./helpers.ts";

const [mode, home, count, tag] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
	if (mode === "create") {
		const res = ask(home, validateDraft({ ...RESEARCH, kind: "question", title: `aa${tag}k${i} bb${tag}k${i} cc${tag}k${i}`, body: "" }), { sessionId: `w${tag}`, cwd: "/tmp", repo: null, pid: process.pid });
		if ("refused" in res) throw new Error("unexpected refusal");
	} else {
		commentItem(home, tag, { kind: "agent", sessionId: `w${process.pid}` }, `c${i}`);
	}
}
