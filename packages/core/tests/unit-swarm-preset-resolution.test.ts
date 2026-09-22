/**
 * Every preset resolves to a tuple the validity table accepts, and a judged tree is funded
 * at the ensemble it was admitted at.
 * Specified by docs/EXPLORATION.md — "Presets", "Validity over the resolved
 * configuration" and "The judge ensemble".
 */
import { describe, expect, test } from 'bun:test';
import {
  JUDGE_MARGINALISATION_MIN, NAMED_SWARM_PRESETS, SWARM_PRESET_POINTS,
  UNMEASURED_JUDGE_SAMPLES, judgeCallPool,
  resolveSwarm, swarmValidity,
  type ResolvedSwarm, type SwarmInput,
} from '../src/strategy/swarm';
import { judgeCallBudget } from '../src/mcts/evaluation';
import { DEFAULT_CONFIG } from '../src/config';
import { resolveVerifier } from '../src/strategy/verifier-registry';
import { VERIFIER_KIND_DOC, VERIFIER_KINDS } from '../src/strategy/objective';
import type { ScalarObjective } from '../src/strategy/objective';
import type { JsonObject } from '../src/utils/json';

/** Its `spec` is whole: `swarmValidity` checks every field the kind needs at call time. */
const EXEC_RATIO_SPEC: JsonObject = {
  params: { n: 8 },
  // The harness calls the reference by this exact name (`REFERENCE_SOLVE_DECLARATION`).
  reference: 'export function solve(input, oracle) { return oracle(input); }',
  body: 'export function solve(input, oracle) { return oracle(input); }',
  targetOps: 8,
  lowerBoundOps: 4,
};

const MEASURED: ScalarObjective = {
  kind: 'scalar', metric: 'oracle calls', unit: 'count', direction: 'minimise',
  scale: 'linear', target: 23,
  verify: { kind: 'exec-ratio', spec: EXEC_RATIO_SPEC },
};

function callFor(preset: (typeof NAMED_SWARM_PRESETS)[number]): SwarmInput {
  if (preset === 'ideate') return { preset, task: 'three ways to cache this' };

  if (preset === 'research' || preset === 'audit' || preset === 'redteam') {
    return { preset, task: 'cover the failure modes', key: 'behaviour', objective: MEASURED };
  }

  return { preset, task: 'beat the baseline', objective: MEASURED };
}

/** Throws the refusal's own text so a failure names the axis. */
function legal(input: SwarmInput): ResolvedSwarm {
  const resolved = resolveSwarm(input);

  if ('reason' in resolved) throw new Error(`resolve refused: ${resolved.error}`);
  const invalid = swarmValidity(resolved);

  if (invalid) throw new Error(`validity refused: ${invalid.error}`);

  return resolved;
}

/** `nodes`: the caller assigns each level-1 node its own task instead of N takes on one. */
describe('the caller can assign the first level node by node', () => {
  const ASSIGNED = [
    { task: 'measure the cold-start path', prompt: 'profile it first, then cut the biggest term' },
    { task: 'measure the cache-hit path', prompt: 'assume the cache is warm and find the next bound' },
    { task: 'measure the eviction path', prompt: 'start from the failure you most expect' },
  ];

  test('its length IS the branch count, and it lands on the resolved call', () => {
    const resolved = legal({ preset: 'ideate', task: 'make it faster', nodes: ASSIGNED });
    expect(resolved.caps.branches).toEqual({ value: 3, origin: 'call' });
    expect(resolved.nodes).toEqual(ASSIGNED);
    expect(SWARM_PRESET_POINTS.ideate.branches).toBe(5);
  });

  test('a count-based call resolves with no assignments at all', () => {
    // Absent means absent, never an invented list.
    expect(legal({ preset: 'ideate', task: 'make it faster', branches: 3 }).nodes).toBeNull();
  });

  test('naming both widths is refused rather than resolved by precedence', () => {
    const refusal = resolveSwarm({
      preset: 'ideate', task: 'make it faster', nodes: ASSIGNED, branches: 5,
    });

    expect('reason' in refusal).toBe(true);

    if ('reason' in refusal) {
      expect(refusal.error).toContain('branch count');
      expect(refusal.error).toContain('would be ignored');
    }
  });

  test('two nodes asked the same question are refused', () => {
    const first = ASSIGNED[0] ?? { task: '', prompt: '' };

    const refusal = resolveSwarm({
      preset: 'ideate',
      task: 'make it faster',
      nodes: [first, { task: first.task, prompt: 'a different brief entirely' }],
    });

    expect('reason' in refusal).toBe(true);

    if ('reason' in refusal) expect(refusal.error).toContain('two of yours are the same');
  });
});

