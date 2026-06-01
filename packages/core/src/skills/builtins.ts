/**
 * Built-in skills shipped with Proteus core. Discovered automatically and
 * merged with any VFS-stored skills the agent has authored. VFS skills
 * shadow built-ins with the same name — the agent can override us.
 *
 * Adding a built-in skill: write the SKILL.md inline as a template
 * string, parse it through `parseSkillFile(..., 'builtin')`, push the
 * result into `BUILTIN_SKILLS`. No magic, no decorators — just an array.
 */

import { parseSkillFile } from './parse.js';
import type { ParsedSkill } from './types.js';

// ── audit-implementation ─────────────────────────────────────────

const AUDIT_IMPLEMENTATION_SRC = `---
name: audit-implementation
description: Multi-head audit of your own recent implementation — correctness, security, ergonomics.
allowed-tools:
  - think
  - memory
  - fact
keywords: [audit, review, verify, double-check, audit-this, validate-implementation]
auto_activate: false
---

# Audit your implementation

You just shipped something — code, a refactor, a design — and want a
second opinion using the same tree-search infrastructure you use to
explore problems. This skill runs that audit.

## Procedure

1. Restate what you implemented in two or three sentences: the change,
   the user-facing effect, the files touched.

2. Call \`think({ strategy: "heads", task: <audit task>, budget: 3-4 })\`
   with three or four heads, each scoped to a distinct angle:

   - **correctness** — does the implementation match the stated
     intent? Bugs, missing edge cases, unhandled errors, broken
     invariants? Walk every changed function.
   - **security** — threat-model anything that crosses a trust boundary
     in the change (user input, external API responses, file paths,
     shell args, deserialized payloads). Name attacks, then check
     whether the change prevents them.
   - **ergonomics / UX** — does the change leave the user with an
     interface that's discoverable and hard to misuse? For backend
     work: is the error path as good as the happy path? Does logging
     surface what the operator needs?
   - **simplicity** (optional, fourth head) — is there code that doesn't
     earn its keep? Parallel paths? Compatibility shims? Apply the
     deletion test: would removing this and inlining the callsites
     produce clearer code?

3. Each head reports as evidence + a graded finding (P0–P3 or
   none-found). The merge step synthesises into:

   - the top three findings ranked by severity
   - a one-line "ship / fix-first / abort" verdict
   - the smallest concrete change list that addresses every P0 + P1

4. If any P0 surfaces, do not claim the work is done — fix it before
   the next step. If everything is P2 or below, note them and proceed.

## Output

Reply with the synthesised report. Do not produce additional prose
beyond the findings + verdict + fix-list. The user wants the audit, not
a recap of what you implemented.
`;

// ── Catalogue ────────────────────────────────────────────────────

function parseBuiltin(src: string): ParsedSkill {
  const r = parseSkillFile(src, 'builtin');
  if (!r.ok) throw new Error(`built-in skill failed to parse: ${r.error}`);
  return r.skill;
}

export const BUILTIN_SKILLS: ReadonlyArray<ParsedSkill> = Object.freeze([
  parseBuiltin(AUDIT_IMPLEMENTATION_SRC),
]);
