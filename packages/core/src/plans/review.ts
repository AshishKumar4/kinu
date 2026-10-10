import { Cause, Effect, Result } from 'effect';
import { settle, settleSync } from '../obs/effect';
import { markStoreChanged } from '@kinu.run/agent-utils';
import * as v from 'valibot';
import type { WorkMode } from '../types/turn';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { nanoid } from '../utils/nanoid';
import { JsonArraySchema, type JsonObject } from '../utils/json';
import { turnAuthor } from '../utils/ui-message';
import { renderThrownChain } from '../obs/index';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { seekPage, StaleCursorError, type Page, type PageRequest } from '../session/page';
import { boundedInt } from '../utils/bounds';
import type {
  NoteReply, PlanDecisionOutcome, PlanEdit, PlanReview, ReviewAnnotation, PlanReviewDecision, PlanReviewResult, PlanReviewStatus,
} from '../types/plans';
import type { BackendHost, EnqueueTurnResult, ProgrammaticTurn } from '../types/backend-host';
import { admitReviewAnnotations, byteLength, MAX_PLAN_ANNOTATIONS_BYTES } from './annotation-admission';
import type { TaskPlan } from '../tools/task-plan-scope';
import { OWNER_ANSWER_SIGNAL } from '../types/owner-questions';

export type {
  PlanAnnotationMathTarget, PlanAnnotationTextPosition, PlanDecisionOutcome, PlanEdit,
  DiffAnchor, DiffSide, GeneralNote, NoteReply, PassageNote, PlanReview, ReviewAnnotation, PlanReviewDecision, PlanReviewResult,
  PlanReviewStatus, ReplyToCommentToolDeps, SubmitPlanToolDeps,
} from '../types/plans';

// Content plus annotations_json share one row capped at do.sqlite.row_bytes; this cap and MAX_PLAN_ANNOTATIONS_BYTES fit inside it together.
export const MAX_PLAN_CONTENT_BYTES = 1536 * 1024;

/** Read on call: the browser imports this module's schemas, and a module-scope read ships the whole catalog to it. */
function planReviewRowBytes(): number {
  return PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value;
}

const PlanReviewStatusSchema = v.picklist([
  'pending', 'changes_requested', 'approved', 'superseded', 'dismissed',
]);

export const PlanReviewSchema = v.object({
  id: v.string(), sessionId: v.string(), revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  content: v.string(), status: PlanReviewStatusSchema,
  annotations: v.pipe(JsonArraySchema, v.rawTransform(({ dataset, addIssue, NEVER }): readonly ReviewAnnotation[] => {
    const admitted = admitReviewAnnotations({ value: dataset.value });

    if (Result.isFailure(admitted)) {
      addIssue({ message: admitted.failure.error });

      return NEVER;
    }

    return admitted.success;
  })),
  feedback: v.nullable(v.string()), handoffAccepted: v.boolean(),
  createdAt: v.number(), updatedAt: v.number(),
});

/** The store's answer to a save, a dismissal or a submission, as it crosses a wire. */
export const PlanReviewResultSchema: v.GenericSchema<unknown, PlanReviewResult> = v.variant('ok', [
  v.object({ ok: v.literal(true), plan: PlanReviewSchema }),
  v.object({ ok: v.literal(false), error: v.string(), plan: v.nullable(PlanReviewSchema) }),
]);

/** The answer to a decision, whole: `queued` says whether the turn it hands off was admitted. */
export const PlanDecisionOutcomeSchema: v.GenericSchema<unknown, PlanDecisionOutcome> = v.variant('ok', [
  v.object({ ok: v.literal(true), plan: PlanReviewSchema, queued: v.boolean(), queueError: v.optional(v.string()) }),
  v.object({ ok: v.literal(false), error: v.string(), plan: v.nullable(PlanReviewSchema) }),
]);

/** What a recorded decision still owes, in words, or null once the turn it hands off was admitted. */
export function planHandoffShortfall(outcome: PlanDecisionOutcome): string | null {
  if (!outcome.ok || outcome.queued) return null;

  return `Decision saved, but the next turn could not start${outcome.queueError === undefined ? '.' : `: ${outcome.queueError}`}`;
}

export function planReviewAwaitingDecision(
  review: Pick<PlanReview, 'status' | 'handoffAccepted'> | null | undefined,
): boolean {
  return review?.status === 'pending'
    || review?.status === 'changes_requested'
    || (review?.status === 'approved' && !review.handoffAccepted);
}

