import { execFileSync } from 'node:child_process';

/**
 * The model published baselines are measured on: the product default on kinu.run, so a baseline
 * measures what a user gets. `KINU_EVAL_MODELS` adds others; each is its own cohort.
 */
export const DEFAULT_MODEL = 'workers-ai/@cf/zai-org/glm-5.3';

/** The product as deployed, with no workspace setting changed. */
export const DEFAULT_ARM = 'product';

/** Trials per task, model and arm; a pass rate over fewer cannot separate a regression from noise. */
export const DEFAULT_TRIALS = 10;

/**
 * Trials a run holds at once. Every trial shares the eval account's Workers AI rate limit with every
 * other eval-service run, so trials past what it sustains only add 429 waits: on 2026-09-24, twelve
 * at once all sat in 429 backoff with no model step done after two minutes. `KINU_EVAL_CONCURRENCY`
 * overrides it; task files run one at a time.
 */
export const DEFAULT_CONCURRENCY = 3;

/** The paths whose changes can move an eval result; a change elsewhere is not named in the report. */
export const EXERCISED_PATHS: readonly string[] = [
  'packages/core/src/', 'packages/cf-backend/src/', 'packages/agent-core/', 'packages/agent-utils/src/',
  'packages/compaction/src/',
];

/** The eval definitions: a change here moves the goalposts, so cohorts across it are not compared. */
export const DEFINITION_PATHS: readonly string[] = ['evals/'];

const GIT_SHA = /^[0-9a-f]{7,40}$/;

type Env = Record<string, string | undefined>;

export interface EvalMatrix {
  readonly models: readonly string[];
  readonly arms: readonly string[];
  readonly trials: number;
}

/** How many trials run at once, from `KINU_EVAL_CONCURRENCY`. */
export function evalConcurrency(env: Env): number {
  const raw = env.KINU_EVAL_CONCURRENCY?.trim() ?? '';
  const concurrency = raw === '' ? DEFAULT_CONCURRENCY : Number(raw);

  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('KINU_EVAL_CONCURRENCY must be a positive integer');

  return concurrency;
}

/** The cohorts one run measures, parsed before any trial spends inference. */
export function evalMatrix(env: Env, knownArms: readonly string[]): EvalMatrix {
  const [models = [], arms = []] = [env.KINU_EVAL_MODELS, env.KINU_EVAL_ARMS]
    .map((value) => (value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== ''));

  const unknown = arms.filter((arm) => !knownArms.includes(arm));

  if (unknown.length > 0) {
    throw new Error(`KINU_EVAL_ARMS names ${unknown.join(', ')}; the declared arms are ${knownArms.join(', ')}`);
  }

  const raw = env.KINU_EVAL_TRIALS?.trim();
  const trials = raw === undefined || raw === '' ? DEFAULT_TRIALS : Number(raw);

  if (!Number.isInteger(trials) || trials < 1) throw new Error('KINU_EVAL_TRIALS must be a positive integer');

  return {
    models: models.length > 0 ? models : [DEFAULT_MODEL],
    arms: arms.length > 0 ? arms : [DEFAULT_ARM],
    trials,
  };
}

/**
 * The commit that supplied the task definitions. A local run with uncommitted changes under
 * `evals/` would publish results nobody can reproduce, so it must name a commit explicitly.
 */
export function evalCommit(env: Env): string {
  const named = [env.KINU_EVAL_COMMIT, env.GITHUB_SHA].map((value) => value?.trim() ?? '').find((value) => value !== '');

  if (named === undefined) {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...DEFINITION_PATHS], { encoding: 'utf8' });

    if (dirty.trim() !== '') {
      throw new Error('evals/ has uncommitted changes: commit them, or set KINU_EVAL_COMMIT to the commit '
        + 'these definitions will be compared under');
    }

    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }

  if (!GIT_SHA.test(named)) throw new Error(`KINU_EVAL_COMMIT must be a git sha, not ${named}`);

  return named;
}
