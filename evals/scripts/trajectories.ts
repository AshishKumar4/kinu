// Render a report's trials as Markdown for a reviewer:
//   bun evals/scripts/trajectories.ts <results.json> <out.md> [--failed]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { renderTrajectories } from '../src/trajectories';

const { values, positionals } = parseArgs({ options: { failed: { type: 'boolean' } }, allowPositionals: true });

const [input, output] = positionals;

if (input === undefined || output === undefined) throw new Error('Usage: bun evals/scripts/trajectories.ts <results.json> <out.md> [--failed]');

writeFileSync(output, renderTrajectories(readFileSync(input, 'utf8'), values.failed === true ? 'failed' : 'all'));

process.stdout.write(`Wrote ${output}\n`);