/** `active` is read only for an operator Build turn, the one case the review can hold. */
export function workModeUnderReview(
  requested: WorkMode,
  metadata: JsonObject | undefined,
  active: () => Pick<PlanReview, 'status' | 'handoffAccepted'> | null,
): WorkMode {
  if (requested !== 'build' || metadata?.kinuMode === 'build' || turnAuthor({ metadata }) !== 'operator') return requested;

  return planReviewAwaitingDecision(active()) ? 'plan' : requested;
}

/** First non-empty line of the content as plain text: its heading marks and code spans' backticks stripped. */
export function planTitle(content: string): string {
  return content.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').replace(/`([^`]*)`/g, '$1').trim() ?? 'Plan';
}

/** Pending plan reviews workspace-wide with owner name and id. Retired actors stay included: their undecided plan is still undecided. */
export function listPendingPlanReviews(
  sql: SqlExecutor,
): ReadonlyArray<{ owner: string; actor: string; id: string; revision: number; content: string; updatedAt: number }> {
  return sql<{ owner: string; actor: string; id: string; revision: number; content: string; updated_at: number }>`
    SELECT a.name AS owner, a.actor_id AS actor, r.id, r.revision, r.content, r.updated_at
    FROM plan_reviews r JOIN workspace_actors a ON a.actor_id = r.actor_id
    WHERE r.status = 'pending'
    ORDER BY r.updated_at DESC`.map((row) => ({ ...row, updatedAt: row.updated_at }));
}

interface PlanReviewRow {
  id: string;
  session_id: string;
  revision: number;
  content: string;
  status: string;
  annotations_json: string;
  feedback: string | null;
  handoff_accepted: number;
  handoff_attempt: number;
  created_at: number;
  updated_at: number;
}

