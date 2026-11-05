/**
 * A box's readiness, asked again while the box is on its way and not yet ready: waiting for its base snapshot to be
 * built (D79), or saving and stopping (D108). The workspace's calls hold on it (cf-backend sandbox-exec-lane.ts), and a
 * terminal attach holds on it inside the box, telling its pane each new reason (D109). Every other pending is answered
 * at once.
 */
import { Effect } from 'effect';
import type { RestoreReadiness } from './restoration';

/** How often a held ask asks again. */
const READINESS_ASK_MS = 1_000;

/**
 * A base build that names no new step for this long has stopped: the caller gets the box's words. Its longest step,
 * the base image's first start, is given up by the builder at 120 s, and a fresh install took at most 31 s (D66).
 */
const BASE_STALL_MS = 180_000;

/**
 * How long an ask waits for a box that is saving and stopping. The longest such stop is a rest: its commit (a base commit
 * took up to 76.9 s, D50), the snapshot it waits on (given up at 60 s, D108), and the stop the box waits for (5 s): 142 s.
 */
const QUIESCE_HOLD_MS = 180_000;

export interface ReadinessHold<E> {
  /** The box's readiness now, or why it could not be read: the hold ends in that failure. */
  readonly ask: () => Effect.Effect<RestoreReadiness, E>;
  /** Waits `ms` before the next ask; it may end early (a call stopped), and `gone` then says so. */
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Told each pending the hold waits on. */
  readonly pending?: (readiness: Extract<RestoreReadiness, { kind: 'pending' }>) => void;
  /** True once whoever asked has gone: the hold ends with the last answer. */
  readonly gone?: () => boolean;
}

/** The first answer that is no held pending, or the box's words once a bound is past. */
export function holdReadiness<E>(hold: ReadinessHold<E>): Effect.Effect<RestoreReadiness, E> {
  return Effect.gen(function* () {
    let readiness = yield* hold.ask();
    let step: string | null | undefined;
    let movedAt = hold.now();
    const askedAt = hold.now();

    while (readiness.kind === 'pending' && (readiness.building !== undefined || readiness.quiescing === true)) {
      if (readiness.building === undefined) {
        if (hold.now() - askedAt >= QUIESCE_HOLD_MS) return { kind: 'pending', reason: `still after ${String(QUIESCE_HOLD_MS / 1000)} s: ${readiness.reason}` };
      } else if (readiness.building.step !== step) {
        step = readiness.building.step;
        movedAt = hold.now();
      } else if (hold.now() - movedAt >= BASE_STALL_MS) {
        return { kind: 'pending', reason: `the base snapshot's build made no progress in ${String(BASE_STALL_MS / 1000)} s (at: ${step ?? 'not begun'}); ${readiness.reason}` };
      }

      hold.pending?.(readiness);
      yield* Effect.promise(() => hold.wait(READINESS_ASK_MS));

      if (hold.gone?.() === true) return readiness;
      readiness = yield* hold.ask();
    }

    return readiness;
  });
}
