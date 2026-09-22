import * as v from 'valibot';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { nanoid } from '../utils/nanoid';
import { JsonArraySchema, isJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import { renderThrownChain } from '../obs/index';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { seekPage, StaleCursorError, type Page, type PageRequest } from '../session/page';
import { boundedInt } from '../utils/bounds';
import type {
  PlanAnnotationMathTarget, PlanAnnotationTextPosition, PlanEdit,
  PlanReview, PlanReviewAnnotation, PlanReviewDecision, PlanReviewResult,
  PlanReviewStatus,
} from '../types/plans';

export type {
  PlanAnnotationMathTarget, PlanAnnotationTextPosition, PlanEdit,
  PlanReview, PlanReviewAnnotation, PlanReviewDecision, PlanReviewResult,
  PlanReviewStatus, SubmitPlanToolDeps,
} from '../types/plans';

// One plan_reviews row holds content plus annotations_json. The platform
// caps that row at do.sqlite.row_bytes. Both caps below fit inside it
// together, so a stored row stays under the platform ceiling.
export const MAX_PLAN_CONTENT_BYTES = 1536 * 1024;

export const MAX_PLAN_ANNOTATIONS_BYTES = 256 * 1024;

const MAX_PLAN_REVIEW_ROW_BYTES = PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value;

const PlanReviewStatusSchema = v.picklist([
  'pending', 'changes_requested', 'approved', 'superseded',
]);

export const PlanReviewSchema = v.object({
  id: v.string(), sessionId: v.string(), revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  content: v.string(), status: PlanReviewStatusSchema,
  annotations: v.pipe(JsonArraySchema, v.rawTransform(({ dataset, addIssue, NEVER }): readonly PlanReviewAnnotation[] => {
    const admitted = admitPlanReviewAnnotations({ value: dataset.value });

    if (!admitted.ok) {
      addIssue({ message: admitted.error });

      return NEVER;
    }

    return admitted.annotations;
  })),
  feedback: v.nullable(v.string()), handoffAccepted: v.boolean(),
  createdAt: v.number(), updatedAt: v.number(), decidedAt: v.nullable(v.number()),
});

export function planReviewAwaitingDecision(
  review: Pick<PlanReview, 'status' | 'handoffAccepted'> | null | undefined,
): boolean {
  return review?.status === 'pending'
    || review?.status === 'changes_requested'
    || (review?.status === 'approved' && !review.handoffAccepted);
}

/** The plan's own name for itself: the first non-empty line of the content,
 *  headings stripped, which is what every list row prints for it. */
export function planTitle(content: string): string {
  return content.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() ?? 'Plan';
}

/** A `plan_reviews` row awaiting an owner decision, read workspace-wide and
 *  carrying its owner's name — the `plan_review` pending-action's input. The
 *  roster stays retired-inclusive: a dismissed actor's undecided plan is
 *  still undecided, and its row belongs to the owner, not the actor. */
export function listPendingPlanReviews(
  sql: SqlExecutor,
  workspaceId: string,
): ReadonlyArray<{ owner: string; id: string; revision: number; content: string; updatedAt: number }> {
  return sql<{ owner: string; id: string; revision: number; content: string; updated_at: number }>`
    SELECT a.name AS owner, r.id, r.revision, r.content, r.updated_at
    FROM plan_reviews r JOIN workspace_actors a ON a.actor_id = r.actor_id
    WHERE a.workspace_id = ${workspaceId} AND r.status = 'pending'
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
  decided_at: number | null;
}

const PLAN_ANNOTATION_FIELDS = new Set([
  'id', 'blockId', 'startOffset', 'endOffset', 'type', 'text', 'originalText',
  'createdA', 'author', 'startMeta', 'endMeta', 'mathTargets',
]);

const PLAN_ANNOTATION_POSITION_FIELDS = new Set(['parentTagName', 'parentIndex', 'textOffset']);

const PLAN_ANNOTATION_MATH_FIELDS = new Set(['blockId', 'tex', 'displayMode']);

const NonEmptyStringSchema = v.pipe(v.string(), v.nonEmpty());

const StringSchema = v.string();

const BooleanSchema = v.boolean();

const NonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const NonNegativeNumberSchema = v.pipe(v.number(), v.finite(), v.minValue(0));

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

type AnnotationAdmission =
  | { readonly ok: true; readonly annotations: PlanReviewAnnotation[] }
  | { readonly ok: false; readonly error: string };

function unsupportedField(value: JsonObject, allowed: ReadonlySet<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

type OptionalAdmission<T> =
  | { readonly ok: true; readonly value?: T }
  | { readonly ok: false; readonly error: string };

function admitTextPosition(value: JsonValue | undefined, field: string): OptionalAdmission<PlanAnnotationTextPosition> {
  if (value === undefined) return { ok: true };

  if (!isJsonObject(value)) return { ok: false, error: `${field} must be a text position` };
  const extra = unsupportedField(value, PLAN_ANNOTATION_POSITION_FIELDS);

  if (extra) return { ok: false, error: `${field} has unsupported field ${extra}` };

  if (!v.is(NonEmptyStringSchema, value.parentTagName)
    || !v.is(NonNegativeIntegerSchema, value.parentIndex)
    || !v.is(NonNegativeIntegerSchema, value.textOffset)) {
    return { ok: false, error: `${field} must contain a tag and non-negative integer offsets` };
  }

  return { ok: true, value: {
    parentTagName: value.parentTagName,
    parentIndex: value.parentIndex,
    textOffset: value.textOffset,
  } };
}

function admitMathTargets(value: JsonValue | undefined): OptionalAdmission<readonly PlanAnnotationMathTarget[]> {
  if (value === undefined) return { ok: true };

  if (!Array.isArray(value)) return { ok: false, error: 'mathTargets must be an array' };
  const targets: PlanAnnotationMathTarget[] = [];

  for (const target of value) {
    if (!isJsonObject(target)) return { ok: false, error: 'each math target must be an object' };
    const extra = unsupportedField(target, PLAN_ANNOTATION_MATH_FIELDS);

    if (extra) return { ok: false, error: `mathTargets has unsupported field ${extra}` };

    if (!v.is(NonEmptyStringSchema, target.blockId)
      || !v.is(StringSchema, target.tex)
      || !v.is(BooleanSchema, target.displayMode)) {
      return { ok: false, error: 'each math target requires blockId, tex, and displayMode' };
    }

    targets.push({ blockId: target.blockId, tex: target.tex, displayMode: target.displayMode });
  }

  return { ok: true, value: targets };
}

export function admitPlanReviewAnnotations(input: { value: unknown }): AnnotationAdmission {
  const parsed = v.safeParse(JsonArraySchema, input.value);

  if (!parsed.success) return { ok: false, error: 'annotations must be an array' };
  const annotations: PlanReviewAnnotation[] = [];

  for (const [index, annotation] of parsed.output.entries()) {
    if (!isJsonObject(annotation)) return { ok: false, error: `annotation ${index} must be an object` };
    const extra = unsupportedField(annotation, PLAN_ANNOTATION_FIELDS);

    if (extra) return { ok: false, error: `annotation ${index} has unsupported field ${extra}` };

    if (!v.is(NonEmptyStringSchema, annotation.id)
      || !v.is(NonEmptyStringSchema, annotation.blockId)) {
      return { ok: false, error: `annotation ${index} requires id and blockId` };
    }

    if (!v.is(NonNegativeIntegerSchema, annotation.startOffset)
      || !v.is(NonNegativeIntegerSchema, annotation.endOffset)
      || annotation.endOffset < annotation.startOffset) {
      return { ok: false, error: `annotation ${index} has invalid offsets` };
    }

    const type = annotation.type;

    if (type !== 'DELETION' && type !== 'COMMENT' && type !== 'GLOBAL_COMMENT') {
      return { ok: false, error: `annotation ${index} has invalid type` };
    }

    if (!v.is(StringSchema, annotation.originalText)
      || !v.is(NonNegativeNumberSchema, annotation.createdA)
      || (annotation.text !== undefined && !v.is(StringSchema, annotation.text))
      || (annotation.author !== undefined && !v.is(StringSchema, annotation.author))) {
      return { ok: false, error: `annotation ${index} has invalid text or author fields` };
    }

    const startMeta = admitTextPosition(annotation.startMeta, 'startMeta');

    if (!startMeta.ok) return { ok: false, error: `annotation ${index}: ${startMeta.error}` };
    const endMeta = admitTextPosition(annotation.endMeta, 'endMeta');

    if (!endMeta.ok) return { ok: false, error: `annotation ${index}: ${endMeta.error}` };
    const mathTargets = admitMathTargets(annotation.mathTargets);

    if (!mathTargets.ok) return { ok: false, error: `annotation ${index}: ${mathTargets.error}` };

    const admitted: PlanReviewAnnotation = {
      id: annotation.id,
      blockId: annotation.blockId,
      startOffset: annotation.startOffset,
      endOffset: annotation.endOffset,
      type,
      originalText: annotation.originalText,
      createdA: annotation.createdA,
    };

    if (v.is(StringSchema, annotation.text)) Object.assign(admitted, { text: annotation.text });

    if (v.is(StringSchema, annotation.author)) Object.assign(admitted, { author: annotation.author });

    if (startMeta.value) Object.assign(admitted, { startMeta: startMeta.value });

    if (endMeta.value) Object.assign(admitted, { endMeta: endMeta.value });

    if (mathTargets.value) Object.assign(admitted, { mathTargets: mathTargets.value });
    annotations.push(admitted);
  }

  return { ok: true, annotations };
}

function toPlanReview(row: PlanReviewRow): PlanReview {
  const parsed: unknown = JSON.parse(row.annotations_json);
  const admission = admitPlanReviewAnnotations({ value: parsed });

  if (!admission.ok) throw new Error(`invalid stored plan annotations: ${admission.error}`);

  return {
    id: row.id,
    sessionId: row.session_id,
    revision: row.revision,
    content: row.content,
    status: v.is(PlanReviewStatusSchema, row.status) ? row.status : 'pending',
    annotations: admission.annotations,
    feedback: row.feedback,
    handoffAccepted: row.handoff_accepted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
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
    decided_at       INTEGER,
    PRIMARY KEY (actor_id, id, revision)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_plan_reviews_session_current
    ON plan_reviews(actor_id, session_id, created_at DESC)`);
}

