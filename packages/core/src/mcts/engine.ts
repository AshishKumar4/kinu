/**
 * MCTS search engine: the fiber-backed parallel exploration loop. Reference: docs/MCTS.md "Search Flow".
 * LATS arXiv:2310.04406 programming instantiation (§5.2); `plan` mode is Tree of Thoughts with UCT.
 * Formal spec: MCTS/StorageIsolation.lean — init_isolated, transition_preserves_isolation
 */

import type { AgentRuntime, BranchReflection } from '../types/agent-runtime';
import type { MCTSConfig, MCTSPhase, MCTSProgressBody } from '../types/mcts';
import { missionMeter } from '../mission-budget';
import type { ConvergenceResult } from '../types/evaluation';
import type { NodeEvaluationDiagnostics, SessionWriter } from './record-node';
import { DEFAULT_CONFIG } from '../config';
import { initSearchTables } from './schemas';
import { initAlternateTakesTable } from './takes';
import { selectNode } from './uct';
import { siblingAngles } from './diversity';
import { backpropagate } from './backpropagation';
import { recordNode } from './record-node';
import { converge, abandonSearchTree } from './convergence';
import { evaluateWithMultiModelJudging, executionObservation, type BranchEvaluation } from './evaluation';
import { readProposalCode } from '../execution/code-fence';
import { pruneLowValueBranches } from './pruning';
import { isCraftable, maybeStoreCraftedTool } from '../craft/discovery';
import { describeCostBasis, estimateCost } from './cost';
import { persistableMCTSConfig } from './search-store';
import { initMctsSearchTable } from './search-store';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';
import { nanoid } from '../utils/nanoid';
import { isoDate } from '../utils/date';
import * as v from 'valibot';
import { UsageSchema } from '../usage';

/** The durable fiber one search runs in; exported because backend fiber-recovery hooks match on it. */
export const SEARCH_FIBER_NAME = 'mcts';

export const BranchExplorationSchema = v.object({
  text: v.string(),
  usage: v.optional(UsageSchema),
});

export const BranchReflectionSchema = v.object({
  text: v.string(),
  usage: v.optional(UsageSchema),
});

