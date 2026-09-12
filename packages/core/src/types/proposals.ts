/** The proposed-task contract, declared at the platform layer: the agent-self
 *  tool surface reads proposals without importing the curriculum proposer. */

/** The one list of proposed-task statuses — the table default, the picklist
 *  below and the `agent.*` tools' status picklist all derive from it. */
export const PROPOSED_TASK_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'completed',
] as const;

export type ProposedTaskStatus = (typeof PROPOSED_TASK_STATUSES)[number];

export interface ProposedTask {
  id: string;
  task: string;
  rationale: string;
  /** Predicted success rate ∈ [0..1] — 0.5 is ideal "barely succeeds." */
  predictedSuccess: number;
  /** Skills this task would exercise or extend. */
  targetsSkills: string[];
  proposedAt: number;
  status: ProposedTaskStatus;
}
