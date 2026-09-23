/**
 * Scoring one candidate: the report gate, the instrument path (`measureChild`) and the
 * judged path (`judgeChild`). Measurement policy only; the per-candidate loop is the runner's.
 */
import { evaluateWithMultiModelJudging, type BranchEvaluation } from '../mcts/evaluation';
import { renderThrownChain } from '../obs/index';
import { isTreeAdvance, judgeCallPool, JUDGE_MARGINALISATION_MIN } from './swarm';
import type { ChildOutcome } from './swarm-resume';
import { breaches, type PreparedParetoMeasurement } from './swarm-setup';
import {
  floorMargin, isBetter, normalisedScore, validateParetoEvidence,
  type Measurement, type MeasurementContext, type MeasuredObjective,
} from './objective';
import type { ResolvedVerifier } from './verifier-registry';
import type { AgentRuntime } from '../types/agent-runtime';
import type { WorkMode } from '../types/turn';

import type { Logger } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import { insertSearchNode } from '../mcts/record-node';
import { backpropagate } from '../mcts/backpropagation';
import { readProposalCode } from '../execution/code-fence';
import type { MctsSearchStore } from '../mcts/search-store';
import { recordSwarmNode } from './swarm-resume';
import { unavailable } from './swarm-setup';
import type { Refusal } from '../obs/error';
import type { Expansion, TreeNode } from './swarm-tree';
import type { ObjectiveDirection, ObjectiveIdentity, PublicationState } from './objective';
import { sealRecords } from './records';
import type { ResolvedSwarm, SwarmCandidate } from './swarm';

/**
 * The gate a node's `report` call runs through when the run has an instrument
 * (*The report contract*). Gates on runnability, not score: an unmeasurable or
 * throwing candidate is returned to the node with the reason; grading stays at
 * the barrier. Serialised because every candidate is written to the same path;
 * the last node waits `width x instrument` inside its turn, under the inactivity watchdog.
 */
export function reportGate(input: {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
}): (candidate: string) => Promise<string | null> {
  const { ctx, verifier } = input;
  let lane: Promise<unknown> = Promise.resolve();

  return (candidate: string): Promise<string | null> => {
    const measured = lane.then(async (): Promise<string | null> => {
      let measurement: Measurement;

      try {
        // The write sits inside the try so the returned promise never rejects.
        await ctx.vfs.writeFile(verifier.artifact, candidate);
        measurement = await verifier.verify(ctx);
      } catch (error) {
        return `the verifier could not run over what you reported: `
          + `${renderThrownChain({ cause: error })}. Fix the answer and report again.`;
      }

      if (measurement.kind === 'unmeasurable') {
        return `the verifier ran and could not measure what you reported: ${measurement.detail}. `
          + 'Fix the answer and report again — a report the instrument cannot read is a '
          + 'candidate the search cannot score.';
      }

      return null;
    });

    // Advance on the measurement, not the caller, so a node cancelled in between
        // cannot leave the next one measuring its file.
    lane = measured;

    return measured;
  };
}

/**
 * Measure one child: write it where the instrument reads, run it, classify the result.
 * Sequential: every candidate is written to the same path (*Isolation*).
 */
export async function measureChild(input: {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
  readonly measured: MeasuredObjective;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly baseline: number;
  readonly artifact: string;
}): Promise<ChildOutcome> {
  const { ctx, verifier, witnessVerifier, measured, baseline } = input;
  await ctx.vfs.writeFile(verifier.artifact, input.artifact);
  let measurement: Measurement;

  try {
    measurement = await verifier.verify(ctx);
  } catch (error) {
    return {
      kind: 'instrument-faulted',
      error: renderThrownChain({ cause: error }),
    };
  }

  let witnessFound: boolean | null = null;

  if (measured.witness !== null) {
    if (witnessVerifier === null) {
      return { kind: 'instrument-faulted', error: 'witness verifier was not resolved' };
    }

    try {
      await ctx.vfs.writeFile(witnessVerifier.artifact, input.artifact);
      const witness = await witnessVerifier.verify(ctx);
      witnessFound = witness.kind === 'measured' && witness.value === 1;
    } catch (error) {
      return {
        kind: 'instrument-faulted',
        error: `witness verifier: ${renderThrownChain({ cause: error })}`,
      };
    }
  }

  if (measurement.kind === 'unmeasurable') {
    return { kind: 'unmeasurable', detail: measurement.detail, witnessFound };
  }

  if (measured.floor && breaches(measured.floor, measured.direction, measurement.value)) {
    return {
      kind: 'sealed',
      measurement,
      breach: {
        floor: measured.floor,
        // Retained in full: a discarded measurement cannot adjudicate H1 against H2.
        measured: measurement,
        margin: floorMargin(measured.floor, measured.direction),
        hypotheses: ['floor_wrong', 'verifier_gameable'],
      },
      witnessFound,
    };
  }

  return {
    kind: 'scored',
    measurement,
    score: normalisedScore({
      value: measurement.value, baseline, target: measured.target,
      direction: measured.direction, scale: measured.scale,
    }),
    witnessFound,
  };
}

