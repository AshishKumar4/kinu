// Entry zero of the exploration fixture suite: ONE complete `agents.swarm` call
// for docs/EXPLORATION-SPEC.md §2.4(a), executable, so the spec's own worked
// example and the surface that carries it cannot drift apart.
//
// The class, not the instance. An audit of that spec found the tool boundary had
// no owner end to end — one review found `objective.verify` declared as a closure
// while `agents.swarm` is a valibot-validated JSON action, a second found the
// action has no result type, a third found every empirical receipt measured a
// different surface, and none of them wrote the call. Writing it is what forced
// the decision, and the decision it forced is the concrete serialisable form of
// `verify`:
//
//   - `Verifier = (ctx) => Promise<Measurement>` is UNAUTHORABLE over a JSON tool
//     argument, not merely undigestible. §11.5 conceded the digest and stopped a
//     step short. The counter-example is not hypothetical and not a stand-in: the
//     hard-task corpus's own `HardTask.verify` is a real shipped closure, and it
//     fails the JSON boundary below at runtime.
//   - §3.4's one real guard — "a fabricated script cannot resolve, so the run
//     faults before it can publish" — is incoherent for a closure, which has no
//     name to fail to resolve. The closure arm is not merely unpublishable, it is
//     unguarded.
//   - So the only inhabitable arm on this surface is `VerifierSpec = {kind, spec}`
//     with `kind` CLOSED over a registry's declared set, and `spec` carrying every
//     field the digest is defined over rather than a pointer at them. Agreed with
//     the spec's author (`ObjectiveSpec`) rather than decided here.
//
// WHAT CHANGED, AND WHY THE FIXTURE IS STILL THE SAME FIXTURE. It was written
// against a tree where none of this existed: thirteen of its assertions pinned an
// ABSENCE, on purpose, so that landing the real thing would turn them red and force
// them to be rewired instead of quietly passing over a stub. That has now happened.
// Every one of those assertions is FLIPPED rather than deleted — the original claim
// is kept in the comment, because a pin whose history is erased cannot be checked
// against what it was protecting.
//
// The numbers are READ FROM THE CORPUS, never retyped. §2.4(a) claims its figures
// are `hard-majority-vote`'s; sourcing them from `HARD_TASKS` makes that claim a
// test rather than a footnote, so retargeting the task turns this red instead of
// leaving a normative document quoting a number nothing measures.
import { describe, test, expect } from 'bun:test';
import { HARD_TASKS, type HardTask } from '@proteus/test-utils';
import * as v from 'valibot';
import * as objectiveModule from '../src/strategy/objective';
import * as swarmModule from '../src/strategy/swarm';
import {
  floorMargin, type Floor, type ScalarObjective, type VerifierSpec,
} from '../src/strategy/objective';
import {
  SWARM_PRESETS, SWARM_PRESET_POINTS, isPresetPoint, resolveSwarm, settleOf, swarmValidity,
  type SwarmAdvance, type SwarmConfig, type SwarmInput,
} from '../src/strategy/swarm';
import { VERIFIER_KINDS, resolveVerifier, unregisteredKindRefusal } from '../src/strategy/verifier-registry';
import { AGENTS_TOOL_ACTIONS } from '../src/tools/registry';
import { parseAgentsToolInput } from '../src/tools/agents-tool';
import { JsonObjectSchema } from '../src/utils/json';

/** The corpus task §2.4(a) is written over. Its absence is a broken instrument
 *  rather than a skipped case — every number in the example comes from here, so
 *  a missing task means the spec quotes figures nothing measures. */
function majorityVote(): HardTask {
  const found = HARD_TASKS.find((task) => task.id === 'hard-majority-vote');
  if (!found) {
    throw new Error(
      'hard-majority-vote is absent from HARD_TASKS, so EXPLORATION-SPEC §2.4(a) '
      + 'quotes numbers no shipped task measures',
    );
  }
  return found;
}

const TASK = majorityVote();
const PROBLEM = TASK.problem;

