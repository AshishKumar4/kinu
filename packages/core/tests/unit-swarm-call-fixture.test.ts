// Entry zero: one complete, executable `agents.swarm` call, asserted against the shipped
// parser, preset table, validity predicate and verifier registry. Its numbers are read from
// `hard-majority-vote` in HARD_TASKS, never retyped.
// Specified by docs/EXPLORATION.md.
import { describe, test, expect } from 'bun:test';
import { HARD_TASKS, type HardTask } from '@kinu.run/test-utils';
import * as v from 'valibot';
import * as objectiveModule from '../src/strategy/objective';
import * as swarmModule from '../src/strategy/swarm';
import {
  floorMargin, type Floor, type ScalarObjective, type VerifierSpec,
} from '../src/strategy/objective';
import {
  NAMED_SWARM_PRESETS, SWARM_PRESETS, SWARM_PRESET_POINTS, resolveSwarm, settleOf, swarmValidity,
  type SwarmAdvance, type SwarmConfig, type SwarmInput,
} from '../src/strategy/swarm';
import { VERIFIER_KINDS, resolveVerifier, unregisteredKindRefusal } from '../src/strategy/verifier-registry';
import { AGENTS_TOOL_ACTIONS } from '../src/tools/registry';
import { parseAgentsToolInput } from '../src/delegation/agents-tool';
import { JsonObjectSchema } from '../src/utils/json';

/** A missing task is a broken instrument, not a skipped case. */
function majorityVote(): HardTask {
  const found = HARD_TASKS.find((task) => task.id === 'hard-majority-vote');

  if (!found) {
    throw new Error(
      'hard-majority-vote is absent from HARD_TASKS, so entry zero quotes numbers '
      + 'no shipped task measures',
    );
  }

  return found;
}

const TASK = majorityVote();

const PROBLEM = TASK.problem;

/**
 * `verify` in the only form that crosses a JSON tool argument. `spec` is `RatioProblem` in
 * full, not a pointer at a corpus entry, so the digest covers its contents. `spec` is
 * opaque to the snake_case wire convention.
 */
const VERIFY: VerifierSpec = {
  kind: 'exec-ratio',
  spec: {
    params: { ...PROBLEM.params },
    reference: PROBLEM.reference,
    body: PROBLEM.body,
    targetOps: PROBLEM.targetOps,
    lowerBoundOps: PROBLEM.lowerBoundOps,
  },
};

/** `best_known_honest` equals `target`: a score of 1.0 means "matched the best known algorithm". */
const WIRE_FLOOR = {
  value: PROBLEM.lowerBoundOps,
  kind: 'certificate',
  best_known_honest: PROBLEM.targetOps,
  proof: 'Per instance every token must appear in at least one call; a call '
    + 'touches TWO tokens, so covering n needs ceil(n/2), i.e. n for the pair.',
};

const WIRE_OBJECTIVE = {
  kind: 'scalar',
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  target: PROBLEM.targetOps,
  verify: VERIFY,
  floor: WIRE_FLOOR,
};

const CALL = {
  action: 'swarm',
  preset: 'optimise',
  task: 'Beat reference.mjs on oracle calls. Same answers, fewer comparisons.',
  // Wire form, deliberately untyped: the parse below proves the mapping to camelCase.
  objective: WIRE_OBJECTIVE,
};

const PARSED = parseAgentsToolInput({ input: CALL });

const OBJECTIVE = v.parse(
  v.custom<ScalarObjective>((input) => v.is(v.object({ kind: v.literal('scalar') }), input)),
  PARSED.objective,
);

const FLOOR: Floor = v.parse(
  v.custom<Floor>((input) => v.is(v.object({ bestKnownHonest: v.number() }), input)),
  OBJECTIVE.floor,
);

/** Resolved from the preset row, never hand-built: validity is checked over the resolved configuration. */
const OPTIMISE = SWARM_PRESET_POINTS.optimise;

