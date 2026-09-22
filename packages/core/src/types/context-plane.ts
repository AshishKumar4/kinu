/** Cross-layer context-edit metadata. Canonical content and selection are relational, not array snapshots. */

export const STAGED_CONTEXT_DEFERRALS = ['unpaired_tool_call', 'history_rewritten'] as const;

export type StagedContextDeferral = (typeof STAGED_CONTEXT_DEFERRALS)[number];

export type ContextProposalClosure = 'superseded_by_edit' | 'history_rewritten';

export type ContextEditEffect = 'step' | 'turn';

export interface ContextEditEvent {
  readonly type: 'context_edit';
  readonly contextId: string;
  readonly proposalId: string;
  /** Current committed revision when staged; new committed revision when activated. */
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

export interface ContextEventRecorder {
  emit(runId: string, event: ContextEditEvent): void;
  /** Row participates in the caller's synchronous transaction; publication follows its successful return. */
  emitDeferred(runId: string, event: ContextEditEvent): { publish(): void };
}
