/**
 * Freeze the system prompt, surface by surface.
 *
 * Writes `packages/core/tests/fixtures/prompt-golden.json` from the matrix in
 * `packages/core/tests/fixtures/prompt-surface-matrix.ts`, which
 * `unit-prompt-sections.test.ts` reads back. The fixture is what the builder
 * rendered before its prose moved into `prompting/section-templates.ts`, so it
 * is the evidence that the move changed representation and nothing else.
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
