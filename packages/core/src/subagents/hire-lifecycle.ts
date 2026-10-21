/**
 * The one hire lifecycle (`SubagentRuntime`), the cloud's and the CLI's: a hire registered and its birth cancelled, a
 * newborn's name, role and tier, work admitted with the delivery that opens its turn, its status, a rename, and a subtree
 * dismissed. A backend gives it only the acts it alone can do (seat a hire, write a newborn, deliver, retire); every rule
 * is here, so a rule the two backends once held apart is held once (InternalFish #12, 2026-10-20).
 */
import { Effect } from 'effect';
import { KinuError, settle } from '../obs/index';
import { EventLog, type PublishResult } from '../events/hub/log';
import type { SqlExec } from '../types/primitives';
import type { WorkMode } from '../types/turn';
import type { SubagentInheritedContext } from '../types/subagents';
import { actorReferenceOf, type ActorHandle, type ActorReference } from '../identity/actor-handle';
import { isSubagentOrigin, subagentDescendants, type WorkspaceActor, type WorkspaceActorDirectory } from '../identity/workspace-actors';
import { titleActorFromMessage } from '../identity/naming';
import type { AgentConfigStore } from '../config/store';
import type { ActorRetirement } from '../state/actor-host';
import type { JobRetirement } from '../jobs/runner';
import { assignmentDelivery, type OwedAdmission } from './deliveries';
import { delegationBudgetOf, delegationDepthRefusal, delegationExhausted } from './depth';
import type { SubagentRosterStore } from './roster';
import type { SubagentSeed } from './birth';
import { admitSubagentTask, describeSubagentHandoff, readSubagentLiveStatus, type SubagentRuntime } from './support';

/** A hire as one call reaches it, where its backend runs it. */
export interface SeatedHire {
  readonly handle: ActorHandle;
  /** Its event log's and live status's SQL. */
  readonly exec: SqlExec;
  /** Whether a turn of its runs now. */
  readonly turnInFlight: () => boolean;
}

/** What a backend gives the lifecycle: its directory and host, and the acts only it can do; `Seat` is its own seated hire. */
export interface HireLifecyclePorts<Seat extends SeatedHire = SeatedHire> {
  /** The hiring actor as it is at this call. */
  readonly parent: () => { readonly reference: ActorReference; readonly record: WorkspaceActor };
  readonly directory: Pick<WorkspaceActorDirectory, 'apply' | 'storagePath' | 'retained' | 'list'>;
  /** An actor's row, for the hirer's delegation depth. */
  readonly describe: (actorId: string) => Pick<WorkspaceActor, 'parentActorId'> | null;
  /** A hire just registered, written by `seed` (its name, role and tier) before anything runs it. */
  readonly born: (reference: ActorReference, name: string, seed: (config: AgentConfigStore) => void) => Promise<void>;
  /** Runs `body` as the hire `reference` names. */
  readonly asHire: <Result>(reference: ActorReference, name: string, body: (hire: Seat) => Promise<Result>) => Promise<Result>;
  /** What `admit` writes and the delivery it owes the hire, committed as one, and its turn woken to take it. */
  readonly deliver: (hire: Seat, admit: () => OwedAdmission<PublishResult>) => Promise<PublishResult>;
  /** Who assigns the hire its work, as its chat shows it. */
  readonly hirerName: (hire: Seat) => string;
  /** The hire's title moved: whatever lists it reads it again. */
  readonly announce: (hire: Seat) => void;
  /** Stops the running jobs of one actor, and says which it could not confirm stopped. */
  readonly retireJobs: (actorId: string) => Promise<JobRetirement>;
  /** The roster of the actor that hired `hirer`'s child. */
  readonly roster: (hirer: ActorReference) => SubagentRosterStore;
  /** Retires an actor under `parent`, ending what this backend holds of it. */
  readonly retire: (parent: ActorReference, retirement: ActorRetirement) => Promise<void>;
}

