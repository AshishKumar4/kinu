// Start, resume and retry share one path: skip `done` rows, rerun the rest (steps are idempotent).
// Rows never hold tokens, provider keys or minted secrets.
import { CloudflareApiError } from './cloudflare';
import { FACT_ADDRESS } from './context';
import type { DeployContext, DeployFacts } from './context';
import type { DeployStep } from './steps';
import { Cause, Effect } from 'effect';
import { diagnostics, renderThrownChain, settle } from '../obs/index';

export type DeployStepState = 'pending' | 'running' | 'done' | 'failed';

export interface DeployStepFailure {
  readonly detail: string;
  /** 0 when the failure was not Cloudflare's. */
  readonly code: number;
  readonly status: number;
  /** The path Cloudflare refused, which the refusal catalog reads where a code is shared. */
  readonly endpoint?: string;
}

export interface DeployStepRow {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  readonly state: DeployStepState;
  readonly attempt: number;
  readonly detail: string;
  readonly notes: readonly string[];
  readonly failure: DeployStepFailure | null;
  readonly facts: Readonly<Record<string, string>>;
}

export interface DeployLedger {
  rows(): Promise<readonly DeployStepRow[]>;
  seed(steps: readonly DeployStepSeed[]): Promise<void>;
  started(id: string, attempt: number): Promise<void>;
  /** Synchronous so a step never awaits its own progress line. */
  noted(id: string, note: string): void;
  settled(id: string, detail: string, facts: Readonly<Record<string, string>>): Promise<void>;
  failed(id: string, failure: DeployStepFailure): Promise<void>;
}

export interface DeployStepSeed {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
}

export type DeployProgress =
  | { readonly kind: 'step-started'; readonly id: string; readonly attempt: number }
  | { readonly kind: 'step-note'; readonly id: string; readonly note: string }
  | { readonly kind: 'step-done'; readonly id: string; readonly detail: string }
  | { readonly kind: 'step-failed'; readonly id: string; readonly failure: DeployStepFailure }
  | { readonly kind: 'run-done'; readonly address: string };

export type DeployProgressSink = (progress: DeployProgress) => void;

export type DeployRunState = 'done' | 'failed';

export interface DeployRunOutcome {
  readonly state: DeployRunState;
  readonly failedAt: string | null;
  readonly rows: readonly DeployStepRow[];
}

/**
 * Each step starts once every step it needs (`after`) is done, so steps that need nothing of each other run at once.
 * A refusal starts nothing more: what already runs ends and is recorded, and the run stops on the first refusal. A step
 * named in `after` comes earlier in the plan, so no step waits on one that waits on it.
 */
export function runDeployPlan(
  plan: readonly DeployStep[],
  context: DeployContext,
  ledger: DeployLedger,
  onProgress: DeployProgressSink,
): Promise<DeployRunOutcome> {
  return settle(Effect.gen(function* () {
    yield* Effect.promise(() => ledger.seed(plan.map((step, seq) => ({ id: step.id, seq, title: step.title }))));

    const before = yield* Effect.promise(() => ledger.rows());
    const known = new Map(before.map((row) => [row.id, row]));
    // Whether each step ended done: false for a refused step, and for one a refusal kept from starting.
    const ended = new Map(plan.map((step) => [step.id, Promise.withResolvers<boolean>()]));
    // The refused steps, in the order they were refused: the run stops on the first.
    const refused: string[] = [];

    for (const row of before) {
      if (row.state === 'done') for (const [key, value] of Object.entries(row.facts)) context.facts.set(key, value);
    }

    for (const [index, step] of plan.entries()) {
      const later = step.after.find((id) => !plan.slice(0, index).some((earlier) => earlier.id === id));

      if (later !== undefined) return yield* Effect.die(new Error(`deploy step ${step.id} waits on ${later}, which the plan does not run before it`));
    }

    const stepDone = (step: DeployStep): Effect.Effect<boolean> => Effect.gen(function* () {
      const needed = yield* Effect.promise(() => Promise.all(step.after.map(async (id) => await (ended.get(id)?.promise ?? false))));

      if (known.get(step.id)?.state === 'done') return true;

      if (needed.includes(false) || refused.length > 0) return false;
      const attempt = (known.get(step.id)?.attempt ?? 0) + 1;
      const started = Date.now();

      yield* Effect.promise(() => ledger.started(step.id, attempt));
      onProgress({ kind: 'step-started', id: step.id, attempt });

      const recorded: Record<string, string> = {};

      const facts: DeployFacts = {
        get: (key: string) => context.facts.get(key),
        set: (key: string, value: string) => {
          recorded[key] = value;
          context.facts.set(key, value);
        },
      };

      const outcome = yield* stepOutcome(step, {
        ...context,
        facts,
        note: (message: string) => {
          onProgress({ kind: 'step-note', id: step.id, note: message });
          ledger.noted(step.id, message);
        },
      });

      diagnostics.event('deploy.step_settled', { step: step.id, attempt, ms: Date.now() - started, refused: outcome.failure !== null });

      if (outcome.failure !== null) {
        const failure = outcome.failure;

        refused.push(step.id);
        yield* Effect.promise(() => ledger.failed(step.id, failure));
        onProgress({ kind: 'step-failed', id: step.id, failure });

        return false;
      }

      yield* Effect.promise(() => ledger.settled(step.id, outcome.detail, recorded));
      onProgress({ kind: 'step-done', id: step.id, detail: outcome.detail });

      return true;
    });

    yield* Effect.forEach(plan, (step) => Effect.tap(stepDone(step), (done) => Effect.sync(() => ended.get(step.id)?.resolve(done))), { concurrency: 'unbounded', discard: true });
    const rows = yield* Effect.promise(() => ledger.rows());

    const failedAt = refused[0];

    if (failedAt !== undefined) {
      const failed: DeployRunOutcome = { state: 'failed', failedAt, rows };

      return failed;
    }

    onProgress({ kind: 'run-done', address: factsFrom(rows).get(FACT_ADDRESS) ?? '' });

    const done: DeployRunOutcome = { state: 'done', failedAt: null, rows };

    return done;
  }));
}

interface StepOutcome {
  readonly detail: string;
  readonly failure: DeployStepFailure | null;
}

function stepOutcome(step: DeployStep, context: DeployContext): Effect.Effect<StepOutcome> {
  return step.run(context).pipe(Effect.matchCause({
    onSuccess: (detail): StepOutcome => ({ detail, failure: null }),
    onFailure: (failed): StepOutcome => {
      const cause = Cause.squash(failed);

      return cause instanceof CloudflareApiError
        ? { detail: '', failure: { detail: cause.detail, code: cause.code, status: cause.status, endpoint: cause.path } }
        : { detail: '', failure: { detail: renderThrownChain({ cause }), code: 0, status: 0 } };
    },
  }));
}

export function factsFrom(rows: readonly DeployStepRow[]): DeployFacts {
  const held = new Map<string, string>();

  for (const row of rows) {
    for (const [key, value] of Object.entries(row.facts)) held.set(key, value);
  }

  return {
    get: (key: string) => held.get(key),
    set: (key: string, value: string) => void held.set(key, value),
  };
}