/** Measure each declared Pareto coordinate without synthesising an aggregate. */
export async function measureParetoChild(input: {
  readonly pareto: PreparedParetoMeasurement;
  readonly artifact: string;
}): Promise<ChildOutcome> {
  const evidence: Record<string, number> = {};
  const details: string[] = [];

  for (const instrument of input.pareto.instruments) {
    try {
      await input.pareto.ctx.vfs.writeFile(instrument.verifier.artifact, input.artifact);
      const measurement = await instrument.verifier.verify(input.pareto.ctx);

      if (measurement.kind === 'unmeasurable') {
        return { kind: 'unmeasurable', detail: measurement.detail };
      }

      for (const axisId of instrument.axisIds) {
        const value = instrument.perInstance
          ? measurement.perInstance?.[axisId]
          : measurement.measured?.[axisId] ?? measurement.value;

        if (value === undefined) {
          return {
            kind: 'unmeasurable',
            detail: `Pareto instrument omitted declared axis "${axisId}".`,
          };
        }

        evidence[axisId] = value;
      }

      details.push(measurement.detail);
    } catch (error) {
      return { kind: 'instrument-faulted', error: renderThrownChain({ cause: error }) };
    }
  }

  const checked = validateParetoEvidence(input.pareto.axes, evidence);

  if ('reason' in checked) return { kind: 'unmeasurable', detail: checked.reason };

  return {
    kind: 'pareto',
    axes: input.pareto.axes,
    evidence: checked.evidence,
    detail: details.join(' | '),
  };
}

/**
 * Score one child by the marginalised judge ensemble in `mcts/evaluation.ts`.
 * The call pool is sized by {@link judgeCallPool} so the clamp cannot bind. The
 * reported ensemble is the number of samples the median used; a run whose realised
 * ensemble falls below `minEnsemble` fails rather than scoring. A thrown judge
 * fails the run like a thrown verifier (*The closed verifier registry*).
 */
export async function judgeChild(input: {
  readonly rt: AgentRuntime;
  readonly mode: WorkMode;
  readonly samples: number;
  /** Smallest ensemble this run may be scored by: {@link JUDGE_MARGINALISATION_MIN}
     *  down a tree, 1 for a flat run. */
  readonly minEnsemble: number;
  readonly task: string;
  /** The node's output as written, fences intact; the judge grades the answer, not the extracted artifact. */
  readonly answer: string;
  readonly siblings: readonly string[];
  readonly siblingsProducedCode: boolean;
}): Promise<ChildOutcome> {
  const { rt } = input;

  const options = {
    task: input.task,
    trajectory: input.answer,
    siblings: input.siblings,
    siblingsProducedCode: input.siblingsProducedCode,
    // Plan mode never invokes the executor, so evaluation is judge-only (as in `mcts/engine.ts`).
    executionPolicy: input.mode === 'plan' ? ('judge-only' as const) : ('grounded' as const),
    executor: rt.executor,
    explorer: rt.llm,
    judgeSamples: input.samples,
    // Funded from the request, never `DEFAULT_CONFIG.mcts.maxEvalLLMCalls`; see {@link judgeCallPool}.
    maxLLMCalls: judgeCallPool(input.samples),
  };

  let evaluation: BranchEvaluation;

  try {
    // Cross-model judge when the runtime holds one, else the explorer; absent key, not `undefined`.
    evaluation = rt.judgeModel === undefined
      ? await evaluateWithMultiModelJudging(options)
      : await evaluateWithMultiModelJudging({ ...options, judge: rt.judgeModel });
  } catch (error) {
    return {
      kind: 'instrument-faulted',
      error: renderThrownChain({ cause: error }),
    };
  }

  if (evaluation.judgeSamplesAttempted > 0
    && evaluation.judgeSamplesUsed < input.minEnsemble) {
    // Dropped samples (timeouts, unparseable replies) left fewer opinions than the admitted floor.
    return {
      kind: 'instrument-faulted',
      error: `the judge ensemble answered with ${String(evaluation.judgeSamplesUsed)} usable `
        + `samples of the ${String(evaluation.judgeSamplesAttempted)} asked for, below the `
        + `${String(input.minEnsemble)} this run was admitted at, so its median is a different `
        + 'scorer from the one validity checked. A judge call that times out or will not parse '
        + 'is dropped, so ask for more than the floor where the provider is being rate-limited.',
    };
  }

  if (evaluation.judgeSamplesAttempted > 0
    && evaluation.judgeSamplesAttempted < input.samples) {
    // Unreachable by construction: the pool is sized so the clamp cannot bind.
    return {
      kind: 'instrument-faulted',
      error: `the judge ensemble realised ${String(evaluation.judgeSamplesAttempted)} of the `
        + `${String(input.samples)} samples this run was admitted at, so its median is a different `
        + 'scorer from the one validity checked. The per-evaluation pool was sized at '
        + `${String(judgeCallPool(input.samples))} calls for exactly this reason.`,
    };
  }

  return {
    kind: 'judged',
    score: evaluation.score,
    ensemble: evaluation.judgeSamplesUsed,
    grounding: evaluation.grounding,
  };
}

