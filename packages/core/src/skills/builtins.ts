/**
 * Built-in skills shipped with Kinu core. Discovered automatically and merged
 * with the workspace skills under `/workspace/skills/`.
 *
 * These names are RESERVED (KINU-N028): that directory is writable by the
 * agent's own file tool and shell, so a file there may not take a built-in's
 * name. Shadowing would replace shipped doctrine — including the
 * `allowed_tools` a built-in declares — by choosing a filename, and no owner
 * approval could make that the right answer, because the built-in would simply
 * be gone. `discoverSkills` refuses such a file and says why.
 *
 * Adding a built-in skill: write the SKILL.md inline as a template
 * string, parse it through `parseSkillFile(..., 'builtin')`, push the
 * result into `BUILTIN_SKILLS`. No magic, no decorators — just an array.
 */

import { parseSkillFile } from './parse';
import type { ParsedSkill } from './types';

// ── audit-implementation ─────────────────────────────────────────

const AUDIT_IMPLEMENTATION_SRC = `---
name: audit-implementation
description: Multi-head audit of your own recent implementation — correctness, security, ergonomics.
allowed-tools:
  - agents
  - memory
keywords: [audit, review, verify, double-check, audit-this, validate-implementation]
auto_activate: false
---

# Audit your implementation

You just shipped something — code, a refactor, a design — and want a
second opinion using the same search you use to explore problems. This
skill runs that audit.

## Procedure

1. Restate what you implemented in two or three sentences: the change,
   the user-facing effect, the files touched.

2. Call \`agents({ action: "swarm", preset: "ideate", branches: 4, task: <the whole audit brief> })\`.
   An audit wants distinct findings rather than a ranked winner, which is what
   \`ideate\` returns; the nodes write their own angles from \`task\`, so name the
   angles you want covered IN the task rather than as per-node briefs:

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
   - **simplicity** (optional, fourth angle) — is there code that doesn't
     earn its keep? Parallel paths? Compatibility shims? Apply the
     deletion test: would removing this and inlining the callsites
     produce clearer code?

3. Each node reports as evidence + a graded finding (P0–P3 or none-found), and
   the settled set comes back unranked. Synthesise it yourself into:

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