const VERIFIER_TREE: SwarmConfig = OPTIMISE.config;

/** The tree selectors *Settle is derived* is exercised over. */
const TREE_ADVANCES = ['uct', 'best-first'] as const satisfies readonly SwarmAdvance[];

describe('entry zero crosses a JSON tool boundary, or it is not a call', () => {
  test('every field of the call is JSON', () => {
    expect(v.is(JsonObjectSchema, CALL)).toBe(true);
    expect(JSON.parse(JSON.stringify(CALL))).toEqual(CALL);
  });

  test('the closure arm of VerifierSource could not have been sent', () => {
    expect(v.is(JsonObjectSchema, { ...WIRE_OBJECTIVE, verify: TASK.verify })).toBe(false);
    // The live parser refuses it too, not just the JSON schema.
    expect(() => parseAgentsToolInput({ input: {
      ...CALL, objective: { ...WIRE_OBJECTIVE, verify: TASK.verify },
    } })).toThrow();
  });

  test('verify is a VerifierSpec whose kind is closed and whose spec is whole', () => {
    expect(VERIFIER_KINDS).toContain('exec-ratio');
    const resolved = resolveVerifier(VERIFY);
    expect('reason' in resolved).toBe(false);

    if ('reason' in resolved) return;
    expect(resolved.artifact).toBe('solution.mjs');
    expect(resolved.baselineKey).toBe('refOps');
    // G6: identity captures which implementation the kind resolved to.
    expect(resolved.implementation).toStartWith('exec-ratio@');
    // The refusal deliberately does not offer "or pass a closure".
    const fabricated = resolveVerifier({ kind: 'simulate_conversion', spec: VERIFY.spec });
    expect(fabricated).toMatchObject({ reason: 'bad_input' });
    expect('error' in fabricated ? fabricated.error : '').toContain(unregisteredKindRefusal());
    expect('error' in fabricated ? fabricated.error : '').not.toContain('closure');

    // The refusal names the missing field rather than reporting a shape mismatch.
    const incomplete = resolveVerifier({
      kind: 'exec-ratio',
      spec: {
        params: { ...PROBLEM.params }, reference: PROBLEM.reference,
        body: PROBLEM.body, targetOps: PROBLEM.targetOps,
      },
    });

    expect(incomplete).toMatchObject({ reason: 'bad_input' });
    expect('error' in incomplete ? incomplete.error : '').toContain('lowerBoundOps');
  });

  test('the wire form is snake_case and `spec` is not touched by it', () => {
    // `spec` crosses unchanged, otherwise `verifierDigest` would depend on which side of the
    // transform computed it.
    expect(Object.keys(WIRE_FLOOR)).toContain('best_known_honest');
    expect(FLOOR.bestKnownHonest).toBe(PROBLEM.targetOps);
    expect(OBJECTIVE.verify).toEqual(VERIFY);
    expect(Object.keys(v.parse(JsonObjectSchema, VERIFY.spec))).toEqual([
      'params', 'reference', 'body', 'targetOps', 'lowerBoundOps',
    ]);
    // camelCase for a snake_case field is the expected model error: refused, not dropped.
    expect(() => parseAgentsToolInput({ input: {
      ...CALL,
      objective: { ...WIRE_OBJECTIVE, floor: { ...WIRE_FLOOR, bestKnownHonest: 2992 } },
    } })).toThrow();
  });
});

describe('entry zero is the worked example, and its numbers are the corpus\'s', () => {
  test('the worked example verbatim', () => {
    expect(OBJECTIVE.metric).toBe('oracle_calls');
    expect(OBJECTIVE.unit).toBe('oracle calls');
    expect(OBJECTIVE.direction).toBe('minimise');
    expect(OBJECTIVE.scale).toBe('log');
    expect(OBJECTIVE.target).toBe(2992);
    expect(FLOOR.kind).toBe('certificate');
    expect(FLOOR.value).toBe(1200);
    expect(FLOOR.bestKnownHonest).toBe(2992);
  });

  test('and those numbers are hard-majority-vote\'s', () => {
    expect(PROBLEM.targetOps).toBe(2992);
    expect(PROBLEM.lowerBoundOps).toBe(1200);
    expect(PROBLEM.params.n).toBe(1200);
  });
});

