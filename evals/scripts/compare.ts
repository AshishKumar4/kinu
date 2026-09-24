// Compare a candidate eval report with a baseline and write comparison.json and comparison.md:
//   bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out <dir>
// Without a baseline the report stands alone: every row is the candidate's, the verdict inconclusive.
// Cohorts are not compared when the eval definitions differ between the two reports' eval commits:
// a scorer change moves the goalposts without touching the product under test.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFINITION_PATHS, EXERCISED_PATHS } from '../src/config';
import { compareEvalResults, renderEvalComparison } from '../src/comparison';
import { diffBetween, ensureCommit, git } from './git';

const USAGE = 'Usage: bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out <dir>';

function definitionsChanged(baselineCommit: string, candidateCommit: string): boolean {
  ensureCommit(baselineCommit);
  ensureCommit(candidateCommit);
  const status = git(['diff', '--quiet', baselineCommit, candidateCommit, '--', ...DEFINITION_PATHS]).status;

  if (status > 1) throw new Error(`git diff ${baselineCommit} ${candidateCommit} exited with ${String(status)}`);

  return status === 1;
}

function changedFiles(baselineSha: string, candidateSha: string): string[] {
  return diffBetween(baselineSha, candidateSha, { paths: EXERCISED_PATHS, names: true }).split('\n').filter((line) => line !== '');
}

const { values } = parseArgs({
  options: { candidate: { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' } },
});

if (values.candidate === undefined || values.out === undefined) throw new Error(USAGE);

const comparison = compareEvalResults(
  values.baseline === undefined ? null : readFileSync(values.baseline, 'utf8'),
  readFileSync(values.candidate, 'utf8'),
  { definitionsChanged, changedFiles },
);

mkdirSync(values.out, { recursive: true });

writeFileSync(join(values.out, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);

writeFileSync(join(values.out, 'comparison.md'), `${renderEvalComparison(comparison)}\n`);

process.stdout.write(`Compared ${String(comparison.rows.length)} cohorts: ${comparison.verdict}. Wrote ${values.out}/comparison.{json,md}\n`);
