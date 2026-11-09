#!/usr/bin/env node
// Copyright (c) Woksin. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//
// Rule inventory for agent/AGENTS.md (woksin/pi-setup#158): proves every rule sentence of the frozen
// baseline is still present in AGENTS.md or a named skill. Exact text passes; a rewording must be an
// explicit, reviewed tools/agents-rules/map.json entry. Similarity is only ever printed as a hint.
//
// Usage: node tools/agents-rules.mjs [--check] [--report] [--root DIR]
//        node tools/agents-rules.mjs --init-baseline <old AGENTS.md> [--root DIR]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES_DIR = "tools/agents-rules";
const FORCE_WORDS = ["never", "must", "do not", "don't", "only", "always", "not", "no", "without", "at most", "at least", "before", "after", "unless", "except"];
const DEFAULT_PIN = "\\b(never|must|do not|secret|force|destructive|guard)";

export const normalize = (s) => s
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\*\*|`/g, "")
  .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim().toLowerCase();

export const slug = (s) => normalize(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const stripMarker = (line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
const isBullet = (line) => /^\s*(?:[-*+]|\d+\.)\s+/.test(line);

// Sentence boundary: . ! ? then whitespace then an uppercase/opening char. Abbreviations are protected.
function sentences(paragraph) {
  const guarded = paragraph.replace(/\b(e\.g|i\.e|etc|vs|cf)\.(\s)/gi, "$1\u0000$2");
  return guarded.split(/(?<=[.!?])\s+(?=[A-Z"'`*(\[<])/).map((s) => s.replace(/\u0000/g, ".").trim()).filter(Boolean);
}

// Splits markdown into [{section, text}] paragraphs, skipping headings and managed marker blocks.
const MARKER = /^<!-- pi-(?:setup|profile):[\w:-]+:(start|end)/;

function flushParagraph(st, out) {
  if (st.current) out.push(st.current);
  st.current = null;
}