/**
 * `verify` for §2.4(a), in the only form that crosses a JSON tool argument.
 *
 * `kind` names the instrument the spec names in prose — the metered-oracle harness —
 * and `spec` is `RatioProblem` in FULL rather than a pointer at a corpus entry. Full
 * because §5.1 makes the digest the comparability key exactly on the grounds that "a
 * name is a claim the caller can get wrong": a `spec` naming `hard-majority-vote`
 * would digest a label whose contents can change underneath it, which is the
 * silent-recomparison failure the digest exists to prevent. `RatioProblem` costs
 * nothing to send this way — it is already fully data, every field
 * JSON-serialisable, not one closure.
 *
 * `spec`'s fields stay camelCase while the objective around it is snake_case, and
 * that is the contract rather than an inconsistency: `spec` is OPAQUE to the wire
 * convention, because the convention governs the fields this specification declares
 * and not the interior of a payload the registered kind owns. Asserted below.
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

/**
 * §2.4(a)'s floor as it crosses the WIRE, with both numbers read off the corpus.
 *
 * `best_known_honest` rather than `bestKnownHonest`: §2.2 makes the objective's wire
 * form snake_case, and this is the one multiword field entry zero contains — the
 * naming collision the fixture originally recorded as an open question (G13), now
 * decided and mapped at the boundary. The parse below is what proves the mapping.
 *
 * `best_known_honest` and `target` are the same number here and that is not a
 * duplicated literal: `targetOps` is documented as the MEASURED cost of the best
 * algorithm this corpus ships (1488 + 1504 = 2992 across the instance pair), so a
 * target at the best known honest cost is what makes a score of 1.0 mean "matched
 * the best algorithm we know" rather than "beat an arbitrary bar".
 */
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

/**
 * Entry zero, complete, as a call to the shipped tool.
 *
 * FLIPPED (was: `type SwarmCall = { readonly action: 'swarm' } & SwarmInput`, this
 * fixture's own statement of a shape nothing upstream declared, because
 * `AGENTS_TOOL_ACTIONS` carried no `swarm` and `SwarmInput` carried no `action`).
 * The action exists, so the call is typed against the real input and every
 * assertion below runs through the real parser.
 */
const CALL = {
  action: 'swarm',
  preset: 'optimise',
  task: 'Beat reference.mjs on oracle calls. Same answers, fewer comparisons.',
  // Deliberately NOT typed as `AgentsToolInput`: this is what the model SENDS, in the
  // wire form, and the parse below is the assertion that it maps onto the camelCase
  // types the search is written over. Annotating it as the parsed type would have
  // tested nothing about the boundary it exists to cross.
  objective: WIRE_OBJECTIVE,
};

/** Entry zero after the boundary: the camelCase objective the search is written
 *  over. Derived from the parse rather than hand-written beside it, so the two
 *  spellings cannot drift into disagreeing about the same field. */
const PARSED = parseAgentsToolInput(CALL);
const OBJECTIVE = v.parse(
  v.custom<ScalarObjective>((input) => v.is(v.object({ kind: v.literal('scalar') }), input)),
  PARSED.objective,
);
const FLOOR: Floor = v.parse(
  v.custom<Floor>((input) => v.is(v.object({ bestKnownHonest: v.number() }), input)),
  OBJECTIVE.floor,
);

/**
 * §6.3's `optimise` row, RESOLVED rather than hand-built.
 *
 * FLIPPED (was: a hand-built `SwarmConfig` the fixture called "the fixture's reading
 * of that prose and not a resolution", usable only for `settleOf` because §6.5 says
 * validity is checked over the RESOLVED configuration and nothing resolved a named
 * preset). `resolve(preset) → SwarmConfig` exists, so this reads the row instead of
 * guessing it, and every assertion that used to be scoped to `settleOf` now runs
 * against the real thing.
 */
const OPTIMISE = SWARM_PRESET_POINTS.optimise;
const VERIFIER_TREE: SwarmConfig = OPTIMISE.config;

/** The tree selectors §6.6 property 6 is exercised over. */
const TREE_ADVANCES: readonly SwarmAdvance[] = ['uct', 'beam', 'best-first'];

