/** Evidence budgets: the one table of truncation ceilings every evidence
 *  reader shares, declared at the platform layer so the craft discovery plane
 *  does not import the prompt assembler for a number. */

export const EVIDENCE_BUDGETS = {
  /** turn_outcomes rows. Everything downstream — GEPA instances, the replay
   *  judge — reads these, so this is the ceiling on the whole ledger path and
   *  must be raised first or every reader budget below it is inert. */
  storedUserMessage: 8_000,
  storedAssistantResponse: 16_000,
  storedFollowup: 8_000,
  /** The one-sentence reason behind a verdict — the classifier's own words or
   *  the execution observation. A reason longer than this is not the short
   *  answer the classifier was asked for. */
  storedEvidence: 1_000,

  /** Shadow eval: what the sampled judge is shown, and what the trial row
   *  records. One window for both, so the stored evidence IS the evidence the
   *  verdict was formed on. */
  shadowTask: 6_000,
  shadowOutput: 10_000,

  /** GEPA reflective mutation: per-instance trajectory evidence. */
  gepaInstanceInput: 1_600,
  gepaInstanceEvidence: 3_200,
  gepaInstanceFeedback: 3_200,
  /** The parent candidate's source. Head-only truncation, not a window: a
   *  rewrite of code whose middle was elided comes back with a hole. */
  gepaParentSource: 16_000,

  /** Replay eval: the task, the fresh response, and the reference it is scored
   *  against. */
  replayTask: 6_000,
  replayFreshResponse: 12_000,
  replayReferenceResponse: 12_000,
  replayFailedResponse: 8_000,
  replayCorrection: 4_000,

  /** Turn outcome classification from the user's follow-up. */
  outcomeUserMessage: 4_000,
  outcomeAssistantResponse: 8_000,
  outcomeFollowup: 4_000,

  /** MCTS branch judging (mcts/evaluation.ts): the candidate trajectory being
   *  scored, the task it is scored against, the sibling echoes shown for
   *  calibration, and the execution error when the run failed. */
  judgeTask: 6_000,
  judgeTrajectory: 12_000,
  judgeSibling: 1_600,
  judgeExecutionError: 1_200,
  /** Code handed to the assertion generator. Same value as gepaParentSource:
   *  both are code a model must read faithfully. */
  assertionCode: 16_000,

  /** Merge-sample scoring (heads/controller.ts): the k-sample median judge
   *  reads whole candidate syntheses, not their openings. */
  mergeRationale: 6_000,
  mergeNarrative: 12_000,

  /** Convergence memory writeback: the winner's observation the lesson
   *  summarizer reads. */
  convergenceObservation: 1_600,

  /** Eval-harness judge (eval/judge.ts): reference answer + both outputs. */
  evalReference: 6_000,
  evalOutput: 8_000,

  /** Scaffold evolution (evolution/engine.ts): the session reflection carried
   *  into the mutation prompt, and the recent-lessons digest it reflects over. */
  reflection: 2_000,
  lessons: 6_000,
  /** Per-tool-call args/result echoes in the pattern extractor. */
  patternToolCall: 800,

  /** Alternate-Takes continuation: the chosen take's text and the task echo. */
  takeChosen: 8_000,
  taskEcho: 800,

  /** Per-result lines of the no-prose turn-summary fallback (chat.ts) — the
   *  synthesized text that becomes the stored assistantResponse when a turn
   *  ends on a tool call, i.e. what the user sees and evolution grades. */
  toolFallbackSummary: 800,

  /** Per-message window of the conversation a spawned head inherits — its
   *  whole view of why it was spawned. */
  inheritedMessage: 1_600,

  /**
   * The trajectory a continual refinement hands its refiner
   * (`evolution/refinement-lane.ts`).
   *
   * Half the stored ceiling, per turn, because a refiner reads MANY turns where
   * every other reader of this ledger reads one: a batch of twelve at the stored
   * budget would be a third of a megabyte of prose before the artifact
   * inventory. Half keeps a full batch inside one child's window while still
   * showing more of each turn than the outcome classifier that graded it saw.
   */
  refinerUserMessage: 4_000,
  refinerAssistantResponse: 8_000,
  refinerFollowup: 4_000,
} as const;
