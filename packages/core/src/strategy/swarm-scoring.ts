import { Effect } from 'effect';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Scoring one candidate: the report gate, the instrument path (`measureChild`) and the
 * judged path (`judgeChild`). Measurement policy only; the per-candidate loop is the runner's.
 */
import { evaluateWithMultiModelJudging, type BranchEvaluation } from '../mcts/evaluation';
import { renderThrownChain } from '../obs/index';
import { settle } from '../obs/effect';
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
import { outcomeFacts, recordSwarmNode } from './swarm-resume';
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
    const measured = lane.then(() => settle(Effect.gen(function* () {
      // The write sits inside the attempt so the returned promise never rejects.
      const measurement: Measurement = yield* Effect.tryPromise({
        try: async () => {
          await writeText(ctx.vfs, verifier.artifact, candidate);

          return verifier.verify(ctx);
        },
        catch: (error) => `the verifier could not run over what you reported: `
          + `${renderThrownChain({ cause: error })}. Fix the answer and report again.`,
      });

      if (measurement.kind === 'unmeasurable') {
        return `the verifier ran and could not measure what you reported: ${measurement.detail}. `
          + 'Fix the answer and report again: a report the instrument cannot read is a '
          + 'candidate the search cannot score.';
      }

      return null;
    }).pipe(Effect.catch((refusal) => Effect.succeed(refusal)))));

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
export function measureChild(input: ChildMeasurement): Promise<ChildOutcome> {
  return settle(answered(measuredChild(input)));
}

interface ChildMeasurement {
  readonly ctx: MeasurementContext;
  readonly verifier: ResolvedVerifier;
  readonly measured: MeasuredObjective;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly baseline: number;
  readonly artifact: string;
}

/** `run`, its rejection read as the instrument faulting. */
function instrumented<A>(run: () => Promise<A>, label = ''): Effect.Effect<A, ChildOutcome> {
  return Effect.tryPromise({ try: run, catch: (error): ChildOutcome => ({ kind: 'instrument-faulted', error: `${label}${renderThrownChain({ cause: error })}` }) });
}

/** A verifier's artifact written and measured as one instrument call: a refused write faults it like a thrown verify. */
function verified(ctx: MeasurementContext, verifier: ResolvedVerifier, artifact: string, label = ''): Effect.Effect<Measurement, ChildOutcome> {
  return instrumented(async () => {
    await writeText(ctx.vfs, verifier.artifact, artifact);

    return verifier.verify(ctx);
  }, label);
}

function answered(outcome: Effect.Effect<ChildOutcome, ChildOutcome>): Effect.Effect<ChildOutcome> {
  return Effect.catch(outcome, (faulted) => Effect.succeed(faulted));
}

