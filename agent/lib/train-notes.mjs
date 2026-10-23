export const SECTIONS = ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security'];
const normalise = text => text.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim().toLowerCase();

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
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*#*$/);
    if (heading) setSection(state, heading[1]);
    else if (state.section) collectLine(state, line);
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