/** Validate edits against the revision the model saw. Line coordinates are
 * one-indexed, inclusive, and refer to the pre-edit document for the batch. */
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
  const invalid = validatePlanEdits(existingLines, edits);

  if (invalid) throw new Error(invalid);

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

  if (!content.trim()) throw new Error('plan content is empty after applying edits');

  if (byteLength(content) > MAX_PLAN_CONTENT_BYTES) {
    throw new Error('plan content exceeds the maximum size of 1.5 MiB');
  }

  return lines;
}

export function formatPlanWithLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;

  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join('\n');
}

/**
 * The turn a decided plan hands off to.
 *
 * A verdict means the same thing on every backend: an approval hands the
 * model the exact plan to implement, a change request hands back the numbered
 * revision to edit. So the words, the `kinuEvent`/`kinuMode` the loop reads
 * off them, and the key a retry collapses onto are declared once here rather
 * than per adapter.
 */
export interface PlanHandoffTurn {
  readonly text: string;
  readonly metadata: JsonObject;
}

export function planHandoffTurn(plan: PlanReview, decision: PlanReviewDecision): PlanHandoffTurn {
  const text = decision === 'request_changes'
    ? [
        `The owner requested changes to plan ${plan.id} revision ${plan.revision}.`,
        '',
        '## Review feedback',
        plan.feedback ?? '',
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

/** The name one handoff attempt announces itself under: the decision's own
 *  identity, so a re-delivery collapses onto the row the first attempt wrote. */
export function planHandoffKey(plan: PlanReview, decision: PlanReviewDecision, attempt: number): string {
  return `plan:${plan.id}:${plan.revision}:${decision}:${attempt}`;
}

export interface PlanReviewStoreOptions {
  readonly newId?: () => string;
  readonly now?: () => number;
}

/** One durable review stream per session. Every revision is immutable except
 * for its reviewer-owned annotations and terminal decision fields. */
export class PlanReviewStore {
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly actorId: string;

  /** Bind the review stream to ONE actor. A plan is written by an actor working
   *  in plan mode and approved for THAT actor to execute: a subordinate planning
   *  its own delegated task shares a session id with nobody, and an approval is
   *  not transferable between actors. */
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
    this.actor.assertCurrent();
    const limit = boundedInt(request.limit, 20, 1, 50);
    const after = request.cursor?.after;
    const anchor = after === undefined ? null : this.sql<{ rowid: number }>`SELECT rowid FROM plan_reviews WHERE actor_id=${this.actorId} AND session_id=${sessionId} AND id || ':' || revision=${after}`[0];

    if (after !== undefined && !anchor) throw new StaleCursorError('plan history', after);

    const rows = anchor
      ? this.sql<PlanReviewRow>`SELECT * FROM plan_reviews WHERE actor_id=${this.actorId} AND session_id=${sessionId} AND rowid<${anchor.rowid} ORDER BY rowid DESC LIMIT ${limit + 1}`
      : this.sql<PlanReviewRow>`SELECT * FROM plan_reviews WHERE actor_id=${this.actorId} AND session_id=${sessionId} ORDER BY rowid DESC LIMIT ${limit + 1}`;

    return seekPage(rows.map(toPlanReview), limit, plan => plan.id + ':' + plan.revision);
  }

  get(id: string, revision: number): PlanReview | null {
    this.actor.assertCurrent();

    const rows = this.sql<PlanReviewRow>`SELECT * FROM plan_reviews
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} LIMIT 1`;

    return rows[0] ? toPlanReview(rows[0]) : null;
  }

  /** The revision a write in this store just produced. Absent means the write
   *  did not land, which is a failure of this call and not a stale revision —
   *  the caller renders it the same way it renders every other refusal. */
  private written(id: string, revision: number): PlanReviewResult {
    const plan = this.get(id, revision);

    if (!plan) return { ok: false, error: `plan ${id} revision ${revision} did not survive its write`, plan: null };

    return { ok: true, plan };
  }

  /** The latest non-superseded revision, including an approved revision so a
   * reload can keep rendering the plan the owner accepted. */
  getActive(sessionId: string): PlanReview | null {
    this.actor.assertCurrent();

    const rows = this.sql<PlanReviewRow>`SELECT * FROM plan_reviews
      WHERE actor_id=${this.actorId} AND session_id=${sessionId} AND status != 'superseded'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`;

    return rows[0] ? toPlanReview(rows[0]) : null;
  }

  submit(sessionId: string, edits: readonly PlanEdit[]): PlanReviewResult {
    const current = this.getActive(sessionId);

    if (current?.status === 'pending') {
      return { ok: false, error: `plan ${current.id} revision ${current.revision} is awaiting review`, plan: current };
    }

    const revising = current?.status === 'changes_requested' ? current : null;
    const existingLines = revising ? revising.content.split('\n') : [];
    let content: string;

    try {
      content = applyPlanEdits(existingLines, edits).join('\n');
    } catch (error) {
      return { ok: false, error: renderThrownChain({ cause: error }), plan: current };
    }

    if (byteLength(content) + byteLength('[]') > MAX_PLAN_REVIEW_ROW_BYTES) {
      return { ok: false, error: `plan content exceeds the stored row size of ${MAX_PLAN_REVIEW_ROW_BYTES} bytes`, plan: current };
    }

    const id = revising?.id ?? this.newId();
    const revision = revising ? revising.revision + 1 : 1;
    const now = this.now();
    void this.sql`INSERT INTO plan_reviews (
      actor_id, id, session_id, revision, content, status, annotations_json, feedback,
      handoff_accepted, handoff_attempt, created_at, updated_at, decided_at
    ) VALUES (
      ${this.actorId}, ${id}, ${sessionId}, ${revision}, ${content}, 'pending', '[]', NULL,
      0, 0, ${now}, ${now}, NULL
    )`;

    if (revising) {
      void this.sql`UPDATE plan_reviews SET status='superseded', updated_at=${now}
        WHERE actor_id=${this.actorId} AND id=${revising.id} AND revision=${revising.revision}
          AND status='changes_requested'`;
    }

    return this.written(id, revision);
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

    let encoded: string;

    try { encoded = JSON.stringify(annotations.value); }
    catch (error) {
      return { ok: false, error: `annotations must be JSON-serializable: ${renderThrownChain({ cause: error })}`, plan: current };
    }

    if (byteLength(encoded) > MAX_PLAN_ANNOTATIONS_BYTES) {
      return { ok: false, error: 'annotations exceed the maximum size of 256 KiB', plan: current };
    }

    const admission = admitPlanReviewAnnotations(annotations);

    if (!admission.ok) return { ok: false, error: admission.error, plan: current };
    encoded = JSON.stringify(admission.annotations);

    if (byteLength(current.content) + byteLength(encoded) > MAX_PLAN_REVIEW_ROW_BYTES) {
      return { ok: false, error: `plan content and annotations exceed the stored row size of ${MAX_PLAN_REVIEW_ROW_BYTES} bytes`, plan: current };
    }

    const now = this.now();
    void this.sql`UPDATE plan_reviews SET annotations_json=${encoded}, updated_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND status='pending'`;

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

    const trimmedFeedback = feedback?.trim();
    const normalizedFeedback = trimmedFeedback === undefined || trimmedFeedback === '' ? null : trimmedFeedback;

    if (decision === 'request_changes' && !normalizedFeedback) {
      return { ok: false, error: 'request_changes requires non-empty feedback', plan: current };
    }

    const status: PlanReviewStatus = decision === 'approve' ? 'approved' : 'changes_requested';
    const now = this.now();
    void this.sql`UPDATE plan_reviews
      SET status=${status}, feedback=${normalizedFeedback}, updated_at=${now}, decided_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND status='pending'`;

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
    }

    return this.written(id, revision);
  }

  handoffAttempt(id: string, revision: number): number {
    const current = this.get(id, revision);

    if (!current || (current.status !== 'approved' && current.status !== 'changes_requested')) {
      throw new Error(`plan revision ${id}/${revision} has no decided handoff`);
    }

    const rows = this.sql<{ handoff_attempt: number }>`SELECT handoff_attempt FROM plan_reviews
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} LIMIT 1`;

    const attempt = rows[0]?.handoff_attempt ?? 0;

    if (attempt > 0) return attempt;
    void this.sql`UPDATE plan_reviews SET handoff_attempt=1
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} AND handoff_attempt=0`;

    return 1;
  }

  advanceHandoffAttempt(id: string, revision: number, expected: number): number {
    this.actor.assertCurrent();
    void this.sql`UPDATE plan_reviews SET handoff_attempt=handoff_attempt + 1
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision}
        AND handoff_attempt=${expected} AND handoff_accepted=0`;

    const rows = this.sql<{ handoff_attempt: number }>`SELECT handoff_attempt FROM plan_reviews
      WHERE actor_id=${this.actorId} AND id=${id} AND revision=${revision} LIMIT 1`;

    const attempt = rows[0]?.handoff_attempt;

    if (attempt === undefined || attempt <= expected) {
      throw new Error(`could not advance plan handoff attempt for ${id}/${revision}`);
    }

    return attempt;
  }
}


/**
 * The owner-facing review actions over one store, with every change the store
 * makes announced to whoever watches the actor. Both backends expose these
 * verbatim; the one thing each supplies is how it broadcasts.
 */
export class PlanReviewActions {
  constructor(
    private readonly store: PlanReviewStore,
    private readonly announce: (plan: PlanReview) => void,
  ) {}

  private announced(result: PlanReviewResult): PlanReviewResult {
    if (result.ok) this.announce(result.plan);

    return result;
  }

  submit(edits: readonly PlanEdit[]): PlanReviewResult {
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

  markHandoffAccepted(id: string, revision: number): PlanReviewResult {
    return this.announced(this.store.markHandoffAccepted(id, revision));
  }
}
