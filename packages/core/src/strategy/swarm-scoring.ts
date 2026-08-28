/**
 * SCORING ONE CANDIDATE: the report gate an agent node's `report` call runs through, the
 * instrument path (`measureChild`), and the judged path (`judgeChild`) over the
 * marginalised ensemble the shipped tree already owns.
 *
 * Split from `swarm-run.ts` because this is MEASUREMENT policy: how a number is earned,
 * when a scorer's shortfall fails the run rather than scoring, and where a candidate is
 * placed for the instrument to read. The loop that calls these per candidate is the
 * runner's.
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
import type { WorkMode } from '../prompting/surface';

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
import type { ObjectiveDirection, PublicationState } from './objective';
import type { ResolvedSwarm, SwarmCandidate } from './swarm';

/**
 * THE REPORT CONTRACT (*The report contract*): the gate a node's own `report` call runs
 * through when this run has an instrument.
 *
 * The owner's ask, and it is one sentence: *"If it's something that is verifiable, run
 * and compute the metric/results — and block the report tool until it runs
 * successfully, else return the error to the agent."* What shipped ran the instrument
 * LATER, at the settle barrier, so a node whose answer the instrument could not run at
 * all learnt nothing and arrived as an unmeasurable candidate with the node long gone.
 * The information existed; nothing delivered it to the one agent that could act on it.
 *
 * IT GATES ON RUNNABILITY, NOT ON SCORE, and the distinction is the whole design. A
 * candidate the instrument measures passes, whatever the number — grading stays at the
 * barrier, because *No self-grading* means a node never supplies the quantity it would
 * have to lie about. A candidate the instrument reports `unmeasurable` for, or throws
 * on, is turned back with the reason as the node's next instruction.
 *
 * SERIALISED, for {@link measureChild}'s exact reason and not by analogy with it: every
 * candidate is written to the SAME path, and nodes run in PARALLEL, so two gates racing
 * would each measure whichever wrote last. The lane is one promise chain.
 *
 * THE LANE COSTS THE LAST NODE `width x instrument`, and that wait happens INSIDE its
 * turn, under the stream-inactivity watchdog — which counts a silent tool call as a
 * stall, deliberately and on measured grounds (`chat.ts`: "a tool call that never
 * returns stalls the same turn through the same silence"). So a run whose instrument
 * takes t seconds gives its last node `width x t` of silence to survive, against a
 * five-minute default. It is stated rather than guarded because the alternative is a
 * per-node artifact path, and where the candidate is written is the verifier contract's
 * to decide, not this function's.
 *
 * A THROW IS THE INSTRUMENT BREAKING, and here it is still returned to the node rather
 * than failing the run. At the barrier a throw means no number can be trusted; here it
 * means this candidate could not be placed, and the node is the party that can try
 * something else. The barrier keeps its own verdict either way — this gate decides
 * nothing the run records.
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
        // The WRITE is inside the try beside the measurement, so this function has one
        // failure story rather than two: everything between placing the candidate and
        // reading the verdict is the instrument's attempt, and the node hears about all
        // of it. It also makes the returned promise total, which is what lets the lane
        // below advance without a catch that would flatten a rejection into a value.
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
    // The lane advances on the MEASUREMENT rather than on the caller, so a node that is
    // cancelled between the two cannot leave the next one measuring its file. No catch
    // is needed and none is written: the function above returns the instrument's
    // failures as text, so this promise does not reject.
    lane = measured;
    return measured;
  };
}

/**
 * Measure one child: write it to the path the instrument reads, run the instrument,
 * and classify what came back.
 *
 * Sequential by construction — every candidate is written to the SAME path, so a
 * parallel measurement would measure whichever wrote last. That is the isolation gap
 * *Isolation* names, respected rather than assumed away, and it is also why a node needs
 * no storage of its own: the engine places the answer, the engine measures it.
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
        // Retained in FULL: a discarded measurement cannot adjudicate H1 against H2.
        measured: measurement,
        margin: floorMargin(measured.floor, measured.direction),
        // Fixed at exactly two because exactly two fit, and they demand opposite
        // responses. The pair is data, not prose.
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
 * Score one child by the MARGINALISED JUDGE ENSEMBLE the shipped tree already owns.
 *
 * REACHED, not reimplemented. `mcts/evaluation.ts` runs `samples` independent judge
 * calls over one prompt, takes their MEDIAN, drops the ones that timed out or would not
 * parse, and clamps the ensemble against the per-evaluation call budget — and it is
 * objective-agnostic, taking a task, a candidate's text, an executor and two LLMs. A
 * second ensemble written here would be the drifting second spelling this file refuses
 * everywhere else, and it would also lose the clamp disclosure, which is the one thing
 * about this scorer that was measured going silent.
 *
 * THE POOL IS FUNDED FROM THE REQUEST. `maxEvalLLMCalls` is the whole per-evaluation
 * call pool that check generation and the ensemble share, and this path used to hand the
 * evaluator the MCTS engine's shipped 4 — so a judged tree admitted at the
 * marginalisation floor of 20 realised `min(20, 4 − 1) = 3`. {@link judgeCallPool} sizes
 * the pool at `samples + 1` instead, so the clamp cannot bind.
 *
 * AN ENSEMBLE SHRINKS TWO WAYS AND BOTH ARE REFUSED HERE. The pool is one: it decides
 * how many calls are ASKED FOR, and a shortfall there means the evaluator did not honour
 * the budget it was handed. Dropped samples are the other, and they are the door the
 * pool fix does not close: `completeWithinTimeout` returns null for a judge call that
 * lost its race and `sampleJudgeScore` returns null for one that would not parse, so the
 * median can be taken over far fewer opinions than were asked for. Under sustained rate
 * limiting, the transport may spend three 180 s retry windows waiting to send against
 * the judge's 600 s envelope, so this is reachable rather than theoretical. Found by
 * `SwarmRuntimeFix` while pacing the provider, and it is the same defect the pool fix
 * removes arriving by another door: an
 * ensemble admitted at one size and MEDIANED at another.
 *
 * SO THE REPORTED ENSEMBLE IS THE ONE THE MEDIAN WAS TAKEN OVER, `judgeSamplesUsed`,
 * rather than the number asked for. A run whose realised marginalisation falls below
 * `minEnsemble` fails rather than scoring: below the floor the measurement says the
 * scorer is not worth building, and a caller who wants headroom against drops asks for
 * more than the floor rather than being quietly given less.
 *
 * A THROWN judge is the instrument breaking and takes the run down through the same arm
 * a thrown verifier does (*The closed verifier registry*). It is NOT converted into a
 * badly-scored candidate: a judge that failed produced no opinion, and scoring the
 * candidate on the absence of one is the accepted-and-ignored lie in its purest form.
 */