/**
 * Score, persist, backpropagate and rank one expansion: scorer outcome -> node record
 * -> selection row -> terminal state or ancestor reward -> best candidate.
 */
interface ScoreExpansionInput {
  readonly expansion: Expansion;
  readonly siblings: readonly Expansion[];
  readonly measures: boolean;
  readonly verifier: ResolvedVerifier | null;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly pareto: PreparedParetoMeasurement | null;
  readonly ctx: MeasurementContext | null;
  readonly measured: MeasuredObjective | null;
  readonly identity: ObjectiveIdentity | null;
  readonly baseline: number | null;
  readonly judgeSamples: number | null;
  readonly resolved: ResolvedSwarm;
  readonly rt: AgentRuntime;
  readonly mode: WorkMode;
  readonly languages: readonly [string, ...string[]];
  readonly sql: SqlExecutor;
  readonly rootId: string;
  readonly candidates: SwarmCandidate[];
  readonly spentBy: ReadonlyMap<string, number | null>;
  readonly nodes: Map<string, TreeNode>;
  readonly log: Logger;
  readonly searchLedger: MctsSearchStore;
  readonly ledgerEpoch: number;
  readonly rankDirection: ObjectiveDirection;
  readonly state: {
    publication: PublicationState;
    best: SwarmCandidate | null;
    bestValue: number | null;
    readonly ensembles: number[];
  };
}

/** Scoring paths in eligibility order: unfinished (unscored), Pareto, measured, judged.
 *  A child eligible for none is unscored, which is not a fault. */
async function scoreOutcome(input: ScoreExpansionInput) {
  const { expansion, pareto, measures, verifier, ctx, measured, baseline, judgeSamples } = input;

  if (expansion.incomplete !== null) {
    return { kind: 'incomplete' as const, detail: expansion.incomplete.detail };
  }

  if (pareto !== null) return measureParetoChild({ pareto, artifact: expansion.artifact });

  if (measures && verifier && ctx && measured && baseline !== null) {
    return measureChild({
      ctx, verifier, witnessVerifier: input.witnessVerifier, measured, baseline,
      artifact: expansion.artifact,
    });
  }

  if (judgeSamples === null) return null;

  const { rt, mode, resolved, siblings, languages } = input;

  return judgeChild({
    rt, mode, samples: judgeSamples, task: resolved.task,
    minEnsemble: isTreeAdvance(resolved.config.advance.kind)
      ? JUDGE_MARGINALISATION_MIN
      : 1,
    answer: expansion.answer,
    siblings: siblings.map((other) => other.answer),
    siblingsProducedCode: siblings.some(
      (other) => readProposalCode(other.answer, languages)?.kind === 'runnable',
    ),
  });
}

