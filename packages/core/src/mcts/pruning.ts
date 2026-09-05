/**
 * MCTS pruning — retire settled low-value branches so selection stops spending
 * on them and their branch agents are freed.
 *
 * Architecture reference: docs/MCTS.md — "Pruning and convergence"
 * Formal spec: MCTS/StorageIsolation.lean — transition_preserves_isolation
 * (the Prune action preserves the storage-isolation invariant).
 *
 * Pruning criteria (WP-A2):
 * - status='open' AND backpropagated value < pruneThreshold
 * - AND visits >= minVisitsForPrune (config, was a hardcoded, unsatisfiable 2)
 *
 * We evaluate the FULL open population, not just the freshly-expanded children.
 * A child is grounded-scored once and backpropagated once → visits === 1, so a
 * fresh-children-only pass could never satisfy any visit gate and pruning never
 * fired. Scanning the population lets an internal node be pruned once it has
 * been re-selected enough for its running-mean value to settle below threshold
 * (visits >= minVisitsForPrune). Single-visit leaves are protected by the gate:
 * their one grounded sample is enough to keep UCT from re-selecting them, but
 * not to justify pruning the subtree they might still open.
 *
 * Reflections on failed branches are written to memory by the engine's REFLECT
 * step before this runs; pruning only marks status and aborts branch agents.
 *
 * Scoped to the calling search's tree (`root_id`) — an unscoped sweep would
 * retire, and abort the branch agents of, another search's live nodes.
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
    WHERE root_id = ${rootId} AND status = 'open'
      AND value < ${threshold} AND visits >= ${minVisits}
  `;

  for (const node of doomed) {
    // Soft prune: mark status so UCT stops selecting it, drop the agent key.
    void rt.storage.sql`
      UPDATE search_nodes SET status = 'pruned', branch_agent_key = NULL
      WHERE id = ${node.id}
    `;

    if (node.branch_agent_key) {
      // Abort the branch agent (platform-specific, via injected callback).
      // One abort failure must not end the sweep: the node is already
      // pruned, so record the failure and move on to the next node.
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