const MCTSPhaseSchema: v.GenericSchema<MCTSPhase> = v.object({
  iteration: v.number(),
  budget: v.number(),
  rootId: v.string(),
  rootMsgId: v.string(),
  task: v.string(),
});

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

  // Resume an unfinished search (B6); the stored config is authoritative for the loop.
  const mode = config.mode ?? 'build';
  const resumed = search?.findResumable(task, mode) ?? null;

  const effective: MCTSConfig = resumed
    ? { ...config, ...resumed.config, mode }
    : { ...config, mode };

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

  // `config.costModel` is a host seam, never persisted. A resume prices only the remaining budget.
  const estimateBudget = resumed?.budget ?? effective.budget;
  const estimate = estimateCost(estimateBudget, N_BRANCHES, maxEvalLLMCalls, config.costModel?.());

  if (estimate.estimatedUSD > maxCostUSD) {
    // The refusal names its pricing basis so a mispriced model is distinguishable from a real cap.
    throw new Error(
      `Estimated cost $${estimate.estimatedUSD.toFixed(2)} exceeds limit $${maxCostUSD} `
      + `(${describeCostBasis(estimate.basis)}). `
      + `Reduce budget (${estimateBudget}) or branches (${N_BRANCHES}).`,
    );
  }

  let rootId: string;
  let rootMsgId: string;
  let initialPhase: MCTSPhase;
  // Lease epoch for search-store writes; bumped when a resume reclaims a running search (§5.3).
  let searchEpoch = 0;

  if (resumed) {
    rootId = resumed.rootId;
    rootMsgId = resumed.rootMsgId;
    initialPhase = { iteration: resumed.iteration, budget: resumed.budget, rootId, rootMsgId, task };
    searchEpoch = search?.reclaim(rootId) ?? resumed.epoch;
  } else {
    rootId = nanoid();
    rootMsgId = await recordNode(session, rt.storage.sql, rt.actor, {
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
      rootId, task, rootMsgId, engine: 'mcts',
      // The resolved judge knobs, so the row states what ensemble was requested (read-models/fork-params.ts).
      config: persistableMCTSConfig({ ...effective, judgeSamples, maxEvalLLMCalls }),
      budget: effective.budget, now: Date.now(),
    });
  }

  const report = (event: MCTSProgressBody): void => config.onProgress?.({ ...event, rootId });
  const { outOfBudget, charge } = missionMeter(config.mission);
  const reportedUngroundedLanguages = new Set<string>();
  const reportedClampedEnsembles = new Set<number>();

  return rt.schedule.fiber<ConvergenceResult>(SEARCH_FIBER_NAME, async (ctx) => {
    // The durable search store is the resume source of truth; the fiber snapshot is the no-store fallback.
    const snapshot = v.safeParse(MCTSPhaseSchema, ctx.snapshot);
    const phase = search || !snapshot.success ? initialPhase : snapshot.output;

    while (phase.budget > 0) {
      throwIfAborted(config.signal);

      // The mission ledger gates the expansion, not the branch: a refused branch would backpropagate 0.
      if (await outOfBudget()) break;
      // Depth cap lives in selection (WP-A4); break only when nothing is selectable.
      const selected = selectNode(rt.storage.sql, rt.actor, rootId, { explorationWeight: W, maxDepth });

      if (!selected) break;

      const iteration = phase.iteration + 1;
      report({
        type: 'phase', phase: 'explore',
        iteration, remainingBudget: phase.budget, branches: N_BRANCHES,
      });

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

      // Branch agents live for exactly this iteration; on the CLI a leak keeps the caller alive.
      try {
        throwIfAborted(config.signal);

        const priorHistory = selected.msg_id
          ? await session.getHistory(selected.msg_id)
          : [{ role: 'user', content: task }];

        const craftedTools = rt.craftStore.list();

        // allSettled: one branch failure does not kill the rest. Sibling angles diversify proposals.
        const explorationResults = await abortable(
          Promise.allSettled(branchHandles.map((handle, i) =>
            handle.explore({
              priorHistory,
              craftedTools,
              languages: rt.executor.languages,
              mode,
              siblings: siblingAngles(i, N_BRANCHES),
            }),
          )),
          config.signal,
          abortBranches,
        );

        throwIfAborted(config.signal);

        const explorations = explorationResults.map((r, i) => {
          // A fulfilled branch result is still untrusted input: a malformed one scores 0.
          const exploration = r.status === 'fulfilled'
            ? v.safeParse(BranchExplorationSchema, r.value)
            : null;

          if (exploration?.success) {
            // Reported here, the only place that knows the branch completed a call; `{}` when no usage.
            config.reportModelCall?.({ source: 'mcts', usage: exploration.output.usage ?? {} });

            return exploration.output;
          }

          report({
            type: 'branch-failed', stage: 'explore', iteration,
            branchId: branchIds[i] ?? '',
            error: r.status === 'rejected'
              ? renderThrownChain({ cause: r.reason })
              : 'branch returned no exploration',
          });

          return { text: '' };
        });

        // Charged per rollout so the next expansion's guard reads a current ledger.
        for (const exploration of explorations) await charge(exploration.usage);

        const offeredCode = explorations.map(({ text }) => mode === 'plan'
          ? null
          : readProposalCode(text, rt.executor.languages));

        const proposals = explorations.map(e => e.text);

        // Failures score 0, not 0.5. Runs before recording: a node's observation is the environment's reply.
        report({
          type: 'phase', phase: 'evaluate',
          iteration, remainingBudget: phase.budget, branches: N_BRANCHES,
        });

        const scoreResults = await abortable(
          Promise.allSettled(explorations.map((exploration, i) =>
            evaluateWithMultiModelJudging({
              task,
              trajectory: exploration.text,
              siblings: proposals.filter((p, j) => j !== i && p.length > 0),
              // WP-A5: if a sibling attempted code, a prose-only branch is capped at the fail ceiling.
              siblingsProducedCode: offeredCode.some((code, j) =>
                j !== i && code?.kind === 'runnable'),
              executionPolicy: mode === 'plan' ? 'judge-only' : 'grounded',
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
        const scores: number[] = [];
        const observations: Array<string | null> = [];
        const evaluations: Array<BranchEvaluation | null> = [];

        for (const [i, r] of scoreResults.entries()) {
          if (r.status !== 'fulfilled') {
            report({
              type: 'branch-failed', stage: 'evaluate', iteration,
              branchId: branchIds[i] ?? '', error: renderThrownChain({ cause: r.reason }),
            });
            scores.push(0);
            observations.push(null);
            evaluations.push(null);
            continue;
          }

          const language = r.value.unrunnableLanguage;

          if (language !== undefined && !reportedUngroundedLanguages.has(language)) {
            reportedUngroundedLanguages.add(language);
            report({
              type: 'grounding-unavailable',
              language,
              canRun: [...rt.executor.languages],
              iteration,
              remainingBudget: phase.budget,
            });
          }

          // The realised ensemble size, reported only when judging was reached.
          const realised = r.value.judgeSamplesAttempted;

          if (realised > 0) {
            // Also on the ledger row, which the surface reads; the store keeps the smallest reached.
            search?.observeJudgeEnsemble(rootId, realised);
          }

          if (realised > 0 && realised < judgeSamples && !reportedClampedEnsembles.has(realised)) {
            reportedClampedEnsembles.add(realised);
            diagnostics.event('mcts.judge_ensemble_clamped', {
              rootId,
              mode,
              iteration,
              judgeSamplesRequested: judgeSamples,
              judgeSamplesRealised: realised,
              maxEvalLLMCalls,
            });
          }

          scores.push(r.value.score);
          observations.push(executionObservation(r.value.execution));
          evaluations.push(r.value);
        }

        const childNodeIds: string[] = [];

        for (let i = 0; i < N_BRANCHES; i++) {
          const childId = branchIds[i] ?? nanoid();
          const exploration = explorations[i] ?? { text: '' };
          const code = offeredCode[i];
          childNodeIds.push(childId);
          await recordNode(session, rt.storage.sql, rt.actor, {
            nodeId: childId,
            parentNodeId: selected.id,
            parentMsgId: selected.msg_id,
            rootId,
            task,
            action: exploration.text.slice(0, 300),
            observation: exploration.text,
            feedback: observations[i] ?? null,
            codeUsed: code?.kind === 'runnable' ? code.code : null,
            codeLanguage: code?.kind === 'runnable' ? code.language : null,
            depth: selected.depth + 1,
            evaluation: nodeEvaluationDiagnostics(evaluations[i]),
          });
          void rt.storage.sql`
   UPDATE search_nodes SET branch_agent_key = ${childId}
            WHERE actor_id = ${rt.actor.actorId} AND id = ${childId}
          `;
        }

        for (let i = 0; i < N_BRANCHES; i++) {
          const nodeId = childNodeIds[i];
          const score = scores[i];

          if (nodeId !== undefined && score !== undefined) {
            backpropagate(rt.storage.sql, rt.actor, nodeId, score);
          }
        }

        // Reflect below-threshold branches to memory; pruning scans the whole open population separately.
        const reflecting = mode === 'build'
          ? scores.filter(score => score < reflectionThreshold).length
          : 0;

        if (reflecting > 0) {
          report({
            type: 'phase', phase: 'reflect',
            iteration, remainingBudget: phase.budget, branches: reflecting,
          });
        }

        // A reflection is another model call, so the budget may already be spent.
        const mayReflect = mode === 'build' && !(await outOfBudget());

        for (let i = 0; mayReflect && i < N_BRANCHES; i++) {
          const score = scores[i] ?? 0;

          if (score >= reflectionThreshold) continue;
          const handle = branchHandles[i];

          if (!handle) continue;
          // A reflection is optional: its failure or malformed result yields no lesson, never a thrown search.
          // The verdict travels with the question (LATS §4.2); null when nothing executed.
          let result: BranchReflection | undefined;

          try {
            result = await handle.generateReflection(task, observations[i] ?? undefined);
          } catch (cause) {
            report({
              type: 'branch-failed', stage: 'reflect', iteration,
              branchId: branchIds[i] ?? '', error: renderThrownChain({ cause }),
            });
          }

          const parsed = v.safeParse(BranchReflectionSchema, result);
          let reflection = '';

          if (parsed.success) {
            await charge(parsed.output.usage);
            config.reportModelCall?.({ source: 'mcts', usage: parsed.output.usage ?? {} });
            reflection = parsed.output.text.trim();
          }

          throwIfAborted(config.signal);

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

        for (let i = 0; i < N_BRANCHES; i++) {
          const score = scores[i] ?? 0;
          const code = offeredCode[i];

          if (mode === 'build' && score > craftExtractionThreshold && code?.kind === 'runnable'
              && isCraftable(code.language)) {
            await maybeStoreCraftedTool(rt, code.code, score);
          }
        }

        phase.iteration++;
        phase.budget--;
        ctx.stash({
          iteration: phase.iteration,
          budget: phase.budget,
          rootId: phase.rootId,
          rootMsgId: phase.rootMsgId,
          task: phase.task,
        });
        // Durable, epoch-fenced checkpoint for resume (B6).
        search?.checkpoint(rootId, searchEpoch, { iteration: phase.iteration, budget: phase.budget, now: Date.now() });

        if (search) {
          diagnostics.event('mcts.checkpoint_reached', {
            rootId,
            iteration: phase.iteration,
            total: phase.iteration + phase.budget,
            remaining: phase.budget,
          });
        }

        report({
          type: 'iteration-complete',
          iteration: phase.iteration, remainingBudget: phase.budget, scores,
        });
      } finally {
        await Promise.allSettled(branchHandles.map((handle) => handle.release()));
      }
    }

    // Close the tree, then record the outcome: the settle record must never run ahead of the work.
    // A false result settles as `no_acceptable_candidate`.
    try {
      const result = await converge(rt, session, rootId, { minAcceptable: minAcceptableScore, takesEpsilon, mode });

      if (result.converged) {
        search?.converge(rootId, searchEpoch, Date.now());
      } else {
        search?.noAcceptableCandidate(rootId, searchEpoch, Date.now());
      }

      return result;
    } catch (err) {
      // Budget spent: retire the tree and settle as failed rather than leave a poison-pill 'running' row.
      abandonSearchTree(rt.storage.sql, rt.actor, rootId);
      search?.fail(rootId, searchEpoch, Date.now());
      throw err;
    }
  });
}

function nodeEvaluationDiagnostics(
  evaluation: BranchEvaluation | null | undefined,
): NodeEvaluationDiagnostics | null {
  if (!evaluation) return null;

  return {
    grounding: evaluation.grounding,
    score: evaluation.score,
    judgeSamplesAttempted: evaluation.judgeSamplesAttempted,
    judgeSamplesUsed: evaluation.judgeSamplesUsed,
    execution: evaluation.execution && {
      passed: evaluation.execution.passed,
      passedChecks: evaluation.execution.passedChecks,
      totalChecks: evaluation.execution.totalChecks,
      assertionsGenerated: evaluation.execution.assertionsGenerated,
    },
    unrunnableLanguage: evaluation.unrunnableLanguage,
  };
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

  let aborting = false;
  let cleanup = (): void => {};

  const aborted = new Promise<never>((_resolve, reject) => {
    const onSignalAbort = async (): Promise<void> => {
      if (aborting) return;
      aborting = true;
      cleanup();

      try {
        await onAbort();
      } catch (cause) {
        // The abort sweep itself failed; recorded rather than surfacing as an unhandled rejection.
        diagnostics.failure(
          'mcts.abort_sweep_failed',
          toKinuError({ doing: 'abort MCTS branches on signal', cause, otherwise: 'cancelled' }),
          { signalReason: renderThrownChain({ cause: signal.reason }) },
        );
      }

      reject(signal.reason instanceof Error ? signal.reason : new Error('MCTS aborted'));
    };

    cleanup = () => signal.removeEventListener('abort', onSignalAbort);
    signal.addEventListener('abort', onSignalAbort, { once: true });
  });

  try {
    return await Promise.race([
      (async (): Promise<T> => {
        try {
          const value = await promise;

          return aborting ? await aborted : value;
        } catch (cause) {
          if (aborting) return await aborted;
          throw cause;
        } finally {
          if (!aborting) cleanup();
        }
      })(),
      aborted,
    ]);
  } finally {
    cleanup();
  }
}
