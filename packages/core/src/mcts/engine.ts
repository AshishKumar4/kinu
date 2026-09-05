/**
 * MCTS search engine — the full fiber-backed parallel exploration loop.
 *
 * Architecture reference: docs/MCTS.md — "Search Flow"
 * Paper: LATS arXiv:2310.04406, the PROGRAMMING instantiation (§5.2), where a
 *   node's action is one complete candidate solution rather than a ReAct step,
 *   the simulation phase is skipped, and the environment is a generated assert
 *   suite plus the compiler. Selection/expansion/evaluation/backpropagation/
 *   reflection follow §4.2. In `plan` mode there is no environment to observe,
 *   so the search degrades to Tree of Thoughts (arXiv:2305.10601) with UCT.
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

/**
 * The durable fiber one search runs in.
 *
 * Exported for the same reason `BACKGROUND_FIBER_PREFIX` is: this module mints
 * the name and each backend's fiber-recovery hook matches on it, so two
 * literals in two packages would let a rename route an interrupted search into
 * the "no recovery is defined for this lane" branch.
 */
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

  // Resume an unfinished search for this task (one evicted mid-run): continue its
  // remaining budget against the persisted tree instead of starting over (B6).
  // The stored config is authoritative for the loop — knobs can't drift on resume.
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

  // `config.costModel`, not `effective.costModel`: this is a host seam (like
  // `reportModelCall` and `onProgress` below), never a persisted knob, so a
  // resume must not be able to restore a stale one.
  // A resume prices what it will still spend — the REMAINING budget — never the
  // persisted initial one. Spent iterations are gone; refusing on the full
  // initial budget would turn every price rise after an eviction into a refusal
  // of work the cap still funds. `effective` keeps the initial budget (the
  // loop's phase still counts down from the checkpoint); only the gate reads
  // the remainder.
  const estimateBudget = resumed?.budget ?? effective.budget;
  const estimate = estimateCost(estimateBudget, N_BRANCHES, maxEvalLLMCalls, config.costModel?.());
  if (estimate.estimatedUSD > maxCostUSD) {
    // The BASIS is named, not just the number. A refusal that says only
    // "$19.08 exceeds $10" is unactionable when the $19.08 came from a blended
    // guess about a model the catalog never priced — the operator cannot tell a
    // real cap from a mispriced one without it.
    throw new Error(
      `Estimated cost $${estimate.estimatedUSD.toFixed(2)} exceeds limit $${maxCostUSD} `
      + `(${describeCostBasis(estimate.basis)}). `
      + `Reduce budget (${estimateBudget}) or branches (${N_BRANCHES}).`,
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
      rootId, task, rootMsgId, engine: 'mcts',
      // The RESOLVED judge knobs, not just the caller-supplied ones. A read of
      // this row has to be able to say what ensemble the run REQUESTED, and that
      // is unrecoverable from a blob that omits a knob the caller left at its
      // default — which is also why the read model refuses to invent one
      // (read-models/fork-params.ts). What it REALISED is not here: it is
      // observed per branch and folded onto this row as it happens.
      config: persistableMCTSConfig({ ...effective, judgeSamples, maxEvalLLMCalls }),
      budget: effective.budget, now: Date.now(),
    });
  }

  // The one place a progress event acquires its search identity. Every consumer
  // reads the tree the event names instead of guessing at "the latest" one.
  const report = (event: MCTSProgressBody): void => config.onProgress?.({ ...event, rootId });
  const { outOfBudget, charge } = missionMeter(config.mission);
  const reportedUngroundedLanguages = new Set<string>();
  // Realised judge-ensemble sizes already disclosed. A build search has two:
  // a code-bearing branch pays one of its evaluation calls for the generated
  // check suite, a prose-only branch does not, so each is stated once rather
  // than per branch per iteration.
  const reportedClampedEnsembles = new Set<number>();

  return rt.schedule.fiber<ConvergenceResult>(SEARCH_FIBER_NAME, async (ctx) => {
    // The durable search store is the resume source of truth when injected; the
    // fiber snapshot is the fallback for the inline/no-store path (tests).
    const snapshot = v.safeParse(MCTSPhaseSchema, ctx.snapshot);
    const phase = search || !snapshot.success ? initialPhase : snapshot.output;

    while (phase.budget > 0) {
      throwIfAborted(config.signal);
      // The mission ledger gates the EXPANSION, not the branch: a branch that
      // refused its own call would return empty, score 0, and backpropagate
      // that 0 up the persisted tree. Stopping here settles the tree on what it
      // actually explored instead.
      if (await outOfBudget()) break;
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
        const craftedTools = rt.craftStore.list();

        // EXPLORE — parallel LLM calls (allSettled: one branch failure doesn't kill the rest).
        // Each branch is handed its siblings' distinct angles so the N proposals
        // diverge by construction, not just by sampling temperature (DO-NOW #1).
        const explorationResults = await abortable(
          Promise.allSettled(branchHandles.map((handle, i) =>
            handle.explore(
              priorHistory,
              craftedTools,
              rt.executor.languages,
              mode,
              siblingAngles(i, N_BRANCHES),
            ),
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
          const exploration = r.status === 'fulfilled'
            ? v.safeParse(BranchExplorationSchema, r.value)
            : null;
          if (exploration?.success) {
            // Reported HERE and not in the charge loop below, because this is the
            // only place that knows the branch completed a call: a rejected or
            // malformed one is mapped to empty text, and an absent `usage` on
            // THAT is a failure rather than a silent provider. Unconditional,
            // unlike the charge — the mission port is a cap that no-ops without a
            // label, so an unlabelled search's rollouts were captured off the
            // wire and then dropped. `{}` when the branch reported no usage: the
            // call still happened, and the coverage fraction is made of exactly
            // these. No `spec`/`modelId`: a branch resolves its own model in
            // another process and reports neither, and inventing one would name
            // a model this search cannot see.
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
        // Charged per rollout, from the provider's own report, so the ledger is
        // current when the next expansion's guard reads it.
        for (const exploration of explorations) await charge(exploration.usage);

        const offeredCode = explorations.map(({ text }) => mode === 'plan'
          ? null
          : readProposalCode(text, rt.executor.languages));

        const proposals = explorations.map(e => e.text);

        // EVALUATE — the engine-level seam every backend shares: branches only
        // explore; scoring happens HERE through the one grounded evaluator
        // (execution verdicts via rt.executor + judge ensemble via
        // rt.judgeModel ?? rt.llm, sibling-relative). Evaluation failures score
        // 0, not neutral 0.5; otherwise failed infrastructure can look like a
        // balanced optimum and converge falsely.
        //
        // Runs BEFORE the nodes are recorded, because a node's observation is
        // the environment's reply to its action and cannot be written before
        // the environment has answered. Recording first also left a whole
        // expansion of unscored `open` children behind whenever an abort landed
        // between the two phases — visits=0 nodes that a resumed search's UCT
        // argmax then selects and expands under, and that pruning can never
        // reach (it needs visits >= minVisitsForPrune).
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
              // Close the band loophole (WP-A5): if a sibling attempted code,
              // this prose-only branch is capped at the fail ceiling.
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
        // What the environment said back to each branch, indexed alongside the
        // scores. Null for a branch that never reached it — prose, plan mode,
        // an unrunnable language, or an evaluation that failed outright.
        const observations: Array<string | null> = [];
        // Each branch's own evaluation, same indexing — the bounded facts a
        // node row persists so a search that earns no answer is diagnosable
        // from the tree alone. Null where the evaluation failed outright.
        const evaluations: Array<BranchEvaluation | null> = [];
        for (const [i, r] of scoreResults.entries()) {
          if (r.status === 'fulfilled') {
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
            // The ensemble this branch ACTUALLY ran. `judgeSamples` is only the
            // request: it shares one per-evaluation call pool with check
            // generation, so a request the pool cannot fund is realised lower —
            // and used to be realised lower with no field anywhere carrying the
            // realised number. Reported from the evaluator's own answer rather
            // than predicted from the knobs, and only when the ensemble was
            // reached at all: a cascade that short-circuited before judging
            // attempted zero samples, which is not a clamp.
            const realised = r.value.judgeSamplesAttempted;
            if (realised > 0) {
              // On the ledger row as well as in the diagnostic, because the surface
              // reads the row: an event nobody can query later is not a field a run's
              // parameters carry. The store keeps the smallest any branch reached.
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
            continue;
          }
          report({
            type: 'branch-failed', stage: 'evaluate', iteration,
            branchId: branchIds[i] ?? '', error: renderThrownChain({ cause: r.reason }),
          });
          scores.push(0);
          observations.push(null);
          evaluations.push(null);
        }

        // RECORD nodes — action plus the observation it earned, which is the
        // pair a child expansion inherits through session.getHistory(msg_id).
        const childNodeIds: string[] = [];
        for (let i = 0; i < N_BRANCHES; i++) {
          const childId = branchIds[i] ?? nanoid();
          const exploration = explorations[i] ?? { text: '' };
          const code = offeredCode[i];
          childNodeIds.push(childId);
          await recordNode(session, rt.storage.sql, {
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
            WHERE id = ${childId}
          `;
        }

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
        const reflecting = mode === 'build'
          ? scores.filter(score => score < reflectionThreshold).length
          : 0;
        if (reflecting > 0) {
          report({
            type: 'phase', phase: 'reflect',
            iteration, remainingBudget: phase.budget, branches: reflecting,
          });
        }
        // A reflection is another model call on the far side, so the rollouts
        // just debited above can be what takes the budget away from it.
        const mayReflect = mode === 'build' && !(await outOfBudget());
        for (let i = 0; mayReflect && i < N_BRANCHES; i++) {
          const score = scores[i] ?? 0;
          if (score >= reflectionThreshold) continue;
          const handle = branchHandles[i];
          if (!handle) continue;
          // A reflection is an optional memory side-effect on an already-scored
          // branch. Its model call fails the same way exploration does (that is
          // what allSettled above tolerates), so letting it throw would discard
          // a search whose branches are already recorded and backpropagated —
          // and a malformed resolve is the same untrusted input a malformed
          // exploration is, so it yields no lesson rather than a TypeError.
          //
          // The verdict travels with the question. LATS prompts the reflection
          // "with the trajectory AND final reward" (§4.2); a branch's own trace
          // table holds only what it proposed, so asking "what went wrong?"
          // without the environment's answer asks a model to guess at a runtime
          // error the engine already read. Null when nothing executed.
          let result: BranchReflection | undefined;
          try {
            result = await handle.generateReflection(task, observations[i] ?? undefined);
          } catch (cause) {
            report({
              type: 'branch-failed', stage: 'reflect', iteration,
              branchId: branchIds[i] ?? '', error: renderThrownChain({ cause }),
            });
          }
          let reflection = '';
          if (result) {
            const parsed = v.safeParse(BranchReflectionSchema, result);
            if (parsed.success) {
              await charge(parsed.output.usage);
              config.reportModelCall?.({ source: 'mcts', usage: parsed.output.usage ?? {} });
              reflection = parsed.output.text.trim();
            }
          }
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
        if (mode === 'build') {
          for (let i = 0; i < N_BRANCHES; i++) {
            const score = scores[i] ?? 0;
            const code = offeredCode[i];
            if (score > craftExtractionThreshold && code?.kind === 'runnable'
                && isCraftable(code.language)) {
              await maybeStoreCraftedTool(rt, code.code, score);
            }
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
        // Durable, epoch-fenced checkpoint: an eviction after this can re-enter and
        // continue from the remaining budget against the persisted tree (B6).
        search?.checkpoint(rootId, searchEpoch, phase.iteration, phase.budget, Date.now());
        // The checkpoint above is durable but silent: nothing reached Workers Logs
        // or `wrangler tail` per iteration, so a durably-checkpointed search running
        // for HOURS produced no visible sign of life. Gated on `search`, matching the
        // checkpoint call itself, so the fiber-snapshot-only and test paths stay
        // quiet. An `event` and not a `failure`: an iteration completing is not a
        // failure, and `failure` would demand a classification there is none of.
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
        await Promise.allSettled(branchIds.map((id) => rt.releaseBranch(id)));
      }
    }

    // CONVERGE — the durable settle record must never run ahead of the work it
    // claims. converge() awaits real I/O (a summary call, memory writes) before
    // it closes the tree, so writing 'converged' first left a search recorded as
    // settled with its whole tree still open whenever that I/O failed or the
    // process died mid-flight. Order: close the tree, then record the outcome.
    // A crash between the two is safe in one direction only — a closed tree with
    // a still-'running' row is inert (nothing is selectable) and resumable.
    // The status is equally load-bearing: `converged` means a candidate cleared
    // the acceptance floor. A false result closed the tree without a terminal
    // node, so it must settle as `no_acceptable_candidate`.
    try {
      const result = await converge(rt, session, rootId, minAcceptableScore, takesEpsilon, mode);
      if (result.converged) {
        search?.converge(rootId, searchEpoch, Date.now());
      } else {
        search?.noAcceptableCandidate(rootId, searchEpoch, Date.now());
      }
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

/** Fixed scalar facts only. Proposal text stays in `observation`; bounded
 * execution feedback stays in the session message. */
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
        // The abort sweep itself failed — infrastructure, not the search's
        // own work. Recorded so the sweep's failure is stated rather than
        // surfacing as an unhandled rejection after the race has already
        // thrown for the abort.
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
