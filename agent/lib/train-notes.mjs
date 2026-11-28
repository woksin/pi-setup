export const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'];
export const GENERATED_NOTES_MARKER = '<!-- pi-train:generated-notes -->';
const normalise = text => text.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();

function nextFence(fence, line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return fence;
  const [, delimiter, rest] = match;
  if (fence) return delimiter[0] === fence[0] && delimiter.length >= fence.length && !rest.trim() ? null : fence;
  return delimiter[0] === '`' && rest.includes('`') ? null : delimiter;
}

function withoutComments(state, line) {
  if (state.comment) {
    const end = line.indexOf('-->');
    if (end === -1) return '';
    line = line.slice(end + 3);
  }
  line = line.replace(/<!--.*?-->/g, '');
  const start = line.indexOf('<!--');
  state.comment = start !== -1;
  return state.comment ? line.slice(0, start) : line;
}

function* markdownLines(body) {
  const state = { comment: false };
  let fence = null, offset = 0;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, ''), start = offset;
    offset += raw.length + 1;
    const before = fence;
    if (!state.comment) fence = nextFence(fence, line);
    if (before || fence) { yield { fence }; continue; }
    const marker = /^ {0,3}</.test(line) && line.trimEnd().trimStart() === GENERATED_NOTES_MARKER;
    yield { text: withoutComments(state, line), start, marker };
  }
}

export function closeFence(summary) {
  let fence;
  for (const line of markdownLines(summary)) fence = line.fence;
  return fence ? `${summary}\n${fence}` : summary;
}

export function extractSummary(body, notes) {
  const text = body.trimEnd();
  // Older bodies had no marker. Remove only an exact generated suffix, not arbitrary human headings.
  const legacyStart = notes && (text === notes || text.endsWith(`\n\n${notes}`)) ? text.length - notes.length : -1;
  let legacyBoundary = false;
  for (const { marker, start } of markdownLines(text)) {
    if (marker) return text.slice(0, start);
    if (start === legacyStart) legacyBoundary = true;
  }
  return legacyBoundary ? text.slice(0, legacyStart) : text;
}

function flush(state) {
  const { bullet, section, group } = state;
  if (bullet && !/short statement of|^[-*]\s+none\.?\s*$/i.test(bullet)) {
    (state.notes[section] ??= []).push({ text: bullet, ...(group ? { group } : {}) });
  }
  state.bullet = null;
}

function setSection(state, heading) {
  flush(state);
  state.group = null;
  state.section = SECTIONS.find(name => name.toLowerCase() === heading.trim().toLowerCase());
  if (/^summary$/i.test(heading)) state.summaryDropped = true;
}

function collectLine(state, line) {
  const subgroup = line.match(/^###\s+(.+?)\s*#*$/);
  if (subgroup) { flush(state); state.group = subgroup[1]; return; }
  if (/^[-*]\s+/.test(line)) { flush(state); state.bullet = line.replace(/^\*\s+/, '- '); return; }
  if (state.bullet && /^\s+\S/.test(line)) { state.bullet += `\n${line}`; return; }
  if (line.trim()) flush(state);
}

export function extractBullets(body = '') {
  const state = { notes: {}, section: null, group: null, bullet: null, summaryDropped: false };
  for (const { text } of markdownLines(body)) {
    if (text === undefined) { flush(state); continue; }
    const heading = text.match(/^##\s+(.+?)\s*#*$/);
    if (heading) setSection(state, heading[1]);
    else if (state.section) collectLine(state, text);
  }
  flush(state);
  return { notes: state.notes, summaryDropped: state.summaryDropped };
}

export function copyBullets(target, extracted, from) {
  for (const section of SECTIONS) {
    const entries = target[section] ??= [];
    const known = new Set(entries.map(entry => normalise(entry.text)));
    for (const entry of extracted[section] ?? []) {
      const key = normalise(entry.text);
      if (known.has(key)) continue;
      entries.push({ ...entry, from });
      known.add(key);
    }
  }
}

export function renderNotes(notes) {
  return SECTIONS.filter(section => notes[section]?.length).map(section => {
    let group;
    const lines = notes[section].flatMap(entry => {
      const heading = entry.group && entry.group !== group ? [`### ${entry.group}`, ''] : [];
      group = entry.group;
      return [...heading, entry.text];
    });
    return `## ${section}\n\n${lines.join('\n')}`;
  }).join('\n\n');
}
