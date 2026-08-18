/**
 * Running a resolved swarm: expand, measure, settle — and refusing, by name, the
 * resolved shapes no engine in this tree can execute faithfully.
 *
 * WHAT RUNS HERE, AND WHY IT IS EXACTLY THIS. A resolved configuration at `depth: 1`
 * is one expansion from the workspace as found, scored, and settled. Every axis it
 * names is realised rather than approximated:
 *
 *   - `branches` candidates, each a single toolless generation, which is what an
 *     `expand:'sample'` or `expand:'mutate'` step IS at one level (the parent is the
 *     workspace as found, so `sample` writes from scratch and `mutate` improves what
 *     is already there);
 *   - `decorrelate:'angles'` through the deterministic, LLM-free angle set the MCTS
 *     expansion already uses, so siblings differ by construction rather than by
 *     temperature;
 *   - `observe:'ancestors'` by putting the MEASURED BASELINE in the expansion prompt —
 *     at depth 1 the only ancestor is the workspace as found, and its measurement is
 *     precisely the environment feedback that axis names;
 *   - `score:'verify'` through the registry's instrument, one candidate at a time,
 *     because candidates share one workspace and a parallel measurement would measure
 *     whichever wrote last (§10.3's isolation gap, respected rather than assumed away);
 *   - `settle` derived by `settleOf` and never chosen here.
 *
 * WHAT DOES NOT RUN, STATED AS A REFUSAL RATHER THAN AS SILENCE. `depth > 1` needs a
 * tree engine that consumes an `objective`, and the shipped one
 * (`mcts/engine.ts` → `evaluateWithMultiModelJudging`) scores by judge and execution
 * verdict with no seam for a verifier at all. Dispatching a verify-scored call onto it
 * would return a judge's number under the objective's name, which is the
 * accepted-and-ignored lie §2.5 exists to refuse — strictly worse than refusing. So
 * the refusal is `unsupported`, it names the cap that makes the call runnable, and it
 * names `settle=mcts` for a caller who wanted the judged tree that does exist.
 */
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { diversityAngle, siblingAngles } from '../mcts/diversity';
import { explorePrompt, type ExplorePrompt } from '../mcts/explore-prompt';
import { readProposalCode } from '../execution/code-fence';
import { diagnostics } from '../obs/index';
import { ProteusError, refusalOf, type Refusal } from '../obs/error';
import { normalizeUsage, usageTotal, type Usage, addUsage } from '../usage';
import { resolveVerifier, type ResolvedVerifier } from './verifier-registry';
import {
  carrySuppression, floorMargin, isBetter, normalisedScore, PUBLISHING_CARRIES,
} from './objective';
import type {
  Floor, FloorBreach, Measurement, MeasurementContext, Objective,
  ObjectiveDirection, ObjectiveScale, PublicationState, PublishingCarry, VerifierSource,
} from './objective';
import { isTreeAdvance, SWARM_TREE_ADVANCES } from './swarm';
import type {
  ResolvedSwarm, SwarmCandidate, SwarmResult, SwarmSettleReport,
} from './swarm';
import type { AgentRuntime } from '../types/agent-runtime';
import type { ModelCallSink } from '../events/model-call';
import type { WorkMode } from '../prompting/surface';

/** What a run needs that a resolved call does not carry: a model to expand with, and
 *  a workspace to measure in. */
export interface SwarmRunDeps {
  readonly rt: AgentRuntime;
  readonly model: LanguageModel;
  readonly mode: WorkMode;
  readonly signal?: AbortSignal;
  /** Where this run's model calls are reported. Absent = unreported, which the spend
   *  coverage fraction states rather than hides. */
  readonly reportModelCall?: ModelCallSink;
}

/** The scalar half of an objective — the metric, direction, scale, target, floor and
 *  instrument a measured run needs. A `witness` hunt supplies its `proxy`'s, which is
 *  §2.4(c)'s rule that the proxy is what the search optimises. */
interface MeasuredObjective {
  readonly metric: string;
  readonly unit: string;
  readonly direction: ObjectiveDirection;
  readonly scale: ObjectiveScale;
  readonly target: number;
  readonly verify: VerifierSource;
  readonly floor: Floor | undefined;
  /** The witness predicate, when this run is a bounded hunt with a proxy. Evaluated
   *  as a SIDE CONDITION on every candidate, never as the thing being optimised. */
  readonly witness: VerifierSource | null;
}

