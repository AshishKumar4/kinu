/**
 * WHAT a failed episode was, and WHETHER a restart still owes it.
 *
 * One concept in one file, because it used to be three answers in three places
 * that had to agree: the observation's outcome, the durable phase, and the
 * INFRA marker the tier's ratchet counts. A run that lost four of thirty-four
 * cases to an upstream 500 reported "17 behavioural, 0 infrastructure" because
 * those three answers were derived separately at the call site.
 *
 * The distinction this file exists to keep is between:
 *
 *   THE AGENT did nothing gradable          — `inert`, terminal.
 *   THE HARNESS or the code failed          — `errored`, terminal.
 *   THE ENVIRONMENT killed the turn         — no verdict, RESUMABLE.
 *
 * The third is the one that had no home. It looks identical to the first from
 * the ledger — one closed turn, zero tool calls, zero model steps — so it was
 * filed as the agent being lazy, and once filed it was settled, which made a
 * transient outage a permanent verdict.
 *
 * The guard errors for a broken RUNTIME (`DegenerateRuntimeError`,
 * `UnsandboxedRuntimeError`) stay in `harness.ts` beside the checks that throw
 * them: those are refusals before an episode exists, and this file is about an
 * episode that ran.
 */
import { INFRA_FAILURE_MARKER, RUN_END_FAILURE_PREFIX } from '@kinu.run/test-utils';
import { classifyTurnFailure } from '../../packages/core/src/index';

/**
 * A provider error that is the DEPLOYMENT's rather than the agent's, and could
 * not have been anything else.
 *
 * WHY THIS IS NOT `classifyTurnFailure` ALONE. Core's classifier answers a
 * different question — WHICH REMEDY does a failed request need: force-compaction
 * (`context_length`), throughput backoff (`rate_limit`), re-auth (`auth`), or
 * plain retry (`transient`). For that question `transient` is a correct
 * catch-all, because a 500 and a `TypeError` are both just retried. Here the
 * question is WHOSE FAULT, and `transient` cannot answer it: it is the
 * FALL-THROUGH return (`packages/core/src/turn-failure.ts`), so every internal
 * throw sealed into a `run_end` — `no executor: settled at start of life`,
 * `Tool result is missing for tool call …` — arrived labelled INFRA. That
 * direction reads a product regression that kills turns as an outage, which is
 * the gate-blindness one.
 *
 * So the environment classes are matched POSITIVELY. `rate_limit` and `auth`
 * come from core, which already owns those patterns. The provider-server class
 * does not exist in core — its four classes never needed to separate a 5xx from
 * an internal throw — and it must be matched somewhere, because the measured
 * failure text was `Failed after 3 attempts. Last error: Internal Server Error`,
 * which core classifies `transient`. Dropping it would put those four cases
 * straight back to reading as "the agent did nothing".
 *
 * Moving these patterns into core as a fifth `TurnFailureClass` would be
 * strictly better — the retry ladder asks the same question of the same text —
 * and it is a core change with a layergate baseline behind it, so it belongs to
 * whoever next touches `turn-failure.ts` rather than to the eval harness.
 */
const PROVIDER_SERVER_PATTERNS: readonly RegExp[] = [
  /\b5\d\d\b/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /upstream (?:connect|error|timeout)/i,
  // The retry ladder's own envelope. It wraps whatever the upstream last said,
  // and reaching it at all means the request was retried to exhaustion rather
  // than failing on this run's own inputs.
  /failed after \d+ attempts?\./i,
];

/**
 * The TURN's own provider error, when the error is the environment's.
 *
 * ONLY the `run_end` failure is consulted. The ledger reducer prefixes each
 * failure with its source, so the turn's provider error is distinguishable from
 * a tool's — and a tool that failed IS the agent's episode, not the environment.
 * `context_length` is deliberately not environmental either: a request that
 * overflowed the window is something the episode did.
 */
export function environmentFailure(failures: readonly string[]): string | null {
  const turnError = failures.find((failure) => failure.startsWith(RUN_END_FAILURE_PREFIX));
  if (turnError === undefined) return null;
  const error = turnError.slice(RUN_END_FAILURE_PREFIX.length);
  const kind = classifyTurnFailure(error);
  if (kind === 'rate_limit' || kind === 'auth') {
    return `${INFRA_FAILURE_MARKER} (${kind}): ${turnError}`;
  }
  if (kind === 'transient' && PROVIDER_SERVER_PATTERNS.some((pattern) => pattern.test(error))) {
    return `${INFRA_FAILURE_MARKER} (provider_server): ${turnError}`;
  }
  return null;
}

/**
 * Thrown when a trajectory recorded nothing gradable.
 *
 * A distinct type so the suite can record the observation as `inert` rather than
 * `errored`: "the agent did nothing" and "not the agent" are different facts and
 * the run record must not conflate them. {@link environment} is the third fact —
 * a degenerate trajectory whose own turn error came from the environment is
 * neither of the first two, and it carries {@link INFRA_FAILURE_MARKER} in this
 * error's MESSAGE so `scripts/skip-ratchet.ts` counts it as infrastructure
 * without a second copy of the string.
 */
export class DegenerateRunError extends Error {
  /** The environment's own sentence, or null when the agent simply did nothing. */
  readonly environment: string | null;

  constructor(
    readonly taskId: string, readonly turns: number, readonly toolCalls: number,
    readonly failures: readonly string[],
  ) {
    const environment = environmentFailure(failures);
    super((environment === null ? '' : `${environment} — `)
      + `degenerate run for ${taskId}: ${String(turns)} closed turns, `
      + `${String(toolCalls)} tool calls — not a result. No mechanism could have been `
      + 'exercised, so this contributes no score.'
      + (failures.length > 0 ? ` Recorded failures: ${failures.join(' | ')}` : ''));
    this.name = 'DegenerateRunError';
    this.environment = environment;
  }
}

/**
 * How a failed case is recorded, and whether a restart owes it again.
 *
 * A VALUE rather than two booleans at the call site. The outcome a record
 * publishes and the phase a resumed run reads have to be one decision: they were
 * two, and the pair `outcome:'errored'` + `markSettled` is what made an outage a
 * permanent verdict.
 */
export type FailedCaseDisposition =
  /** The episode produced its own verdict. No judge reads a failed case, so a
   *  restart skips it rather than paying for the same failure twice. */
  | { readonly kind: 'settled'; readonly outcome: 'inert' | 'errored' }
  /** No verdict was produced, and the cause was not the agent's. The case is
   *  recorded `incomplete` — the phase that already means "began and never
   *  settled, and this run owes it" — so a restart retries it. */
  | { readonly kind: 'resumable'; readonly outcome: 'incomplete' };

/**
 * Classify a thrown episode failure.
 *
 * `DegenerateRunError` is the only type that can be resumable, because it is the
 * only one that consulted the turn's own provider error. Everything else — a
 * harness guard, a schema refusal, a programming error — is the run's own and
 * terminal: retrying it would spend money on a failure that will repeat. The
 * domain is `Error`: a caller holding an unknown throw normalizes it with
 * `new Error(String(thrown))` before asking, so non-Error throwables classify
 * as the terminal failures they are.
 */
export function disposeFailedCase(error: Error): FailedCaseDisposition {
  if (!(error instanceof DegenerateRunError)) return { kind: 'settled', outcome: 'errored' };
  if (error.environment !== null) return { kind: 'resumable', outcome: 'incomplete' };
  return { kind: 'settled', outcome: 'inert' };
}