function toPlanReview(row: PlanReviewRow): PlanReview {
  // Only admitted annotations are ever written, so the stored list is read back as is.
  const annotations: ReviewAnnotation[] = JSON.parse(row.annotations_json);

  return {
    id: row.id,
    sessionId: row.session_id,
    revision: row.revision,
    content: row.content,
    status: v.is(PlanReviewStatusSchema, row.status) ? row.status : 'pending',
    annotations,
    feedback: row.feedback,
    handoffAccepted: row.handoff_accepted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function initPlanReviewTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS plan_reviews (
    actor_id         TEXT NOT NULL,
    id               TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    content          TEXT NOT NULL,
    status           TEXT NOT NULL,
    annotations_json TEXT NOT NULL DEFAULT '[]',
    feedback         TEXT,
    handoff_accepted INTEGER NOT NULL DEFAULT 0 CHECK (handoff_accepted IN (0, 1)),
    handoff_attempt  INTEGER NOT NULL DEFAULT 0 CHECK (handoff_attempt >= 0),
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id, revision)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_plan_reviews_session_current
    ON plan_reviews(actor_id, session_id, created_at DESC)`);
}

/** Line coordinates are one-indexed, inclusive, and refer to the pre-edit document for the batch. */
export function validatePlanEdits(existingLines: readonly string[], edits: readonly PlanEdit[]): string | null {
  if (edits.length === 0) return 'at least one edit is required';
  const lineCount = existingLines.length;

  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || edit.start < 1) {
      return `start must be a positive integer >= 1, got ${edit.start}`;
    }

    if (edit.start > lineCount + 1) {
      return `start (${edit.start}) exceeds file length + 1 (${lineCount + 1})`;
    }

    if (edit.end != null) {
      if (!Number.isInteger(edit.end) || edit.end < edit.start) {
        return `end (${edit.end}) must be an integer >= start (${edit.start})`;
      }

      if (lineCount > 0 && edit.end > lineCount) {
        return `end (${edit.end}) exceeds file length (${lineCount})`;
      }
    }
  }

  const sorted = [...edits].sort((a, b) => a.start - b.start);

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];

    if (previous.start > lineCount) continue;
    const previousEnd = previous.end ?? lineCount;

    if (current.start <= previousEnd) {
      return `edits overlap: [${previous.start},${previousEnd}] and [${current.start},${current.end ?? 'end'}]`;
    }
  }

  return null;
}

export function applyPlanEdits(existingLines: readonly string[], edits: readonly PlanEdit[]): string[] {
  return settleSync(Effect.gen(function* () {
    const invalid = validatePlanEdits(existingLines, edits);

    if (invalid) return yield* Effect.die(new Error(invalid));

    const lines = [...existingLines];
    let offset = 0;

    for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
      const start = edit.start - 1 + offset;
      const end = edit.end != null ? edit.end + offset : lines.length;
      const replacement = edit.content ? edit.content.split('\n') : [];
      const removed = end - start;
      lines.splice(start, removed, ...replacement);
      offset += replacement.length - removed;
    }

    const content = lines.join('\n');

    if (!content.trim()) return yield* Effect.die(new Error('plan content is empty after applying edits'));

    if (byteLength(content) > MAX_PLAN_CONTENT_BYTES) {
      return yield* Effect.die(new Error('plan content exceeds the maximum size of 1.5 MiB'));
    }

    return lines;
  }));
}

export function formatPlanWithLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;

  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join('\n');
}

interface PlanHandoffTurn {
  readonly text: string;
  readonly metadata: JsonObject;
}

/** Written on this revision rather than carried from an earlier one: what a decision on it sends. */
export function freshNotes(notes: readonly ReviewAnnotation[]): ReviewAnnotation[] {
  return notes.filter((note) => note.revision === undefined);
}

function quoted(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();

  return `"${flat.length > 160 ? `${flat.slice(0, 157)}...` : flat}"`;
}

function noteLine(note: Exclude<ReviewAnnotation, NoteReply>): string {
  const carried = note.revision === undefined ? '' : `, from revision ${String(note.revision)}`;

  if (note.type === 'GLOBAL_COMMENT') return `Comment ${note.id} on the whole plan${carried}: ${note.text}`;

  if (note.type === 'DELETION') return `Comment ${note.id}${carried}: remove ${quoted(note.originalText)}${note.text ? `. ${note.text}` : ''}`;

  return `Comment ${note.id} on ${quoted(note.originalText)}${carried}: ${note.text ?? ''}`;
}

/**
 * Whether `notes`, as the next revision would carry them (each stamped with `revision`), fit the annotation budget and,
 * beside `content`, the stored row: a write admits only a list its revision can still carry.
 */
function carryRefusal(content: string, notes: readonly ReviewAnnotation[], revision: number): string | null {
  const carried = byteLength(JSON.stringify(notes.map((note) => note.revision === undefined ? { ...note, revision } : note)));

  if (carried > MAX_PLAN_ANNOTATIONS_BYTES) return `the review's comments would exceed the maximum size of ${String(MAX_PLAN_ANNOTATIONS_BYTES / 1024)} KiB`;

  const rowBytes = planReviewRowBytes();

  return byteLength(content) + carried > rowBytes
    ? `plan content and annotations exceed the stored row size of ${String(rowBytes)} bytes` : null;
}

/**
 * Whether a turn may offer `submit_plan`: any Plan turn, which a submission from the harness then refuses with its
 * reason; and in Build, only the owner's own turn or their review's feedback turn, so no harness turn is offered it.
 */
export function planSubmissionReach(mode: WorkMode, driving: JsonObject | undefined): boolean {
  return mode === 'plan' || planSubmissionAllowed(driving);
}

/** The owner's own turn, the feedback turn of their review, or the turn their answer resumes: the owner's conversation. */
function planSubmissionAllowed(driving: JsonObject | undefined): boolean {
  return turnAuthor({ metadata: driving }) === 'operator' || driving?.kinuEvent === 'plan_feedback' || driving?.kinuEvent === OWNER_ANSWER_SIGNAL;
}

/**
 * Whether a turn may answer comments of `plan`, the active revision: it was sent back with comments, and the turn is the
 * owner's own or that revision's feedback turn. The reply tool's gate, and its check when called.
 */
export function planAwaitingReply(plan: PlanReview | null, driving: JsonObject | undefined): boolean {
  if (plan?.status !== 'changes_requested' || !planSubmissionAllowed(driving)) return false;

  if (driving?.kinuEvent === 'plan_feedback' && (driving.planId !== plan.id || driving.revision !== plan.revision)) return false;

  return freshNotes(plan.annotations).some((note) => note.type !== 'REPLY' || note.author === 'owner');
}

/** The owner's comments and replies written on this revision, each under its id so the agent can answer it. */
export function reviewFeedbackText(notes: readonly ReviewAnnotation[]): string {
  const roots = new Map(notes.flatMap((note) => note.type === 'REPLY' ? [] : [[note.id, note] as const]));
  const fresh = freshNotes(notes);
  const answered = new Set(fresh.flatMap((note) => note.type === 'REPLY' && note.author === 'owner' ? [note.inReplyTo] : []));
  const threads = [...roots.values()].filter((note) => note.revision === undefined || answered.has(note.id));

  return threads.flatMap((root) => [
    `- ${noteLine(root)}`,
    ...fresh.flatMap((note) => note.type === 'REPLY' && note.author === 'owner' && note.inReplyTo === root.id ? [`  - Owner's reply: ${note.text}`] : []),
  ]).join('\n');
}

function planHandoffTurn(plan: PlanReview, decision: PlanReviewDecision): PlanHandoffTurn {
  const text = decision === 'request_changes'
    ? [
        `The owner requested changes to plan ${plan.id} revision ${plan.revision}.`,
        '',
        '## Review feedback',
        plan.feedback ?? '',
        '',
        'Answer with reply_to_comment, naming the comment\'s id, a comment that asks a question or one the revision will not simply follow; then revise.',
        '',
        `## Current plan (${plan.content.split('\n').length} lines)`,
        'Use these exact pre-edit line numbers in the next submit_plan call:',
        '',
        '```',
        formatPlanWithLineNumbers(plan.content),
        '```',
        '',
        'Revise the plan with targeted submit_plan edits. Do not implement or create previews.',
      ].join('\n')
    : [
        `The owner approved plan ${plan.id} revision ${plan.revision}.`,
        ...(plan.feedback ? ['', 'Approval notes:', plan.feedback] : []),
        '',
        'Implement the exact approved plan below. Verify the result and report any necessary deviation explicitly.',
        '',
        '<approved-plan>',
        plan.content,
        '</approved-plan>',
      ].join('\n');

  return {
    text,
    metadata: {
      kinuEvent: decision === 'approve' ? 'plan_approved' : 'plan_feedback',
      kinuMode: decision === 'approve' ? 'build' : 'plan',
      planId: plan.id,
      revision: plan.revision,
      decision,
    },
  };
}

const PlanHandoffMetadataSchema = v.object({
  kinuEvent: v.picklist(['plan_approved', 'plan_feedback']),
  planId: v.string(),
  revision: v.number(),
});

const PlanApprovalMetadataSchema = v.looseObject({
  kinuEvent: v.literal('plan_approved'), planId: v.string(),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)), decision: v.literal('approve'),
});