function measuredHalf(objective: Objective): MeasuredObjective | null {
  if (objective.kind === 'witness') {
    if (!objective.proxy) return null;
    const proxy = measuredHalf(objective.proxy);
    return proxy && { ...proxy, witness: objective.check };
  }
  if (objective.kind === 'vector') return null;
  return {
    metric: objective.metric,
    unit: objective.unit,
    direction: objective.direction,
    scale: objective.scale,
    target: objective.target,
    verify: objective.verify,
    floor: objective.floor,
    witness: null,
  };
}

function unsupported(error: string): Refusal {
  return refusalOf(new ProteusError('unsupported', error));
}

function unavailable(error: string): Refusal {
  return refusalOf(new ProteusError('unavailable', error));
}

function badInput(error: string): Refusal {
  return refusalOf(new ProteusError('bad_input', error));
}

/**
 * Whether this tree can execute the resolved shape, or the refusal naming what it
 * would have needed.
 *
 * Every arm names the one thing that is missing and the one move that fixes it, per
 * §7.2: a refusal offering two remedies was measured being corrected to the wrong one.
 */
function regionRefusal(resolved: ResolvedSwarm): Refusal | null {
  const { config, caps } = resolved;
  const depth = caps.depth;
  if (!depth) {
    return badInput('neither this call nor its base states `depth`, so nothing says how deep the '
      + 'search may go — and no default exists to inherit, because a composition with no `from` has '
      + 'no preset row behind it. Pass `depth`, or name a base with `from`.');
  }
  if (!caps.branches) {
    return badInput('neither this call nor its base states `branches`, so nothing says how many '
      + 'candidates an expansion produces. Pass `branches`, or name a base with `from`.');
  }
  if (depth.value > 1) {
    return unsupported(`depth ${String(depth.value)} needs a search TREE that scores nodes against the `
      + 'call\'s own `objective`, and no engine here does: the shipped tree scores by judge ensemble '
      + 'and execution verdict, so running this would report a judge\'s number under your metric\'s '
      + `name. Pass depth:1 for one measured expansion of ${String(caps.branches.value)} candidates, `
      + 'which runs exactly as configured. For the judged tree that does exist, use '
      + 'agents.fork settle:"mcts", which is scored by judge on purpose and says so.');
  }
  if (config.unit !== 'answer') {
    return unsupported(`unit:"${config.unit}" is not executable here — a node is one complete answer, `
      + 'measured as a whole. Use unit:"answer".');
  }
  if (config.observe === 'own') {
    return unsupported('observe:"own" gives a node feedback about its OWN attempt, which needs a '
      + 'second round to exist at all, and depth:1 has one. Use observe:"ancestors" to put the '
      + 'measured baseline in the expansion prompt, or observe:"none" for a blind expansion.');
  }
  if (config.expand === 'aggregate') {
    return unsupported('expand:"aggregate" builds a DAG whose merges are ordered by dependency, and '
      + 'nothing here orders merges. Use expand:"sample" for independent candidates or '
      + 'expand:"mutate" to improve what the workspace already holds.');
  }
  if (config.score.kind !== 'verify' && config.score.kind !== 'none') {
    return unsupported(`score:"${config.score.kind}" needs a scorer this run has no engine for: `
      + 'novelty needs an archive with a rejection test, and judge needs the marginalised ensemble '
      + 'the shipped tree owns. Use score:"verify" with an `objective` to measure candidates, or '
      + 'score:"none" for a flat run that returns them unranked.');
  }
  if (isTreeAdvance(config.advance) && config.score.kind === 'none') {
    // Unreachable through `swarmValidity`, which refuses this composition outright.
    // Kept because this function is also the in-process entry point.
    return badInput(`advance:"${config.advance}" cannot select without a score.`);
  }
  if (config.advance !== 'none' && !isTreeAdvance(config.advance)) {
    return unsupported(`advance:"${config.advance}" reports a front or an archive, and both need a `
      + 'store this run has no writer for. Use advance:"none" for a flat expansion, or one of '
      + `${SWARM_TREE_ADVANCES.join('/')} at depth:1, where selection is an argmax over the `
      + 'candidates.');
  }
  return null;
}

/** The workspace, as an instrument sees it. §3.2's two members and no others: no
 *  model, no network, no trajectory. */