export async function judgeChild(input: {
  readonly rt: AgentRuntime;
  readonly mode: WorkMode;
  readonly samples: number;
  /** The smallest median this run may be scored by: {@link JUDGE_MARGINALISATION_MIN}
   *  down a tree, where the floor is stated, and 1 for a flat run, where it is not —
   *  but where a median over nothing is still not an opinion. */
  readonly minEnsemble: number;
  readonly task: string;
  /** The node's output AS WRITTEN — fences intact. Not the extracted artifact: the
   *  judge grades the answer, and stripping it to its code hides the reasoning the
   *  ensemble is being asked about. */
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
    // Plan mode never invokes the executor, so its evaluation is judge-only and spends
    // no call on a check suite — the same gate `mcts/engine.ts` applies.
    executionPolicy: input.mode === 'plan' ? ('judge-only' as const) : ('grounded' as const),
    executor: rt.executor,
    explorer: rt.llm,
    judgeSamples: input.samples,
    // FUNDED AT THE REQUEST, which is the whole of the judge-ceiling fix. This used to
    // be `DEFAULT_CONFIG.mcts.maxEvalLLMCalls` — the MCTS engine's dial, 4, sized for
    // that engine's own `judgeSamples: 3` — so every judged swarm realised
    // `min(samples, 3)` no matter what the marginalisation floor admitted. See
    // {@link judgeCallPool}.
    maxLLMCalls: judgeCallPool(input.samples),
  };
  let evaluation: BranchEvaluation;
  try {
    // A cross-model judge where the runtime holds one, and the explorer where it does
    // not — the documented fallback, spelled as an ABSENT KEY rather than an explicit
    // `undefined` for `nodeDeps`' reason.
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
    // THE DROPPED-SAMPLE DOOR. The calls were asked for and some of them answered with
    // nothing — a timeout or an unparseable reply — so the median stands on fewer
    // opinions than the floor this run was admitted at. Refused rather than scored,
    // because a median over four samples reported as a twenty-sample ensemble is the
    // silent downgrade in its purest form.
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
    // UNREACHABLE BY CONSTRUCTION, and stated anyway. The pool above is sized so the
    // clamp cannot bind; if it binds regardless, the evaluator did not honour the
    // budget it was handed, and a candidate scored by a smaller ensemble than the one
    // this run was admitted at is exactly the silent downgrade the fix exists to
    // remove. It is the instrument breaking, so it takes the run down the way a thrown
    // verifier does rather than returning a number nothing validated.
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
    // USED, not attempted: the ensemble is the number of opinions the median stands on,
    // and reporting the number asked for would restate the request as a result.
    ensemble: evaluation.judgeSamplesUsed,
    grounding: evaluation.grounding,
  };
}

