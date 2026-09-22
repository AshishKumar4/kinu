/** Truncation ceilings shared by every evidence reader. */

export const EVIDENCE_BUDGETS = {
  /** turn_outcomes rows: every downstream reader is capped by these, so raise them first. */
  storedUserMessage: 8_000,
  storedAssistantResponse: 16_000,
  storedFollowup: 8_000,
  storedEvidence: 1_000,

  /** One window for judge input and trial row, so stored evidence is what the verdict saw. */
  shadowTask: 6_000,
  shadowOutput: 10_000,

  gepaInstanceInput: 1_600,
  gepaInstanceEvidence: 3_200,
  gepaInstanceFeedback: 3_200,
  /** Head-only truncation, not a window: a rewrite of code with an elided middle has a hole. */
  gepaParentSource: 16_000,

  replayTask: 6_000,
  replayFreshResponse: 12_000,
  replayReferenceResponse: 12_000,
  replayFailedResponse: 8_000,
  replayCorrection: 4_000,

  outcomeUserMessage: 4_000,
  outcomeAssistantResponse: 8_000,
  outcomeFollowup: 4_000,

  judgeTask: 6_000,
  judgeTrajectory: 12_000,
  judgeSibling: 1_600,
  judgeExecutionError: 1_200,
  assertionCode: 16_000,

  mergeRationale: 6_000,
  mergeNarrative: 12_000,

  convergenceObservation: 1_600,

  evalReference: 6_000,
  evalOutput: 8_000,

  reflection: 2_000,
  lessons: 6_000,
  patternToolCall: 800,

  takeChosen: 8_000,
  taskEcho: 800,

  /** Per-result lines of the no-prose turn-summary fallback, stored as assistantResponse. */
  toolFallbackSummary: 800,

  inheritedMessage: 1_600,

  /** Half the stored ceiling per turn: a refiner reads a whole batch in one child's window. */
  refinerUserMessage: 4_000,
  refinerAssistantResponse: 8_000,
  refinerFollowup: 4_000,
} as const;
