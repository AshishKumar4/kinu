import { execFileSync } from 'node:child_process';
import { accountCredentialKey, CHATGPT_CRED_KEY, EVAL_TRIAL_ACCOUNTS } from '@kinu.run/core';

/**
 * The models a run measures unless `KINU_EVAL_MODELS` names others: Muse Spark alone, the owner's choice (2026-10-02).
 * On 85a438698 it passed 8 of 12 tasks with its slowest trial at 16.1 minutes, while Mercury (0 of 12) and Ling (3 of
 * 12) held the pass for up to 135 minutes a trial.
 */
export const DEFAULT_MODELS: readonly [string, ...string[]] = [
  'opencode-go/muse-spark-1.3-contributor',
];

const REVIEW_ACCOUNT = 'ashishkmr472';

/**
 * The model that reads a run rather than being measured by it: the diagnosis, the trajectory review and the judge of
 * what no check computes. GPT 6.1 Sol through ChatGPT on the owner's one Pro login (the owner, 2026-10-08), the eval
 * identity's own sign-in on a deployment (`evals/scripts/reviewer-sign-in.ts`), served once `key` is held: a menu names
 * no account, so `spec` is never listed. Without it a review fails; no paid route stands in.
 */
export const REVIEW_LOGIN = {
  account: REVIEW_ACCOUNT,
  spec: `chatgpt@${REVIEW_ACCOUNT}/gpt-6.1-sol`,
  key: accountCredentialKey(CHATGPT_CRED_KEY, REVIEW_ACCOUNT),
} as const;

/** A reviewer `KINU_EVAL_REVIEW_MODEL` names in place of {@link REVIEW_LOGIN}, or null. */
export function reviewModelOverride(env: Env): string | null {
  const named = env.KINU_EVAL_REVIEW_MODEL?.trim() ?? '';

  return named === '' ? null : named;
}

/** The product as deployed, with no workspace setting changed. */
export const DEFAULT_ARM = 'product';

/**
 * Trials per task, model and arm. Five is the fewest at which the exact test calls a fall in one task at all
 * (`canTellAFall`, src/comparison.ts): 5/5 to 1/5 is p = 0.048 and a collapse to 0/5 always regresses, while 5/5 to
 * 2/5 (p = 0.17) reads as unchanged. At three no fall but a collapse can be told from noise, and the verdict says
 * inconclusive. Seven tasks of parts, five trials each, one trial of each task at a time: seven trials at once on a
 * leg, as the ten of the eighteen tasks before them were.
 */
export const DEFAULT_TRIALS = 5;


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
  /** The run's first trial account: {@link PASS_FIRST_SLOT} for a deploy's pass, else 1. */
  readonly firstSlot: number;
}

/** A positive integer from `env[name]`, or `fallback` when it is unset. */
function positiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? '';
  const value = raw === '' ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);

  return value;
}

/** Project load ceiling on the one opencode-go bearer shared by both deployments' trial accounts.
 * Twenty requests were measured clean on 2026-09-26 (93b6c02f1); the 340-trial burst in run
 * 37726316713 was refused 429. This is a shared-key scheduling ceiling, not an advertised per-key
 * provider quota: OpenCode Go publishes usage windows, not a concurrency limit. Splitting Kinu
 * trial accounts or running both deployments does not give their common bearer another budget. */
export const MUSE_CALLS_AT_ONCE = 20;

/** Observed trial fan-out: about one request per agent, up to six during swarm work (owner, 2026-10-09).
 * Reserve the peak for every trial, including coding's review swarm and hired agents, rather than
 * averaging task weights or relying on queue order. The map has three containers: 3 * 6 = 18 <= 20. */
export const EVAL_TRIAL_CALLS = 6;

export const EVAL_MAP_POOL = Math.floor(MUSE_CALLS_AT_ONCE / EVAL_TRIAL_CALLS);

/** Infrastructure ceiling only: armada f8725d7 worker/src/job.ts JOB_DEADLINE_MS is six hours.
 * Its protocol has no timeout maximum; do not confuse the retracted client `timeout 2400` probe
 * with a platform wall. Harness silence still decides a hang, never elapsed trial time. */
export const EVAL_TASK_TIMEOUT_SECONDS = 6 * 60 * 60;

/**
 * How many trials of a task run at once: all of them, unless `KINU_EVAL_CONCURRENCY` caps it for a provider that
 * cannot hold them. A trial waits on its provider, not on this machine. Muse Spark met no provider wait with 20 trials
 * at once (2026-09-26); Workers AI put all of 12 at once into 429 backoff (2026-09-24), so a run on it sets a cap.
 */
export function evalConcurrency(env: Env): number {
  return positiveInteger(env, 'KINU_EVAL_CONCURRENCY', Number.MAX_SAFE_INTEGER);
}

/** How many task files run at once: all of them, unless `KINU_EVAL_FILES` caps it for the same reason. */
export function evalFiles(env: Env): number {
  return positiveInteger(env, 'KINU_EVAL_FILES', Number.MAX_SAFE_INTEGER);
}

/** A deploy's one-trial pass (`KINU_EVAL_PASS=1`) runs beside the measured run on one deployment, so it takes the upper
 *  half of the trial accounts and the measured run the lower: no two runs share an account. */
export const PASS_FIRST_SLOT = EVAL_TRIAL_ACCOUNTS / 2 + 1;

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
    firstSlot: env.KINU_EVAL_PASS === '1' ? PASS_FIRST_SLOT : 1,
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
