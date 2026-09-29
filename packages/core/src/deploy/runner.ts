// Start, resume and retry share one path: skip `done` rows, rerun the rest (steps are idempotent).
// Rows never hold tokens, provider keys or minted secrets.
import { CloudflareApiError } from './cloudflare';
import { FACT_ADDRESS } from './context';
import type { DeployContext, DeployFacts } from './context';
import type { DeployStep } from './steps';
import { Effect } from 'effect';
import { renderThrownChain, settle } from '../obs/index';

export type DeployStepState = 'pending' | 'running' | 'done' | 'failed';

export interface DeployStepFailure {
  readonly detail: string;
  /** 0 when the failure was not Cloudflare's. */
  readonly code: number;
  readonly status: number;
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

/** Stops at the first refusal: later steps bind what earlier ones create. */
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

    for (const step of plan) {
      const row = known.get(step.id);

      if (row?.state === 'done') {
        for (const [key, value] of Object.entries(row.facts)) context.facts.set(key, value);
        continue;
      }

      const attempt = (row?.attempt ?? 0) + 1;

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

      if (outcome.failure !== null) {
        const failure = outcome.failure;
        yield* Effect.promise(() => ledger.failed(step.id, failure));
        onProgress({ kind: 'step-failed', id: step.id, failure });

        const failed: DeployRunOutcome = { state: 'failed', failedAt: step.id, rows: yield* Effect.promise(() => ledger.rows()) };

        return failed;
      }

      yield* Effect.promise(() => ledger.settled(step.id, outcome.detail, recorded));
      onProgress({ kind: 'step-done', id: step.id, detail: outcome.detail });
    }

    const rows = yield* Effect.promise(() => ledger.rows());

    const address = factsFrom(rows).get(FACT_ADDRESS) ?? '';

    onProgress({ kind: 'run-done', address });

    const done: DeployRunOutcome = { state: 'done', failedAt: null, rows };

    return done;
  }));
}

interface StepOutcome {
  readonly detail: string;
  readonly failure: DeployStepFailure | null;
}

function stepOutcome(step: DeployStep, context: DeployContext): Effect.Effect<StepOutcome> {
  return Effect.tryPromise({ try: () => step.run(context), catch: (cause) => ({ cause }) }).pipe(Effect.match({
    onSuccess: (detail): StepOutcome => ({ detail, failure: null }),
    onFailure: (failed): StepOutcome => (failed.cause instanceof CloudflareApiError
      ? { detail: '', failure: { detail: failed.cause.detail, code: failed.cause.code, status: failed.cause.status } }
      : { detail: '', failure: { detail: renderThrownChain(failed), code: 0, status: 0 } }),
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
