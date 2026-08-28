/**
 * Freeze the system prompt, surface by surface.
 *
 * Writes `packages/core/tests/fixtures/prompt-golden.json` from the matrix in
 * `packages/core/tests/fixtures/prompt-surface-matrix.ts`, which
 * `unit-prompt-sections.test.ts` reads back. The fixture is the last DELIBERATE
 * rendering of every surface: the baseline any later source edit is compared
 * against, byte for byte.
 *
 * It was originally the pre-sectionisation builder's output, held to prove that
 * move changed representation only. It was re-cut on 2026-08-25 by a measured
 * slimming pass (135,116 → 120,952 bytes over 27 surfaces, −10.5%), which
 * retires that particular claim and leaves the drift gate intact.
 *
 * Re-cut again on 2026-08-27 for the `llm.query` → `rlm.query` namespace cutover
 * and the `contextRef` channel it added (120,952 → 121,454 bytes over the same 27
 * surfaces, +502). Three surfaces moved, and only the two RLM lines inside them.
 *
 * Re-cut again on 2026-08-27 for KINU-N028 instruction trust (121,454 → 121,955
 * over the same 27 surfaces, +501). One surface moved, `cf-full-surface`, which
 * now carries an unapproved workspace file beside its approved one: it gains the
 * `## Workspace instruction files` rule that governs the sealed block those
 * bytes ride in, and the skills index says an authored skill is reference
 * material until the owner approves it. No instruction content moved tier.
 *
 * Re-cut again on 2026-08-28 for the `rlm.query` → `agents.ask({role})` cutover:
 * the standalone recursive-LM namespace is gone and the delegation ladder gained
 * a third rung — one temporary full agent per question, with `context_ref` for
 * material it reads itself (121,955 → 125,938 bytes, +3,983). The surface COUNT
 * moved too, 27 → 28: `code-execution-with-rlm` / `-without-rlm` became
 * `code-execution-with-temporary-ask` / `-without-temporary-ask`, and
 * `delegation-temporary-ask` is new — a surface that carries the rung's own
 * bullets, which nothing else in the matrix rendered. Every surface that renders
 * the delegation ladder or the code-execution section moved; `unit-prompt-sections`
 * raised its matrix ceiling to 127,200 in the same change, with the reason.
 *
 * Run this ONLY when a prompt change is the intended change, and say so in the
 * commit. Regenerating it to quiet a red test erases the only record of what the
 * model used to read.
 *
 *   bun run scripts/prompt-golden.ts
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPromptSync } from '../packages/core/src/prompt';
import { PROMPT_MATRIX } from '../packages/core/tests/fixtures/prompt-surface-matrix';
import { createTestRuntime } from '../packages/test-utils/src/runtime';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'packages', 'core', 'tests', 'fixtures', 'prompt-golden.json');

const { rt } = createTestRuntime();
const golden: Record<string, string> = {};
for (const testCase of PROMPT_MATRIX) {
  if (golden[testCase.name] !== undefined) {
    throw new Error(`duplicate matrix case name: ${testCase.name}`);
  }
  golden[testCase.name] = buildSystemPromptSync(rt, testCase.opts);
}

writeFileSync(target, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');
const bytes = Object.values(golden).reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
process.stdout.write(
  `prompt-golden: ${String(PROMPT_MATRIX.length)} surfaces, ${String(bytes)} prompt bytes total\n`,
);