describe('every named preset resolves to a tuple validity accepts', () => {
  test('all six resolve, and none of them resolves into a refusal', () => {
    // *Presets* requires a named preset to be unrefusable.
    for (const preset of NAMED_SWARM_PRESETS) {
      expect(() => legal(callFor(preset))).not.toThrow();
    }
  });

  test('the three coverage presets are archive runs at the converted Rainbow filter', () => {
    // `novelty` is a distance floor; Rainbow Teaming's τ=0.6 is a similarity ceiling, converted here.
    for (const preset of ['research', 'audit', 'redteam'] as const) {
      const resolved = legal(callFor(preset));
      expect(resolved.config.advance).toEqual({ kind: 'archive', novelty: 0.4 });
      expect(resolved.settle).toBe('archive');
      // Depth 1: an archive bins at the settle barrier, so a run has no second level to select from.
      expect(resolved.caps.depth?.value).toBe(1);
      expect(resolved.caps.branches?.value).toBe(4);
      // Verified, not judged: a cell is keyed by the objective's identity and ordered by its direction.
      expect(resolved.config.score).toEqual({ kind: 'verify' });
    }
  });

  test('research and audit publish findings; redteam keeps its corpus in the workspace', () => {
    // `carry:'artifacts'` publishes cross-workspace; an exploit corpus must not.
    for (const preset of ['research', 'audit'] as const) {
      expect(legal(callFor(preset)).config.carry).toEqual({ kind: 'artifacts', threshold: 0.8 });
    }

    expect(legal(callFor('redteam')).config.carry).toEqual({ kind: 'elites' });
  });

  test('the artifacts bar is the pass-band midpoint this repository already publishes at', () => {
    // `craftExtractionThreshold` 0.80 is the pass-band midpoint, already the bar for publishing
    // an artifact derived from a search winner.
    const carry = legal(callFor('research')).config.carry;
    expect(carry.kind === 'artifacts' ? carry.threshold : null)
      .toBe(DEFAULT_CONFIG.mcts.craftExtractionThreshold);
  });

  test('a preset row is a POINT — every row declares its config, so nothing guards one', () => {
    for (const preset of NAMED_SWARM_PRESETS) {
      expect(SWARM_PRESET_POINTS[preset].config).toBeDefined();
      expect(SWARM_PRESET_POINTS[preset].depth).toBeGreaterThan(0);
    }
  });
});

describe('custom seeded from a preset resolves on the axes the caller states', () => {
  test('`from` each named preset resolves, overriding only what differs', () => {
    // The escape hatch the refusal text recommends must work from every base.
    for (const from of NAMED_SWARM_PRESETS) {
      const resolved = legal({
        preset: 'custom', from, label: `from-${from}`,
        task: 'beat the baseline', objective: MEASURED,
        config: {
          score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'none' },
        },
        depth: 3,
      });

      expect(resolved.preset).toBe('custom');
      expect(resolved.from).toBe(from);
      expect(resolved.config.advance).toEqual({ kind: 'uct' });
      expect(resolved.config.unit).toEqual(SWARM_PRESET_POINTS[from].config.unit);
      expect(resolved.config.expand).toEqual(SWARM_PRESET_POINTS[from].config.expand);
      expect(resolved.caps.depth).toEqual({ value: 3, origin: 'call' });
      expect(resolved.caps.branches?.origin).toBe('preset');
    }
  });

  test('a composition inherits the row\'s caps where it states none', () => {
    const resolved = legal({
      preset: 'custom', from: 'redteam', label: 'from-redteam',
      task: 'cover the tactics', key: 'tactic', objective: MEASURED,
      config: { carry: { kind: 'artifacts', threshold: 0.8 } },
    });

    expect(resolved.config.advance).toEqual({ kind: 'archive', novelty: 0.4 });
    expect(resolved.caps.depth).toEqual({ value: 1, origin: 'preset' });
    expect(resolved.caps.branches).toEqual({ value: 4, origin: 'preset' });
  });
});