/** Work a hire is given: its brief or a later message. */
interface HireWork {
  readonly kind: 'task' | 'message';
  readonly body: string;
  readonly mode: WorkMode;
  readonly deliverable?: string;
  readonly inheritedContext?: SubagentInheritedContext;
  readonly creationId?: string;
}

const refusal = (refused: boolean, error: () => KinuError): Effect.Effect<void, KinuError> => (refused ? Effect.fail(error()) : Effect.void);

/** A dismissal's flags as the host's retirement reads them: one that keeps no history destroys. */
function retirementFor(reference: ActorReference, name: string, keepHistory: boolean, interrupt: boolean): ActorRetirement {
  return { reference, name, destroy: !keepHistory, interrupt };
}

/**
 * Admits `work` to the hire and owes it the delivery that opens its turn. The first work it is given is its brief: its
 * stand-in title shows at once, before the turn that opens its chat names it from the same words. A later message
 * ("Continue") never titles it.
 */
export function admitHireWork<Seat extends SeatedHire>(ports: HireLifecyclePorts<Seat>, reference: ActorReference, name: string, work: HireWork) {
  return refusal(work.creationId !== undefined && work.creationId !== ports.directory.retained(reference.actorId)?.creationId,
    () => new KinuError('denied', 'The birth assignment belongs to a different actor creation.'))
    .pipe(Effect.andThen(Effect.promise(() => ports.asHire(reference, name, async (hire) => {
      const busy = hire.turnInFlight();
      const log = new EventLog(hire.exec, hire.handle);
      const brief = log.query({ variant: 'subagent_task', limit: 1 }).length === 0;
      const admission: Parameters<typeof admitSubagentTask>[1] = { fromWorkspace: hire.handle.workspaceId, kind: work.kind, body: work.body, mode: work.mode, now: Date.now() };

      if (work.deliverable) admission.deliverable = work.deliverable;

      if (work.inheritedContext) admission.inheritedContext = work.inheritedContext;

      if (work.creationId !== undefined) admission.creationId = work.creationId;

      const admitted = await ports.deliver(hire, () => {
        const result = admitSubagentTask(log, admission);

        return { value: result, delivery: result.admitted ? assignmentDelivery(log, { id: result.id, body: work.body.trim(), mode: work.mode, from: ports.hirerName(hire) }) : null };
      });

      if (admitted.admitted && brief && (await titleActorFromMessage(hire.handle, work.body)).changed) ports.announce(hire);

      return describeSubagentHandoff({ admission: admitted, turnInFlight: busy, live: readSubagentLiveStatus(hire.exec, hire.handle) });
    }))));
}

/** Each hire below `below`, its row dismissed on its hirer's roster and retired under it: a dismissal's subtree, and a
 *  stopped task agent's. */
export async function retireHireSubtree(
  ports: Pick<HireLifecyclePorts, 'directory' | 'roster' | 'retire'>, below: ActorReference, keepHistory: boolean,
): Promise<void> {
  for (const descendant of subagentDescendants(ports.directory.list(), below.actorId)) {
    const hirer = ports.directory.retained(descendant.parentActorId ?? '');

    if (hirer === null) continue;
    const roster = ports.roster(actorReferenceOf(hirer));

    if (roster.get(descendant.name)?.status !== 'dismissed') roster.dismiss(descendant.name, Date.now());
    await ports.retire(actorReferenceOf(hirer), retirementFor(actorReferenceOf(descendant), descendant.name, keepHistory, true));
  }
}