export async function scoreExpansion(input: ScoreExpansionInput): Promise<Refusal | null> {
  const {
    expansion, measures, pareto, measured, identity, resolved, rt, sql, rootId, candidates, spentBy,
    nodes, log, searchLedger, ledgerEpoch, rankDirection, state,
  } = input;

  let { publication, best, bestValue } = state;

  const outcome = await scoreOutcome(input);

  if (outcome?.kind === 'instrument-faulted') {
    searchLedger.fail(rootId, ledgerEpoch, Date.now());

    return unavailable(`the ${pareto !== null || measures ? 'verifier' : 'judge'} faulted while scoring `
      + `${expansion.id}, so no number this run produced can be trusted: ${outcome.error}`);
  }

  const measurement = outcome?.kind === 'sealed' || outcome?.kind === 'scored'
    ? outcome.measurement
    : null;

  const score = outcome?.kind === 'scored' || outcome?.kind === 'judged'
    ? outcome.score
    : null;

  const candidate: SwarmCandidate = {
    id: expansion.id,
    artifact: expansion.artifact,
    measured: measurement,
    pareto: outcome?.kind === 'pareto' ? outcome.evidence : null,
    unmeasurable: outcome?.kind === 'unmeasurable' ? outcome.detail : null,
    incomplete: outcome?.kind === 'incomplete' ? outcome.detail : null,
    score,
    witnessFound: outcome?.kind === 'sealed'
      || outcome?.kind === 'scored'
      || outcome?.kind === 'unmeasurable'
      ? outcome.witnessFound ?? null
      : null,
  };

  candidates.push(candidate);
  recordSwarmNode(sql, rt.actor, {
    rootId,
    nodeId: expansion.id,
    record: {
      outcome,
      conclusion: expansion.conclusion,
      aggregated: expansion.aggregated,
      tokens: spentBy.get(expansion.id) ?? null,
    },
    now: Date.now(),
  });
  insertSearchNode(sql, rt.actor, {
    nodeId: expansion.id, parentNodeId: expansion.parentId, parentMsgId: null, rootId,
    task: resolved.task, action: '', observation: expansion.artifact,
    codeUsed: null, depth: expansion.depth, msgId: null,
  });
  nodes.set(expansion.id, {
    id: expansion.id, parentId: expansion.parentId, depth: expansion.depth,
    artifact: expansion.artifact,
    measurement,
    score,
    pareto: candidate.pareto,
    proposal: expansion.proposal,
    proposalError: expansion.proposalError,
    granted: expansion.granted,
    conclusion: expansion.conclusion,
    transcript: expansion.transcript,
    compacted: null,
    aggregated: expansion.aggregated,
  });

  if (expansion.proposalError) {
    log.event('swarm.proposal_unreadable', {
      preset: resolved.preset, node: expansion.id, depth: expansion.depth,
      error: expansion.proposalError,
    });
  }

  if (outcome?.kind === 'sealed') {
    publication = { kind: 'sealed', breach: outcome.breach };

    if (identity !== null) sealRecords(sql, rt.actor, { identity, breach: outcome.breach, at: Date.now() });
    log.event('exploration.floor_breach', {
      preset: resolved.preset,
      metric: measured?.metric ?? '',
      value: outcome.measurement.value,
      floor: outcome.breach.floor.value,
      margin: outcome.breach.margin,
      hypotheses: outcome.breach.hypotheses.join(','),
    });
  }

  if (outcome?.kind === 'judged' && outcome.ensemble > 0) {
    state.ensembles.push(outcome.ensemble);
    searchLedger.observeJudgeEnsemble(rootId, outcome.ensemble);
  }

  if (score !== null) {
    backpropagate(sql, rt.actor, expansion.id, score);
  } else if (outcome && outcome.kind !== 'pareto') {
    const status = outcome.kind === 'sealed' ? 'terminal' : 'failed';
    void sql`UPDATE search_nodes SET status = ${status}
      WHERE actor_id = ${rt.actor.actorId} AND id = ${expansion.id}`;
  }

  let rank: number | null = null;

  if (outcome?.kind === 'scored') rank = outcome.measurement.value;
  else if (outcome?.kind === 'judged') rank = outcome.score;

  if (rank !== null && (bestValue === null || isBetter(rank, bestValue, rankDirection))) {
    best = candidate;
    bestValue = rank;
  }

  state.publication = publication;
  state.best = best;
  state.bestValue = bestValue;

  return null;
}
