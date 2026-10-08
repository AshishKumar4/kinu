/** Plan-review contract shared by the builtins tool surface without importing the review store. */
import * as v from 'valibot';

/** One edit to a submitted plan: the `submit_plan` tool's input item, and what the review store applies. A key it does
 *  not read is dropped, as calls that ran before took it. */
export const PlanEditSchema = v.object({
  start: v.pipe(v.number(), v.integer(), v.minValue(1), v.description('First affected line, one-indexed.')),
  end: v.optional(v.pipe(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))), v.description('Last affected line, inclusive. Omit to replace through the end of the plan.'))),
  content: v.pipe(v.string(), v.description('Replacement Markdown. Empty with an explicit end deletes the range.')),
});

export type PlanEdit = v.InferOutput<typeof PlanEditSchema>;

export type PlanReviewStatus = 'pending' | 'changes_requested' | 'approved' | 'superseded' | 'dismissed';

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

export type DiffSide = 'old' | 'new';

export type DiffAnchor =
  | { readonly scope: 'file'; readonly path: string; readonly baseline: string }
  | {
    readonly scope: 'lines'; readonly path: string; readonly side: DiffSide;
    readonly lineStart: number; readonly lineEnd: number; readonly baseline: string;
  }
  | {
    readonly scope: 'text'; readonly path: string; readonly side: DiffSide;
    readonly lineStart: number; readonly lineEnd: number; readonly charStart: number; readonly charEnd: number;
    readonly baseline: string;
  };

interface NoteFields {
  readonly id: string;
  readonly createdA: number;
  /** Set when the note was carried into a later revision: the revision it was written on. A carried note is read-only. */
  readonly revision?: number;
}

/** A comment on, or a removal of, a passage of the plan (or of a diff, through `anchor`). */
export interface PassageNote extends NoteFields {
  readonly type: 'COMMENT' | 'DELETION';
  readonly blockId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly originalText: string;
  readonly text?: string;
  readonly author?: string;
  readonly startMeta?: PlanAnnotationTextPosition;
  readonly endMeta?: PlanAnnotationTextPosition;
  readonly mathTargets?: readonly PlanAnnotationMathTarget[];
  readonly anchor?: DiffAnchor;
}

/** A comment on the whole plan, or on all of a change-set: no block, offsets or quote. */
export interface GeneralNote extends NoteFields {
  readonly type: 'GLOBAL_COMMENT';
  readonly text: string;
  readonly author?: string;
}

/** A reply in a note's thread; `inReplyTo` names a note in the same list that is not itself a reply. */
export interface NoteReply extends NoteFields {
  readonly type: 'REPLY';
  readonly inReplyTo: string;
  readonly text: string;
  readonly author: 'owner' | 'agent';
}

export type ReviewAnnotation = PassageNote | GeneralNote | NoteReply;

export interface PlanReview {
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly content: string;
  readonly status: PlanReviewStatus;
  readonly annotations: readonly ReviewAnnotation[];
  readonly feedback: string | null;
  readonly handoffAccepted: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type PlanReviewResult =
  | { readonly ok: true; readonly plan: PlanReview }
  | { readonly ok: false; readonly error: string; readonly plan: PlanReview | null };

/** `queued: false` leaves the handoff owed to the next decision. */
export type PlanDecisionOutcome =
  | { readonly ok: false; readonly error: string; readonly plan: PlanReview | null }
  | { readonly ok: true; readonly plan: PlanReview; readonly queued: boolean; readonly queueError?: string };

export interface SubmitPlanToolDeps {
  readonly submit: (edits: readonly PlanEdit[]) => PlanReviewResult | Promise<PlanReviewResult>;
}

export interface ReplyToCommentToolDeps {
  readonly reply: (comment: string, text: string) => PlanReviewResult | Promise<PlanReviewResult>;
}
