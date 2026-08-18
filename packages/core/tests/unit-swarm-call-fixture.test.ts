// Entry zero of the exploration fixture suite: ONE complete `agents.swarm` call
// for docs/EXPLORATION-SPEC.md §2.4(a), executable, so the spec's own worked
// example and the surface that would have to carry it cannot drift apart.
//
// The class, not the instance. An audit of that spec found the tool boundary had
// no owner end to end — one review found `objective.verify` declared as a closure
// while `agents.swarm` is a valibot-validated JSON action, a second found the
// action has no result type, a third found every empirical receipt measured a
// different surface, and none of them wrote the call. Writing it is what forces
// the decision, and the decision it forces is the concrete serialisable form of
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
// The numbers are READ FROM THE CORPUS, never retyped. §2.4(a) claims its figures
// are `hard-majority-vote`'s; sourcing them from `HARD_TASKS` makes that claim a
// test rather than a footnote, so retargeting the task turns this red instead of
// leaving a normative document quoting a number nothing measures any more.
import { describe, test, expect } from 'bun:test';
import { HARD_TASKS, type HardTask } from '@proteus/test-utils';
import * as v from 'valibot';
import * as objectiveModule from '../src/strategy/objective';
import * as swarmModule from '../src/strategy/swarm';
import {
  floorMargin, type Floor, type ScalarObjective, type VerifierSpec,
} from '../src/strategy/objective';
import {
  SWARM_PRESETS, settleOf, type SwarmAdvance, type SwarmConfig, type SwarmInput,
} from '../src/strategy/swarm';
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
 * The registered verifier kinds entry zero needs.
 *
 * A PICKLIST rather than a string, which is the reading agreed with the spec's
 * author. `objective.ts` says "a registered verifier kind" and names no registry,
 * no membership rule and no refusal for an unregistered one — and under the open
 * reading `kind` is a free string, which is gemini-3-flash's invented
 * `scripts/simulate_conversion.py` one level up: a name nobody registered, waved
 * through by the type system, making §3.4's guard advisory again by §3.8's own
 * argument that a rule firing on a MISSING field cannot fire on a fabricated one.
 */
const VERIFIER_KINDS = ['exec-ratio'] as const;

/**
 * What `kind:'exec-ratio'` requires of its `spec`.
 *
 * `VerifierSpec.spec` is typed `JsonValue`, so the boundary validates that the
 * instrument is JSON and nothing about the instrument. A closed `kind` implies a
 * per-kind spec schema; this is entry zero's, and its absence upstream is a gap.
 */
const VerifierSpecSchema = v.object({
  kind: v.picklist(VERIFIER_KINDS),
  spec: v.object({
    params: v.record(v.string(), v.number()),
    reference: v.string(),
    body: v.string(),
    targetOps: v.number(),
    lowerBoundOps: v.number(),
  }),
});

/**
 * `verify` for §2.4(a), in the only form that crosses a JSON tool argument.
 *
 * `kind` names the instrument the spec names in prose — `runRatioMeasurement` +
 * `scoreRatio` — and `spec` is `RatioProblem` in FULL rather than a pointer at a
 * corpus entry. Full because §5.1 makes the digest the comparability key exactly
 * on the grounds that "a name is a claim the caller can get wrong": a `spec`
 * naming `hard-majority-vote` would digest a label whose contents can change
 * underneath it, which is the silent-recomparison failure the digest exists to
 * prevent. `RatioProblem` costs nothing to send this way — it is already fully
 * data, every field JSON-serialisable, not one closure.
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
 * §2.4(a)'s floor, with both numbers read off the corpus.
 *
 * `bestKnownHonest` and `target` are the same number here and that is not a
 * duplicated literal: `targetOps` is documented as the MEASURED cost of the best
 * algorithm this corpus ships (1488 + 1504 = 2992 across the instance pair), so a
 * target at the best known honest cost is what makes a score of 1.0 mean "matched
 * the best algorithm we know" rather than "beat an arbitrary bar".
 */
const FLOOR: Floor = {
  value: PROBLEM.lowerBoundOps,
  kind: 'certificate',
  bestKnownHonest: PROBLEM.targetOps,
  proof: 'Per instance every token must appear in at least one call; a call '
    + 'touches TWO tokens, so covering n needs ceil(n/2), i.e. n for the pair.',
};

