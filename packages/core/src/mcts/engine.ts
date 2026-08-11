/**
 * MCTS search engine — the full fiber-backed parallel exploration loop.
 *
 * Architecture reference: docs/MCTS.md — "Search Flow"
 * Paper: LATS arXiv:2310.04406
 * Formal spec: MCTS/StorageIsolation.lean — init_isolated, transition_preserves_isolation
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { MCTSConfig, MCTSPhase, MCTSProgressEvent, SearchNode } from '../types/mcts.js';
import type { ConvergenceResult } from '../types/evaluation.js';
import type { SessionWriter } from './record-node.js';
import { DEFAULT_CONFIG } from '../config.js';
import { initSearchTables } from './schemas.js';
import { initAlternateTakesTable } from './takes.js';
import { selectNode } from './uct.js';
import { siblingAngles } from './diversity.js';
import { backpropagate } from './backpropagation.js';
import { recordNode } from './record-node.js';
import { converge, abandonSearchTree } from './convergence.js';
import { evaluateWithMultiModelJudging } from './evaluation.js';
import { pruneLowValueBranches } from './pruning.js';
import { maybeStoreCraftedTool } from '../craft/discovery.js';
import { estimateCost } from './cost.js';
import { persistableMCTSConfig } from './search-store.js';
import { initMctsSearchTable } from './search-store.js';
import { nanoid } from '../utils/nanoid.js';
import { isoDate } from '../utils/date.js';

export async function runMCTS(
  rt: AgentRuntime,
  session: SessionWriter,
  task: string,
  config: MCTSConfig,
): Promise<ConvergenceResult> {
  initSearchTables(rt.storage.execRaw);
  initAlternateTakesTable(rt.storage.execRaw);

  const search = config.search;
  if (search) initMctsSearchTable(rt.storage.execRaw);

  // Resume an unfinished search for this task (one evicted mid-run): continue its
  // remaining budget against the persisted tree instead of starting over (B6).
  // The stored config is authoritative for the loop — knobs can't drift on resume.
  const resumed = search?.findResumable(task) ?? null;
  const effective: MCTSConfig = resumed ? { ...config, ...resumed.config } : config;

  const defaults = DEFAULT_CONFIG.mcts;
  const N_BRANCHES = Math.max(1, effective.branches);
  const maxDepth = effective.maxDepth ?? defaults.maxDepth;
  const W = effective.explorationWeight ?? defaults.explorationWeight;
  const pruneThreshold = effective.pruneThreshold ?? defaults.pruneThreshold;
  const minVisitsForPrune = defaults.minVisitsForPrune;
  const minAcceptableScore = effective.minAcceptableScore ?? defaults.minAcceptableScore;
  const maxCostUSD = effective.maxCostUSD ?? defaults.maxCostUSD;
  const judgeSamples = effective.judgeSamples ?? defaults.judgeSamples;
  const maxEvalLLMCalls = effective.maxEvalLLMCalls ?? defaults.maxEvalLLMCalls;
  const takesEpsilon = effective.takesEpsilon ?? defaults.takesEpsilon;
  const reflectionThreshold = defaults.reflectionThreshold;
  const craftExtractionThreshold = defaults.craftExtractionThreshold;

  const estimate = estimateCost(effective.budget, N_BRANCHES, maxEvalLLMCalls);
  if (estimate.estimatedUSD > maxCostUSD) {
    throw new Error(
      `Estimated cost $${estimate.estimatedUSD.toFixed(2)} exceeds limit $${maxCostUSD}. ` +
      `Reduce budget (${effective.budget}) or branches (${N_BRANCHES}).`,
    );
  }

  let rootId: string;
  let rootMsgId: string;
  let initialPhase: MCTSPhase;
  // Lease epoch for this executor's search-store writes — bumped when a resume
  // reclaims a running search (fences the dead executor, §5.3).
  let searchEpoch = 0;

  if (resumed) {
    rootId = resumed.rootId;
    rootMsgId = resumed.rootMsgId;
    initialPhase = { iteration: resumed.iteration, budget: resumed.budget, rootId, rootMsgId, task };
    searchEpoch = search!.reclaim(rootId) ?? resumed.epoch;
  } else {
    rootId = nanoid();
    rootMsgId = await recordNode(session, rt.storage.sql, {
      nodeId: rootId,
      parentNodeId: null,
      parentMsgId: null,
      rootId,
      task,
      action: '',
      observation: task,
      codeUsed: null,
      depth: 0,
    });
    initialPhase = { iteration: 0, budget: effective.budget, rootId, rootMsgId, task };
    search?.begin({
      rootId, task, rootMsgId,
      config: persistableMCTSConfig(effective), budget: effective.budget, now: Date.now(),
    });
  }

  const report = (event: MCTSProgressEvent): void => config.onProgress?.(event);

  return rt.schedule.fiber<ConvergenceResult>('mcts', async (ctx) => {
    // The durable search store is the resume source of truth when injected; the
    // fiber snapshot is the fallback for the inline/no-store path (tests).
    const phase: MCTSPhase = search ? initialPhase : ((ctx.snapshot as MCTSPhase | null) ?? initialPhase);

    while (phase.budget > 0) {
      throwIfAborted(config.signal);
      // Depth cap lives in selection (WP-A4): a maxed-out argmax no longer
      // aborts the search — selection skips depth-capped nodes and the budget
      // keeps flowing to the shallower frontier. Break only when nothing is
      // selectable (frontier exhausted or every open node is at the cap).
      const selected = selectNode(rt.storage.sql, rootId, W, maxDepth);
      if (!selected) break;

      const iteration = phase.iteration + 1;
      report({
        type: 'phase', phase: 'explore',
        iteration, remainingBudget: phase.budget, branches: N_BRANCHES,
      });

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
      // The expansion owns its branch agents for exactly this iteration:
      // they explore, get scored, reflect, and are then released. On the CLI
      // these are child processes — leaking them keeps the search's caller
      // alive long after the tree is done.
      try {
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
        const explorations = explorationResults.map((r, i) => {
          // A branch runs behind a backend seam (a facet RPC on cf, a forked
          // worker locally), so a "fulfilled" result is still untrusted input:
          // a malformed one must score 0 like any other failure, never crash
          // the search after its nodes are already recorded.
          if (r.status === 'fulfilled' && typeof r.value?.text === 'string') return r.value;
          report({
            type: 'branch-failed', stage: 'explore', iteration,
            branchId: branchIds[i] ?? '',
            error: r.status === 'rejected' ? reasonText(r.reason) : 'branch returned no exploration',
          });
          return { text: '', codeUsed: null };
        });

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
            rootId,
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

        const proposals = explorations.map(e => e.text);

        // EVALUATE — the engine-level seam every backend shares: branches only
        // explore; scoring happens HERE through the one grounded evaluator
        // (execution verdicts via rt.executor + judge ensemble via
        // rt.judgeModel ?? rt.llm, sibling-relative). Evaluation failures score
        // 0, not neutral 0.5; otherwise failed infrastructure can look like a
        // balanced optimum and converge falsely.
        report({
          type: 'phase', phase: 'evaluate',
          iteration, remainingBudget: phase.budget, branches: N_BRANCHES,
        });
        const scoreResults = await abortable(
          Promise.allSettled(explorations.map((exploration, i) =>
            evaluateWithMultiModelJudging({
              task,
              trajectory: exploration.text,
              codeUsed: exploration.codeUsed,
              siblings: proposals.filter((p, j) => j !== i && p.length > 0),
              // Close the band loophole (WP-A5): if a sibling attempted code,
              // this prose-only branch is capped at the fail ceiling.
              siblingsProducedCode: explorations.some((e, j) => j !== i && !!e.codeUsed),
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
        const scores = scoreResults.map((r, i) => {
          if (r.status === 'fulfilled') return r.value.score;
          report({
            type: 'branch-failed', stage: 'evaluate', iteration,
            branchId: branchIds[i] ?? '', error: reasonText(r.reason),
          });
          return 0;
        });

        // BACKPROPAGATE
        for (let i = 0; i < N_BRANCHES; i++) {
          const nodeId = childNodeIds[i];
          const score = scores[i];
          if (nodeId !== undefined && score !== undefined) {
            backpropagate(rt.storage.sql, nodeId, score);
          }
        }

        // REFLECT — write a failure lesson to memory for each below-threshold
        // branch. Pruning is separate: it scans the whole open population for
        // settled low-value nodes (pruneLowValueBranches), so it isn't confined
        // to this iteration's freshly-expanded children.
        const reflecting = scores.filter(score => score < reflectionThreshold).length;
        if (reflecting > 0) {
          report({
            type: 'phase', phase: 'reflect',
            iteration, remainingBudget: phase.budget, branches: reflecting,
          });
        }
        for (let i = 0; i < N_BRANCHES; i++) {
          const score = scores[i] ?? 0;
          if (score >= reflectionThreshold) continue;
          const handle = branchHandles[i];
          if (!handle) continue;
          // A reflection is an optional memory side-effect on an already-scored
          // branch. Its model call fails the same way exploration does (that is
          // what allSettled above tolerates), so letting it throw would discard
          // a search whose branches are already recorded and backpropagated.
          const reflection = await handle.generateReflection(task).then(
            text => text.trim(),
            (err: unknown) => {
              report({
                type: 'branch-failed', stage: 'reflect', iteration,
                branchId: branchIds[i] ?? '', error: reasonText(err),
              });
              return '';
            },
          );
          throwIfAborted(config.signal);
          // An empty reflection carries no lesson — writing it just litters
          // MEMORY.md with duplicate bare "### Failure lesson" headers.
          if (reflection) {
            await rt.memory.append(
              'memory/MEMORY.md',
              `\n### Failure lesson (${isoDate()})\n${reflection}\n`,
            );
            await rt.memory.index('memory/MEMORY.md');
          }
        }
        await pruneLowValueBranches(rt, rootId, pruneThreshold, minVisitsForPrune);
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
        // Durable, epoch-fenced checkpoint: an eviction after this can re-enter and
        // continue from the remaining budget against the persisted tree (B6).
        search?.checkpoint(rootId, searchEpoch, phase.iteration, phase.budget, Date.now());

        report({
          type: 'iteration-complete',
          iteration: phase.iteration, remainingBudget: phase.budget, scores,
        });
      } finally {
        await abortBranches();
      }
    }

    // CONVERGE — the durable settle record must never run ahead of the work it
    // claims. converge() awaits real I/O (a summary call, memory writes) before
    // it closes the tree, so writing 'converged' first left a search recorded as
    // settled with its whole tree still open whenever that I/O failed or the
    // process died mid-flight. Order: close the tree, then record the outcome.
    // A crash between the two is safe in one direction only — a closed tree with
    // a still-'running' row is inert (nothing is selectable) and resumable.
    try {
      const result = await converge(rt, session, rootId, minAcceptableScore, takesEpsilon);
      search?.converge(rootId, searchEpoch, Date.now());
      return result;
    } catch (err) {
      // The budget is spent, so a resume would re-enter with nothing left to
      // explore and fail again. Retire the tree and settle the search as failed
      // rather than leaving a poison-pill 'running' row for this task.
      abandonSearchTree(rt.storage.sql, rootId);
      search?.fail(rootId, searchEpoch, Date.now());
      throw err;
    }
  });
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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
