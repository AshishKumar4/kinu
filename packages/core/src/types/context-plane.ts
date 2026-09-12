/** The working-revision and context-edit contract, declared at the platform
 *  layer: the VFS context plane renders revisions and the orchestrator planes
 *  own them, sharing one source instead of importing upward. */

import type { ModelMessage } from 'ai';

/** Why a boundary could not take a pending revision. */
export const STAGED_CONTEXT_DEFERRALS = ['unpaired_tool_call', 'history_rewritten'] as const;

export type StagedContextDeferral = (typeof STAGED_CONTEXT_DEFERRALS)[number];

/** How a revision came to exist. */
export const WORKING_SOURCES = ['hydrate', 'turn', 'edit'] as const;

export type WorkingSource = (typeof WORKING_SOURCES)[number];

/**
 * Where a revision stands.
 *
 * `active` is the one the runtime builds requests from — at most one per actor.
 * `staged` is an authored edit waiting for a safe boundary. `superseded` is
 * every revision that is neither, whether it was effective once (its
 * `activatedAt` says so) or never became effective (`closedReason` says why).
 */
export const WORKING_STATUSES = ['staged', 'active', 'superseded'] as const;

export type WorkingStatus = (typeof WORKING_STATUSES)[number];

/** Which surface authored a revision. `runtime` is the host recording what the
 *  actor's own history now is; the other three are edits. */
export const WORKING_VIAS = ['runtime', 'file', 'session', 'owner'] as const;

export type WorkingVia = (typeof WORKING_VIAS)[number];

/** Why a staged edit was closed without ever becoming effective. */
export const WORKING_CLOSED_REASONS = ['history_rewritten', 'superseded_by_edit'] as const;

export type WorkingClosedReason = (typeof WORKING_CLOSED_REASONS)[number];

/** One revision's metadata — everything except the messages themselves, which
 *  a listing must not pay for. */
export interface WorkingRevision {
  readonly revision: number;
  /** The revision this content was derived from, or null for the first one. */
  readonly baseRevision: number | null;
  /** Where the material this revision does not own begins in the live array. */
  readonly baseMessageCount: number;
  readonly source: WorkingSource;
  readonly status: WorkingStatus;
  readonly via: WorkingVia;
  /** The ISSUED actor id that authored it: the actor itself, or the parent/owner
   *  that edited it through an authorized surface. */
  readonly author: string;
  readonly digest: string;
  readonly messageCount: number;
  /** The turn that was live when it was authored, or null between turns. */
  readonly turnId: string | null;
  /** The turn whose boundary made it effective, null while it never was. */
  readonly activatedTurnId: string | null;
  /** The step index it landed at, null for a turn-boundary activation. */
  readonly activatedStep: number | null;
  readonly activatedAt: number | null;
  /** Why the last boundary that saw this staged revision could not take it.
   *  Null once it activates, and null while nothing has blocked it — a pending
   *  edit that reads as blocked says so instead of looking ignored. */
  readonly deferredReason: StagedContextDeferral | null;
  readonly deferredAt: number | null;
  readonly closedReason: WorkingClosedReason | null;
  readonly recordedAt: number;
}

/** A revision with its array decoded. */
export interface WorkingRevisionContent extends WorkingRevision {
  readonly messages: ModelMessage[];
}

/** When an authored edit becomes the request. */
export type ContextEditEffect = 'step' | 'turn';

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
