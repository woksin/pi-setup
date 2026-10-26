# Skill template

This file is an example, not a discoverable skill. To start a skill, copy the block
below to `skills/<name>/SKILL.md`. The name must equal the directory name.

```markdown
---
name: example-skill
description: Use when the user asks to rotate the example credentials.
---

# Example skill

What it does and how, in the body.

## Steps

1. The first step.
2. The next step.

## Safety

What the skill must never do, and who authorises what.

## Not for

Near misses worth naming, if any.
```

Rules for the description line:

- It is a condition for invocation: `Use when ...` or `Use before ...`.
- Leave out what the skill does, how it does it, and its options. Those belong in the body.
- Keep the provenance, upstream pins and licence notes out of the body. Record them in
  `docs/skills-adoption.md`, and ship any required licence as `skills/<name>/LICENSE`.

See `docs/authoring-skills.md`.
