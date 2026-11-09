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
function paragraphs(markdown) {
  const out = [];
  let section = "preamble", inBlock = false, fence = false, current = null;
  const flush = () => { if (current) out.push(current); current = null; };
  for (const line of markdown.split("\n")) {
    if (/^<!-- pi-(?:setup|profile):[\w:-]+:start/.test(line)) { flush(); inBlock = true; continue; }
    if (/^<!-- pi-(?:setup|profile):[\w:-]+:end/.test(line)) { flush(); inBlock = false; continue; }
    if (inBlock) continue;
    if (/^\s*```/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) { if (line.trim()) out.push({ section, text: line.trim(), literal: true }); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { flush(); section = slug(heading[1]); continue; }
    if (!line.trim()) { flush(); continue; }
    if (isBullet(line) || !current) { flush(); current = { section, text: stripMarker(line).trim() }; }
    else current.text += " " + line.trim();
  }
  flush();
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

export function check(root) {
  const config = readJson(root, `${RULES_DIR}/config.json`);
  const baseline = readJson(root, `${RULES_DIR}/baseline.json`);
  const map = readJson(root, `${RULES_DIR}/map.json`, []);
  const errors = [], lost = [], files = new Map(), mapped = [], removed = [];
  const agentsPath = config.agents ?? "agent/AGENTS.md";
  const skillPath = (name) => `skills/${name}/SKILL.md`;
  const load = (rel) => {
    if (!files.has(rel)) files.set(rel, existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null);
    return files.get(rel);
  };
  if (load(agentsPath) === null) throw new Error(`missing ${agentsPath}`);
  const allowed = new Set([agentsPath, ...config.skills.map(skillPath)]);
  const corpus = new Map([...allowed].filter((p) => load(p) !== null).map((p) => [p, corpusOf(load(p))]));

  for (const name of config.skills) {
    const text = load(skillPath(name));
    if (text === null) { errors.push(`skill ${name}: ${skillPath(name)} is missing`); continue; }
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    if (!new RegExp(`^name:\\s*${name}\\s*$`, "m").test(fm) || !/^description:\s*\S/m.test(fm)) errors.push(`skill ${name}: invalid frontmatter (name/description)`);
    if (!load(agentsPath).includes(`\`${name}\``)) errors.push(`${agentsPath} does not name skill \`${name}\` (a moved procedure must not be orphaned)`);
  }

  const byId = new Map(baseline.map((u) => [u.id, u]));
  const entryFor = new Map();
  for (const entry of map) {
    for (const id of entry.ids ?? [entry.id]) {
      if (!byId.has(id)) errors.push(`map: id ${id} is not in the baseline`);
      else if (entryFor.has(id)) errors.push(`map: duplicate id ${id}`);
      else entryFor.set(id, entry);
    }
    if (!["reworded", "merged", "removed", "moved-core"].includes(entry.kind)) errors.push(`map: ${entry.id ?? entry.ids} has unknown kind ${entry.kind}`);
    if (!entry.reason) errors.push(`map: ${entry.id ?? entry.ids} needs a reason`);
    if (entry.kind !== "removed") {
      if (!allowed.has(entry.to)) errors.push(`map: ${entry.id ?? entry.ids} points to ${entry.to}, which is not ${agentsPath} or a configured skill`);
      else if (entry.kind !== "moved-core" && !corpus.get(entry.to)?.includes(normalize(entry.new ?? ""))) errors.push(`map: stale entry ${entry.id ?? entry.ids}: new text not found in ${entry.to}`);
    }
  }

  const pinnedSections = new Set(config.pinnedSections ?? []);
  const pinPattern = new RegExp(config.pinnedPattern ?? DEFAULT_PIN, "i");
  let exact = 0;
  const exactFiles = {};
  for (const unit of baseline) {
    const norm = normalize(unit.text);
    const pinned = pinnedSections.has(unit.section) || pinPattern.test(norm);
    const entry = entryFor.get(unit.id);
    if (entry) {
      if (entry.kind === "removed") { removed.push({ unit, entry }); continue; }
      if (!allowed.has(entry.to)) continue;
      if (entry.kind === "moved-core") {
        if (!corpus.get(entry.to)?.includes(norm)) errors.push(`map: moved-core ${unit.id} is not verbatim in ${entry.to}`);
      } else {
        const normNew = normalize(entry.new ?? ""), dropped = new Set((entry.droppedTokens ?? []).map(normalize));
        const missing = constraintTokens(unit.text).filter((t) => !hasToken(normNew, t) && !dropped.has(t));
        if (missing.length) errors.push(`map: ${unit.id} drops constraint token(s) [${missing.join(", ")}]; keep them or list droppedTokens with a reason`);
        if (pinned && entry.to !== agentsPath) errors.push(`map: pinned ${unit.id} reworded into ${entry.to}; keep it in ${agentsPath} or use kind moved-core with the verbatim text`);
      }
      mapped.push({ unit, entry });
      continue;
    }
    const where = [...corpus].find(([, text]) => text.includes(norm))?.[0];
    if (!where) { lost.push(unit); continue; }
    if (pinned && where !== agentsPath) { errors.push(`pinned ${unit.id} (${unit.section}) is only in ${where}; hard constraints stay in ${agentsPath} (or map it as moved-core with a reason)`); continue; }
    exact++;
    exactFiles[where] = (exactFiles[where] ?? 0) + 1;
  }

  const corpusUnits = [...corpus.keys()].flatMap((p) => splitUnits(load(p)).map((u) => ({ ...u, file: p })));
  const details = lost.map((unit) => ({ unit, hints: hints(unit, corpusUnits) }));
  const summary = `agents-rules: ${baseline.length} units, ${exact} exact, ${mapped.length} mapped, ${removed.length} removed, ${lost.length} lost`;
  return { ok: !errors.length && !lost.length, errors, lost: details, mapped, removed, exact, exactFiles, total: baseline.length, summary };
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