describe('validity over entry zero, as far as the document defines it', () => {
  test('*Accepted and ignored*: optimise prohibits key, config, from, label — and TAKES an optional objective', () => {
    const entry = swarmCall();
    expect(SWARM_PRESETS).toContain(entry.preset);
    expect(PARSED.objective).toBeDefined();
    expect(PARSED.key).toBeUndefined();
    expect(PARSED.config).toBeUndefined();
    expect(PARSED.from).toBeUndefined();
    expect(PARSED.label).toBeUndefined();
    // `from`/`label` are refused on the call; `key` on the resolved configuration, because only
    // an archive `advance` may take one.
    expect(resolveSwarm({ ...entry, from: 'ideate' })).toMatchObject({ reason: 'bad_input' });
    expect(resolveSwarm({ ...entry, label: 'x' })).toMatchObject({ reason: 'bad_input' });
    const keyed = resolveSwarm({ ...entry, key: 'coverage' });

    if ('reason' in keyed) throw new Error('a named preset must resolve, and this one refused');
    expect(swarmValidity(keyed)).toMatchObject({ reason: 'bad_input' });
    // A missing `objective` is legal: a named preset resolves to its unmeasured (judged) point.
    const unmeasured = resolveSwarm({ preset: 'optimise', task: entry.task });

    if ('reason' in unmeasured) throw new Error('a named preset must resolve, and this one refused');
    expect(swarmValidity(unmeasured)).toBeNull();
    expect(unmeasured.config.score.kind).toBe('judge');
    expect(unmeasured.config.advance).toEqual({ kind: 'none' });
    const measured = resolveSwarm({ preset: 'optimise', task: entry.task, objective: OBJECTIVE });

    if ('reason' in measured) throw new Error(measured.error);
    expect(swarmValidity(measured)).toBeNull();
    expect(measured.config.score.kind).toBe('verify');
    expect(measured.config.advance).toEqual({ kind: 'uct' });
  });

  test('*Validity over the resolved configuration*: entry zero is LEGAL', () => {
    const resolved = resolveSwarm(swarmCall());
    expect('reason' in resolved).toBe(false);

    if ('reason' in resolved) return;
    expect(resolved.config).toEqual(VERIFIER_TREE);
    expect(resolved.settle).toBe('best');
    expect(swarmValidity(resolved)).toBeNull();
  });

  test('*Floor margin*: the floor leaves room, and the margin is computed not asserted', () => {
    expect(floorMargin(FLOOR, OBJECTIVE.direction)).toBeCloseTo(0.599, 3);
  });

  test('*Measured baseline*: the baseline leaves the target a range to score on', () => {
    // The seeded reference is quadratic per instance; a target at or beyond the measured
    // baseline refuses the run.
    expect(OBJECTIVE.target).toBeLessThan(PROBLEM.params.n * PROBLEM.params.n);
  });

  test('the caps entry zero does not state are RESOLVED, and say where from', () => {
    expect(PARSED.branches).toBeUndefined();
    expect(PARSED.depth).toBeUndefined();
    const resolved = resolveSwarm(swarmCall());

    if ('reason' in resolved) throw new Error(resolved.error);
    expect(resolved.caps.depth).toEqual({ value: 5, origin: 'preset' });
    expect(resolved.caps.branches).toEqual({ value: 3, origin: 'preset' });
    const widened = resolveSwarm({ ...swarmCall(), branches: 8 });

    if ('reason' in widened) throw new Error(widened.error);
    expect(widened.caps.branches).toEqual({ value: 8, origin: 'call' });
  });
});