describe('§2.4(a) crosses a JSON tool boundary, or it is not a call', () => {
  test('every field of the call is JSON', () => {
    expect(v.is(JsonObjectSchema, CALL)).toBe(true);
    expect(JSON.parse(JSON.stringify(CALL))).toEqual(CALL);
  });

  test('the closure arm of VerifierSource could not have been sent', () => {
    // The corpus's own shipped verifier, not a stand-in for one.
    expect(v.is(JsonObjectSchema, { ...WIRE_OBJECTIVE, verify: TASK.verify })).toBe(false);
    // FLIPPED, and this is the half that could not be written before: the live
    // parser refuses it too, so the arm is unauthorable at the surface rather than
    // merely at the JSON schema this fixture used to check on its own.
    expect(() => parseAgentsToolInput({
      ...CALL, objective: { ...WIRE_OBJECTIVE, verify: TASK.verify },
    })).toThrow();
  });

  test('verify is a VerifierSpec whose kind is closed and whose spec is whole', () => {
    // FLIPPED (was: a picklist and a spec schema this fixture DECLARED ITSELF,
    // because `objective.ts` said "a registered verifier kind" and named no
    // registry, no membership rule and no refusal for an unregistered one). The
    // registry is the membership rule now, so these assert resolution rather than a
    // local reading of the prose.
    expect(VERIFIER_KINDS).toContain('exec-ratio');
    const resolved = resolveVerifier(VERIFY);
    expect('reason' in resolved).toBe(false);
    if ('reason' in resolved) return;
    // §3.4's guard, made real: the kind resolved to an INSTRUMENT — one that says
    // where a candidate is written and which quantity is the run's own measured
    // baseline — rather than to a name the caller asked to be trusted.
    expect(resolved.artifact).toBe('solution.mjs');
    expect(resolved.baselineKey).toBe('refOps');
    // G6: identity captures WHICH implementation the kind resolved to, which
    // `argumentDigest({kind, spec})` cannot see on its own.
    expect(resolved.implementation).toStartWith('exec-ratio@');
    // A kind nobody registered is the fabrication the closed picklist refuses, and
    // the refusal is the one agreed with the spec's author — it deliberately does
    // NOT offer "or pass a closure", an arm unreachable from this surface.
    const fabricated = resolveVerifier({ kind: 'simulate_conversion', spec: VERIFY.spec });
    expect(fabricated).toMatchObject({ reason: 'bad_input' });
    expect('error' in fabricated ? fabricated.error : '').toContain(unregisteredKindRefusal());
    expect('error' in fabricated ? fabricated.error : '').not.toContain('closure');
    // A spec missing the floor's input leaves §4.5 C1 and C2 with no numbers, and
    // the refusal NAMES the field rather than reporting a shape mismatch.
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
    // G13, decided. The objective's own multiword field crosses as snake_case and
    // arrives camelCase; the verifier's `spec` crosses UNCHANGED, because a
    // transform reaching inside it would make `verifierDigest` depend on which side
    // of that transform it was computed on — §5.1's failure mode through a naming
    // convention.
    expect(Object.keys(WIRE_FLOOR)).toContain('best_known_honest');
    expect(FLOOR.bestKnownHonest).toBe(PROBLEM.targetOps);
    expect(OBJECTIVE.verify).toEqual(VERIFY);
    expect(Object.keys(v.parse(JsonObjectSchema, VERIFY.spec))).toEqual([
      'params', 'reference', 'body', 'targetOps', 'lowerBoundOps',
    ]);
    // And the collision itself is refused rather than dropped, which is the whole
    // reason the spelling had to be decided: camelCase for a snake_case field is the
    // measured model error on this surface.
    expect(() => parseAgentsToolInput({
      ...CALL,
      objective: { ...WIRE_OBJECTIVE, floor: { ...WIRE_FLOOR, bestKnownHonest: 2992 } },
    })).toThrow();
  });
});

describe('entry zero is the spec\'s example, and its numbers are the corpus\'s', () => {
  test('§2.4(a) verbatim', () => {
    expect(OBJECTIVE.metric).toBe('oracle_calls');
    expect(OBJECTIVE.unit).toBe('oracle calls');
    expect(OBJECTIVE.direction).toBe('minimise');
    expect(OBJECTIVE.scale).toBe('log');
    expect(OBJECTIVE.target).toBe(2992);
    expect(FLOOR.kind).toBe('certificate');
    expect(FLOOR.value).toBe(1200);
    expect(FLOOR.bestKnownHonest).toBe(2992);
  });

  // The other end of the same drift: the assertions above pin the document, these
  // pin the instrument. Retarget the task and this goes red while the spec keeps
  // quoting 2992, which is the failure sourcing them from HARD_TASKS prevents.
  test('and those numbers are hard-majority-vote\'s', () => {
    expect(PROBLEM.targetOps).toBe(2992);
    expect(PROBLEM.lowerBoundOps).toBe(1200);
    expect(PROBLEM.params.n).toBe(1200);
  });
});

