/**
 * Scaffold types — versioning, rollout, task history.
 * Architecture reference: final-architecture.md §4
 */

export interface ScaffoldVersion {
  version: number;
  written_at: number;
  rationale: string;
  canary_score: number | null;
  baseline_score: number | null;
}

export type TaskOutcome = 'success' | 'error' | 'timeout';

export interface TaskHistoryEntry {
  id: string;
  task: string;
  scaffold_version: number;
  outcome: TaskOutcome;
  score: number | null;
  created_at: number;
}