/** The plan a turn implements when it is an approval's handoff, keyed as the decision minted it; honoured only while
 *  the row still says approved. Null otherwise. */
export function approvedTaskPlan(
  item: { readonly kind: 'user' | 'programmatic'; readonly metadata?: JsonObject; readonly idempotencyKey?: string },
  plans: Pick<PlanReviewStore, 'get'>,
): TaskPlan | null {
  const parsed = item.kind === 'programmatic' ? v.safeParse(PlanApprovalMetadataSchema, item.metadata) : null;

  if (parsed?.success !== true) return null;
  const { planId, revision } = parsed.output;
  const prefix = `plan:${planId}:${String(revision)}:approve:`;
  const key = item.idempotencyKey ?? '';

  if (!key.startsWith(prefix) || !/^\d+$/.test(key.slice(prefix.length))) return null;
  const plan = plans.get(planId, revision);

  return plan?.status === 'approved' && plan.sessionId === CHAT_SESSION_ID
    ? Object.freeze({ id: plan.id, revision: plan.revision, sessionId: plan.sessionId })
    : null;
}

/** Owed while the plan row still holds that decision. */
export function planHandoffStillOwed(
  metadata: JsonObject | undefined,
  plans: Pick<PlanReviewStore, 'get'>,
): boolean {
  if (metadata?.kinuEvent !== 'plan_approved' && metadata?.kinuEvent !== 'plan_feedback') return true;
  const handoff = v.safeParse(PlanHandoffMetadataSchema, metadata);

  if (!handoff.success) return false;
  const { kinuEvent, planId, revision } = handoff.output;

  return plans.get(planId, revision)?.status === (kinuEvent === 'plan_approved' ? 'approved' : 'changes_requested');
}

/** Keyed on the decision's identity so a re-delivery collapses onto the first attempt's row. */
function planHandoffKey(plan: PlanReview, decision: PlanReviewDecision, attempt: number): string {
  return `plan:${plan.id}:${plan.revision}:${decision}:${attempt}`;
}

