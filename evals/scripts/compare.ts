// Compare a candidate eval report with a baseline and write comparison.json and comparison.md:
//   bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out <dir>
// Without a baseline the report stands alone: every row is the candidate's, the verdict inconclusive.
// Cohorts are not compared when the eval definitions differ between the two reports' eval commits:
// a scorer change moves the goalposts without touching the product under test.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFINITION_PATHS, EXERCISED_PATHS } from '../src/config';
import { compareEvalResults, renderEvalComparison } from '../src/comparison';

const USAGE = 'Usage: bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out <dir>';

function git(args: readonly string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

  if (result.error !== undefined) throw new Error(`git ${args.join(' ')} could not start`, { cause: result.error });

  return { status: result.status ?? 1, stdout: result.stdout };
}

/** A baseline may predate a shallow checkout; fetch its commit on demand. */
function ensureCommit(sha: string): void {
  if (git(['cat-file', '-e', `${sha}^{commit}`]).status === 0) return;

  if (git(['fetch', '--no-tags', '--depth=1', 'origin', sha]).status !== 0) {
    throw new Error(`commit ${sha} is not in this checkout or on origin`);
  }
}

function definitionsChanged(baselineCommit: string, candidateCommit: string): boolean {
  ensureCommit(baselineCommit);
  ensureCommit(candidateCommit);
  const status = git(['diff', '--quiet', baselineCommit, candidateCommit, '--', ...DEFINITION_PATHS]).status;

  if (status > 1) throw new Error(`git diff ${baselineCommit} ${candidateCommit} exited with ${String(status)}`);

  return status === 1;
}

function changedFiles(baselineSha: string, candidateSha: string): string[] {
  ensureCommit(baselineSha);
  ensureCommit(candidateSha);
  const diff = git(['diff', '--name-only', baselineSha, candidateSha, '--', ...EXERCISED_PATHS]);

  if (diff.status !== 0) throw new Error(`git diff ${baselineSha} ${candidateSha} exited with ${String(diff.status)}`);

  return diff.stdout.split('\n').filter((line) => line !== '');
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
