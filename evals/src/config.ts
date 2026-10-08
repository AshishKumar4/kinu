import { execFileSync } from 'node:child_process';
import { accountCredentialKey, CHATGPT_CRED_KEY } from '@kinu.run/core';

/**
 * The models a run measures unless `KINU_EVAL_MODELS` names others: Muse Spark alone, the owner's choice (2026-10-02).
 * On 85a438698 it passed 8 of 12 tasks with its slowest trial at 16.1 minutes, while Mercury (0 of 12) and Ling (3 of
 * 12) held the pass for up to 135 minutes a trial.
 */
export const DEFAULT_MODELS: readonly [string, ...string[]] = [
  'opencode-go/muse-spark-1.3-contributor',
];

/**
 * The owner's ChatGPT Pro logins the reviewer runs on (2026-10-07), first to last, each the eval identity's own ChatGPT
 * sign-in on a deployment, asked of the owner only when the deployment lacks it (`evals/scripts/reviewer-sign-in.ts`).
 */
export const REVIEW_ACCOUNTS = ['ashishkmr472', 'aksnip4284'] as const;

export type ReviewAccount = (typeof REVIEW_ACCOUNTS)[number];

/** GPT 6.1 Sol through ChatGPT on one of {@link REVIEW_ACCOUNTS}, and the login it is served on: a menu names no account,
 *  so the spec is never listed, and it is the reviewer's once its login is held. */
export function reviewLogin(account: ReviewAccount) {
  return { spec: `chatgpt@${account}/gpt-6.1-sol`, key: accountCredentialKey(CHATGPT_CRED_KEY, account) } as const;
}

/**
 * GPT 6.1 Sol through the `openrouter.bearer` key every eval account holds (`scripts/eval-provider-keys.ts`, which
 * requires it listed): the reviewer's last resort, when neither ChatGPT login is held. Staging listed it on 2026-10-07.
 */
export const REVIEW_KEYED_MODEL = 'openrouter/openai/gpt-6.1-sol';

/**
 * The model that reads a run rather than being measured by it, the owner's choice (2026-10-07): the diagnosis, the
 * trajectory review and the judge of what no check computes. GPT 6.1 Sol, first choice first; a review runs on the
 * first its deployment lists for the eval identity, and falls back to the others it lists (`reviewerModels`).
 */
export const REVIEW_MODELS: readonly string[] = [...REVIEW_ACCOUNTS.map((account) => reviewLogin(account).spec), REVIEW_KEYED_MODEL];

/** A reviewer `KINU_EVAL_REVIEW_MODEL` names in place of {@link REVIEW_MODELS}, or null. */
export function reviewModelOverride(env: Env): string | null {
  const named = env.KINU_EVAL_REVIEW_MODEL?.trim() ?? '';

  return named === '' ? null : named;
}

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