/**
 * Score, persist, backpropagate and rank ONE expansion. This owns the one ordered state
 * transition every candidate crosses: scorer outcome -> durable node record -> selection
 * row -> terminal state or ancestor reward -> best candidate. The runner owns level
 * ordering; this module owns what one settled child changes.
 */
export async function scoreExpansion(input: {
  readonly expansion: Expansion;
  readonly siblings: readonly Expansion[];
  readonly measures: boolean;
  readonly verifier: ResolvedVerifier | null;
  readonly witnessVerifier: ResolvedVerifier | null;
  readonly pareto: PreparedParetoMeasurement | null;
  readonly ctx: MeasurementContext | null;
  readonly measured: MeasuredObjective | null;
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
}): Promise<Refusal | null> {
  const {
    expansion, siblings, measures, verifier, witnessVerifier, pareto, ctx, measured, baseline,
    judgeSamples, resolved, rt, mode, languages, sql, rootId, candidates, spentBy,
    nodes, log, searchLedger, ledgerEpoch, rankDirection, state,
  } = input;
  let { publication, best, bestValue } = state;
  const outcome = expansion.incomplete !== null
    ? { kind: 'incomplete' as const, detail: expansion.incomplete.detail }
    : pareto !== null
      ? await measureParetoChild({ pareto, artifact: expansion.artifact })
      : measures && verifier && ctx && measured && baseline !== null
        ? await measureChild({
            ctx, verifier, witnessVerifier, measured, baseline, artifact: expansion.artifact,
          })
        : judgeSamples !== null
          ? await judgeChild({
            rt, mode, samples: judgeSamples, task: resolved.task,
            minEnsemble: isTreeAdvance(resolved.config.advance.kind)
              ? JUDGE_MARGINALISATION_MIN
              : 1,
            answer: expansion.answer,
            siblings: siblings.map((other) => other.answer),
            siblingsProducedCode: siblings.some(
              (other) => readProposalCode(other.answer, languages)?.kind === 'runnable',
            ),
          })
          : null;
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
  recordSwarmNode(sql, {
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
  insertSearchNode(sql, {
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
    publication = { kind: 'sealed', breach: outcome.breach, clearedBy: null };
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
    backpropagate(sql, expansion.id, score);
  } else if (outcome && outcome.kind !== 'pareto') {
    const status = outcome.kind === 'sealed' ? 'terminal' : 'failed';
    void sql`UPDATE search_nodes SET status = ${status} WHERE id = ${expansion.id}`;
  }
  const rank = outcome?.kind === 'scored'
    ? outcome.measurement.value
    : outcome?.kind === 'judged' ? outcome.score : null;
  if (rank !== null && (bestValue === null || isBetter(rank, bestValue, rankDirection))) {
    best = candidate;
    bestValue = rank;
  }
  state.publication = publication;
  state.best = best;
  state.bestValue = bestValue;
  return null;
}
