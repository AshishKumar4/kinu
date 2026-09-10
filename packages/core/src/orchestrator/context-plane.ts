/**
 * The actor's context plane: one place that sequences a turn boundary, an
 * authored edit, and the evidence each leaves behind.
 *
 * WHY ONE OBJECT. The pieces were reachable but never wired to each other: the
 * claim ledger could stage an edit, the step pipeline could land one, and
 * NOTHING called either arm — so the "editable working context" of the product
 * spec existed as a store method with no surface. Worse, the two halves used
 * different coordinate spaces (see `working-context.ts`). This module owns the
 * order of operations, and every surface that edits context — the `file` tool
 * on `/context`, a host's session-level restore, an owner's UI save — goes
 * through the same method, so none of them can invent a second policy.
 *
 * THE FOUR MOMENTS:
 *
 *  • `hydrate` — an activation loaded this actor's history from durable storage.
 *    The working ledger records it if it differs, so a cold start has a real
 *    revision to read and edit rather than an empty answer that would let an
 *    edit clobber the whole history.
 *  • `startTurn` — a turn is about to be admitted. A staged edit lands HERE if
 *    one is waiting (a turn boundary is a safe boundary), the newly delivered
 *    user input is preserved after it exactly once, and the resulting array is
 *    recorded as the working revision the claim will name.
 *  • `steps` — the per-step plane the request pipeline consumes: apply the
 *    working base, land a pending edit at the first safe step, report a
 *    deferral, record each rendered request against its working revision.
 *  • `endTurn` — the turn's messages are final. A pending edit lands if the
 *    tail lets it, and the working history is snapshotted so the NEXT turn (and
 *    anyone reading `/context`) sees the answer the turn produced.
 *
 * WHAT IT DOES NOT DO. It never mutates a rendered revision, never deletes a
 * working revision, and never fabricates an activation: a refused edit writes
 * no row and emits no event, and an edit that could not land stays staged with
 * the reason recorded. Retention and deletion are the owner's separate
 * authority (spec §6.4), not a side effect of editing.
 */

import type { ModelMessage } from 'ai';
import { KinuError } from '../obs/error';
import { applyStagedContext, unpairedToolCallIds } from '../prompting/staged-context';
import type { StepContextPlane } from '../prompting/prepare-step';
import { modelMessagesDigest, encodeModelMessages } from '../prompting/message-codec';
import type { ActorClaimStore, ActorTurnClaim } from './actor-claims';
import type {
  ActorWorkingContextStore, WorkingRevision, WorkingRevisionContent, WorkingVia,
} from './working-context';

/** When an authored edit becomes the request. */
export type ContextEditEffect = 'step' | 'turn';

/** What an authored edit did. Returned to whichever surface authored it, so a
 *  writer can say "staged as revision N, effective at the next step" instead of
 *  reporting a success that has not happened yet. */
export interface ContextEditReceipt {
  readonly revision: number;
  readonly baseRevision: number;
  readonly messageCount: number;
  readonly author: string;
  readonly via: WorkingVia;
  readonly effectiveAt: ContextEditEffect;
  /** The turn that was live when it was authored, or null between turns. */
  readonly turnId: string | null;
}

/** What `startTurn` resolved: the array the turn must be admitted with, and the
 *  working revision that array IS. */
export interface AdmittedContext {
  readonly messages: ModelMessage[];
  readonly workingRevision: number;
}

/**
 * What a finished turn left behind: the actor's working history, and the
 * revision it was recorded as.
 *
 * The caller MUST adopt `messages` as the actor's history. It is not
 * necessarily the array that was passed in: when an edit landed mid-turn, the
 * live array still carries the pre-edit prefix (a `prepareStep` override is
 * per-request and never feeds back into the SDK's own array), so the working
 * history is the landed revision plus the turn's tail — and a host that kept
 * the passed-in array would silently discard the edit at the turn boundary.
 */
export interface SettledContext {
  readonly messages: ModelMessage[];
  readonly revision: WorkingRevision;
}