describe('validity over entry zero, as far as the document defines it', () => {
  test('§2.5: optimise requires objective and prohibits key, config, from, label', () => {
    const entry = swarmCall();
    expect(SWARM_PRESETS).toContain(entry.preset);
    expect(PARSED.objective).toBeDefined();
    // Asserted on the PARSE rather than on the literal: what matters is that nothing
    // the call did not send arrives at the dispatcher carrying a value.
    expect(PARSED.key).toBeUndefined();
    expect(PARSED.config).toBeUndefined();
    expect(PARSED.from).toBeUndefined();
    expect(PARSED.label).toBeUndefined();
    // FLIPPED: requiredness is now CHECKED rather than restated, and each prohibition
    // fires with its own reason — so the assertion is about the boundary's behaviour
    // rather than about this fixture's reading of a table.
    //
    // `from` and `label` are refused on the CALL, because a named preset accepting
    // either would make it refusable and a refusable preset is not a tested path.
    // `key` is refused on the RESOLVED configuration, because "an archive needs a
    // key, and nothing else may take one" is one rule about `advance` rather than
    // four about preset names — which is what gives `custom` the same verdict for
    // the same reason.
    expect(resolveSwarm({ ...entry, from: 'ideate' })).toMatchObject({ reason: 'bad_input' });
    expect(resolveSwarm({ ...entry, label: 'x' })).toMatchObject({ reason: 'bad_input' });
    const keyed = resolveSwarm({ ...entry, key: 'coverage' });
    if ('reason' in keyed) throw new Error('a named preset must resolve, and this one refused');
    expect(swarmValidity(keyed)).toMatchObject({ reason: 'bad_input' });
    // And the one field it REQUIRES, missing.
    expect(resolveSwarm({ preset: 'optimise', task: entry.task }))
      .toMatchObject({ reason: 'bad_input' });
  });

  test('§6.5: entry zero is LEGAL over its resolved configuration', () => {
    // FLIPPED (was: nothing to assert — §6.5 is stated over the resolved
    // configuration and no resolution existed, so the fixture could only check the
    // requiredness table above). This is the assertion the whole gap list was about.
    const resolved = resolveSwarm(swarmCall());
    expect('reason' in resolved).toBe(false);
    if ('reason' in resolved) return;
    expect(resolved.config).toEqual(VERIFIER_TREE);
    expect(resolved.settle).toBe('best');
    expect(swarmValidity(resolved)).toBeNull();
  });

  test('§4.5 C1: the floor leaves room, and the margin is computed not asserted', () => {
    expect(floorMargin(FLOOR, OBJECTIVE.direction)).toBeCloseTo(0.599, 3);
  });

  test('§2.3: the measured baseline leaves the target a range to score on', () => {
    // The seeded reference counts every token against every other, so the
    // baseline is quadratic per instance and quadratic again over the pair. A
    // target at or beyond the measured baseline refuses the run.
    expect(OBJECTIVE.target).toBeLessThan(PROBLEM.params.n * PROBLEM.params.n);
  });

  test('the caps entry zero does not state are RESOLVED, and say where from', () => {
    // FLIPPED (was: "absent rather than guessed" — `branches` and `depth` were
    // optional with no stated default anywhere in the document, so entry zero could
    // not say how wide or how deep it runs and inventing a number here would have
    // made the fixture the source of truth for a quantity the spec never set).
    // §6.3's tuple table states both per preset now, so the CALL still states
    // neither and the RESOLUTION states both — with the origin recorded, which is
    // what keeps an inherited default distinguishable from a chosen one.
    expect(PARSED.branches).toBeUndefined();
    expect(PARSED.depth).toBeUndefined();
    const resolved = resolveSwarm(swarmCall());
    if ('reason' in resolved) throw new Error(resolved.error);
    expect(resolved.caps.depth).toEqual({ value: 5, origin: 'preset' });
    expect(resolved.caps.branches).toEqual({ value: 3, origin: 'preset' });
    // A caller who says so owns the number, and the record can tell the two apart.
    const widened = resolveSwarm({ ...swarmCall(), branches: 8 });
    if ('reason' in widened) throw new Error(widened.error);
    expect(widened.caps.branches).toEqual({ value: 8, origin: 'call' });
  });
});