export interface PlanReviewStoreOptions {
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** Every revision is immutable except its reviewer-owned annotations and terminal decision fields. */
export class PlanReviewStore {
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly actorId: string;

  /** Bound to one actor: an approval is not transferable between actors. */
  constructor(
    private readonly sql: SqlExecutor,
    private readonly actor: ActorHandle,
    options: PlanReviewStoreOptions = {},
  ) {
    this.newId = options.newId ?? (() => `plan-${nanoid(12)}`);
    this.now = options.now ?? Date.now;
    this.actorId = actor.actorId;
  }

  listPage(sessionId: string, request: PageRequest = {}): Page<PlanReview> {
    return settleSync(Effect.gen({ self: this }, function* () {
      this.actor.assertCurrent();
      const limit = boundedInt(request.limit, 20, 1, 50);
      const after = request.cursor?.after;
      const anchor = after === undefined ? null : this.sql<{ rowid: number }>`SELECT rowid FROM plan_reviews WHERE actor_id=${this.actorId} AND session_id=${sessionId} AND id || ':' || revision=${after}`[0];

      if (after !== undefined && !anchor) return yield* Effect.die(new StaleCursorError('plan history', after));

      const rows = anchor
        ? this.sql<PlanReviewRow>`SELECT * FROM plan_reviews WHERE actor_id=${this.actorId} AND session_id=${sessionId} AND rowid<${anchor.rowid} ORDER BY rowid DESC LIMIT ${limit + 1}`
        : this.sql<PlanReviewRow>`SELECT * FROM plan_reviews WHERE actor_id=${this.actorId} AND session_id=${sessionId} ORDER BY rowid DESC LIMIT ${limit + 1}`;

      return seekPage(rows.map(toPlanReview), limit, plan => plan.id + ':' + plan.revision);
    }));
  }

  get(id: string, revision: number): PlanReview | null {
    this.actor.assertCurrent();

    const rows = this.sql<PlanReviewRow>`SELECT * FROM plan_reviews
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} LIMIT 1`;

    return rows[0] ? toPlanReview(rows[0]) : null;
  }

  private written(id: string, revision: number): PlanReviewResult {
    const plan = this.get(id, revision);

    if (!plan) return { ok: false, error: `plan ${id} revision ${revision} did not survive its write`, plan: null };

    return { ok: true, plan };
  }

  /** Includes an approved revision so a reload keeps rendering the accepted plan. */
  getActive(sessionId: string): PlanReview | null {
    this.actor.assertCurrent();

    const rows = this.sql<PlanReviewRow>`SELECT * FROM plan_reviews
      WHERE actor_id=${this.actorId} AND session_id=${sessionId} AND status != 'superseded'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`;

    return rows[0] ? toPlanReview(rows[0]) : null;
  }

  submit(sessionId: string, edits: readonly PlanEdit[]): PlanReviewResult {
    return settleSync(Effect.gen({ self: this }, function* (): Effect.gen.Return<PlanReviewResult> {
      const current = this.getActive(sessionId);

      // A pending revision nobody has annotated is the author's to correct: a resubmit replaces it. Once the owner
      // marks it up, it waits for their decision.
      if (current?.status === 'pending' && freshNotes(current.annotations).length > 0) {
        return { ok: false, error: `plan ${current.id} revision ${current.revision} is awaiting review`, plan: current };
      }

      const revising = current?.status === 'changes_requested' || current?.status === 'pending' ? current : null;
      const existingLines = revising ? revising.content.split('\n') : [];

      const edited = yield* Effect.matchCause(Effect.sync(() => applyPlanEdits(existingLines, edits).join('\n')), {
        onSuccess: (content) => ({ content }),
        onFailure: (failed) => ({ refused: renderThrownChain({ cause: Cause.squash(failed) }) }),
      });

      if ('refused' in edited) return { ok: false, error: edited.refused, plan: current };
      const { content } = edited;

      if (content.trim() === '') return { ok: false, error: 'the plan is empty: write it in full with one edit starting at line 1', plan: current };

      // The threads of a revision sent back carry into the next one, read-only, so its replies stay in view.
      const carried = JSON.stringify((revising?.annotations ?? []).map((note) => note.revision === undefined ? { ...note, revision: revising?.revision } : note));

      const rowBytes = planReviewRowBytes();

      if (byteLength(content) + byteLength(carried) > rowBytes) {
        return { ok: false, error: `plan content exceeds the stored row size of ${rowBytes} bytes`, plan: current };
      }

      const id = revising?.id ?? this.newId();
      const revision = revising ? revising.revision + 1 : 1;
      const now = this.now();
      void this.sql`INSERT INTO plan_reviews (
      actor_id, id, session_id, revision, content, status, annotations_json, feedback,
      handoff_accepted, handoff_attempt, created_at, updated_at
    ) VALUES (
      ${this.actorId}, ${id}, ${sessionId}, ${revision}, ${content}, 'pending', ${carried}, NULL,
      0, 0, ${now}, ${now}
    )`;
      markStoreChanged(this.sql);

      if (revising) {
        void this.sql`UPDATE plan_reviews SET status='superseded', updated_at=${now}
        WHERE actor_id=${this.actorId} AND id=${revising.id} AND revision=${revising.revision}
          AND status IN ('changes_requested', 'pending')`;
      }

      return this.written(id, revision);
    }));
  }

