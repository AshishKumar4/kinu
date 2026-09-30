import { execFileSync } from 'node:child_process';

/**
 * The models a run measures unless `KINU_EVAL_MODELS` names others, each its own cohort: fast models off Workers AI,
 * the owner's choice for evals (2026-09-18, 09-19). The product default, GLM-5.3 on Workers AI, spent 26 to 66 minutes
 * a trial in the 2026-09-24 pilot (~100k output tokens at ~40 tok/s, 4-17% of it in 429 waits); Muse Spark spent 2 to
 * 6 (2026-09-30, `kinu-logs/evals-fast`). OpenRouter's Mercury 2.5 and Ling 3.0 Flash VL join once the eval accounts
 * hold an OpenRouter key.
 */
export const DEFAULT_MODELS: readonly [string, ...string[]] = ['opencode-go/muse-spark-1.3-contributor'];

/** The product as deployed, with no workspace setting changed. */
export const DEFAULT_ARM = 'product';

/** Trials per task, model and arm; a pass rate over fewer cannot separate a regression from noise. */
export const DEFAULT_TRIALS = 10;


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
  /** Trials per cohort in this run, numbered from 1. */
  readonly trials: number;
}

/** A positive integer from `env[name]`, or `fallback` when it is unset. */
function positiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? '';
  const value = raw === '' ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);

  return value;
}

/**
 * How many trials of a task run at once: all of them, unless `KINU_EVAL_CONCURRENCY` caps it for a provider that
 * cannot hold them. A trial waits on its provider, not on this machine. Muse Spark met no provider wait with 20 trials
 * at once (2026-09-26); Workers AI put all of 12 at once into 429 backoff (2026-09-24), so a run on it sets a cap.
 */
export function evalConcurrency(env: Env): number {
  return positiveInteger(env, 'KINU_EVAL_CONCURRENCY', Number.MAX_SAFE_INTEGER);
}

/** The cohorts one run measures, parsed before any trial spends inference. */
export function evalMatrix(env: Env, knownArms: readonly string[]): EvalMatrix {
  const [models = [], arms = []] = [env.KINU_EVAL_MODELS, env.KINU_EVAL_ARMS]
    .map((value) => (value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== ''));

  const unknown = arms.filter((arm) => !knownArms.includes(arm));

  if (unknown.length > 0) {
    throw new Error(`KINU_EVAL_ARMS names ${unknown.join(', ')}; the declared arms are ${knownArms.join(', ')}`);
  }

  return {
    models: models.length > 0 ? models : DEFAULT_MODELS,
    arms: arms.length > 0 ? arms : [DEFAULT_ARM],
    trials: positiveInteger(env, 'KINU_EVAL_TRIALS', DEFAULT_TRIALS),
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