/** Precedence: `config` overrides the `from` row, and only where it speaks. */
describe('resolve(custom): `config` overrides `from`\'s row, and only where it speaks', () => {
  test('the axes a composition states are its own; the rest come from the base', () => {
    const composed = resolveSwarm({
      ...swarmCall(), preset: 'custom', from: 'optimise',
      label: 'optimise, run fresh and carrying nothing forward',
      config: { context: 'fresh', carry: { kind: 'none' } },
    });

    if ('reason' in composed) throw new Error(composed.error);
    expect(composed.config).toEqual({ ...VERIFIER_TREE, context: 'fresh', carry: { kind: 'none' } });
    expect(swarmValidity(composed)).toBeNull();
  });
});

describe('what the live tool surface does with entry zero', () => {
  test('swarm IS an action, and the call parses', () => {
    expect(AGENTS_TOOL_ACTIONS).toContain('swarm');
    expect(PARSED.action).toBe('swarm');
    expect(PARSED.preset).toBe('optimise');
    expect(PARSED.task).toBe(CALL.task);
    expect(PARSED.objective).toBeDefined();
  });

  test('a field is refused for the action that does not read it, and the refusal names the one that does', () => {
    // valibot's `object` strips unknown entries, so a field sent to the wrong action would
    // arrive as absent without this refusal.
    const smuggle = () => parseAgentsToolInput({ input: {
      action: 'hire',
      role: 'researcher',
      mission: CALL.task,
      preset: CALL.preset,
      objective: CALL.objective,
      branches: 8,
      depth: 4,
    } });

    expect(smuggle).toThrow(/field "preset" does not apply to action "hire"/);
    expect(smuggle).toThrow(/it is read by swarm/);

    // Every misapplied field is named, not just the first.
    for (const field of ['objective', 'branches', 'depth']) {
      expect(smuggle).toThrow(new RegExp(`field "${field}" does not apply to action "hire"`));
    }

    expect(smuggle).toThrow(/action "hire" takes: role, mission, agent/);
  });

  test('and the money case is refused by the spelling it got wrong', () => {
    // Dropping `budgetUsd` would silently grant no ceiling; the refusal must name the
    // snake_case spelling.
    const camelCase = () => parseAgentsToolInput({ input: {
      action: 'swarm', preset: PARSED.preset, task: CALL.task, budgetUsd: 5, budgetLabel: 'zero',
    } });

    expect(camelCase).toThrow(/unknown field "budgetUsd" — did you mean "budget_usd"\?/);
    expect(camelCase).toThrow(/unknown field "budgetLabel" — did you mean "budget_label"\?/);

    expect(parseAgentsToolInput({ input: {
      action: 'swarm', preset: PARSED.preset, task: CALL.task, budget_usd: 5,
    } })).toEqual({ action: 'swarm', preset: PARSED.preset, task: CALL.task, budget_usd: 5 });
  });
});