describe('what the live tool surface does with entry zero', () => {
  test('swarm IS an action, and the call parses', () => {
    // FLIPPED (was: "swarm is not an action, so the call is refused by the enum" —
    // `AGENTS_TOOL_ACTIONS` was fork/hire/ask/send/reply/list/dismiss and
    // `parseAgentsToolInput(CALL)` threw). Both halves are the opposite now, and the
    // parse is asserted field for field so the action cannot be added to the enum
    // without its fields reaching the dispatcher.
    expect(AGENTS_TOOL_ACTIONS).toContain('swarm');
    expect(PARSED.action).toBe('swarm');
    expect(PARSED.preset).toBe('optimise');
    expect(PARSED.task).toBe(CALL.task);
    expect(PARSED.objective).toBeDefined();
  });

  test('a field is refused for the action that does not read it, and the refusal names the one that does', () => {
    // FLIPPED TWICE, and the history is the point. First it pinned the silent drop:
    // `AgentsToolInputSchema` was one flat `v.object`, valibot's `object` EXCLUDES
    // unknown entries rather than rejecting them, so `preset`, `objective`,
    // `branches` and `depth` reached the dispatcher as ABSENT — indistinguishable
    // from a caller who never sent them. Then `v.strictObject` made them "unknown
    // field" refusals. Now they are REAL fields of a REAL action, so the same call
    // is refused for the sharper reason: they belong to `swarm`, and `fork` would
    // ignore them. Still through an action that IS on the picklist, so it remains a
    // property of the schema rather than of a missing action.
    const smuggle = () => parseAgentsToolInput({
      action: 'fork',
      task: CALL.task,
      preset: CALL.preset,
      objective: CALL.objective,
      branches: 8,
      depth: 4,
    });
    expect(smuggle).toThrow(/field "preset" does not apply to action "fork"/);
    expect(smuggle).toThrow(/it is read by swarm/);
    // Every one of them, not just the first: a refusal that named one field at a
    // time would cost a round trip per field of the call entry zero writes.
    for (const field of ['objective', 'branches', 'depth']) {
      expect(smuggle).toThrow(new RegExp(`field "${field}" does not apply to action "fork"`));
    }
    // And the correction: what `fork` does take, so a caller can fix the call
    // from the message alone rather than guessing again. `settle` is absent
    // because tree search is `action:'swarm'` with a `depth` — a fork has one
    // settlement and nothing to choose between.
    expect(smuggle).toThrow(/action "fork" takes: task, forks, merge_strategy/);
  });

  test('and the money case is refused by the spelling it got wrong', () => {
    // FLIPPED (was: "the same silence already costs money on a shipping
    // action"). The caps DO exist on this schema — as `budget_usd` and
    // `wall_clock_ms` — and a model spelling either in camelCase used to ask for
    // a $5 ceiling and get none, with no error and no field recording that its
    // request vanished. Reproduced by `Main` against the shipped parser, and by
    // `StrictAgentsInput` before the change. It composes with the naming
    // collision entry zero also carries (`floor.best_known_honest` beside
    // `merge_strategy`): camelCase-for-snake_case is the EXPECTED model error on
    // this surface, not an exotic one — which is why the refusal has to name the
    // snake_case spelling and not merely reject the key.
    const camelCase = () => parseAgentsToolInput({
      action: 'fork', task: CALL.task, budgetUsd: 5, wallClockMs: 1_000,
    });
    expect(camelCase).toThrow(/unknown field "budgetUsd" — did you mean "budget_usd"\?/);
    expect(camelCase).toThrow(/unknown field "wallClockMs" — did you mean "wall_clock_ms"\?/);

    // Both spellings of the same request: one is heard, and the other is now
    // TOLD, where before it was dropped and the two were indistinguishable.
    expect(parseAgentsToolInput({
      action: 'fork', task: CALL.task, budget_usd: 5,
    })).toEqual({ action: 'fork', task: CALL.task, budget_usd: 5 });
  });
});