const OBJECTIVE: ScalarObjective = {
  kind: 'scalar',
  metric: 'oracle_calls',
  unit: 'oracle calls',
  direction: 'minimise',
  scale: 'log',
  target: PROBLEM.targetOps,
  verify: VERIFY,
  floor: FLOOR,
};

/**
 * The call type, which does not exist in the tree.
 *
 * `SwarmInput` carries no `action` and `AGENTS_TOOL_ACTIONS` carries no `swarm`,
 * so nothing upstream states the shape a model would send. This intersection is
 * this fixture's own statement of it.
 */
type SwarmCall = { readonly action: 'swarm' } & SwarmInput;

/** Entry zero, complete. */
const CALL: SwarmCall = {
  action: 'swarm',
  preset: 'optimise',
  task: 'Beat reference.mjs on oracle calls. Same answers, fewer comparisons.',
  objective: OBJECTIVE,
};

/**
 * The tree shape §2.4(a) runs under, hand-built because nothing derives it.
 *
 * §6.5 says validity is checked over the RESOLVED configuration and §6.3
 * describes `optimise` as "verifier + tree" in prose. No preset-to-`SwarmConfig`
 * table exists, so this is the fixture's reading of that prose and not a
 * resolution — which is why the assertions below use it only for `settleOf`,
 * whose answer is the same for every tree `advance` under `score:'verify'`.
 * This is now §6.3's declared `optimise` row rather than a hand-built config: the
 * tuple table is normatively `resolve(preset) -> SwarmConfig`, and `judgeSamples` is
 * no longer a required field to invent — it lives on `score:'judge'`, which
 * `optimise` does not use, so the row is constructible exactly as declared.
 */
const TREE_ADVANCES: readonly SwarmAdvance[] = ['uct', 'beam', 'best-first'];

/** §6.3's `optimise` point, verbatim. */
const VERIFIER_TREE: SwarmConfig = {
  unit: 'answer',
  observe: 'ancestors',
  expand: 'mutate',
  decorrelate: 'angles',
  score: { kind: 'verify' },
  advance: 'uct',
  carry: { kind: 'elites' },
};