describe('a judged tree is funded at the ensemble it was admitted at', () => {
  test('the pool a judged run funds realises the WHOLE request', () => {
    // `maxEvalLLMCalls` is sized for the MCTS engine's ensemble; borrowed, it clamps a swarm
    // admitted at 20 to 3. The pool is sized to the floor instead.
    const budget = judgeCallBudget({
      judgeSamples: JUDGE_MARGINALISATION_MIN,
      maxLLMCalls: judgeCallPool(JUDGE_MARGINALISATION_MIN),
      offersRunnableCode: true,
    });

    expect(budget.ensemble).toBe(JUDGE_MARGINALISATION_MIN);
    expect(budget.generatesChecks).toBe(true);
  });

  test('a prose candidate is funded at the same ensemble, with the suite call unspent', () => {
    const budget = judgeCallBudget({
      judgeSamples: JUDGE_MARGINALISATION_MIN,
      maxLLMCalls: judgeCallPool(JUDGE_MARGINALISATION_MIN),
      offersRunnableCode: false,
    });

    expect(budget).toMatchObject({ ensemble: JUDGE_MARGINALISATION_MIN, generatesChecks: false });
  });

  test('the pool is the request plus the suite call, at every size', () => {
    for (const samples of [1, 3, 20, 64]) {
      expect(judgeCallPool(samples)).toBe(samples + 1);
      expect(judgeCallBudget({
        judgeSamples: samples, maxLLMCalls: judgeCallPool(samples), offersRunnableCode: true,
      }).ensemble).toBe(samples);
    }
  });

  test('the shipped MCTS dial would still clamp, which is why the swarm stopped using it', () => {
    // Counter-example: a change that reintroduces the borrowed dial fails here.
    expect(judgeCallBudget({
      judgeSamples: JUDGE_MARGINALISATION_MIN,
      maxLLMCalls: DEFAULT_CONFIG.mcts.maxEvalLLMCalls,
      offersRunnableCode: true,
    }).ensemble).toBe(3);
  });

  test('the marginalisation floor is unchanged, because the evidence for it is unchanged', () => {
    // #178: a gate is not lowered to make something pass (Koh Table 4).
    expect(JUDGE_MARGINALISATION_MIN).toBe(20);
  });
});

