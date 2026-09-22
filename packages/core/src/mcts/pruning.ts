/**
 * MCTS pruning: retire settled low-value open nodes and free their branch agents.
 * Reference: docs/MCTS.md "Pruning and convergence".
 * Formal spec: MCTS/StorageIsolation.lean — transition_preserves_isolation
 * Scans the whole open population of this `root_id`: fresh children have visits === 1,
 * so only re-selected nodes can pass the minVisitsForPrune gate.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { DEFAULT_CONFIG } from '../config';
import { diagnostics, toKinuError } from '../obs/index';

export async function pruneLowValueBranches(
  rt: AgentRuntime,
  rootId: string,
  threshold: number = DEFAULT_CONFIG.mcts.pruneThreshold,
  minVisits: number = DEFAULT_CONFIG.mcts.minVisitsForPrune,
): Promise<void> {
  const doomed = rt.storage.sql<{ id: string; branch_agent_key: string | null }>`
    SELECT id, branch_agent_key FROM search_nodes
    WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId} AND status = 'open'
      AND value < ${threshold} AND visits >= ${minVisits}
  `;

  for (const node of doomed) {
    void rt.storage.sql`
      UPDATE search_nodes SET status = 'pruned', branch_agent_key = NULL
      WHERE actor_id = ${rt.actor.actorId} AND id = ${node.id}
    `;

    if (node.branch_agent_key) {
      // One abort failure must not end the sweep: the node is already pruned.
      try {
        await rt.abortBranch(node.branch_agent_key, 'pruned');
      } catch (cause) {
        diagnostics.failure(
          'mcts.prune_abort_failed',
          toKinuError({ doing: 'abort a pruned branch agent', cause, otherwise: 'unavailable' }),
          { nodeId: node.id },
        );
      }
    }
  }
}
