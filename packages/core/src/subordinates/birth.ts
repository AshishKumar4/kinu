import { Cause, Effect } from 'effect';
import { settle } from '../obs/effect';
import * as v from 'valibot';
import { TierIdSchema, isValidRoleId } from '../types/profile';
import { isWorkMode, type WorkMode } from '../types/turn';
import { KinuError, toKinuError } from '../obs/error';
import { diagnostics } from '../obs/index';
import type { ActorReference } from '../identity/actor-handle';
import type { SubordinateRosterStore } from './roster';
import type { SubordinateRuntime } from './support';
import { SubordinateInheritedContextSchema } from '../types/subordinates';

const SubordinateSeedSchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty()),
  displayName: v.string(),
  nameOrigin: v.picklist(['user', 'auto']),
  role: v.pipe(v.string(), v.check(isValidRoleId)),
  tier: v.optional(TierIdSchema),
  mission: v.pipe(v.string(), v.nonEmpty()),
  lifetime: v.picklist(['durable', 'task']),
  /** Who asked for it: the owner, an agent, or an evolution lane. */
  origin: v.picklist(['user', 'agent', 'evolution']),
});

export type SubordinateSeed = v.InferOutput<typeof SubordinateSeedSchema>;

export const SubordinateBirthSchema = v.strictObject({
  creationId: v.pipe(v.string(), v.nonEmpty()),
  seed: SubordinateSeedSchema,
  assignment: v.nullable(v.strictObject({
    body: v.pipe(v.string(), v.nonEmpty()),
    mode: v.custom<WorkMode>(isWorkMode),
    deliverable: v.optional(v.string()),
    inheritedContext: v.optional(SubordinateInheritedContextSchema),
  })),
});

export type SubordinateBirth = v.InferOutput<typeof SubordinateBirthSchema>;

const inFlight = new WeakMap<SubordinateRosterStore, Map<string, Promise<ActorReference>>>();

/** Resume only the request that the roster admitted before its first await. */
export function finishSubordinateBirth(
  roster: SubordinateRosterStore,
  runtime: SubordinateRuntime,
  name: string,
): Promise<ActorReference> {
  return settle(Effect.gen(function* () {
    const entry = roster.requireExisting(name);
    const birth = entry.birth;

    if (entry.deleteRequested) return yield* new KinuError('cancelled', 'The admitted actor birth is cancelled.');

    if (!birth) {
      if (!entry.actorReference) return yield* new KinuError('missing', 'The subordinate has no registered actor reference.');

      return entry.actorReference;
    }

    let pending = inFlight.get(roster);

    if (!pending) { pending = new Map(); inFlight.set(roster, pending); }

    const existing = pending.get(birth.creationId);

    if (existing) return yield* Effect.promise(() => existing);

    const work = ((): Promise<ActorReference> => {
      return settle(Effect.gen(function* () {
        const reference = yield* Effect.promise(() => runtime.spawn({ ...birth.seed, creationId: birth.creationId }));
        roster.attachActor(name, birth.creationId, reference);

        if (roster.requireExisting(name).deleteRequested) return yield* new KinuError('cancelled', 'The admitted actor birth is cancelled.');

        const assignment = birth.assignment;

        if (assignment) {
          const handoff = yield* Effect.promise(() => runtime.assign(name, { ...assignment, creationId: birth.creationId }));

          if (roster.requireExisting(name).birth?.creationId !== birth.creationId) return yield* new KinuError('denied', 'The birth admission no longer owns this assignment.');
          roster.recordAssignmentEvent(name, handoff.eventId);
        }

        roster.finishBirth(name, birth.creationId);

        return reference;
      }));
    })();

    pending.set(birth.creationId, work);
    const held = pending;

    return yield* Effect.ensuring(Effect.catchCause(Effect.promise(() => work), (failed) => {
      const error = toKinuError({ doing: 'completing an admitted actor birth', cause: Cause.squash(failed), otherwise: 'unavailable' });

      if (error.code !== 'io' && error.code !== 'unavailable') roster.cancelBirth(name, birth.creationId);

      return Effect.fail(error);
    }), Effect.sync(() => {
      if (held.get(birth.creationId) === work) held.delete(birth.creationId);
    }));
  }));
}

/** The existing maintenance owner resumes these intents after an interruption. */
export function recoverSubordinateLifecycles(roster: SubordinateRosterStore, runtime: SubordinateRuntime): Promise<boolean> {
  return settle(Effect.gen(function* () {
    for (const entry of roster.pendingDeletions()) {
      let reference = entry.actorReference;

      if (!reference) {
        const birth = entry.birth;

        if (!birth) return yield* new KinuError('missing', 'The deletion intent has no actor or admitted creation identity.');
        reference = yield* Effect.promise(async () => runtime.cancelBirth({ ...birth.seed, creationId: birth.creationId }));
        roster.attachActor(entry.name, birth.creationId, reference);
      } else {
        const held = reference;

        yield* Effect.promise(async () => runtime.dismiss(entry.name, { keepHistory: false, interrupt: true }, held));
      }

      roster.removeActor(entry.name, reference);
    }

    for (const entry of roster.pendingBirths()) {
      yield* Effect.catchCause(Effect.gen(function* () {
        yield* Effect.promise(async () => finishSubordinateBirth(roster, runtime, entry.name));
      }), (failed) => Effect.gen(function* () {
        const cause = Cause.squash(failed);
        const error = toKinuError({ doing: 'recovering an admitted actor birth', cause, otherwise: 'unavailable' });

        if (error.code === 'io' || error.code === 'unavailable') return yield* Effect.die(error);
        diagnostics.failure('subordinate.birth_recovery_failed', error, { subordinate: entry.name });
      }));
    }

    return roster.hasPendingBirths() || roster.pendingDeletions().length > 0;
  }));
}