/** The one hire lifecycle over `ports`. */
export function hireLifecycle<Seat extends SeatedHire>(ports: HireLifecyclePorts<Seat>): SubagentRuntime {
  const inDirectory = (action: 'register' | 'cancelCreation', input: SubagentSeed & { creationId: string }): ActorReference => {
    const owner = ports.parent().reference;

    return ports.directory.apply(owner, ports.directory.storagePath(owner), {
      action, name: input.name, creationId: input.creationId, origin: input.origin, lifetime: input.lifetime,
    }).reference;
  };

  /** A live hire of the parent's, by name: never a swarm worker, nor one already retiring. */
  const resolve = (name: string): Effect.Effect<ActorReference, KinuError> => Effect.suspend(() => {
    const owner = ports.parent().reference;
    const entry = ports.directory.apply(owner, ports.directory.storagePath(owner), { action: 'resolve', name });

    return refusal(!isSubagentOrigin(entry.origin), () => new KinuError('denied', 'The roster name does not identify a subagent.'))
      .pipe(Effect.andThen(refusal(entry.state !== 'active', () => new KinuError('missing', 'The hire is retired.'))), Effect.as(entry.reference));
  });

  const asHire = <Result>(name: string, body: (hire: Seat) => Promise<Result>): Effect.Effect<Result, KinuError> =>
    Effect.flatMap(resolve(name), (reference) => Effect.promise(() => ports.asHire(reference, name, body)));

  return {
    spawn: (input) => settle(Effect.gen(function* () {
      const budget = delegationBudgetOf(ports.describe, ports.parent().record);

      yield* refusal(delegationExhausted(budget), () => new KinuError('denied', delegationDepthRefusal(budget).error));
      const reference = inDirectory('register', input);

      // The child's own config rows only; the parent's roster row is core's (`createTeamToolDeps`), one writer per fact.
      yield* Effect.promise(() => ports.born(reference, input.name, (config) => {
        config.setDisplayNameOrigin(input.displayName, input.nameOrigin);
        config.setRoleSelection(input.role);
        config.setAssignedTier(input.tier ?? null);
      }));

      return reference;
    })),
    // Its row cancelled, then retired and destroyed as every retirement is: a cancelled hire leaves no row or storage.
    cancelBirth: (input) => settle(Effect.gen(function* () {
      const reference = inDirectory('cancelCreation', input);

      yield* Effect.promise(() => ports.retire(ports.parent().reference, { reference, name: input.name, destroy: true, interrupt: true }));

      return reference;
    })),
    assign: (name, input) => settle(Effect.flatMap(resolve(name), (reference) => admitHireWork(ports, reference, name, { kind: 'task', ...input }))),
    status: (name) => settle(asHire(name, async (hire) => readSubagentLiveStatus(hire.exec, hire.handle))),
    message: (name, content, mode) => settle(Effect.flatMap(resolve(name), (reference) => admitHireWork(ports, reference, name, { kind: 'message', body: content, mode }))),
    rename: (name, displayName, nameOrigin) => settle(asHire(name, async (hire) => { hire.handle.config.setDisplayNameOrigin(displayName, nameOrigin); })),
    /** Its subtree's jobs stop first, or none retires; then its hires, then it. Wipe removes rows and home; archive keeps them. */
    dismiss: (name, { keepHistory, interrupt }, reference) => settle(Effect.gen(function* () {
      const stoppedJobs: string[] = [];
      const refused: string[] = [];

      for (const actorId of [...subagentDescendants(ports.directory.list(), reference.actorId).map((record) => record.actorId), reference.actorId]) {
        const retirement = yield* Effect.promise(() => ports.retireJobs(actorId));

        stoppedJobs.push(...retirement.stopped);
        refused.push(...retirement.refused);
      }

      yield* refusal(refused.length > 0, () => new KinuError('unavailable',
        `${name} keeps running: nothing confirmed its job(s) ${refused.join(', ')} stopped${stoppedJobs.length === 0 ? '' : `; ${stoppedJobs.join(', ')} stopped`}.`));
      yield* Effect.promise(() => retireHireSubtree(ports, reference, keepHistory));
      yield* Effect.promise(() => ports.retire(ports.parent().reference, retirementFor(reference, name, keepHistory, interrupt)));

      return { stoppedJobs };
    })),
  };
}
