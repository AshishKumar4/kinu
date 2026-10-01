// Compare the baseline leg's eval report with the candidate's and write comparison.json, comparison.md and
// verdict.json:
//   bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out <dir>
//     [--trials <n>] [--candidate-build <sha>] [--baseline-build <sha>]
// The two legs ran at once with the same definitions, the candidate's, so they are compared as they stand. Without a
// baseline the candidate's report stands alone: every row is the candidate's, the verdict inconclusive. Cohorts are
// not compared when the eval definitions differ between the two reports' eval commits: a scorer change moves the
// goalposts without touching the product under test. verdict.json says whether the run stands as the candidate's
// verdict (`evalGateVerdict`), and why: a promote reads it. A leg is complete when it holds every task of this
// checkout's evals/tasks, every trial, no infrastructure failure, and only the build planned for it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_TRIALS, DEFINITION_PATHS, EXERCISED_PATHS } from '../src/config';
import { compareEvalResults, evalGateVerdict, renderEvalComparison, whyIncomplete } from '../src/comparison';
import { diffBetween, ensureCommit, git } from './git';

const USAGE = 'Usage: bun evals/scripts/compare.ts --candidate <results.json> [--baseline <results.json>] --out <dir> '
  + '[--trials <n>] [--candidate-build <sha>] [--baseline-build <sha>]';

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
  options: {
    candidate: { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' }, trials: { type: 'string' },
    'candidate-build': { type: 'string' }, 'baseline-build': { type: 'string' },
  },
});

if (values.candidate === undefined || values.out === undefined) throw new Error(USAGE);

const candidate = readFileSync(values.candidate, 'utf8');

const baseline = values.baseline === undefined ? null : readFileSync(values.baseline, 'utf8');

const trials = values.trials === undefined ? DEFAULT_TRIALS : Number(values.trials);

const taskFiles = readdirSync('evals/tasks').filter((name) => name.endsWith('.eval.ts'));

const comparison = compareEvalResults(baseline, candidate, { definitionsChanged, changedFiles });

const verdict = evalGateVerdict(comparison, {
  baseline: baseline === null ? null : whyIncomplete(baseline, { trials, taskFiles, build: values['baseline-build'] }),
  candidate: whyIncomplete(candidate, { trials, taskFiles, build: values['candidate-build'] }),
});

mkdirSync(values.out, { recursive: true });

writeFileSync(join(values.out, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);

writeFileSync(join(values.out, 'comparison.md'), `${renderEvalComparison(comparison)}\n`);

writeFileSync(join(values.out, 'verdict.json'), `${JSON.stringify(verdict)}\n`);

process.stdout.write(`Compared ${String(comparison.rows.length)} cohorts: ${comparison.verdict}. `
  + `The run ${verdict.pass ? 'stands' : 'does not stand'}: ${verdict.reason} Wrote ${values.out}/{comparison.json,comparison.md,verdict.json}\n`);