// Handles marker, fence and heading lines. Returns "skip" (inside a managed block), "control" or "body".
function lineKind(st, line) {
  const marker = MARKER.exec(line);
  if (marker) { st.inBlock = marker[1] === "start"; return "control"; }
  if (st.inBlock) return "skip";
  if (/^\s*```/.test(line)) { st.fence = !st.fence; return "control"; }
  const heading = st.fence ? null : /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) { st.section = slug(heading[1]); return "control"; }
  return "body";
}

function addBodyLine(st, out, line) {
  if (st.fence) { if (line.trim()) out.push({ section: st.section, text: line.trim(), literal: true }); return; }
  if (!line.trim()) { flushParagraph(st, out); return; }
  if (isBullet(line) || !st.current) { flushParagraph(st, out); st.current = { section: st.section, text: stripMarker(line).trim() }; }
  else st.current.text += " " + line.trim();
}

function paragraphs(markdown) {
  const out = [], st = { section: "preamble", inBlock: false, fence: false, current: null };
  for (const line of markdown.split("\n")) {
    const kind = lineKind(st, line);
    if (kind === "control") flushParagraph(st, out);
    else if (kind === "body") addBodyLine(st, out, line);
  }
  flushParagraph(st, out);
  return out;
}

export function splitUnits(markdown) {
  const units = [], counts = {};
  for (const p of paragraphs(markdown)) {
    for (const text of p.literal ? [p.text] : sentences(p.text)) {
      const norm = normalize(text);
      if (!norm) continue;
      const n = counts[p.section] = (counts[p.section] ?? 0) + 1;
      units.push({ id: `${p.section}-${n}-${createHash("sha256").update(norm).digest("hex").slice(0, 8)}`, section: p.section, text });
    }
  }
  return units;
}

// Normalized corpus of one file: every line normalized and joined so sentences wrapped over lines still match.
const corpusOf = (markdown) => markdown.split("\n").map((l) => normalize(stripMarker(l).replace(/^#{1,6}\s+/, ""))).filter(Boolean).join(" ");

export function constraintTokens(raw) {
  const text = normalize(raw), tokens = new Set();
  for (const w of FORCE_WORDS) if (new RegExp(`(?<![\\w'])${w}(?![\\w'])`).test(text)) tokens.add(w);
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) tokens.add(m[0]);
  for (const m of raw.matchAll(/`([^`]+)`/g)) tokens.add(normalize(m[1]));
  for (const m of text.matchAll(/<[^>\s]+>/g)) tokens.add(m[0]);
  return [...tokens];
}
const hasToken = (normNew, token) => /^[a-z' ]+$/.test(token) ? new RegExp(`(?<![\\w'])${token}(?![\\w'])`).test(normNew) : normNew.includes(token);

const readJson = (root, rel, fallback) => {
  const path = join(root, rel);
  if (!existsSync(path)) { if (fallback !== undefined) return fallback; throw new Error(`missing ${rel}`); }
  return JSON.parse(readFileSync(path, "utf8"));
};

const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };

function hints(unit, corpusUnits) {
  const words = (s) => normalize(s).split(/[^a-z0-9<>']+/).filter((w) => w.length > 2);
  const mine = words(unit.text);
  return corpusUnits.map((c) => ({ c, score: jaccard(mine, words(c.text)) })).sort((a, b) => b.score - a.score).slice(0, 3);
}

const skillPath = (name) => `skills/${name}/SKILL.md`;
const label = (entry) => entry.id ?? entry.ids;

function loadContext(root) {
  const config = readJson(root, `${RULES_DIR}/config.json`);
  const files = new Map();
  const load = (rel) => {
    if (!files.has(rel)) files.set(rel, existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null);
    return files.get(rel);
  };
  const agentsPath = config.agents ?? "agent/AGENTS.md";
  if (load(agentsPath) === null) throw new Error(`missing ${agentsPath}`);
  const allowed = new Set([agentsPath, ...config.skills.map(skillPath)]);
  const corpus = new Map([...allowed].filter((p) => load(p) !== null).map((p) => [p, corpusOf(load(p))]));
  return {
    config, load, agentsPath, allowed, corpus, errors: [],
    baseline: readJson(root, `${RULES_DIR}/baseline.json`),
    map: readJson(root, `${RULES_DIR}/map.json`, []),
  };
}

function checkSkill(ctx, name) {
  const text = ctx.load(skillPath(name));
  if (text === null) { ctx.errors.push(`skill ${name}: ${skillPath(name)} is missing`); return; }
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  if (!new RegExp(`^name:\\s*${name}\\s*$`, "m").test(fm) || !/^description:\s*\S/m.test(fm)) ctx.errors.push(`skill ${name}: invalid frontmatter (name/description)`);
  if (!ctx.load(ctx.agentsPath).includes(`\`${name}\``)) ctx.errors.push(`${ctx.agentsPath} does not name skill \`${name}\` (a moved procedure must not be orphaned)`);
}

function validateEntry(ctx, entry) {
  const { errors, allowed, corpus, agentsPath } = ctx;
  if (!["reworded", "merged", "removed", "moved-core"].includes(entry.kind)) errors.push(`map: ${label(entry)} has unknown kind ${entry.kind}`);
  if (!entry.reason) errors.push(`map: ${label(entry)} needs a reason`);
  if (entry.kind === "removed") return;
  if (!allowed.has(entry.to)) errors.push(`map: ${label(entry)} points to ${entry.to}, which is not ${agentsPath} or a configured skill`);
  else if (entry.kind !== "moved-core" && !corpus.get(entry.to)?.includes(normalize(entry.new ?? ""))) errors.push(`map: stale entry ${label(entry)}: new text not found in ${entry.to}`);
}

// Validates every map entry and returns Map<unit id, entry>.
function indexMap(ctx) {
  const known = new Set(ctx.baseline.map((u) => u.id)), entryFor = new Map();
  for (const entry of ctx.map) {
    for (const id of entry.ids ?? [entry.id]) {
      if (!known.has(id)) ctx.errors.push(`map: id ${id} is not in the baseline`);
      else if (entryFor.has(id)) ctx.errors.push(`map: duplicate id ${id}`);
      else entryFor.set(id, entry);
    }
    validateEntry(ctx, entry);
  }
  return entryFor;
}

// Verifies a mapped unit; returns true when it counts as mapped.
function verifyMapped(ctx, unit, entry, pinned) {
  const { errors, corpus, agentsPath } = ctx;
  if (!ctx.allowed.has(entry.to)) return false;
  if (entry.kind === "moved-core") {
    if (!corpus.get(entry.to)?.includes(normalize(unit.text))) errors.push(`map: moved-core ${unit.id} is not verbatim in ${entry.to}`);
    return true;
  }
  const normNew = normalize(entry.new ?? ""), dropped = new Set((entry.droppedTokens ?? []).map(normalize));
  const missing = constraintTokens(unit.text).filter((t) => !hasToken(normNew, t) && !dropped.has(t));
  if (missing.length) errors.push(`map: ${unit.id} drops constraint token(s) [${missing.join(", ")}]; keep them or list droppedTokens with a reason`);
  if (pinned && entry.to !== agentsPath) errors.push(`map: pinned ${unit.id} reworded into ${entry.to}; keep it in ${agentsPath} or use kind moved-core with the verbatim text`);
  return true;
}

function isPinned(config, unit) {
  const pattern = new RegExp(config.pinnedPattern ?? DEFAULT_PIN, "i");
  return (config.pinnedSections ?? []).includes(unit.section) || pattern.test(normalize(unit.text));
}

// Classifies one baseline unit into the tally: mapped, removed, lost or exact (with its file).
function classifyUnit(ctx, unit, entry, tally) {
  if (entry?.kind === "removed") { tally.removed.push({ unit, entry }); return; }
  const pinned = isPinned(ctx.config, unit);
  if (entry) {
    if (verifyMapped(ctx, unit, entry, pinned)) tally.mapped.push({ unit, entry });
    return;
  }
  const norm = normalize(unit.text);
  const where = [...ctx.corpus].find(([, text]) => text.includes(norm))?.[0];
  if (!where) tally.lost.push(unit);
  else if (pinned && where !== ctx.agentsPath) ctx.errors.push(`pinned ${unit.id} (${unit.section}) is only in ${where}; hard constraints stay in ${ctx.agentsPath} (or map it as moved-core with a reason)`);
  else { tally.exact++; tally.exactFiles[where] = (tally.exactFiles[where] ?? 0) + 1; }
}

export function check(root) {
  const ctx = loadContext(root);
  ctx.config.skills.forEach((name) => checkSkill(ctx, name));
  const entryFor = indexMap(ctx);
  const tally = { lost: [], mapped: [], removed: [], exact: 0, exactFiles: {} };
  for (const unit of ctx.baseline) classifyUnit(ctx, unit, entryFor.get(unit.id), tally);

  const corpusUnits = [...ctx.corpus.keys()].flatMap((p) => splitUnits(ctx.load(p)).map((u) => ({ ...u, file: p })));
  const lost = tally.lost.map((unit) => ({ unit, hints: hints(unit, corpusUnits) }));
  const { mapped, removed, exact, exactFiles } = tally;
  const summary = `agents-rules: ${ctx.baseline.length} units, ${exact} exact, ${mapped.length} mapped, ${removed.length} removed, ${lost.length} lost`;
  return { ok: !ctx.errors.length && !lost.length, errors: ctx.errors, lost, mapped, removed, exact, exactFiles, total: ctx.baseline.length, summary };
}

function printResult(result, report) {
  for (const e of result.errors) console.error(`error: ${e}`);
  for (const { unit, hints: h } of result.lost) {
    console.error(`lost: ${unit.id}\n  ${unit.text}\n  nearest (hint only):`);
    for (const { c, score } of h) console.error(`   - ${score.toFixed(2)} ${c.file}: ${c.text.slice(0, 140)}`);
    console.error(`  stub: ${JSON.stringify({ ids: [unit.id], kind: "reworded", to: "agent/AGENTS.md", new: "", reason: "" })}`);
  }
  if (report) {
    for (const [file, n] of Object.entries(result.exactFiles)) console.log(`exact in ${file}: ${n}`);
    for (const { unit, entry } of result.mapped) console.log(`mapped ${entry.kind} ${unit.id} -> ${entry.to}: ${entry.reason}`);
    for (const { unit, entry } of result.removed) console.log(`REMOVED ${unit.id}: ${entry.reason}\n  ${unit.text}`);
  }
  (result.ok ? console.log : console.error)(result.summary);
}

const USAGE = `Usage: node tools/agents-rules.mjs [--check] [--report] [--root DIR]
       node tools/agents-rules.mjs --init-baseline <old AGENTS.md> [--root DIR]
Proves every rule sentence of the frozen baseline is still in agent/AGENTS.md or a listed skill.
Exit codes: 0 no rule lost, 1 lost or unverified rule, 2 usage or file error.`;

function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) { console.log(USAGE); return 0; }
  const root = argv.includes("--root") ? resolve(argv[argv.indexOf("--root") + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const init = argv.indexOf("--init-baseline");
  if (init >= 0) {
    const units = splitUnits(readFileSync(argv[init + 1], "utf8"));
    const out = join(root, RULES_DIR, "baseline.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(units, null, 1) + "\n");
    console.log(`agents-rules: wrote ${units.length} units to ${out}`);
    return 0;
  }
  const result = check(root);
  printResult(result, argv.includes("--report"));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`agents-rules: ${e.message}`); process.exitCode = 2; }
}