describe('the implementation, asserted against the shipped strategy modules', () => {
  test('the strategy modules export the resolution, the predicate and the result half', () => {
    // A set assertion, not containment: an added export stays a decision.
    // `paretoObjectiveAxes`, `dominatesPareto`, `paretoFront` port
    // `Exploration/Records.lean`'s `frontier_nondominance`.
    expect(Object.keys(objectiveModule).sort()).toEqual([
      'PUBLICATION_SURFACES', 'PUBLISHING_CARRIES', 'VERIFIER_KINDS', 'VERIFIER_KIND_DOC',
      'admitsPublication', 'carrySuppression', 'dominatesPareto', 'floorMargin', 'isBetter',
      'measuredHalf', 'normalisedScore', 'paretoFront', 'paretoObjectiveAxes',
      'validateParetoEvidence',
    ]);
    // `arbitrateBranch` ports `Exploration/Arbitration.lean`'s `arbitrate`;
    // `BRANCH_PROPOSAL_WIDTH` is the band `accepted_width_in_range` proves,
    // `BRANCH_REFUSAL_POLICIES` the reasons `every_refusal_is_reachable` covers.
    expect(Object.keys(swarmModule).sort()).toEqual([
      'BRANCH_PROPOSAL_WIDTH', 'BRANCH_REFUSAL_POLICIES',
      'JUDGE_MARGINALISATION_MIN', 'NAMED_SWARM_PRESETS', 'SWARM_ADVANCES', 'SWARM_CARRIES',
      'SWARM_CONTEXTS', 'SWARM_EXPANDS',
      'SWARM_PRESETS', 'SWARM_PRESET_DOCTRINE', 'SWARM_PRESET_POINTS', 'SWARM_SCORES',
      'SWARM_TREE_ADVANCES',
      'SWARM_UNITS', 'UNMEASURED_JUDGE_SAMPLES', 'arbitrateBranch', 'archiveRegionRefusal',
      'configDigestOf',
      'isTreeAdvance', 'judgeCallPool',
      'judgeMarginalisationRefusal', 'resolveSwarm', 'settleOf', 'swarmValidity',
      'unmeasuredPoint',
    ]);
  });

  test('a composition missing axes is refused naming every one of them', () => {
    // An axis added to `SwarmConfig` but missing from the resolver's list fails here.
    // `observe` and `decorrelate` are deliberately absent.
    const refusal = resolveSwarm({ preset: 'custom', task: 'x', label: 'l', config: {} });
    expect(refusal).toMatchObject({ reason: 'bad_input' });
    const error = 'error' in refusal ? refusal.error : '';

    for (const axis of [
      'unit', 'context', 'expand', 'score', 'advance', 'carry',
    ]) {
      expect(error).toContain(axis);
    }
  });

  test('*Settle is derived*: settleOf answers for entry zero under every tree advance', () => {
    for (const advance of TREE_ADVANCES) {
      expect(settleOf({ ...VERIFIER_TREE, advance: { kind: advance } })).toBe('best');
    }
  });

  test('*Presets*: EVERY row is stated, so every named preset resolves', () => {
    // A named preset is unrefusable. `novelty: 0.4` is Rainbow Teaming's similarity ceiling
    // converted to a distance floor; `threshold: 0.8` is `craftExtractionThreshold`.
    for (const preset of NAMED_SWARM_PRESETS) {
      expect(SWARM_PRESET_POINTS[preset].config).toBeDefined();
    }

    // The archive is reached only by declaring an objective; a bare call gets the unmeasured point.
    for (const preset of ['research', 'audit', 'redteam'] as const) {
      const resolved = resolveSwarm({ preset, task: 'x', key: 'k', objective: OBJECTIVE });
      expect(resolved).not.toMatchObject({ reason: 'bad_input' });

      if ('reason' in resolved) throw new Error(resolved.error);
      expect(resolved.config.advance).toEqual({ kind: 'archive', novelty: 0.4 });
    }

    for (const preset of ['research', 'audit', 'redteam'] as const) {
      const bare = resolveSwarm({ preset, task: 'x' });

      if ('reason' in bare) throw new Error(bare.error);
      expect(bare.config.advance).toEqual({ kind: 'none' });
      expect(bare.config.score.kind).toBe('judge');
    }

    // A research finding is for publication; an exploit corpus is not.
    for (const preset of ['research', 'audit'] as const) {
      expect(SWARM_PRESET_POINTS[preset].config.carry)
        .toEqual({ kind: 'artifacts', threshold: 0.8 });
    }

    expect(SWARM_PRESET_POINTS.redteam.config.carry).toEqual({ kind: 'elites' });
  });
});

/** Built per use so an overriding test cannot leak into the next. */
function swarmCall(): SwarmInput {
  return { preset: 'optimise', task: CALL.task ?? '', objective: OBJECTIVE };
}