  saveAnnotations(id: string, revision: number, annotations: { value: unknown }): PlanReviewResult {
    const current = this.get(id, revision);

    if (!current) return { ok: false, error: `plan ${id} revision ${revision} was not found`, plan: null };
    const latest = this.getActive(current.sessionId);

    if (!latest || latest.id !== id || latest.revision !== revision) {
      return { ok: false, error: `stale plan revision ${id}/${revision}`, plan: latest };
    }

    if (current.status !== 'pending') {
      return { ok: false, error: `plan revision is already ${current.status}`, plan: current };
    }

    const carried = current.annotations.filter((note) => note.revision !== undefined);
    const admission = admitReviewAnnotations({ value: annotations.value, kept: carried });

    if (Result.isFailure(admission)) return { ok: false, error: admission.failure.error, plan: current };
    const written = admission.success;

    if (written.some((note) => note.type !== 'GLOBAL_COMMENT' && note.type !== 'REPLY' && note.anchor !== undefined)) {
      return { ok: false, error: 'a plan note has no place in a diff', plan: current };
    }

    if (written.some((note) => note.revision !== undefined || (note.type === 'REPLY' && note.author === 'agent'))) {
      return { ok: false, error: 'carried notes and the agent\'s replies are kept by the review, not written by the reviewer', plan: current };
    }

    // The reviewer writes only this revision's own notes; the carried threads stay as they were.
    const merged = [...carried, ...written];
    const tooBig = carryRefusal(current.content, merged, revision);

    if (tooBig !== null) return { ok: false, error: tooBig, plan: current };
    const encoded = JSON.stringify(merged);

    const now = this.now();
    void this.sql`UPDATE plan_reviews SET annotations_json=${encoded}, updated_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND status='pending'`;
    markStoreChanged(this.sql);

    return this.written(id, revision);
  }

  decide(
    id: string,
    revision: number,
    decision: PlanReviewDecision,
    feedback?: string,
  ): PlanReviewResult {
    const current = this.get(id, revision);

    if (!current) return { ok: false, error: `stale or unknown plan revision ${id}/${revision}`, plan: null };

    if (decision !== 'request_changes' && decision !== 'approve') {
      return { ok: false, error: `unknown plan decision: ${String(decision)}`, plan: current };
    }

    const latest = this.getActive(current.sessionId);

    if (!latest || latest.id !== id || latest.revision !== revision) {
      return { ok: false, error: `stale plan revision ${id}/${revision}`, plan: latest };
    }

    if (current.status !== 'pending') {
      const expectedStatus: PlanReviewStatus = decision === 'approve' ? 'approved' : 'changes_requested';

      if (current.status === expectedStatus) return { ok: true, plan: current };

      return { ok: false, error: `plan revision is already ${current.status}`, plan: current };
    }

    const note = feedback?.trim() ?? '';
    // A change request sends the revision's own comments, rendered here so every reviewer sends the same text.
    const sent = decision === 'request_changes' ? [reviewFeedbackText(current.annotations), note].filter(Boolean).join('\n\n') : note;
    const normalizedFeedback = sent === '' ? null : sent;

    if (decision === 'request_changes' && !normalizedFeedback) {
      return { ok: false, error: 'request_changes requires a comment or feedback', plan: current };
    }

    const status: PlanReviewStatus = decision === 'approve' ? 'approved' : 'changes_requested';
    const now = this.now();
    void this.sql`UPDATE plan_reviews
      SET status=${status}, feedback=${normalizedFeedback}, updated_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND status='pending'`;
    markStoreChanged(this.sql);

    return this.written(id, revision);
  }

