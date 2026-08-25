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
