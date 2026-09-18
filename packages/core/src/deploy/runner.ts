/**
 * Running a plan against a durable ledger.
 *
 * ONE MECHANISM FOR THREE THINGS. A run that starts, a page that reloads
 * mid-run, and a person who retries a failed step all call `runDeployPlan`.
 * It reads the ledger, skips what is `done`, and runs the rest in order —
 * which makes resume and retry the same code path and makes "the Durable
 * Object was evicted in the middle of a step" ordinary: the step's row is
 * still `running`, the step is idempotent, and it runs again.
 *
 * WHAT A ROW HOLDS AND WHAT IT NEVER HOLDS. A row holds the step's state, its
 * attempt count, what it established (facts), and, on a refusal, Cloudflare's
 * own words. It never holds the token, a provider key, or a minted secret;
 * those live in the vault and the vault is wiped by the last step.
 */
import { CloudflareApiError } from './cloudflare';
import { FACT_ADDRESS } from './context';
import type { DeployContext, DeployFacts } from './context';
import type { DeployStep } from './steps';
import { renderThrownChain } from '../obs/index';

export type DeployStepState = 'pending' | 'running' | 'done' | 'failed';

export interface DeployStepFailure {
  /** Cloudflare's own message, unedited, or the local failure's text. */
  readonly detail: string;
  /** Cloudflare's numeric error code; 0 when the failure was not Cloudflare's. */
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

/**
 * The durable half. The deploy Durable Object implements this over its SQLite;
 * a test implements it over an array. Every call is a write a reload can read.
 */
export interface DeployLedger {
  rows(): Promise<readonly DeployStepRow[]>;
  /** Called once per plan, before anything runs: the page shows every step,
   *  pending ones included, from the first frame. */
  seed(steps: readonly DeployStepSeed[]): Promise<void>;
  started(id: string, attempt: number): Promise<void>;
  /** Synchronous: a note is appended from inside a running step, and a step
   *  must not have to await its own progress line. The Durable Object's SQL
   *  is synchronous, so this is a write either way. */
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
  /** The step that refused, on a failed run. */
  readonly failedAt: string | null;
  readonly rows: readonly DeployStepRow[];
}

/**
 * Runs what the ledger has not finished, in plan order, and stops at the first
 * refusal.
 *
 * Stopping is the point: step 9 uploads a Worker that binds what steps 2 to 5
 * created, so carrying on past a refusal would deploy something half-bound and
 * report it as a success. The person retries the step that failed, and this
 * function is what a retry calls.
 */
export async function runDeployPlan(
  plan: readonly DeployStep[],
  context: DeployContext,
  ledger: DeployLedger,
  onProgress: DeployProgressSink,
): Promise<DeployRunOutcome> {
  await ledger.seed(plan.map((step, seq) => ({ id: step.id, seq, title: step.title })));

  const before = await ledger.rows();
  const known = new Map(before.map((row) => [row.id, row]));

  for (const step of plan) {
    const row = known.get(step.id);

    if (row?.state === 'done') {
      for (const [key, value] of Object.entries(row.facts)) context.facts.set(key, value);
      continue;
    }

    const attempt = (row?.attempt ?? 0) + 1;

    await ledger.started(step.id, attempt);
    onProgress({ kind: 'step-started', id: step.id, attempt });

    const recorded: Record<string, string> = {};

    const facts: DeployFacts = {
      get: (key: string) => context.facts.get(key),
      set: (key: string, value: string) => {
        recorded[key] = value;
        context.facts.set(key, value);
      },
    };

    const outcome = await settle(step, {
      ...context,
      facts,
      note: (message: string) => {
        onProgress({ kind: 'step-note', id: step.id, note: message });
        ledger.noted(step.id, message);
      },
    });

    if (outcome.failure !== null) {
      await ledger.failed(step.id, outcome.failure);
      onProgress({ kind: 'step-failed', id: step.id, failure: outcome.failure });

      return { state: 'failed', failedAt: step.id, rows: await ledger.rows() };
    }

    await ledger.settled(step.id, outcome.detail, recorded);
    onProgress({ kind: 'step-done', id: step.id, detail: outcome.detail });
  }

  const rows = await ledger.rows();

  const address = factsFrom(rows).get(FACT_ADDRESS) ?? '';

  onProgress({ kind: 'run-done', address });

  return { state: 'done', failedAt: null, rows };
}

interface StepOutcome {
  readonly detail: string;
  readonly failure: DeployStepFailure | null;
}

/**
 * One step's result, with the refusal turned into a row rather than a throw.
 *
 * The catch is this module's whole job — a step that refuses is a domain
 * value here, and the alternative is every step wrapping its own call — so
 * nothing is discarded: Cloudflare's message, code and status go onto the row,
 * and a non-Cloudflare failure keeps its rendered cause chain.
 */
async function settle(step: DeployStep, context: DeployContext): Promise<StepOutcome> {
  try {
    return { detail: await step.run(context), failure: null };
  } catch (caught) {
    if (caught instanceof CloudflareApiError) {
      return { detail: '', failure: { detail: caught.detail, code: caught.code, status: caught.status } };
    }

    return { detail: '', failure: { detail: renderThrownChain({ cause: caught }), code: 0, status: 0 } };
  }
}

/** Facts in memory, seeded from the rows a resumed run already has. */
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