describe('the implementation, asserted where absences used to be pinned', () => {
  test('the strategy modules export the resolution, the predicate and the result half', () => {
    // FLIPPED (was: "nothing resolves a named preset, so §6.5 validity has no
    // input" — this test pinned the VALUE EXPORT SETS of both strategy modules so
    // that landing a preset table, a validity predicate, a verifier-kind registry or
    // a call parser would turn it red and force the fixture onto the real thing
    // instead of its own reading of the prose. All four landed; this is the rewiring
    // that pin existed to demand.)
    //
    // Still a SET assertion rather than a containment check, and for the same
    // reason: an export added without a thought is the pass-by-omission this file is
    // about, so growth stays a decision.
    expect(Object.keys(objectiveModule).sort()).toEqual([
      'PUBLICATION_SURFACES', 'PUBLISHING_CARRIES', 'admitsPublication',
      'carrySuppression', 'floorMargin', 'isBetter', 'normalisedScore',
    ]);
    // GROWN BY THREE, deliberately: §8.2's arbiter landed. `arbitrateBranch` is the
    // executable port of `Exploration/Arbitration.lean`'s `arbitrate`, and the two
    // constants are the bounds its theorems quantify over — `BRANCH_PROPOSAL_WIDTH` is
    // the 2-4 band `accepted_width_in_range` proves, `BRANCH_REFUSAL_POLICIES` the five
    // reasons `every_refusal_is_reachable` proves none of is unreachable. Named here
    // because that is what this pin is for: the decision is recorded rather than
    // absorbed.
    expect(Object.keys(swarmModule).sort()).toEqual([
      'BRANCH_PROPOSAL_WIDTH', 'BRANCH_REFUSAL_POLICIES',
      'JUDGE_MARGINALISATION_MIN', 'NAMED_SWARM_PRESETS', 'SWARM_ADVANCES', 'SWARM_CARRIES',
      'SWARM_DECORRELATES', 'SWARM_EXPANDS', 'SWARM_OBSERVES', 'SWARM_PRESETS',
      'SWARM_PRESET_POINTS', 'SWARM_SCORES', 'SWARM_TREE_ADVANCES', 'SWARM_UNITS',
      'arbitrateBranch', 'isPresetPoint', 'isTreeAdvance', 'resolveSwarm', 'settleOf',
      'swarmValidity',
    ]);
  });

  test('a composition missing axes is refused naming every one of them', () => {
    // The behavioural half of the resolver's axis list: a `custom` call with nothing in
    // `config` must come back naming all seven, so an axis added to `SwarmConfig` and
    // forgotten in the resolver's list fails HERE instead of letting an incomplete
    // tuple through as if it were resolved.
    const refusal = resolveSwarm({ preset: 'custom', task: 'x', label: 'l', config: {} });
    expect(refusal).toMatchObject({ reason: 'bad_input' });
    const error = 'error' in refusal ? refusal.error : '';
    for (const axis of ['unit', 'observe', 'expand', 'decorrelate', 'score', 'advance', 'carry']) {
      expect(error).toContain(axis);
    }
  });

  test('§6.6 property 6: settleOf answers for entry zero under every tree advance', () => {
    for (const advance of TREE_ADVANCES) {
      expect(settleOf({ ...VERIFIER_TREE, advance })).toBe('best');
    }
  });

  test('§6.3: a row the document does not state is REFUSED, never resolved to a guess', () => {
    // The gap this fixture found while flipping: §6.3 gives `research` and `audit`
    // `carry:'artifacts'`, whose admission threshold the table never states, so
    // neither row can be constructed as printed. It is declared undeclared and the
    // resolver refuses it naming the missing parameter — which is the same rule this
    // file already applied to `branches` and `depth`: a number the specification
    // never set is not the implementation's to invent.
    for (const preset of ['research', 'audit'] as const) {
      const row = SWARM_PRESET_POINTS[preset];
      expect(isPresetPoint(row)).toBe(false);
      const refusal = resolveSwarm({ preset, task: 'x', key: 'k' });
      expect(refusal).toMatchObject({ reason: 'bad_input' });
      expect('error' in refusal ? refusal.error : '').toContain('carry:\'artifacts\'');
    }
    // And the three rows §6.3 does state resolve, so the refusal above is about the
    // document rather than about the resolver.
    for (const preset of ['ideate', 'redteam', 'optimise'] as const) {
      expect(isPresetPoint(SWARM_PRESET_POINTS[preset])).toBe(true);
    }
  });
});

/** Entry zero as a `SwarmInput`, i.e. the call minus its action discriminant. Built
 *  per use rather than shared, so a test that overrides a field cannot leak the
 *  override into the next one. */
function swarmCall(): SwarmInput {
  return { preset: 'optimise', task: CALL.task ?? '', objective: OBJECTIVE };
}
