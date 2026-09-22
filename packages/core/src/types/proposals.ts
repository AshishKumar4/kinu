/** Table default and every status picklist derive from this list. */
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
  /** Predicted success rate in [0, 1]; 0.5 ("barely succeeds") is ideal. */
  predictedSuccess: number;
  targetsSkills: string[];
  proposedAt: number;
  status: ProposedTaskStatus;
}
