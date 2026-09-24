// Refuse a report that cannot be a baseline, and print each task's wall time:
//   bun evals/scripts/validate.ts <results.json> [--trials <n>]
// A baseline holds every task, the full trial count per cohort, one build, and no infrastructure failure.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_TRIALS } from '../src/config';
import { validateEvalResults } from '../src/comparison';

const { values, positionals } = parseArgs({ options: { trials: { type: 'string' } }, allowPositionals: true });

const [path] = positionals;

if (path === undefined) throw new Error('Usage: bun evals/scripts/validate.ts <results.json> [--trials <n>]');

const walls = validateEvalResults(readFileSync(path, 'utf8'), values.trials === undefined ? DEFAULT_TRIALS : Number(values.trials));

for (const { taskId, slowestTrialMs } of walls) {
  process.stdout.write(`${taskId}: slowest trial ${(slowestTrialMs / 60_000).toFixed(1)} min\n`);
}

process.stdout.write(`${path} is a complete baseline.\n`);