export interface ActorContextPlane {
  /** Reconcile the ledger with the history an activation just loaded. */
  hydrate(history: readonly ModelMessage[]): WorkingRevision;
  /** The array a turn must be admitted with, after any staged edit lands. */
  startTurn(input: { readonly turnId: string; readonly history: readonly ModelMessage[] }): AdmittedContext;
  /** The per-step plane for one admitted claim. */
  steps(claim: ActorTurnClaim): StepContextPlane;
  /** Snapshot the working history a finished turn leaves behind. */
  endTurn(input: { readonly turnId: string; readonly history: readonly ModelMessage[] }): SettledContext;
  /**
   * Author an edit to this actor's working history.
   *
   * `base` is the revision the editor read (0 when the actor had none), which
   * is the compare-and-set: a write from a stale read is refused and the active
   * version is left intact. `messages` is validated as a native model-message
   * array by the codec and for tool-call pairing before anything is written.
   */
  edit(input: {
    readonly base: number;
    readonly messages: readonly ModelMessage[];
    readonly author: string;
    readonly via: Exclude<WorkingVia, 'runtime'>;
  }): ContextEditReceipt;
  /** What an editor reads: the newest revision, its content, and whether an
   *  edit of it would take effect at the next step or the next turn. */
  read(): ContextPlaneState;
}

/** What a boundary settled: the array the actor's history now IS, and the
 *  revision it was recorded as. */
interface ClosedBoundary {
  readonly messages: readonly ModelMessage[];
  readonly revision: WorkingRevision;
}

/** The plane's own view of where this actor stands. */
export interface ContextPlaneState {
  readonly actorId: string;
  /** The newest revision, or null for an actor that has never recorded one. */
  readonly head: WorkingRevisionContent | null;
  /** The revision the runtime is building requests from. */
  readonly active: WorkingRevisionContent | null;
  /** An authored edit waiting for a boundary. */
  readonly staged: WorkingRevisionContent | null;
  /** The turn in flight, or null. */
  readonly liveTurnId: string | null;
  /** Where an edit written now would take effect. */
  readonly effectiveAt: ContextEditEffect;
}

/**
 * The `context_edit` run event, as `events/recorder.ts` declares it.
 *
 * Two emissions per edit and no more: one when it is AUTHORED (`staged`, with
 * where it will take effect) and one when a boundary actually takes it
 * (`activated`, with the turn and step that did). A refused edit emits nothing
 * — there is no activation to report, and reporting one would be a record of
 * something that did not happen.
 */
export interface ContextEditEvent {
  readonly type: 'context_edit';
  readonly revision: number;
  readonly baseRevision: number;
  readonly messageCount: number;
  readonly author: string;
  readonly via: 'file' | 'session' | 'owner';
  readonly status: 'staged' | 'activated';
  readonly effectiveAt: ContextEditEffect;
  readonly turnId: string | null;
  readonly stepIndex: number | null;
}

/**
 * The recorder port this plane needs — one method, one variant.
 *
 * Structural rather than the whole `RunEventRecorder`, so this module states
 * exactly what it emits and a test can observe it without a database. The real
 * recorder satisfies it, and the assignment is checked HERE, where a mismatch
 * between the emitted shape and the declared variant belongs.
 */
export interface ContextEventRecorder {
  emit(runId: string, event: ContextEditEvent): void;
}

export interface ActorContextPlaneDeps {
  readonly claims: ActorClaimStore;
  /** Run-event evidence. Null is honest: a host with no recorder records the
   *  revision rows and no event, rather than a fabricated one. */
  readonly events?: ContextEventRecorder | null;
}

/**
 * Compose the plane over one actor's claim store.
 *
 * The working ledger comes off the claim store rather than being passed
 * separately: they are the two halves of one subject, and a caller that could
 * supply mismatched halves is a caller that can attribute one actor's edits to
 * another's turns.
 */
