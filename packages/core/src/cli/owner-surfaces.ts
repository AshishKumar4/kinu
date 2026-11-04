import type { FileCheckpointListing, FileRestorePlan, FileRestoreResult } from '../checkpoints/types';
import type { AskingAgent, OwnerAnswer } from '../plans/owner-questions';
import type { DeferredApproval, DeferredApprovalAnswer } from '../safety/deferred-approval';
import type { OwedIntent } from '../subagents/deliveries';
import type { PlanDecisionOutcome, PlanReview, PlanReviewDecision, PlanReviewResult, ReviewAnnotation } from '../types/plans';

/** `list` carries reachability so an empty list is not read as a statement about the turn. */
export interface FileCheckpointSurface {
  /** `turnId` narrows in the store: `limit` is global while retention is per directory, so a window can
   *  hold part of a turn. */
  list(limit?: number, turnId?: string): Promise<FileCheckpointListing>;
  plan(dir: string, id: string): Promise<FileRestorePlan>;
  restore(dir: string, id: string): Promise<FileRestoreResult>;
}

/** The commands a workspace's agents parked on the owner; both backends serve core's `DeferredApprovalQueue`, the
 *  rows and answers the web's consent cards decide. */
export interface WaitingApprovalSurface {
  /** Oldest first. */
  list(): Promise<DeferredApproval[]>;
  decide(ids: string[], decision: DeferredApprovalAnswer): Promise<{ decided: string[] }>;
}

/** The owner's answers to the agent's questions; both backends serve core's `OwnerQuestionStore`. */
export interface OwnerQuestionSurface {
  /** Recent questions; the open ones wait for an answer. */
  list(): Promise<AskingAgent[]>;
  /** Rejects with the reason the answer was refused; owed when it did not reach the agent, whose wake delivers it. */
  answer(id: string, answers: readonly OwnerAnswer[]): Promise<OwedIntent | null>;
}

/** The owner's half of Plan mode; both backends serve core's `PlanReviewStore`. */
export interface PlanReviewSurface {
  active(): Promise<PlanReview | null>;
  saveAnnotations(id: string, revision: number, annotations: ReviewAnnotation[]): Promise<PlanReviewResult>;
  /** Approving queues the implementation turn, which streams through `subscribe`; `queued` says whether it started. A
   *  decision that did not reach the agent is owed, and its wake delivers it. */
  decide(id: string, revision: number, decision: PlanReviewDecision, feedback?: string): Promise<PlanDecisionOutcome | OwedIntent>;
  dismiss(id: string, revision: number): Promise<PlanReviewResult>;
}