  /** The agent's reply in a comment's thread, on the revision the owner sent back. */
  reply(sessionId: string, comment: string, text: string): PlanReviewResult {
    const current = this.getActive(sessionId);
    const said = text.trim();

    if (said === '') return { ok: false, error: 'a reply has text', plan: current };

    if (current?.status !== 'changes_requested') {
      return { ok: false, error: 'no plan review is waiting for replies: replies answer the comments of a revision the owner sent back', plan: current };
    }

    if (!current.annotations.some((note) => note.id === comment && note.type !== 'REPLY')) {
      return { ok: false, error: `plan ${current.id} revision ${String(current.revision)} has no comment ${comment}; the review feedback names each comment's id`, plan: current };
    }

    const reply: NoteReply = { id: `reply-${nanoid(10)}`, type: 'REPLY', inReplyTo: comment, text: said, author: 'agent', createdA: this.now() };
    const notes = [...current.annotations, reply];
    const tooBig = carryRefusal(current.content, notes, current.revision);

    if (tooBig !== null) return { ok: false, error: `the review holds no more replies: ${tooBig}`, plan: current };
    const encoded = JSON.stringify(notes);

    void this.sql`UPDATE plan_reviews SET annotations_json=${encoded}, updated_at=${reply.createdA}
      WHERE actor_id=${this.actorId} AND id=${current.id} AND revision=${current.revision} AND status='changes_requested'`;
    markStoreChanged(this.sql);

    return this.written(current.id, current.revision);
  }

  dismiss(id: string, revision: number): PlanReviewResult {
    const current = this.get(id, revision);

    if (!current) return { ok: false, error: `stale or unknown plan revision ${id}/${revision}`, plan: null };

    if (current.status === 'dismissed') return { ok: true, plan: current };
    const latest = this.getActive(current.sessionId);

    if (!latest || latest.id !== id || latest.revision !== revision) {
      return { ok: false, error: `stale plan revision ${id}/${revision}`, plan: latest };
    }

    if (!planReviewAwaitingDecision(current)) return { ok: false, error: `plan revision is already ${current.status}`, plan: current };
    const now = this.now();
    void this.sql`UPDATE plan_reviews SET status='dismissed', updated_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND status=${current.status}`;
    markStoreChanged(this.sql);

    return this.written(id, revision);
  }

  markHandoffAccepted(id: string, revision: number): PlanReviewResult {
    const current = this.get(id, revision);

    if (!current) return { ok: false, error: `plan ${id} revision ${revision} was not found`, plan: null };

    if (current.status !== 'approved' && current.status !== 'changes_requested') {
      return { ok: false, error: `plan revision ${id}/${revision} has no decided handoff`, plan: current };
    }

    const latest = this.getActive(current.sessionId);

    if (!latest || latest.id !== id || latest.revision !== revision) {
      return { ok: false, error: `stale plan revision ${id}/${revision}`, plan: latest };
    }

    if (!current.handoffAccepted) {
      const now = this.now();
      void this.sql`UPDATE plan_reviews SET handoff_accepted=1, updated_at=${now}
        WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND handoff_accepted=0`;
      markStoreChanged(this.sql);
    }

    return this.written(id, revision);
  }

  handoffAttempt(id: string, revision: number): number {
    return settleSync(Effect.gen({ self: this }, function* () {
      const current = this.get(id, revision);

      if (!current || (current.status !== 'approved' && current.status !== 'changes_requested')) {
        return yield* Effect.die(new Error(`plan revision ${id}/${revision} has no decided handoff`));
      }

      const rows = this.sql<{ handoff_attempt: number }>`SELECT handoff_attempt FROM plan_reviews
        WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} LIMIT 1`;

      const attempt = rows[0]?.handoff_attempt ?? 0;

      if (attempt > 0) return attempt;
      void this.sql`UPDATE plan_reviews SET handoff_attempt=1
        WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND handoff_attempt=0`;
      markStoreChanged(this.sql);

      return 1;
    }));
  }
}


/** Owner-facing review actions; each backend supplies only how it broadcasts. */
export class PlanReviewActions {
  constructor(
    private readonly store: PlanReviewStore,
    private readonly host: Pick<BackendHost, 'broadcast'>,
  ) {}

