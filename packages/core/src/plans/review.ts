import * as v from 'valibot';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import { JsonArraySchema, isJsonObject, type JsonObject, type JsonValue } from '../utils/json';

/**
 * CONFLICTS WITH `do.sqlite.row_bytes` AND IS LEFT UNCHANGED HERE DELIBERATELY.
 *
 * `content` is a TEXT column of `plan_reviews` and `annotations_json` is another
 * column of the SAME row, so their sum meets the platform's per-row ceiling,
 * which the catalog records as 2 MB. These two admit 6 MiB between them, so a
 * plan of 2-5 MiB passes `applyPlanEdits`' own check below and then throws raw
 * at the storage layer on INSERT. Reconciling them is a behavioural change that
 * belongs to whoever owns plan review; this comment exists so the next reader
 * finds the conflict already located rather than in production.
 */
export const MAX_PLAN_CONTENT_BYTES = 5 * 1024 * 1024;
export const MAX_PLAN_ANNOTATIONS_BYTES = 1024 * 1024;

export interface PlanEdit {
  readonly start: number;
  readonly end?: number | null;
  readonly content: string;
}

export type PlanReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'superseded';
export type PlanReviewDecision = 'request_changes' | 'approve';

export interface PlanAnnotationTextPosition {
  readonly parentTagName: string;
  readonly parentIndex: number;
  readonly textOffset: number;
}

export interface PlanAnnotationMathTarget {
  readonly blockId: string;
  readonly tex: string;
  readonly displayMode: boolean;
}

export interface PlanReviewAnnotation {
  readonly id: string;
  readonly blockId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly type: 'DELETION' | 'COMMENT' | 'GLOBAL_COMMENT';
  readonly text?: string;
  readonly originalText: string;
  readonly createdA: number;
  readonly author?: string;
  readonly startMeta?: PlanAnnotationTextPosition;
  readonly endMeta?: PlanAnnotationTextPosition;
  readonly mathTargets?: readonly PlanAnnotationMathTarget[];
}

export interface PlanReview {
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly content: string;
  readonly status: PlanReviewStatus;
  readonly annotations: readonly PlanReviewAnnotation[];
  readonly feedback: string | null;
  readonly handoffAccepted: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly decidedAt: number | null;
}

export function planReviewAwaitingDecision(
  review: Pick<PlanReview, 'status' | 'handoffAccepted'> | null | undefined,
): boolean {
  return review?.status === 'pending'
    || review?.status === 'changes_requested'
    || (review?.status === 'approved' && !review.handoffAccepted);
}

export type PlanReviewResult =
  | { readonly ok: true; readonly plan: PlanReview }
  | { readonly ok: false; readonly error: string; readonly plan: PlanReview | null };

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

const PlanReviewStatusSchema = v.picklist([
  'pending', 'changes_requested', 'approved', 'superseded',
]);
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

