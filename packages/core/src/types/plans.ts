/** Plan-review contract shared by the builtins tool surface without importing the review store. */
import { z } from 'zod';

/** One edit to a submitted plan: the `submit_plan` tool's input item, and what the review store applies. */
export const PlanEditSchema = z.strictObject({
  start: z.number().int().min(1).describe('First affected line, one-indexed.'),
  end: z.number().int().min(1).nullable().optional()
    .describe('Last affected line, inclusive. Omit to replace through end of plan.'),
  content: z.string().describe('Replacement Markdown. Empty with an explicit end deletes the range.'),
});

export type PlanEdit = z.infer<typeof PlanEditSchema>;

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

export interface ReviewAnnotation {
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
  readonly anchor?: DiffAnchor;
}

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
  readonly decidedAt: number | null;
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