function measuredChild(input: ChildMeasurement): Effect.Effect<ChildOutcome, ChildOutcome> {
  return Effect.gen(function* () {
    const { ctx, verifier, witnessVerifier, measured, baseline } = input;
    const measurement = yield* verified(ctx, verifier, input.artifact);
    let witnessFound: boolean | null = null;

    if (measured.witness !== null) {
      if (witnessVerifier === null) {
        return { kind: 'instrument-faulted', error: 'witness verifier was not resolved' };
      }

      const witness = yield* verified(ctx, witnessVerifier, input.artifact, 'witness verifier: ');

      witnessFound = witness.kind === 'measured' && witness.value === 1;
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
  });
}

/** Measure each declared Pareto coordinate without synthesising an aggregate. */
function measureParetoChild(input: {
  readonly pareto: PreparedParetoMeasurement;
  readonly artifact: string;
}): Effect.Effect<ChildOutcome, ChildOutcome> {
  return Effect.gen(function* () {
    const evidence: Record<string, number> = {};
    const details: string[] = [];

    for (const instrument of input.pareto.instruments) {
        const measurement = yield* verified(input.pareto.ctx, instrument.verifier, input.artifact);

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
    }

    const checked = validateParetoEvidence(input.pareto.axes, evidence);

    if ('reason' in checked) return { kind: 'unmeasurable', detail: checked.reason };

    return {
      kind: 'pareto',
      axes: input.pareto.axes,
      evidence: checked.evidence,
      detail: details.join(' | '),
    };
  });
}

/**
 * Score one child by the marginalised judge ensemble in `mcts/evaluation.ts`.
 * The call pool is sized by {@link judgeCallPool} so the clamp cannot bind. The
 * reported ensemble is the number of samples the median used; a run whose realised
 * ensemble falls below `minEnsemble` fails rather than scoring. A thrown judge
 * fails the run like a thrown verifier (*The closed verifier registry*).
 */
function judgeChild(input: {
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
}): Effect.Effect<ChildOutcome, ChildOutcome> {
  return Effect.gen(function* () {
    const { rt } = input;

    const options = {
      task: input.task,
      trajectory: input.answer,
      siblings: input.siblings,
      siblingsProducedCode: input.siblingsProducedCode,
      // Plan mode never invokes the executor, so evaluation is judge-only.
      executionPolicy: input.mode === 'plan' ? ('judge-only' as const) : ('grounded' as const),
      executor: rt.executor,
      explorer: rt.llm,
      judgeSamples: input.samples,
      // Funded from the request, never `DEFAULT_CONFIG.mcts.maxEvalLLMCalls`; see {@link judgeCallPool}.
      maxLLMCalls: judgeCallPool(input.samples),
    };

    // Cross-model judge when the runtime holds one, else the explorer; absent key, not `undefined`.
    const evaluation: BranchEvaluation = yield* instrumented(async () => (rt.judgeModel === undefined
      ? evaluateWithMultiModelJudging(options)
      : evaluateWithMultiModelJudging({ ...options, judge: rt.judgeModel })));

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
  });
}

/** One expansion, in order: scored, sealed on a breach, recorded, backpropagated, ranked. */
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
function scoreOutcome(input: ScoreExpansionInput): Effect.Effect<ChildOutcome | null> {
  const { expansion, pareto, measures, verifier, ctx, measured, baseline, judgeSamples } = input;

  if (expansion.incomplete !== null) {
    return Effect.succeed({ kind: 'incomplete', detail: expansion.incomplete.detail });
  }

  if (pareto !== null) return answered(measureParetoChild({ pareto, artifact: expansion.artifact }));

  if (measures && verifier && ctx && measured && baseline !== null) {
    return answered(measuredChild({
      ctx, verifier, witnessVerifier: input.witnessVerifier, measured, baseline,
      artifact: expansion.artifact,
    }));
  }

  if (judgeSamples === null) return Effect.succeed(null);

  const { rt, mode, resolved, siblings, languages } = input;

  return answered(judgeChild({
    rt, mode, samples: judgeSamples, task: resolved.task,
    minEnsemble: isTreeAdvance(resolved.config.advance.kind)
      ? JUDGE_MARGINALISATION_MIN
      : 1,
    answer: expansion.answer,
    siblings: siblings.map((other) => other.answer),
    siblingsProducedCode: siblings.some(
      (other) => readProposalCode(other.answer, languages)?.kind === 'runnable',
    ),
  }));
}

export function scoreExpansion(input: ScoreExpansionInput): Promise<Refusal | null> {
  return settle(Effect.gen(function* () {
    const {
      expansion, measures, pareto, measured, identity, resolved, rt, sql, rootId, candidates, spentBy,
      nodes, log, searchLedger, ledgerEpoch, rankDirection, state,
    } = input;

    let { publication, best, bestValue } = state;

    const outcome = yield* scoreOutcome(input);

    if (outcome?.kind === 'instrument-faulted') {
      searchLedger.fail(rootId, ledgerEpoch, Date.now());

      return unavailable(`the ${pareto !== null || measures ? 'verifier' : 'judge'} faulted while scoring `
        + `${expansion.id}, so no number this run produced can be trusted: ${outcome.error}`);
    }

    const { breach, rank, ensemble, ...facts } = outcomeFacts(outcome);
    const candidate: SwarmCandidate = { id: expansion.id, artifact: expansion.artifact, ...facts };

    // Seal first, so a sealed record always has its seal.
    if (breach !== null) {
      publication = { kind: 'sealed', breach };

      if (identity !== null) sealRecords(sql, rt.actor, { identity, breach });
      log.event('exploration.floor_breach', {
        preset: resolved.preset,
        metric: measured?.metric ?? '',
        value: breach.measured.value,
        floor: breach.floor.value,
        margin: breach.margin,
        hypotheses: breach.hypotheses.join(','),
      });
    }

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
    });
    insertSearchNode(sql, rt.actor, {
      nodeId: expansion.id, parentNodeId: expansion.parentId, rootId,
      task: resolved.task, action: '', observation: expansion.artifact,
      depth: expansion.depth,
    });
    nodes.set(expansion.id, {
      id: expansion.id, parentId: expansion.parentId, depth: expansion.depth,
      artifact: expansion.artifact,
      measurement: facts.measured,
      score: facts.score,
      pareto: facts.pareto,
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

    if (ensemble > 0) {
      state.ensembles.push(ensemble);
      searchLedger.observeJudgeEnsemble(rootId, ensemble);
    }

    if (facts.score !== null) {
      backpropagate(sql, rt.actor, expansion.id, facts.score);
    } else if (outcome && outcome.kind !== 'pareto') {
      const status = breach === null ? 'failed' : 'terminal';
      void sql`UPDATE search_nodes SET status = ${status}
      WHERE actor_id = ${rt.actor.actorId} AND id = ${expansion.id}`;
    }

    if (rank !== null && (bestValue === null || isBetter(rank, bestValue, rankDirection))) {
      best = candidate;
      bestValue = rank;
    }

    state.publication = publication;
    state.best = best;
    state.bestValue = bestValue;

    return null;
  }));
}