  private announced(result: PlanReviewResult): PlanReviewResult {
    if (result.ok) this.host.broadcast({ type: 'plan_updated', plan: result.plan });

    return result;
  }

  /** `driving`: the calling turn's metadata. */
  submit(edits: readonly PlanEdit[], driving: JsonObject | undefined): PlanReviewResult {
    if (!planSubmissionAllowed(driving)) {
      return {
        ok: false,
        error: 'a plan is submitted only from a turn the owner wrote or from its feedback turn; this turn was started by the harness',
        plan: this.store.getActive(CHAT_SESSION_ID),
      };
    }

    if (driving?.kinuEvent === 'plan_feedback' && !planHandoffStillOwed(driving, this.store)) {
      return { ok: false, error: 'the plan this revision answers was dismissed', plan: this.store.getActive(CHAT_SESSION_ID) };
    }

    return this.announced(this.store.submit(CHAT_SESSION_ID, edits));
  }

  active(): PlanReview | null {
    return this.store.getActive(CHAT_SESSION_ID);
  }

  saveAnnotations(id: string, revision: number, annotations: { value: unknown }): PlanReviewResult {
    return this.announced(this.store.saveAnnotations(id, revision, annotations));
  }

  decide(id: string, revision: number, decision: PlanReviewDecision, feedback?: string): PlanReviewResult {
    return this.announced(this.store.decide(id, revision, decision, feedback));
  }

  /** `driving`: the calling turn's metadata. */
  reply(comment: string, text: string, driving: JsonObject | undefined): PlanReviewResult {
    const active = this.store.getActive(CHAT_SESSION_ID);

    if (!planAwaitingReply(active, driving)) {
      return { ok: false, error: 'only the owner\'s own turn, or the feedback turn of the revision they sent back, answers its comments', plan: active };
    }

    return this.announced(this.store.reply(CHAT_SESSION_ID, comment, text));
  }

  awaitingReply(driving: JsonObject | undefined): boolean {
    return planAwaitingReply(this.store.getActive(CHAT_SESSION_ID), driving);
  }

  dismiss(id: string, revision: number, stopRunning?: (keyPrefix: string) => void): PlanReviewResult {
    const result = this.announced(this.store.dismiss(id, revision));

    if (result.ok) stopRunning?.(`plan:${id}:${String(revision)}:`);

    return result;
  }

  markHandoffAccepted(id: string, revision: number): PlanReviewResult {
    return this.announced(this.store.markHandoffAccepted(id, revision));
  }

  /** The handoff is marked accepted only once the loop admits the turn; otherwise the next decision resubmits under the same key. */
  async decideAndHandOff(
    verdict: { readonly id: string; readonly revision: number; readonly decision: PlanReviewDecision; readonly feedback?: string },
    enqueue: (turn: ProgrammaticTurn) => Promise<EnqueueTurnResult>,
  ): Promise<PlanDecisionOutcome> {
    const { decision } = verdict;
    const result = this.decide(verdict.id, verdict.revision, decision, verdict.feedback);

    if (!result.ok) return result;

    if (result.plan.handoffAccepted) return { ok: true, plan: result.plan, queued: true };
    const plan = result.plan;
    const { text, metadata } = planHandoffTurn(plan, decision);

    return settle(Effect.catchCause(Effect.gen({ self: this }, function* (): Effect.gen.Return<PlanDecisionOutcome> {
      const attempt = this.store.handoffAttempt(plan.id, plan.revision);
      const queued = yield* Effect.promise(() => enqueue({ text, metadata, idempotencyKey: planHandoffKey(plan, decision, attempt) }));

      if (queued.status !== 'queued') {
        return { ok: true, plan, queued: false, queueError: queued.reason ?? 'the durable turn submission was skipped' };
      }

      const accepted = this.markHandoffAccepted(plan.id, plan.revision);

      if (accepted.ok) return { ok: true, plan: accepted.plan, queued: true };

      // A change request's turn may already have submitted the next revision: superseded means delivered.
      if (accepted.plan?.status === 'superseded') return { ok: true, plan: accepted.plan, queued: true };

      return accepted;
    }), (failed) => Effect.sync((): PlanDecisionOutcome => ({ ok: true, plan, queued: false, queueError: renderThrownChain({ cause: Cause.squash(failed) }) }))));
  }
}
