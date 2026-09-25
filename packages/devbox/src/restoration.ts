/** The restoration a box holds for its current container generation, and what callers read off it. */

import * as v from 'valibot';

import type { RestorePhase } from './durability/contracts';
import type { RecoveryRow, RecoveryStage } from './lifecycle';
import type { StoredValue } from './storage';

/** One value per container generation, so a superseded attempt cannot leave readiness and
 *  failure disagreeing; `repair` and `restoring` keep partial and in-flight states distinct. */
export type Restoration =
  /** No attempt has begun for this container generation. NOT "an attempt is
   *  running and has said nothing yet" — that is `restoring`. */
  | { readonly phase: 'unstarted' }
  /** An attempt is in flight; the answer is "wait", never "drive": a second driver
   *  would open a rival restoration against the same container. */
  | { readonly phase: 'restoring'; readonly where: 'start'; readonly since: number }
  /** The work directory is attached AND every supervised process, listener and
   *  port came back. The only phase that is `ready`. */
  | { readonly phase: 'attached' }
  /** Operations stay admitted: a box refusing `exec` could not be repaired by its agent.
   *  `incomplete` names what did not come back; a `repair` with nothing incomplete is `attached`. */
  | { readonly phase: 'repair'; readonly incomplete: string }
  /** Operations refuse. `retry` false is terminal until `attachNow()`; it is a field so a lost
   *  arming write cannot leave a box refusing on a retry nothing holds. */
  | { readonly phase: 'unattached'; readonly reason: string; readonly retry: boolean };

/** Adopted only beside a container boot id that still names this instance, so a row never
 *  settles a box onto a container it did not restore; deleted on every generation turnover. */
export type SettledRestoration = Extract<Restoration, { readonly phase: 'attached' | 'repair' | 'unattached' }>;

/** The readiness gate's answer for the first admitted operation: a caller let into a `repair`
 *  box learns from the call itself that a named service did not come back. */
export type RestoreAdmission =
  | { readonly kind: 'restored' }
  | { readonly kind: 'repair'; readonly incomplete: string };

/** `pending` is returned, not thrown: Workers RPC normalises a thrown error's `name` to
 *  `Error`, so a thrown refusal loses the transient classification the caller needs. */
export type RestoreReadiness =
  | RestoreAdmission
  | { readonly kind: 'pending'; readonly reason: string };

/** `opened` once, each {@link RestorePhase} as it lands, then `settled` once. */
export type RestoreClockPhase = 'opened' | RestorePhase | 'settled';

/** `pending` deliberately reports the failed wording: the next repair reads that sentence
 *  to decide it must retry the stamp, so changing it silently disables the retry. */
const STAMP_MISSING = {
  late: 'the boot id stamp is still pending',
  failed: 'the boot id stamp failed',
  pending: 'the boot id stamp failed',
} as const;

export type StampOutcome = keyof typeof STAMP_MISSING | 'done';

/** One builder for restore and repair: nothing missing is `attached`, else `repair` names it. */
export function settledRestoration(down: readonly string[], stamp: StampOutcome): Restoration {
  const missing = stamp === 'done' ? down : [...down, STAMP_MISSING[stamp]];

  if (missing.length === 0) return { phase: 'attached' };

  return { phase: 'repair', incomplete: missing.join('; ') };
}

/** Refuses a malformed row rather than adopting it: a half-shaped phase would admit callers
 *  into a state the box never established. Parsed strictly from `StoredValue`, never narrowed. */
const SettledRestorationSchema = v.variant('phase', [
  v.strictObject({ phase: v.literal('attached') }),
  v.strictObject({ phase: v.literal('repair'), incomplete: v.string() }),
  v.strictObject({ phase: v.literal('unattached'), reason: v.string(), retry: v.boolean() }),
]);

export function isSettledRestoration(stored: StoredValue): stored is SettledRestoration {
  return stored !== undefined && v.safeParse(SettledRestorationSchema, stored).success;
}

export function admissionOf(held: Restoration): RestoreAdmission | undefined {
  if (held.phase === 'attached') return { kind: 'restored' };

  if (held.phase === 'repair') return { kind: 'repair', incomplete: held.incomplete };

  return undefined;
}

/** The one sentence behind `ready: false`, from the same value `ready` is
 *  read off — so the flag and the reason cannot disagree. */
export function unreadyOf(held: Restoration, hookOpen: boolean): string | undefined {
  if (held.phase === 'unstarted') return 'no restoration has run for this container yet';

  if (held.phase === 'unattached') return held.reason;

  if (held.phase === 'repair') return held.incomplete;

  // An in-flight attempt must not report "nothing has run": a poller would read `pending` forever.
  // The elapsed duration makes the answer actionable.
  if (held.phase === 'restoring') {
    return `a restoration has been running in the ${held.where} for `
      + `${String(Math.max(0, Date.now() - held.since))} ms`;
  }

  return hookOpen ? 'the container start hook has not settled' : undefined;
}

/** One attempt's hold on the ladder row: the token it claimed, the stage that
 *  claim preserved, and whether the row it read was readable at all. */
export interface RecoveryClaim {
  readonly token: string;
  readonly admit: boolean;
  readonly stage: RecoveryStage | undefined;
}

/** An absent stage is an absent key, never a key holding undefined: the row is parsed
 *  strictly, and this single builder is what lets that parse stay strict. */
export function recoveryRow(owner: string, stage: RecoveryStage | undefined): RecoveryRow {
  return stage === undefined ? { owner } : { owner, stage };
}