describe('§2.4(a) crosses a JSON tool boundary, or it is not a call', () => {
  test('every field of the call is JSON', () => {
    expect(v.is(JsonObjectSchema, CALL)).toBe(true);
    expect(JSON.parse(JSON.stringify(CALL))).toEqual(CALL);
  });

  test('the closure arm of VerifierSource could not have been sent', () => {
    // The corpus's own shipped verifier, not a stand-in for one.
    expect(v.is(JsonObjectSchema, { ...OBJECTIVE, verify: TASK.verify })).toBe(false);
  });

  test('verify is a VerifierSpec whose kind is closed and whose spec is whole', () => {
    expect(v.is(VerifierSpecSchema, OBJECTIVE.verify)).toBe(true);
    // A kind nobody registered is the fabrication the closed picklist refuses.
    expect(v.is(VerifierSpecSchema, {
      kind: 'simulate_conversion', spec: VERIFY.spec,
    })).toBe(false);
    // A spec missing the floor's input leaves §4.5 C1 and C2 with no numbers.
    expect(v.is(VerifierSpecSchema, {
      kind: 'exec-ratio',
      spec: {
        params: { ...PROBLEM.params }, reference: PROBLEM.reference,
        body: PROBLEM.body, targetOps: PROBLEM.targetOps,
      },
    })).toBe(false);
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
    expect(SWARM_PRESETS).toContain(CALL.preset);
    expect(CALL.objective).toBeDefined();
    expect(CALL.key).toBeUndefined();
    expect(CALL.config).toBeUndefined();
    expect(CALL.from).toBeUndefined();
    expect(CALL.label).toBeUndefined();
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

  test('the caps entry zero cannot fill are absent rather than guessed', () => {
    // Not an omission. `branches` and `depth` are optional and no default for
    // either is stated anywhere in the document, so entry zero cannot say how
    // wide or how deep it runs, and inventing a number here would make the
    // fixture the source of truth for a quantity the spec never set.
    expect(CALL.branches).toBeUndefined();
    expect(CALL.depth).toBeUndefined();
  });
});

describe('what the live tool surface does with entry zero', () => {
  test('swarm is not an action, so the call is refused by the enum', () => {
    expect(AGENTS_TOOL_ACTIONS).not.toContain('swarm');
    expect(() => parseAgentsToolInput(CALL)).toThrow();
  });

  test('adding the action without its fields drops every one of them silently', () => {
    // `AgentsToolInputSchema` is one flat `v.object`, and valibot's `object`
    // EXCLUDES unknown entries rather than rejecting them. So `swarm` on the
    // picklist and nothing else means `preset`, `objective`, `branches` and
    // `depth` reach the dispatcher as ABSENT — indistinguishable from a caller
    // who never sent them, which is the one distinction this spec exists to
    // keep. Demonstrated through an action that is on the picklist today, so it
    // is a property of the schema rather than of the missing action.
    const smuggled = parseAgentsToolInput({
      action: 'fork',
      task: CALL.task,
      preset: CALL.preset,
      objective: CALL.objective,
      branches: 8,
      depth: 4,
    });
    expect(smuggled).toEqual({ action: 'fork', task: CALL.task });
  });

  test('and the same silence already costs money on a shipping action', () => {
    // Not latent. The caps DO exist on this schema — as `budget_usd` and
    // `wall_clock_ms` — so a model spelling either in camelCase asks for a $5
    // ceiling and gets none, with no error and no field recording that its
    // request vanished. Independently reproduced by `Main` against the shipped
    // parser. It composes with the naming collision entry zero also carries
    // (`floor.bestKnownHonest` beside `merge_strategy`): camelCase-for-snake_case
    // is the EXPECTED model error on this surface, not an exotic one.
    const dropped = parseAgentsToolInput({
      action: 'fork', task: CALL.task, budgetUsd: 5, wallClockMs: 1_000,
    });
    expect(dropped).toEqual({ action: 'fork', task: CALL.task });

    // Both spellings of the same request, and only one of them is heard.
    expect(parseAgentsToolInput({
      action: 'fork', task: CALL.task, budget_usd: 5,
    })).toEqual({ action: 'fork', task: CALL.task, budget_usd: 5 });
  });
});

// SUCCESSOR ASSERTION, stated so the cutover is legible rather than a surprise.
// `Main` is landing a strict input parser that refuses unknown keys with a message
// naming the right spelling, plus a gate asserting the action picklist and the
// declared field set agree. Both tests above then go red BY DESIGN, and their
// replacement is the refusal: `parseAgentsToolInput` must throw on `budgetUsd`
// and name `budget_usd`, and throw on a swarm field until the action declares it.
// A test that passed both before and after would be asserting nothing.

describe('pending the implementation, pinned so the fixture cannot be bypassed', () => {
  test('nothing resolves a named preset, so §6.5 validity has no input', () => {
    // The value exports of both strategy modules, pinned. A preset-to-config
    // table, a validity predicate, a verifier-kind registry and a call parser
    // are each a value export, so landing any of them turns this red — which is
    // the point: entry zero must then be rewired to the real thing instead of
    // continuing to assert its own reading of the prose.
    //
    // The four publication-seal exports are LISTED rather than excluded: they landed
    // with §4.4's enumeration and are none of the four things this pin watches for, so
    // naming them keeps the pin sensitive to what it is actually for. Adding them
    // without a thought would have been the pass-by-omission the seal finding is about.
    expect(Object.keys(objectiveModule).sort()).toEqual([
      'PUBLICATION_SURFACES', 'PUBLISHING_CARRIES', 'admitsPublication',
      'carrySuppression', 'floorMargin', 'isBetter',
    ]);
    expect(Object.keys(swarmModule).sort()).toEqual([
      'SWARM_ADVANCES', 'SWARM_CARRIES', 'SWARM_DECORRELATES', 'SWARM_EXPANDS',
      'SWARM_OBSERVES', 'SWARM_PRESETS', 'SWARM_SCORES', 'SWARM_UNITS', 'settleOf',
    ]);
  });

  test('§6.6 property 6: settleOf answers for entry zero under every tree advance', () => {
    for (const advance of TREE_ADVANCES) {
      expect(settleOf({ ...VERIFIER_TREE, advance })).toBe('best');
    }
  });
});
