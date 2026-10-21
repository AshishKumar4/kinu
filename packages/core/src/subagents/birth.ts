import { Cause, Effect, type Exit } from 'effect';
import { hold, settle } from '../obs/effect';
import * as v from 'valibot';
import { TierIdSchema, isValidRoleId } from '../types/profile';
import { isWorkMode, type WorkMode } from '../types/turn';
import { KinuError, toKinuError } from '../obs/error';
import { diagnostics } from '../obs/index';
import type { ActorReference } from '../identity/actor-handle';
import { SUBAGENT_ORIGINS } from '../identity/workspace-actors';
import type { SubagentRosterStore } from './roster';
import type { SubagentRuntime } from './support';
import { SubagentInheritedContextSchema, subagentBirthContext } from '../types/subagents';
import type { SerializedMessage } from '../types/heads';

const SubagentSeedSchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty()),
  displayName: v.string(),
  nameOrigin: v.picklist(['user', 'auto']),
  role: v.pipe(v.string(), v.check(isValidRoleId)),
  tier: v.optional(TierIdSchema),
  mission: v.pipe(v.string(), v.nonEmpty()),
  lifetime: v.picklist(['durable', 'task']),
  /** Who asked for it: the owner, an agent, or an evolution lane. */
  origin: v.picklist(SUBAGENT_ORIGINS),
});

export type SubagentSeed = v.InferOutput<typeof SubagentSeedSchema>;

export const SubagentBirthSchema = v.strictObject({
  creationId: v.pipe(v.string(), v.nonEmpty()),
  seed: SubagentSeedSchema,
  assignment: v.nullable(v.strictObject({
    body: v.pipe(v.string(), v.nonEmpty()),
    mode: v.custom<WorkMode>(isWorkMode),
    deliverable: v.optional(v.string()),
    inheritedContext: v.optional(SubagentInheritedContextSchema),
  })),
});

export type SubagentBirth = v.InferOutput<typeof SubagentBirthSchema>;

const inFlight = new WeakMap<SubagentRosterStore, Map<string, Promise<Exit.Exit<ActorReference, KinuError>>>>();

/** What a lifetime decides of a birth; the admission itself is the same for every lifetime. */
export interface SubagentBirthRequest {
  readonly seed: SubagentSeed;
  /** Null for an owner's hire, which starts idle; else the work it is born to, with the parent's context if forked. */
  readonly assignment: { readonly body: string; readonly mode: WorkMode; readonly inheritedContext?: SerializedMessage[] } | null;
  readonly createdAt: number;
}

/**
 * Admits `request.seed.name` to the roster under a fresh creation id, then completes its birth: the one admission
 * every lifetime makes. The caller has already refused a name the roster holds, each in its own words.
 */
export function admitSubagentBirth(roster: SubagentRosterStore, runtime: SubagentRuntime, request: SubagentBirthRequest): Promise<ActorReference> {
  const { seed, createdAt } = request;
  const inheritedContext = subagentBirthContext(request.assignment?.inheritedContext);

  const assignment: SubagentBirth['assignment'] = request.assignment === null ? null : {
    body: request.assignment.body, mode: request.assignment.mode, ...(inheritedContext !== undefined && { inheritedContext }),
  };

  roster.create({
    name: seed.name, actorReference: null, birth: { creationId: crypto.randomUUID(), seed, assignment }, deleteRequested: false,
    status: assignment === null ? 'idle' : 'working', currentTask: assignment === null ? null : seed.mission,
    createdAt, dismissedAt: null, taskEventId: null,
  });

  return settle(finishSubagentBirth(roster, runtime, seed.name));
}

/** Resume only the request that the roster admitted before its first await. */
function finishSubagentBirth(
  roster: SubagentRosterStore,
  runtime: SubagentRuntime,
  name: string,
): Effect.Effect<ActorReference, KinuError> {
  return Effect.gen(function* () {
    const entry = roster.requireExisting(name);
    const birth = entry.birth;

    if (entry.deleteRequested) return yield* new KinuError('cancelled', 'The admitted actor birth is cancelled.');

    if (!birth) {
      if (!entry.actorReference) return yield* new KinuError('missing', 'The subagent has no registered actor reference.');

      return entry.actorReference;
    }

    let pending = inFlight.get(roster);

    if (!pending) { pending = new Map(); inFlight.set(roster, pending); }

    const existing = pending.get(birth.creationId);

    if (existing) return yield* Effect.flatten(Effect.promise(() => existing));

    // Held, not run here: a second caller for this creation id joins this one run.
    const work = hold(Effect.gen(function* () {
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

    pending.set(birth.creationId, work);
    const held = pending;

    return yield* Effect.ensuring(Effect.catchCause(Effect.flatten(Effect.promise(() => work)), (failed) => {
      const error = toKinuError({ doing: 'completing an admitted actor birth', cause: Cause.squash(failed), otherwise: 'unavailable' });

      if (error.code !== 'io' && error.code !== 'unavailable') roster.cancelBirth(name, birth.creationId);

      return Effect.fail(error);
    }), Effect.sync(() => {
      if (held.get(birth.creationId) === work) held.delete(birth.creationId);
    }));
  });
}

/** The existing maintenance owner resumes these intents after an interruption. */
export function recoverSubagentLifecycles(roster: SubagentRosterStore, runtime: SubagentRuntime): Promise<boolean> {
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
        yield* finishSubagentBirth(roster, runtime, entry.name);
      }), (failed) => Effect.gen(function* () {
        const cause = Cause.squash(failed);
        const error = toKinuError({ doing: 'recovering an admitted actor birth', cause, otherwise: 'unavailable' });

        if (error.code === 'io' || error.code === 'unavailable') return yield* Effect.die(error);
        diagnostics.failure('subagent.birth_recovery_failed', error, { subagent: entry.name });
      }));
    }

    return roster.hasPendingBirths() || roster.pendingDeletions().length > 0;
  }));
}
