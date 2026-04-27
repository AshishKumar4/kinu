/**
 * CraftStore types — crafted tools, quality scores.
 * Architecture reference: final-architecture.md §6
 */

export interface CraftedTool {
  name: string;
  description: string;
  params: Record<string, string> | null;
  code: string;
  scope: 'local' | 'shared';
  createdAt: number;
  updatedAt: number;
}

/** Tracks per-tool quality metrics for EMA scoring and time decay */
export interface CraftScoreEntry {
  tool_name: string;
  score: number;
  uses: number;
  last_used_at: number;
  created_at: number;
}