export function createActorContextPlane(deps: ActorContextPlaneDeps): ActorContextPlane {
  const { claims } = deps;
  const working: ActorWorkingContextStore = claims.working;
  const events = deps.events ?? null;

  const liveTurn = (): string | null => {
    const latest = claims.latestTurn();

    return latest !== null && latest.status === 'admitted' ? latest.turnId : null;
  };

  /** One authored or activated edit, on the actor's own run-event stream.
   *
   * The run id is the LIVE turn's, because that is the activation the event
   * belongs to. An edit authored between turns has no run: its evidence is the
   * revision row, and the activation that consumes it emits the `activated`
   * event under its own run id — so every edit that ever becomes effective is
   * in the event log, and nothing is attributed to a run that did not exist. */
  const record = (
    revision: WorkingRevision,
    status: 'staged' | 'activated',
    at: { readonly turnId: string | null; readonly stepIndex: number | null; readonly effectiveAt: ContextEditEffect },
  ): void => {
    if (events === null) return;
    const runId = at.turnId === null ? null : claims.read(at.turnId)?.runId ?? null;

    if (runId === null) return;
    events.emit(runId, {
      type: 'context_edit',
      revision: revision.revision,
      baseRevision: revision.baseRevision ?? 0,
      messageCount: revision.messageCount,
      author: revision.author,
      via: revision.via === 'runtime' ? 'session' : revision.via,
      status,
      effectiveAt: at.effectiveAt,
      turnId: at.turnId,
      stepIndex: at.stepIndex,
    });
  };

  /**
   * Whether a staged edit's base still exists in the live array.
   *
   * Checked at TURN boundaries only. Within a turn the prefix is stable by
   * construction — the SDK rebuilds every step from the array the stream was
   * started with, so the first `baseMessageCount` messages cannot change — but
   * between turns compaction may have rewritten durable history underneath a
   * pending edit, and re-appending a tail sliced out of a different array would
   * silently graft unrelated messages onto it.
   */
  const baseIntact = (staged: WorkingRevisionContent, history: readonly ModelMessage[]): boolean => {
    if (history.length < staged.baseMessageCount) return false;
    const base = staged.baseRevision === null ? null : working.revision(staged.baseRevision);

    if (base === null) return staged.baseMessageCount === 0;

    return modelMessagesDigest(encodeModelMessages(history.slice(0, staged.baseMessageCount))) === base.digest;
  };

  /**
   * The actor's working history right now: the active revision, plus whatever
   * the live array has added past the point that revision owns.
   *
   * This is the composition rule the whole plane rests on — a revision is a
   * prefix and an offset, so `active.messages ++ live.slice(offset)` is the
   * history, and for a plain snapshot (offset = its own length) it reduces to
   * the live array. It matters at a TURN boundary: when an edit landed
   * mid-turn, the SDK's own array still begins with the pre-edit prefix,
   * because a `prepareStep` override shapes one request and never becomes the
   * next step's input. Snapshotting the live array there would quietly discard
   * the edit the model already worked from.
   *
   * A live array SHORTER than the offset is not composed: something (a
   * compaction) rewrote history under the revision, and re-prefixing it would
   * resurrect messages the rewrite removed. The live array wins, and the next
   * `baseIntact` check closes any pending edit that named the old prefix.
   */
  const workingHistory = (history: readonly ModelMessage[]): readonly ModelMessage[] => {
    const active = working.active();

    if (active === null || history.length < active.baseMessageCount) return history;

    return [...active.messages, ...history.slice(active.baseMessageCount)];
  };

  /**
   * A turn boundary's disposition of a pending edit.
   *
   * `blocked` is the arm that keeps the promise: the edit waits, its reason is
   * recorded, and — crucially — NO snapshot is written above it. Appending one
   * would leave the edit based on a revision that is no longer the head, which
   * is how a pending edit becomes unlandable and disappears. The edit's own
   * offset still names the same prefix of the live array, so the next boundary
   * simply tries again with everything the turn added preserved as its tail.
   */
  type BoundaryDisposition =
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'lands'; readonly messages: readonly ModelMessage[]; readonly revision: number }
    | { readonly kind: 'blocked' };

  const atTurnBoundary = (history: readonly ModelMessage[]): BoundaryDisposition => {
    const staged = working.staged();

    if (staged === null) return { kind: 'unchanged' };

    if (!baseIntact(staged, history)) {
      // Terminal, and the one case where a pending edit does not survive: the
      // history it named is gone, so the tail it protects cannot be identified.
      // Closed with the reason and retained — applying it over a rewritten
      // history would graft unrelated messages into the actor's context.
      working.close(staged.revision, 'history_rewritten');

      return { kind: 'unchanged' };
    }

    const outcome = applyStagedContext(history, {
      messages: staged.messages, baseMessageCount: staged.baseMessageCount, pending: true,
    });

    if (outcome.kind === 'deferred') {
      working.defer(staged.revision, outcome.reason);

      return { kind: 'blocked' };
    }

    return { kind: 'lands', messages: outcome.messages, revision: staged.revision };
  };

  /** Write the boundary's result: the array the turn runs on, and the working
   *  revision it IS. A blocked edit leaves the ledger alone and reuses the
   *  active revision, whose content plus the live tail is exactly this array. */
  const closeBoundary = (
    turnId: string, history: readonly ModelMessage[], disposition: BoundaryDisposition,
  ): ClosedBoundary => {
    if (disposition.kind === 'blocked') {
      const active = working.active();

      if (active !== null) return { messages: history, revision: active };
    }

    const messages = disposition.kind === 'lands' ? disposition.messages : history;

    const revision = working.append({
      messages,
      source: 'turn',
      turnId,
      lands: disposition.kind === 'lands' ? { revision: disposition.revision, stepIndex: null } : null,
    });

    if (disposition.kind === 'lands') {
      const activated = working.revision(disposition.revision);

      if (activated !== null) {
        record(activated, 'activated', { turnId, stepIndex: null, effectiveAt: 'turn' });
      }
    }

    return { messages, revision };
  };

  return {
    hydrate(history) {
      const staged = working.staged();

      if (staged !== null && baseIntact(staged, history)) {
        // A pending edit survives a restart. Recording a snapshot over it would
        // leave it based on a revision that is no longer the head, so the
        // snapshot waits: the edit's own offset still names the same prefix,
        // and the next turn boundary lands it.
        return staged;
      }

      return working.append({ messages: history, source: 'hydrate', turnId: null });
    },

    startTurn({ turnId, history }) {
      const composed = workingHistory(history);
      const closed = closeBoundary(turnId, composed, atTurnBoundary(composed));

      return { messages: [...closed.messages], workingRevision: closed.revision.revision };
    },

    steps(claim) {
      return {
        base: () => {
          const staged = working.staged();

          if (staged !== null) {
            return {
              revision: staged.revision,
              messages: staged.messages,
              baseMessageCount: staged.baseMessageCount,
              pending: true,
            };
          }

          const active = working.active();

          // Null when the turn still runs on exactly what it was admitted with:
          // re-applying that array would copy it for nothing. A landed edit
          // from an earlier step of THIS turn is a different revision, and it
          // must be re-applied at every later step, because a prepareStep
          // override is not history — the SDK rebuilds the next step from the
          // array the stream started with.
          if (active === null || active.revision === claim.workingRevision) return null;

          return {
            revision: active.revision,
            messages: active.messages,
            baseMessageCount: active.baseMessageCount,
            pending: false,
          };
        },
        consume: ({ stepNumber, messages, base, deferred }) => {
          if (base !== null && base.pending) {
            const activated = working.activate(base.revision, { turnId: claim.turnId, stepIndex: stepNumber });
            record(activated, 'activated', { turnId: claim.turnId, stepIndex: stepNumber, effectiveAt: 'step' });
          }

          if (deferred !== null) {
            const staged = working.staged();

            if (staged !== null) working.defer(staged.revision, deferred);
          }

          claims.consume(claim, {
            index: stepNumber,
            messages,
            workingRevision: base?.revision ?? claim.workingRevision,
          });
        },
      };
    },

    endTurn({ turnId, history }) {
      const composed = workingHistory(history);
      const closed = closeBoundary(turnId, composed, atTurnBoundary(composed));

      return { messages: [...closed.messages], revision: closed.revision };
    },

    edit(input) {
      // The pairing rule is a DELTA, not an absolute. An actor's own history
      // legitimately ends with an unanswered tool call — that is what an
      // interrupted turn leaves, and `prompting/interrupted-tool-calls.ts`
      // settles it at turn assembly. Refusing every array that contains one
      // would make the actor's real history unreadable-and-unwritable exactly
      // when it most needs correcting. What is refused is an edit that SEVERS a
      // pair the base had joined: a call whose result the editor deleted.
      const base = input.base === 0 ? null : working.revision(input.base);
      const already = base === null ? new Set<string>() : unpairedToolCallIds(base.messages);
      const severed = [...unpairedToolCallIds(input.messages)].filter((id) => !already.has(id));

      if (severed.length > 0) {
        throw new KinuError('bad_input',
          `this context leaves tool call(s) ${severed.join(', ')} without their result, and the revision it was `
          + 'written against had them answered — a request with an unanswered tool call is refused by the '
          + 'provider, so the edit was not staged. Delete the assistant message that made the call as well, '
          + 'or keep its result.');
      }

      const turnId = liveTurn();

      const staged = working.stage({
        base: input.base,
        messages: input.messages,
        author: input.author,
        via: input.via,
        turnId,
      });

      const effectiveAt: ContextEditEffect = turnId === null ? 'turn' : 'step';
      record(staged, 'staged', { turnId, stepIndex: null, effectiveAt });

      return {
        revision: staged.revision,
        baseRevision: input.base,
        messageCount: staged.messageCount,
        author: staged.author,
        via: staged.via,
        effectiveAt,
        turnId,
      };
    },

    read() {
      const turnId = liveTurn();

      return {
        actorId: claims.actorId,
        head: working.head(),
        active: working.active(),
        staged: working.staged(),
        liveTurnId: turnId,
        effectiveAt: turnId === null ? 'turn' : 'step',
      };
    },
  };
}