function measurementContext(rt: AgentRuntime): MeasurementContext | null {
  const shell = rt.shell;
  if (!shell) return null;
  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** The measured baseline this instrument reported alongside a candidate, or null when
 *  the kind measures none. §2.3: measured, never asserted. */
function baselineOf(measurement: Measurement, key: string | null): number | null {
  if (!key) return null;
  const reported = measurement.measured?.[key];
  return reported !== undefined && Number.isFinite(reported) ? reported : null;
}

/** Whether `value` sits on the side of the floor no correct candidate can reach.
 *  Named because the comparison INVERTS with the direction, and getting it backwards
 *  turns the fraud check into a fraud. */
function breaches(floor: Floor, direction: ObjectiveDirection, value: number): boolean {
  return direction === 'minimise' ? value < floor.value : value > floor.value;
}

/** The expansion prompt for one branch: the task, the angle its siblings do not have,
 *  and — under `observe:'ancestors'` — what the workspace as found actually measured. */
function branchPrompt(input: {
  readonly resolved: ResolvedSwarm;
  readonly mode: WorkMode;
  readonly languages: readonly [string, ...string[]];
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly index: number;
  readonly branches: number;
}): ExplorePrompt {
  const { resolved, measured, baseline, index, branches } = input;
  const angle = diversityAngle(index, branches);
  const feedback = resolved.config.observe === 'ancestors' && measured && baseline !== null
    ? `\n\nThe workspace as found measures ${String(baseline)} ${measured.unit} on `
      + `${measured.metric}. The target is ${String(measured.target)} ${measured.unit}, `
      + `${measured.direction === 'minimise' ? 'lower' : 'higher'} is better, and only that number `
      + 'is measured. This is the environment\'s own measurement, not an estimate.'
    : '';
  const instruction = resolved.config.expand === 'mutate'
    ? 'Improve what the workspace already holds rather than starting over.'
    : 'Write your approach from scratch; do not assume what is already there is a good start.';
  return explorePrompt({
    mode: input.mode,
    context: `${resolved.task}${feedback}\n\nYour angle: ${angle}. ${instruction}`,
    craftedTools: [],
    siblings: siblingAngles(index, branches),
    languages: input.languages,
  });
}

/** One expansion, as the settle report carries it. */
interface Expansion {
  readonly id: string;
  readonly artifact: string;
  readonly usage: Usage;
}

/**
 * Run a resolved swarm, or refuse.
 *
 * The refusals are ordered by what they cost: shape first (free), then the caps, then
 * the instrument, then the BASELINE — because §2.3's measurement is the first thing
 * that spends anything, and a run that will not start must not spend it.
 */
export async function runSwarm(
  deps: SwarmRunDeps,
  resolved: ResolvedSwarm,
): Promise<SwarmResult | Refusal> {
  const started = Date.now();
  const region = regionRefusal(resolved);
  if (region) return region;
  // Both checked by `regionRefusal`; read here so the types are narrowed once.
  const branches = resolved.caps.branches?.value ?? 0;
  const measures = resolved.config.score.kind === 'verify';

  let measured: MeasuredObjective | null = null;
  let verifier: ResolvedVerifier | null = null;
  let ctx: MeasurementContext | null = null;
  let baseline: number | null = null;
  let publication: PublicationState = { kind: 'open' };

  if (measures) {
    const objective = resolved.objective;
    if (!objective) return badInput('score:"verify" with no `objective` measures nothing.');
    measured = measuredHalf(objective);
    if (!measured) {
      return unsupported(`an objective of kind "${objective.kind}" is measured per component or per `
        + 'instance, and this run settles one answer against one number. Use kind:"scalar", or '
        + 'kind:"witness" with a scalar `proxy`.');
    }
    if (!('kind' in measured.verify)) {
      // The closure arm is legal for in-process callers and unusable HERE, for a
      // reason that is not about publishability: a closure declares no path a
      // candidate belongs at, so a runner holding one could only measure the
      // workspace as found and report it as a candidate's score. Registering the kind
      // is what supplies that path — and it is also what gives §3.4 a name that can
      // fail to resolve.
      return unsupported('this objective supplies `verify` as a closure, which names no path a '
        + 'candidate is written to, so this run cannot place one for it to measure. Register a '
        + 'verifier kind and pass verify as {kind, spec}.');
    }
    const resolvedVerifier = resolveVerifier(measured.verify);
    if ('reason' in resolvedVerifier) return resolvedVerifier;
    verifier = resolvedVerifier;
    ctx = measurementContext(deps.rt);
    if (!ctx) {
      return unavailable('this workspace has no shell, so nothing can run a measurement in it — a '
        + 'verifier is given a filesystem and a shell and this actor was wired neither. The call is '
        + 'well-formed; the instrument is absent.');
    }
    // §2.3: the baseline is measured on the workspace AS FOUND, before any candidate
    // exists. A fault here MUST NOT start the run — there is nothing to normalise
    // against and nothing to compare to.
    let asFound: Measurement;
    try {
      asFound = await verifier.verify(ctx);
    } catch (error) {
      return unavailable(`the baseline measurement faulted, so this run cannot start: `
        + `${error instanceof Error ? error.message : String(error)}. That is the instrument `
        + 'breaking rather than a candidate failing, and it fails the run by design.');
    }
    baseline = baselineOf(asFound, verifier.baselineKey)
      ?? (asFound.kind === 'measured' ? asFound.value : null);
    if (baseline === null) {
      return unavailable('the baseline measurement produced no number, so there is nothing to '
        + `normalise against: ${asFound.detail}`);
    }
    // §4.5 C2 — the run's own first measurement refutes the floor.
    if (measured.floor && breaches(measured.floor, measured.direction, baseline)) {
      return badInput(`the workspace as found already measures ${String(baseline)} `
        + `${measured.unit}, past a floor of ${String(measured.floor.value)} that no correct `
        + 'solution may cross. The floor is refuted by the run\'s own baseline before any candidate '
        + `exists. Re-derive the bound: ${measured.floor.proof}`);
    }
    // §2.3 — a target at or beyond the measured baseline leaves no range to score on.
    if (normalisedScore({
      value: baseline, baseline, target: measured.target,
      direction: measured.direction, scale: measured.scale,
    }) === null) {
      return badInput(`the target of ${String(measured.target)} ${measured.unit} is already met by `
        + `the workspace as found, which measures ${String(baseline)}. Every candidate would `
        + 'saturate at 1.0 and the search would have no gradient — the baseline is measured rather '
        + `than declared, so raise the target past ${String(baseline)}.`);
    }
    diagnostics.event('swarm.baseline_measured', {
      preset: resolved.preset,
      metric: measured.metric,
      baseline,
      target: measured.target,
      kind: verifier.kind,
    });
  }

  // EXPAND. Model calls in parallel — they touch nothing — and measurement strictly
  // sequential below, because every candidate is written to the same path.
  //
  // The executor's declared languages travel into the prompt for the reason
  // explore-prompt.ts states: a proposal fenced in a language nothing here can run is
  // unverifiable, so the question has to name what the measurement can execute.
  const languages = deps.rt.executor.languages;
  const expansions: Expansion[] = [];
  let usage: Usage = {};
  const generated = await Promise.allSettled(
    Array.from({ length: branches }, async (_unused, index) => {
      const prompt = branchPrompt({
        resolved, mode: deps.mode, languages, measured, baseline, index, branches,
      });
      const result = await generateText({
        model: deps.model,
        system: prompt.system,
        prompt: prompt.user,
        abortSignal: deps.signal,
      });
      return { index, text: result.text, usage: normalizeUsage(result.usage), modelId: result.response.modelId };
    }),
  );
  for (const settled of generated) {
    if (settled.status === 'rejected') {
      // Named, never counted: a branch lost to a provider error is one fewer candidate
      // and the report's `expansions` has to be able to say so.
      diagnostics.event('swarm.branch_failed', {
        preset: resolved.preset,
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      });
      continue;
    }
    const { index, text, usage: spent, modelId } = settled.value;
    usage = addUsage(usage, spent);
    deps.reportModelCall?.({ source: 'swarm', usage: spent, modelId });
    // A proposal fenced in a language the executor cannot run is kept WHOLE rather
    // than dropped: it is still the branch's answer, the measurement will report it as
    // unmeasurable with the instrument's own reason, and a caller reading the report
    // can see what was proposed instead of an absence.
    const proposal = readProposalCode(text, languages);
    expansions.push({
      id: `branch-${String(index)}`,
      artifact: proposal?.kind === 'runnable' ? proposal.code : text.trim(),
      usage: spent,
    });
  }

  // SCORE. One candidate at a time, into the one path the instrument reads.
  const candidates: SwarmCandidate[] = [];
  let best: SwarmCandidate | null = null;
  let bestValue: number | null = null;
  for (const expansion of expansions) {
    if (!measures || !verifier || !ctx || !measured || baseline === null) {
      candidates.push({
        id: expansion.id, artifact: expansion.artifact, measured: null,
        unmeasurable: null, score: null,
      });
      continue;
    }
    await ctx.vfs.writeFile(verifier.artifact, expansion.artifact);
    let measurement: Measurement;
    try {
      measurement = await verifier.verify(ctx);
    } catch (error) {
      // §3.4: a throw is the INSTRUMENT breaking and is never converted into an
      // unmeasurable candidate. It fails the run: no node is scored, nothing is
      // published, and the reason reaches the caller intact.
      return unavailable(`the verifier faulted while measuring ${expansion.id}, so no number this `
        + `run produced can be trusted: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (measurement.kind === 'unmeasurable') {
      candidates.push({
        id: expansion.id, artifact: expansion.artifact, measured: null,
        unmeasurable: measurement.detail, score: null,
      });
      continue;
    }
    if (measured.floor && breaches(measured.floor, measured.direction, measurement.value)) {
      // §4.4: NOT scored zero, NOT written, and the run CONTINUES under a seal. The
      // measurement is retained in full because a discarded one cannot adjudicate
      // "the floor is wrong" against "the verifier is gameable".
      const breach: FloorBreach = {
        floor: measured.floor,
        // Retained in FULL: a discarded measurement cannot adjudicate H1 against H2.
        measured: measurement,
        margin: floorMargin(measured.floor, measured.direction),
        // Fixed at exactly two because exactly two fit, and they demand opposite
        // responses. The pair is data, not prose.
        hypotheses: ['floor_wrong', 'verifier_gameable'],
      };
      publication = { kind: 'sealed', breach, clearedBy: null };
      diagnostics.event('exploration.floor_breach', {
        preset: resolved.preset,
        metric: measured.metric,
        value: measurement.value,
        floor: measured.floor.value,
        margin: breach.margin,
        hypotheses: breach.hypotheses.join(','),
      });
      candidates.push({
        id: expansion.id, artifact: expansion.artifact, measured: measurement,
        unmeasurable: null, score: null,
      });
      continue;
    }
    const score = normalisedScore({
      value: measurement.value, baseline, target: measured.target,
      direction: measured.direction, scale: measured.scale,
    });
    const candidate: SwarmCandidate = {
      id: expansion.id, artifact: expansion.artifact, measured: measurement,
      unmeasurable: null, score,
    };
    candidates.push(candidate);
    if (bestValue === null || isBetter(measurement.value, bestValue, measured.direction)) {
      best = candidate;
      bestValue = measurement.value;
    }
  }

  // The answer stays in the workspace. Without this the path holds whichever
  // candidate was measured last, which is a different artifact from the one reported.
  if (best && verifier && ctx) await ctx.vfs.writeFile(verifier.artifact, best.artifact);

  const report = settleReport({
    resolved, measured, baseline, publication, candidates, best,
    expansions: expansions.length, usage, durationMs: Date.now() - started,
  });
  return {
    preset: resolved.preset,
    label: resolved.label,
    config: resolved.config,
    caps: resolved.caps,
    report,
    publication: {
      state: publication,
      caveat: publication.kind === 'sealed' && publication.clearedBy === null
        ? 'this run measured a candidate past its floor, so the floor is SUSPENDED for the rest of '
          + 'the run and the answer is not publishable: the number may be a cheat the verifier '
          + 'missed, or the bound may be wrong, and this observation cannot tell which. Nothing '
          + 'clears it except a recorded re-derivation of the bound.'
        : null,
    },
    best,
    candidates,
  };
}

/** §2.4(c)'s report, assembled from what the run actually observed. */
function settleReport(input: {
  readonly resolved: ResolvedSwarm;
  readonly measured: MeasuredObjective | null;
  readonly baseline: number | null;
  readonly publication: PublicationState;
  readonly candidates: readonly SwarmCandidate[];
  readonly best: SwarmCandidate | null;
  readonly expansions: number;
  readonly usage: Usage;
  readonly durationMs: number;
}): SwarmSettleReport {
  const { resolved, measured, best } = input;
  const carry = PUBLISHING_CARRIES.find(
    (publishing): publishing is PublishingCarry => publishing === resolved.config.carry.kind,
  );
  return {
    settle: resolved.settle,
    floorMargin: measured?.floor ? floorMargin(measured.floor, measured.direction) : null,
    baseline: input.baseline,
    // A witness verdict about THIS RUN. `false` is "this search did not find one",
    // and there is no field on this report that could say none exists.
    witnessFound: measured?.witness ? best !== null && best.score === 1 : null,
    // The count is one per CELL rather than per refused publication: a flat run with
    // no descriptor has exactly one cell, and it costs the next run one thing — a
    // worse starting elite — or nothing at all.
    carrySuppressed: carry
      ? carrySuppression(input.publication, carry, best ? 1 : 0)
      : null,
    // `budget` where fewer candidates came back than the width asked for: a branch
    // lost to a provider is a narrower search than the caller configured, and a
    // report that said `settled` would be claiming the whole width ran.
    stop: input.expansions < (resolved.caps.branches?.value ?? 0) ? 'budget' : 'settled',
    expansions: input.expansions,
    tokens: usageTotal(input.usage) ?? null,
    durationMs: input.durationMs,
  };
}
