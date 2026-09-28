/**
 * Pruning: retire settled low-value open nodes.
 * Formal spec: MCTS/StorageIsolation.lean — transition_preserves_isolation
 * Scans the whole open population of this `root_id`: fresh children have visits === 1,
 * so only re-selected nodes can pass the minVisitsForPrune gate.
 */

import type { AgentRuntime } from '../types/agent-runtime';
import { DEFAULT_CONFIG } from '../config';

export function pruneLowValueBranches(
  rt: AgentRuntime,
  rootId: string,
  threshold: number = DEFAULT_CONFIG.mcts.pruneThreshold,
  minVisits: number = DEFAULT_CONFIG.mcts.minVisitsForPrune,
): void {
  void rt.storage.sql`
    UPDATE search_nodes SET status = 'pruned'
    WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId} AND status = 'open'
      AND value < ${threshold} AND visits >= ${minVisits}
  `;
}
