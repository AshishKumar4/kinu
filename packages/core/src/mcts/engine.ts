/**
 * MCTS search engine — the full fiber-backed parallel exploration loop.
 *
 * Architecture reference: final-architecture.md §5.12 (Full Lifecycle)
 * Paper: LATS arXiv:2310.04406
 * Formal spec: DistributedModel.lean — storage_isolation_invariant
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { MCTSConfig, MCTSPhase, SearchNode } from '../types/mcts.js';
import type { ConvergenceResult } from '../types/evaluation.js';
import type { SessionWriter } from './record-node.js';
import type { BranchScore } from './pruning.js';
import { DEFAULT_CONFIG } from '../config.js';
import { initSearchTables } from './schemas.js';
import { selectNode } from './uct.js';
import { backpropagate } from './backpropagation.js';
import { recordNode } from './record-node.js';
import { converge } from './convergence.js';
import { pruneAndReflect } from './pruning.js';
import { maybeStoreCraftedTool } from '../craft/discovery.js';
import { estimateCost } from './cost.js';
import { nanoid } from '../utils/nanoid.js';
import { isoDate } from '../utils/date.js';

export async function runMCTS(
  rt: AgentRuntime,
  session: SessionWriter,
  task: string,
  config: MCTSConfig,
): Promise<ConvergenceResult> {
  const defaults = DEFAULT_CONFIG.mcts;
  const N_BRANCHES = Math.max(1, config.branches);
  const maxDepth = config.maxDepth ?? defaults.maxDepth;
  const W = config.explorationWeight ?? defaults.explorationWeight;
  const pruneThreshold = config.pruneThreshold ?? defaults.pruneThreshold;
  const minAcceptableScore = config.minAcceptableScore ?? defaults.minAcceptableScore;
  const maxCostUSD = config.maxCostUSD ?? defaults.maxCostUSD;
  const reflectionThreshold = defaults.reflectionThreshold;
  const craftExtractionThreshold = defaults.craftExtractionThreshold;

  const estimate = estimateCost(config.budget, N_BRANCHES);
  if (estimate.estimatedUSD > maxCostUSD) {
    throw new Error(
      `Estimated cost $${estimate.estimatedUSD.toFixed(2)} exceeds limit $${maxCostUSD}. ` +
      `Reduce budget (${config.budget}) or branches (${N_BRANCHES}).`,
    );
  }

  initSearchTables(rt.storage.execRaw);

  const rootId = nanoid();
  const rootMsgId = await recordNode(session, rt.storage.sql, {
    nodeId: rootId,
    parentNodeId: null,
    parentMsgId: null,
    task,
    action: '',
    observation: task,
    codeUsed: null,
    depth: 0,
  });

  return rt.schedule.fiber<ConvergenceResult>('mcts', async (ctx) => {
    const phase: MCTSPhase = (ctx.snapshot as MCTSPhase | null) ?? {
      iteration: 0,
      budget: config.budget,
      rootId,
      rootMsgId,
      task,
    };

    while (phase.budget > 0) {
      const selected = selectNode(rt.storage.sql, W);
      if (!selected || selected.depth >= maxDepth) break;

      // EXPAND — spawn N branches
      const branchIds = Array.from({ length: N_BRANCHES }, () =>
        `${selected.id.slice(0, 8)}-${nanoid(8)}`,
      );
      const branchHandles = await Promise.all(
        branchIds.map(id => rt.spawnBranch(id)),
      );

      const priorHistory = selected.msg_id
        ? session.getHistory(selected.msg_id)
        : [{ role: 'user', content: task }];
      const craftedTools = rt.craftStore.getAll();

      // EXPLORE — parallel LLM calls (allSettled: one branch failure doesn't kill the rest)
      const explorationResults = await Promise.allSettled(
        branchHandles.map(handle => handle.explore(priorHistory, craftedTools)),
      );
      const explorations = explorationResults.map(r =>
        r.status === 'fulfilled' ? r.value : { text: '', codeUsed: null },
      );

      // RECORD nodes
      const childNodeIds: string[] = [];
      for (let i = 0; i < N_BRANCHES; i++) {
        const childId = branchIds[i] ?? nanoid();
        const exploration = explorations[i] ?? { text: '', codeUsed: null };
        childNodeIds.push(childId);
        await recordNode(session, rt.storage.sql, {
          nodeId: childId,
          parentNodeId: selected.id,
          parentMsgId: selected.msg_id,
          task,
          action: exploration.text.slice(0, 300),
          observation: exploration.text,
          codeUsed: exploration.codeUsed ?? null,
          depth: selected.depth + 1,
        });
        rt.storage.sql`
          UPDATE search_nodes SET branch_agent_key = ${childId}
          WHERE id = ${childId}
        `;
      }

      // EVALUATE — cross-model judging (allSettled: partial failures → score 0.5)
      const scoreResults = await Promise.allSettled(
        branchHandles.map(handle => handle.evaluate(task)),
      );
      const scores = scoreResults.map(r =>
        r.status === 'fulfilled' ? r.value : 0.5,
      );

      // BACKPROPAGATE
      for (let i = 0; i < N_BRANCHES; i++) {
        const nodeId = childNodeIds[i];
        const score = scores[i];
        if (nodeId !== undefined && score !== undefined) {
          backpropagate(rt.storage.sql, nodeId, score);
        }
      }

      // REFLECT on failures + PRUNE
      const branchScores: BranchScore[] = [];
      for (let i = 0; i < N_BRANCHES; i++) {
        const score = scores[i] ?? 0.5;
        const nodeId = childNodeIds[i] ?? '';
        const branchId = branchIds[i] ?? '';
        let reflection: string | undefined;

        if (score < reflectionThreshold) {
          const handle = branchHandles[i];
          if (handle) {
            reflection = await handle.generateReflection(task);
            await rt.memory.append(
              'memory/MEMORY.md',
              `\n### Failure lesson (${isoDate()})\n${reflection}\n`,
            );
            await rt.memory.index('memory/MEMORY.md');
          }
        }

        branchScores.push({ nodeId, agentKey: branchId, score, reflection });
      }
      await pruneAndReflect(rt, branchScores, pruneThreshold);

      // EXTRACT crafted tools from winners
      for (let i = 0; i < N_BRANCHES; i++) {
        const score = scores[i] ?? 0;
        const exploration = explorations[i];
        if (score > craftExtractionThreshold && exploration?.codeUsed) {
          await maybeStoreCraftedTool(rt, exploration.codeUsed, score);
        }
      }

      phase.iteration++;
      phase.budget--;
      ctx.stash(phase);

      // Notify caller for real-time UI updates
      config.onIterationComplete?.(phase.iteration, phase.budget);
    }

    return converge(rt, session, minAcceptableScore);
  });
}
