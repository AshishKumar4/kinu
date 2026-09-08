import * as v from 'valibot';
import { isValidRoleId, TIER_IDS } from '../profiles/catalog';
import { isWorkMode, type WorkMode } from '../prompting/surface';
import { KinuError, toKinuError } from '../obs/error';
import { diagnostics } from '../obs/index';
import type { ActorReference } from '../state/actor-handle';
import type { SubordinateRosterStore } from './roster';
import type { SubordinateRuntime } from './support';

export const SubordinateSeedSchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty()),
  displayName: v.string(),
  nameOrigin: v.picklist(['user', 'auto']),
  role: v.pipe(v.string(), v.check(isValidRoleId)),
  tier: v.optional(v.picklist(TIER_IDS)),
  mission: v.pipe(v.string(), v.nonEmpty()),
  lifetime: v.picklist(['durable', 'task']),
});
export type SubordinateSeed = v.InferOutput<typeof SubordinateSeedSchema>;

export const SubordinateBirthSchema = v.strictObject({
  creationId: v.pipe(v.string(), v.nonEmpty()),
  seed: SubordinateSeedSchema,
  assignment: v.nullable(v.strictObject({
    body: v.pipe(v.string(), v.nonEmpty()),
    mode: v.custom<WorkMode>(isWorkMode),
    deliverable: v.optional(v.string()),
    deadlineHint: v.optional(v.string()),
    inheritedContext: v.optional(v.string()),
  })),
});
export type SubordinateBirth = v.InferOutput<typeof SubordinateBirthSchema>;

const inFlight = new WeakMap<SubordinateRosterStore, Map<string, Promise<ActorReference>>>();

/** Resume only the request that the roster admitted before its first await. */
export async function finishSubordinateBirth(
  roster: SubordinateRosterStore,
  runtime: SubordinateRuntime,
  name: string,
): Promise<ActorReference> {
  const entry = roster.requireExisting(name);
  const birth = entry.birth;
  if (entry.deleteRequested) throw new KinuError('cancelled', 'The admitted actor birth is cancelled.');
  if (!birth) {
    if (!entry.actorReference) throw new KinuError('missing', 'The subordinate has no registered actor reference.');
    return entry.actorReference;
  }
  let pending = inFlight.get(roster);
  if (!pending) { pending = new Map(); inFlight.set(roster, pending); }
  const existing = pending.get(birth.creationId);
  if (existing) return await existing;
  const work = (async (): Promise<ActorReference> => {
    const reference = await runtime.spawn({ ...birth.seed, creationId: birth.creationId });
    roster.attachActor(name, birth.creationId, reference);
    if (roster.requireExisting(name).deleteRequested) throw new KinuError('cancelled', 'The admitted actor birth is cancelled.');
    if (birth.assignment) {
      const handoff = await runtime.assign(name, { ...birth.assignment, creationId: birth.creationId });
      if (roster.requireExisting(name).birth?.creationId !== birth.creationId) throw new KinuError('denied', 'The birth admission no longer owns this assignment.');
      roster.recordAssignmentEvent(name, handoff.eventId);
    }
    roster.finishBirth(name, birth.creationId);
    return reference;
  })();
  pending.set(birth.creationId, work);
  try {
    return await work;
  } catch (cause) {
    const error = toKinuError({ doing: 'completing an admitted actor birth', cause, otherwise: 'unavailable' });
    if (error.code !== 'io' && error.code !== 'unavailable') roster.cancelBirth(name, birth.creationId);
    throw error;
  } finally {
    if (pending.get(birth.creationId) === work) pending.delete(birth.creationId);
  }
}

/** The existing maintenance owner resumes these intents after an interruption. */
export async function recoverSubordinateLifecycles(roster: SubordinateRosterStore, runtime: SubordinateRuntime): Promise<boolean> {
  for (const entry of roster.pendingDeletions()) {
    let reference = entry.actorReference;
    if (!reference) {
      if (!entry.birth) throw new KinuError('missing', 'The deletion intent has no actor or admitted creation identity.');
      reference = await runtime.cancelBirth({ ...entry.birth.seed, creationId: entry.birth.creationId });
      roster.attachActor(entry.name, entry.birth.creationId, reference);
    } else {
      await runtime.dismiss(entry.name, false, reference);
    }
    roster.removeActor(entry.name, reference);
  }
  for (const entry of roster.pendingBirths()) {
    try {
      await finishSubordinateBirth(roster, runtime, entry.name);
    } catch (cause) {
      const error = toKinuError({ doing: 'recovering an admitted actor birth', cause, otherwise: 'unavailable' });
      if (error.code === 'io' || error.code === 'unavailable') throw error;
      diagnostics.failure('subordinate.birth_recovery_failed', error, { subordinate: entry.name });
    }
  }
  return roster.hasPendingBirths() || roster.pendingDeletions().length > 0;
}
