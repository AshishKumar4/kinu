/**
 * MCTS search engine — the full fiber-backed parallel exploration loop.
 *
 * Architecture reference: final-architecture.md §5.12 (Full Lifecycle)
 * Paper: LATS arXiv:2310.04406
 * Formal spec: MCTS/StorageIsolation.lean — init_isolated, transition_preserves_isolation
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { MCTSConfig, MCTSPhase, SearchNode } from '../types/mcts.js';
import type { ConvergenceResult } from '../types/evaluation.js';
import type { SessionWriter } from './record-node.js';
import type { BranchScore } from './pruning.js';
import { DEFAULT_CONFIG } from '../config.js';
import { initSearchTables } from './schemas.js';
import { initAlternateTakesTable } from './takes.js';
import { selectNode } from './uct.js';
import { siblingAngles } from './diversity.js';
import { backpropagate } from './backpropagation.js';
import { recordNode } from './record-node.js';
import { converge } from './convergence.js';
import { evaluateWithMultiModelJudging } from './evaluation.js';
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
  const judgeSamples = config.judgeSamples ?? defaults.judgeSamples;
  const maxEvalLLMCalls = config.maxEvalLLMCalls ?? defaults.maxEvalLLMCalls;
  const takesEpsilon = config.takesEpsilon ?? defaults.takesEpsilon;
  const reflectionThreshold = defaults.reflectionThreshold;
  const craftExtractionThreshold = defaults.craftExtractionThreshold;

  const estimate = estimateCost(config.budget, N_BRANCHES, 3, maxEvalLLMCalls);
  if (estimate.estimatedUSD > maxCostUSD) {
    throw new Error(
      `Estimated cost $${estimate.estimatedUSD.toFixed(2)} exceeds limit $${maxCostUSD}. ` +
      `Reduce budget (${config.budget}) or branches (${N_BRANCHES}).`,
    );
  }

  initSearchTables(rt.storage.execRaw);
  initAlternateTakesTable(rt.storage.execRaw);

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
      throwIfAborted(config.signal);
      const selected = selectNode(rt.storage.sql, W);
      if (!selected || selected.depth >= maxDepth) break;

      // EXPAND — spawn N branches
      const branchIds = Array.from({ length: N_BRANCHES }, () =>
        `${selected.id.slice(0, 8)}-${nanoid(8)}`,
      );
      const abortBranches = async () => {
        await Promise.allSettled(branchIds.map((id) => rt.abortBranch(id, 'aborted')));
      };
      const branchHandles = await abortable(
        Promise.all(branchIds.map(id => rt.spawnBranch(id))),
        config.signal,
        abortBranches,
      );
      throwIfAborted(config.signal);

      const priorHistory = selected.msg_id
        ? session.getHistory(selected.msg_id)
        : [{ role: 'user', content: task }];
      const craftedTools = rt.craftStore.getAll();

      // EXPLORE — parallel LLM calls (allSettled: one branch failure doesn't kill the rest).
      // Each branch is handed its siblings' distinct angles so the N proposals
      // diverge by construction, not just by sampling temperature (DO-NOW #1).
      const explorationResults = await abortable(
        Promise.allSettled(branchHandles.map((handle, i) =>
          handle.explore(priorHistory, craftedTools, siblingAngles(i, N_BRANCHES)),
        )),
        config.signal,
        abortBranches,
      );
      throwIfAborted(config.signal);
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

      // EVALUATE — the engine-level seam every backend shares: branches only
      // explore; scoring happens HERE through the one grounded evaluator
      // (execution verdicts via rt.executor + judge ensemble via
      // rt.judgeModel ?? rt.llm, sibling-relative). Evaluation failures score
      // 0, not neutral 0.5; otherwise failed infrastructure can look like a
      // balanced optimum and converge falsely.
      const proposals = explorations.map(e => e.text);
      const scoreResults = await abortable(
        Promise.allSettled(explorations.map((exploration, i) =>
          evaluateWithMultiModelJudging({
            task,
            trajectory: exploration.text,
            codeUsed: exploration.codeUsed,
            siblings: proposals.filter((p, j) => j !== i && p.length > 0),
            executor: rt.executor,
            judge: rt.judgeModel,
            explorer: rt.llm,
            judgeSamples,
            maxLLMCalls: maxEvalLLMCalls,
          }),
        )),
        config.signal,
        abortBranches,
      );
      throwIfAborted(config.signal);
      const scores = scoreResults.map(r =>
        r.status === 'fulfilled' ? r.value.score : 0,
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
        const score = scores[i] ?? 0;
        const nodeId = childNodeIds[i] ?? '';
        const branchId = branchIds[i] ?? '';
        let reflection: string | undefined;

        if (score < reflectionThreshold) {
          const handle = branchHandles[i];
          if (handle) {
            reflection = await handle.generateReflection(task);
            throwIfAborted(config.signal);
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
      throwIfAborted(config.signal);

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

    return converge(rt, session, minAcceptableScore, takesEpsilon);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('MCTS aborted');
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void>,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    await onAbort();
    throwIfAborted(signal);
  }
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const cleanup = () => signal.removeEventListener('abort', onSignalAbort);
    const onSignalAbort = () => {
      if (done) return;
      done = true;
      cleanup();
      void onAbort().finally(() => reject(signal.reason instanceof Error ? signal.reason : new Error('MCTS aborted')));
    };
    signal.addEventListener('abort', onSignalAbort, { once: true });
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        cleanup();
        reject(err);
      },
    );
  });
}
