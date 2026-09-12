/** The plan-review contract, declared at the platform layer: the builtins tool
 *  surface submits edits and reads decisions without importing the review
 *  store. */

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

export type PlanReviewResult =
  | { readonly ok: true; readonly plan: PlanReview }
  | { readonly ok: false; readonly error: string; readonly plan: PlanReview | null };

export interface SubmitPlanToolDeps {
  readonly submit: (edits: readonly PlanEdit[]) => PlanReviewResult | Promise<PlanReviewResult>;
}
