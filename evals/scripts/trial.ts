// One native armada task: select one Vitest case, scrub evidence before upload, and use the ladder's artifact copier.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { ciVerdictRow } from '../../scripts/ladder';
import { selectTrialReport, TrialItemSchema } from '../../scripts/evals-artifacts';

const ROOT = join(import.meta.dirname, '../..');

async function main(): Promise<number> {
  const item = v.parse(TrialItemSchema, JSON.parse(process.env['ARMADA_ITEM'] ?? '{}'));
  const artifacts = process.env['ARMADA_ARTIFACTS'];

  if (artifacts === undefined) throw new Error('armada named no artifacts directory');

  // Containers pull successive tasks into the same checkout. Each task/attempt has a fresh directory;
  // no old result can stand for a task that failed before Vitest wrote its own report.
  const dir = join(ROOT, 'bench-artifacts', 'eval-tasks',
    `${process.env['ARMADA_INDEX'] ?? ''}-${process.env['ARMADA_ATTEMPT'] ?? ''}`);

  mkdirSync(dir, { recursive: true });

  const env = {
    ...process.env, KINU_EVAL_ORIGIN: item.origin, KINU_EVAL_TRIALS: String(item.trials),
    KINU_EVAL_MODELS: item.models.join(','), KINU_EVAL_ARMS: item.arms.join(','),
    KINU_EVAL_PASS: item.pass ? '1' : '0', KINU_EVAL_CONCURRENCY: '1', KINU_EVAL_FILES: '1',
    BENCH_ARTIFACTS: dir,
  };

  const title = `${item.model} | ${item.arm} | trial ${String(item.trial)}`;
  const pattern = `${title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`;
  const started = performance.now();

  const run = Bun.spawn([process.execPath, '--bun', 'vitest', 'run', '--config', 'evals/vitest.config.ts',
    `evals/tasks/${item.task}.eval.ts`, '-t', pattern, '--reporter=./evals/src/reporter.ts', '--reporter=json'],
  { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });

  const interrupt = (): void => { run.kill('SIGINT'); };

  const terminate = (): void => { run.kill('SIGTERM'); };

  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);

  const exitCode = await run.exited;

  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);

  try {
    const path = join(dir, 'results.json');
    const normalized = selectTrialReport(readFileSync(path, 'utf8'), item);

    writeFileSync(path, `${normalized}\n`);

    const scrub = Bun.spawn([process.execPath, 'evals/scripts/scrub-evidence.ts', dir],
      { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' });

    if (await scrub.exited !== 0) throw new Error('trial evidence could not be scrubbed before upload');

    const row = ciVerdictRow({ run: `${item.leg} ${item.task}: ${title}`, evidence: 'evals' },
      { exitCode, seconds: (performance.now() - started) / 1000, stdout: '', stderr: '' }, undefined,
      { dir, artifacts });

    writeFileSync(join(artifacts, 'row.json'), `${JSON.stringify(row)}\n`);

    // Failed assertions are measurements, not a missing task. The comparison decides the verdict.
    return 0;
  } catch (cause) {
    throw new Error(`${item.leg} ${item.task} trial ${String(item.trial)} left no usable artifacts (vitest exit ${String(exitCode)})`, { cause });
  }
}

if (import.meta.main) process.exitCode = await main();
