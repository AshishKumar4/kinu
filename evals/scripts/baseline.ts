// Pick the baseline for a candidate build from stored reports' builds, newest first:
//   bun evals/scripts/baseline.ts <candidate-sha> <sha>...
// Prints the first build that is an earlier build of this line of history (a strict ancestor of the
// candidate), or nothing. Several deploys a day and runs of hours mean the latest complete report
// of an ancestor is the baseline, not strictly the previous deploy.
import { spawnSync } from 'node:child_process';

const [candidate, ...stored] = process.argv.slice(2);

if (candidate === undefined) throw new Error('Usage: bun evals/scripts/baseline.ts <candidate-sha> <sha>...');

const baseline = stored.find((sha) => !candidate.startsWith(sha) && !sha.startsWith(candidate)
  && spawnSync('git', ['merge-base', '--is-ancestor', sha, candidate], { stdio: 'ignore' }).status === 0);

if (baseline !== undefined) process.stdout.write(`${baseline}\n`);
