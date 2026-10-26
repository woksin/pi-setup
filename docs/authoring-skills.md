# Authoring skills

Source for the skills this repository ships lives in top-level `skills/<name>/`.
The installer copies every file in those directories to `~/.agents/skills/<name>/`.
Edit the source here. Do not edit the installed copies. See `docs/skills-adoption.md`
for ownership and update direction, and `docs/skill-template.md` for a starting point.

## Descriptions are invocation hints

pi shows only the name and description to the model before it decides to load a
skill. So the description states **when to use the skill**, and nothing else.

- One task or invocation condition, starting `Use when ...` or `Use before ...`.
- No summary of what the skill does, no marketing, no tour of its options, no steps.
- Keep the words someone would actually use when they need it.
- Add a "Not for ..." sentence only for a real near miss, such as application
  performance versus machine performance. Do not add it as boilerplate.
- No arbitrary shortening. pi's own limits still apply: the name matches the
  directory, and the description is non-empty and at most 1024 characters.

What the skill can do, how it works, examples, safety rules and non-triggers go in
the body.

## Source, provenance and licences

- Keep adaptation history, upstream pins and decisions in `docs/skills-adoption.md`,
  not in the skill body.
- A skill that copies licensed material ships the full licence text in its own
  directory, as `skills/<name>/LICENSE`.
- Keep a skill self-contained. A reference to another skill does not grant that
  skill's authority, publication rights or watchers.

## Checks

`node --test tools/skills.test.mjs` parses every skill with pi's own frontmatter
parser and loader, compares each description with its reviewed snapshot, and checks
the routing cases in `tests/fixtures/skills/routing.json`. These guard format and
intent only. They do not prove a model will route correctly.

When you change a description, update the snapshot in the test and add or adjust a
routing case with a short rationale. A person reviews the intent.