export function admitPlanReviewAnnotations<T>(value: T): AnnotationAdmission {
  const parsed = v.safeParse(JsonArraySchema, value);
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
  const admission = admitPlanReviewAnnotations(parsed);
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
    PRIMARY KEY (id, revision)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_plan_reviews_session_current
    ON plan_reviews(session_id, created_at DESC)`);
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
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
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
    throw new Error('plan content exceeds the maximum size of 5 MiB');
  }
  return lines;
}

export function formatPlanWithLineNumbers(content: string): string {
  const lines = content.split('\n');
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}| ${line}`).join('\n');
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

  constructor(private readonly sql: SqlExecutor, options: PlanReviewStoreOptions = {}) {
    this.newId = options.newId ?? (() => `plan-${nanoid(12)}`);
    this.now = options.now ?? Date.now;
  }

  get(id: string, revision: number): PlanReview | null {
    const rows = this.sql<PlanReviewRow>`SELECT * FROM plan_reviews
      WHERE id=${id} AND revision=${revision} LIMIT 1`;
    return rows[0] ? toPlanReview(rows[0]) : null;
  }

  /** The latest non-superseded revision, including an approved revision so a
   * reload can keep rendering the plan the owner accepted. */
  getActive(sessionId: string): PlanReview | null {
    const rows = this.sql<PlanReviewRow>`SELECT * FROM plan_reviews
      WHERE session_id=${sessionId} AND status != 'superseded'
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
      return { ok: false, error: error instanceof Error ? error.message : String(error), plan: current };
    }

    const id = revising?.id ?? this.newId();
    const revision = revising ? revising.revision + 1 : 1;
    const now = this.now();
    void this.sql`INSERT INTO plan_reviews (
      id, session_id, revision, content, status, annotations_json, feedback, handoff_accepted,
      handoff_attempt, created_at, updated_at, decided_at
    ) VALUES (
      ${id}, ${sessionId}, ${revision}, ${content}, 'pending', '[]', NULL, 0,
      0, ${now}, ${now}, NULL
    )`;
    if (revising) {
      void this.sql`UPDATE plan_reviews SET status='superseded', updated_at=${now}
        WHERE id=${revising.id} AND revision=${revising.revision} AND status='changes_requested'`;
    }
    return { ok: true, plan: this.get(id, revision)! };
  }

  saveAnnotations<T>(id: string, revision: number, annotations: T): PlanReviewResult {
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
    try { encoded = JSON.stringify(annotations); }
    catch { return { ok: false, error: 'annotations must be JSON-serializable', plan: current }; }
    if (byteLength(encoded) > MAX_PLAN_ANNOTATIONS_BYTES) {
      return { ok: false, error: 'annotations exceed the maximum size of 1 MiB', plan: current };
    }
    const admission = admitPlanReviewAnnotations(annotations);
    if (!admission.ok) return { ok: false, error: admission.error, plan: current };
    encoded = JSON.stringify(admission.annotations);
    const now = this.now();
    void this.sql`UPDATE plan_reviews SET annotations_json=${encoded}, updated_at=${now}
      WHERE id=${id} AND revision=${revision} AND status='pending'`;
    return { ok: true, plan: this.get(id, revision)! };
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
    const normalizedFeedback = feedback?.trim() || null;
    if (decision === 'request_changes' && !normalizedFeedback) {
      return { ok: false, error: 'request_changes requires non-empty feedback', plan: current };
    }
    const status: PlanReviewStatus = decision === 'approve' ? 'approved' : 'changes_requested';
    const now = this.now();
    void this.sql`UPDATE plan_reviews
      SET status=${status}, feedback=${normalizedFeedback}, updated_at=${now}, decided_at=${now}
      WHERE id=${id} AND revision=${revision} AND status='pending'`;
    return { ok: true, plan: this.get(id, revision)! };
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
        WHERE id=${id} AND revision=${revision} AND handoff_accepted=0`;
    }
    return { ok: true, plan: this.get(id, revision)! };
  }

  handoffAttempt(id: string, revision: number): number {
    const current = this.get(id, revision);
    if (!current || (current.status !== 'approved' && current.status !== 'changes_requested')) {
      throw new Error(`plan revision ${id}/${revision} has no decided handoff`);
    }
    const rows = this.sql<{ handoff_attempt: number }>`SELECT handoff_attempt FROM plan_reviews
      WHERE id=${id} AND revision=${revision} LIMIT 1`;
    const attempt = rows[0]?.handoff_attempt ?? 0;
    if (attempt > 0) return attempt;
    void this.sql`UPDATE plan_reviews SET handoff_attempt=1
      WHERE id=${id} AND revision=${revision} AND handoff_attempt=0`;
    return 1;
  }

  advanceHandoffAttempt(id: string, revision: number, expected: number): number {
    void this.sql`UPDATE plan_reviews SET handoff_attempt=handoff_attempt + 1
      WHERE id=${id} AND revision=${revision} AND handoff_attempt=${expected} AND handoff_accepted=0`;
    const rows = this.sql<{ handoff_attempt: number }>`SELECT handoff_attempt FROM plan_reviews
      WHERE id=${id} AND revision=${revision} LIMIT 1`;
    const attempt = rows[0]?.handoff_attempt;
    if (attempt === undefined || attempt <= expected) {
      throw new Error(`could not advance plan handoff attempt for ${id}/${revision}`);
    }
    return attempt;
  }
}

export interface SubmitPlanToolDeps {
  readonly submit: (edits: readonly PlanEdit[]) => PlanReviewResult | Promise<PlanReviewResult>;
}