describe('`{preset, task}` is a complete call on every row', () => {
  // The shortest advertised call must succeed on every row. Only the call boundary
  // (resolution and validity) is under test; the engine is not run.

  test('every declared preset resolves AND validates from `preset` and `task` alone', () => {
    for (const preset of NAMED_SWARM_PRESETS) {
      const resolved = resolveSwarm({ preset, task: 'work out what to do here' });

      if ('reason' in resolved) {
        throw new Error(`${preset} refused a bare call at resolve: ${resolved.error}`);
      }

      const invalid = swarmValidity(resolved);

      if (invalid) throw new Error(`${preset} refused a bare call at validity: ${invalid.error}`);
    }
  });

  test('a bare call on a verifying row is a judged sweep that selects and publishes nothing', () => {
    // Archive, tree selection and records all read a measurement, so the fallback drops all three.
    for (const preset of NAMED_SWARM_PRESETS) {
      const row = SWARM_PRESET_POINTS[preset];

      if (row.config.score.kind !== 'verify') continue;
      const resolved = resolveSwarm({ preset, task: 'x' });

      if ('reason' in resolved) throw new Error(resolved.error);
      expect(resolved.config.score).toEqual({ kind: 'judge', samples: UNMEASURED_JUDGE_SAMPLES });
      expect(resolved.config.advance).toEqual({ kind: 'none' });
      expect(resolved.config.carry).toEqual({ kind: 'none' });
      expect(resolved.caps.depth?.value).toBe(1);
      // The fallback changes the scorer, not the row's width.
      expect(resolved.caps.branches?.value).toBe(row.branches);
      expect(resolved.config.unit).toEqual(row.config.unit);
      expect(resolved.config.context).toBe(row.config.context);
    }
  });

  test('naming an `objective` restores the row the doctrine describes', () => {
    for (const preset of NAMED_SWARM_PRESETS) {
      const row = SWARM_PRESET_POINTS[preset];

      if (row.config.score.kind !== 'verify') continue;
      const resolved = legal(callFor(preset));
      expect(resolved.config).toEqual(row.config);
      expect(resolved.caps.depth?.value).toBe(row.depth);
    }
  });

  test('`custom` is NOT given the fallback — a composed `verify` still asks for its instrument', () => {
    // Deliberate: a composed `score:{kind:'verify'}` is an explicit request for an instrument.
    const composed = resolveSwarm({
      preset: 'custom', label: 'composed-verify', task: 'x',
      config: {
        unit: { kind: 'answer' }, context: 'fresh', expand: 'sample',
        score: { kind: 'verify' }, advance: { kind: 'none' }, carry: { kind: 'none' },
      },
    });

    if ('reason' in composed) throw new Error(composed.error);
    const refusal = swarmValidity(composed);

    if (!refusal) throw new Error('a composed score:"verify" with no objective must be refused');
    expect(refusal.error).toContain('score:"verify"');
    expect(refusal.error).toContain('`config`');
  });

  test("the incident's call sequence collapses to one refusal, and it names a working call", () => {
    const task = 'reduce the oracle calls our solver spends';
    const bare = resolveSwarm({ preset: 'optimise', task });

    if ('reason' in bare) throw new Error(bare.error);
    expect(swarmValidity(bare)).toBeNull();

    // A volunteered instrument gets one refusal per mistake, each ending with a working call.
    const invented = resolveSwarm({
      preset: 'optimise', task,
      objective: { ...MEASURED, verify: { kind: 'script', spec: { path: 'measure.py' } } },
    });

    if ('reason' in invented) throw new Error(invented.error);
    const kindRefusal = swarmValidity(invented);

    if (!kindRefusal) throw new Error('an unregistered kind must be refused');
    expect(kindRefusal.error).toContain('exec-ratio');
    expect(kindRefusal.error).toContain('{action:"swarm", preset:"optimise", task:"…"}');

    // An empty spec is refused once, naming every field.
    const empty = resolveSwarm({
      preset: 'optimise', task,
      objective: { ...MEASURED, verify: { kind: 'exec-ratio', spec: {} } },
    });

    if ('reason' in empty) throw new Error(empty.error);
    const specRefusal = swarmValidity(empty);

    if (!specRefusal) throw new Error('an empty spec must be refused');

    for (const field of VERIFIER_KIND_DOC['exec-ratio'].specFields) {
      expect(specRefusal.error).toContain(field);
    }

    expect(specRefusal.error).toContain('{action:"swarm", preset:"optimise", task:"…"}');
  });

  test('the documented spec fields are exactly the fields the registry binds', () => {
    // `VERIFIER_KIND_DOC` cannot import the registry (cycle), so this holds the printed field
    // list and the enforcing schema together in both directions.
    for (const kind of VERIFIER_KINDS) {
      const fields = VERIFIER_KIND_DOC[kind].specFields;

      const full: JsonObject = Object.fromEntries(
        fields.map((field) => [field, EXEC_RATIO_SPEC[field]]),
      );

      const bound = resolveVerifier({ kind, spec: full });

      if ('reason' in bound) throw new Error(`${kind}: documented fields did not bind: ${bound.error}`);

      for (const omitted of fields) {
        const partial: JsonObject = { ...full };
        delete partial[omitted];
        const refused = resolveVerifier({ kind, spec: partial });

        if (!('reason' in refused)) {
          throw new Error(`${kind}: spec bound without "${omitted}", so the doc names a field the schema ignores`);
        }
      }
    }
  });
});
