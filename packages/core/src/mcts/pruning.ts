/**
 * MCTS pruning — remove low-scoring branches, extract reflections first.
 *
 * Architecture reference: final-architecture.md §5.10
 * Formal spec: Convergence.lean — pruning_safety, prune_preserves_isolation
 *
 * Pruning criteria:
 * - Score below PRUNE_THRESHOLD (0.25) AND at least 2 visits
 * - Reflections extracted BEFORE marking pruned (failure lessons are the value from losers)
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { DEFAULT_CONFIG } from '../config.js';

export interface BranchScore {
  nodeId: string;
  agentKey: string;
  score: number;
  reflection?: string;
}

export async function pruneAndReflect(
  rt: AgentRuntime,
  branches: BranchScore[],
  threshold: number = DEFAULT_CONFIG.mcts.pruneThreshold,
): Promise<void> {
  for (const b of branches) {
    const node = rt.storage.sql<{ visits: number }>`
      SELECT visits FROM search_nodes WHERE id = ${b.nodeId}
    `[0];
    if (!node) continue;

    // Prune only if below threshold AND visited at least twice (avoid premature pruning)
    if (b.score < threshold && node.visits >= 2) {
      // Reflection already written to memory in engine.ts STEP 7.
      // We don't duplicate the write here.

      // Soft prune: mark status, stop UCT from selecting it
      rt.storage.sql`
        UPDATE search_nodes SET status = 'pruned', branch_agent_key = NULL
        WHERE id = ${b.nodeId}
      `;

      // Abort the branch agent (platform-specific, via injected callback)
      await rt.abortBranch(b.agentKey, 'pruned').catch(() => {
        // Branch may already be gone — that's fine
      });
    }
  }
}
