/**
 * Every preset resolves to a tuple the validity table accepts, and a judged tree is
 * FUNDED at the ensemble it was admitted at.
 *
 * These two are one file because they are one defect seen twice. The preset table
 * declined to name three parameters and three presets stopped resolving; the judged
 * scorer declined to fund the ensemble validity had already admitted and every judged
 * tree ran at 3. Both are a declared number that the implementation did not carry
 * through, and both were disclosed rather than fixed — the preset refusal quoted the
 * missing parameter, the clamp emitted `swarm.judge_ensemble_clamped`. Honest, and
 * non-functional.
 *
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

/**
 * A measurable objective naming a REGISTERED instrument, which is what every verifying
 * preset requires and what the archive presets bin their cells by.
 *
 * ITS `spec` USED TO BE `{}`, and that passed because nothing checked a spec until the
 * instrument was bound — one round trip into a started run. `swarmValidity` now names
 * every field the kind needs at CALL time, so the fixture has to be an instrument that
 * could actually run: an empty spec described a verifier that would have faulted the
 * moment it was asked to measure anything.
 */
const EXEC_RATIO_SPEC: JsonObject = {
  params: { n: 8 },
  // The harness calls the reference by this exact name, which its own schema rule
  // enforces — see `REFERENCE_SOLVE_DECLARATION`.
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

/** The call each preset needs to be legal, and nothing beyond it. A preset that
 *  requires an objective gets one; a coverage preset gets its `key`. */
function callFor(preset: (typeof NAMED_SWARM_PRESETS)[number]): SwarmInput {
  if (preset === 'ideate') return { preset, task: 'three ways to cache this' };
  if (preset === 'research' || preset === 'audit' || preset === 'redteam') {
    return { preset, task: 'cover the failure modes', key: 'behaviour', objective: MEASURED };
  }
  return { preset, task: 'beat the baseline', objective: MEASURED };
}

/** Resolve and check validity in one step, throwing the refusal's own text so a
 *  failure names the axis rather than an undefined. */
function legal(input: SwarmInput): ResolvedSwarm {
  const resolved = resolveSwarm(input);
  if ('reason' in resolved) throw new Error(`resolve refused: ${resolved.error}`);
  const invalid = swarmValidity(resolved);
  if (invalid) throw new Error(`validity refused: ${invalid.error}`);
  return resolved;
}

/**
 * PER-NODE ASSIGNMENTS: `nodes` is the caller writing the first level themselves,
 * instead of asking for N takes on one task.
 *
 * THE DEFECT IT CLOSES. Every level-1 node received the run's `task` verbatim —
 * `swarm-run.ts` reads each child's assignment off the parent's granted proposal, and
 * at level 1 the parent is the ROOT, which no model wrote and which therefore
 * proposes nothing. The only thing that differed between siblings was a canned
 * diversity angle. No axis could say otherwise: the six are run-scoped single values
 * and `branches` is an integer.
 */
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
    // …and `ideate`'s own width of 5 is overridden by the caller's three, exactly as
    // an explicit `branches: 3` would be. One width, from one place.
    expect(SWARM_PRESET_POINTS.ideate.branches).toBe(5);
  });

  test('a count-based call resolves with no assignments at all', () => {
    // The other direction, without which a change that assigns every run passes the
    // test above: absent means absent, never an invented list.
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
    // The duplication the field exists to remove, restated by the caller. A search
    // that asks one question twice pays twice for one answer.
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
    // The acceptance criterion whole. Before this change `research`, `audit` and
    // `redteam` refused at resolve time with the missing parameter quoted, which is an
    // honest refusal and a non-functional preset — and *Presets* requires a named
    // preset to be unrefusable.
    for (const preset of NAMED_SWARM_PRESETS) {
      expect(() => legal(callFor(preset))).not.toThrow();
    }
  });

  test('the three coverage presets are archive runs at the converted Rainbow filter', () => {
    // 0.4 and not 0.6. `novelty` is the DISTANCE a candidate must put between itself
    // and its cell's occupants; Rainbow Teaming's τ=0.6 is a SIMILARITY ceiling, and
    // `archiveRegionRefusal` states the conversion in its own text — "a filter quoted
    // as a similarity ceiling is one MINUS that number here". Transcribing 0.6
    // unconverted would be a stricter archive than the evidence describes.
    for (const preset of ['research', 'audit', 'redteam'] as const) {
      const resolved = legal(callFor(preset));
      expect(resolved.config.advance).toEqual({ kind: 'archive', novelty: 0.4 });
      expect(resolved.settle).toBe('archive');
      // Depth 1 BY CONSTRUCTION, the same shape as `ideate`'s: an archive bins at the
      // settle barrier, so within one run there is nothing to select a second level
      // from. The illumination loop runs across runs, through `carry`.
      expect(resolved.caps.depth?.value).toBe(1);
      expect(resolved.caps.branches?.value).toBe(4);
      // Verified rather than judged, because a cell is keyed by the objective's
      // identity and ordered by its direction, and a judge measures neither.
      expect(resolved.config.score).toEqual({ kind: 'verify' });
    }
  });

  test('research and audit publish findings; redteam keeps its corpus in the workspace', () => {
    // The one axis the three coverage presets differ on, and the reason is blast
    // radius rather than taste: `carry:'artifacts'` publishes cross-workspace, which is
    // what a research finding is FOR and what an exploit corpus must not be.
    for (const preset of ['research', 'audit'] as const) {
      expect(legal(callFor(preset)).config.carry).toEqual({ kind: 'artifacts', threshold: 0.8 });
    }
    expect(legal(callFor('redteam')).config.carry).toEqual({ kind: 'elites' });
  });

  test('the artifacts bar is the pass-band midpoint this repository already publishes at', () => {
    // Derived, not chosen. `craftExtractionThreshold` is 0.80 = PASS_FLOOR 0.60 +
    // ½·PASS_SPAN 0.40 — the midpoint of the pass band, reachable only by executed code
    // with an at-or-above-median judge and unreachable by any prose branch (cap 0.75).
    // It is this repository's existing bar for publishing an artifact derived from a
    // search winner, and that is the same question asked of the same kind of object.
    const carry = legal(callFor('research')).config.carry;
    expect(carry.kind === 'artifacts' ? carry.threshold : null)
      .toBe(DEFAULT_CONFIG.mcts.craftExtractionThreshold);
  });

  test('a preset row is a POINT — the undeclared arm is gone rather than guarded', () => {
    // The strongest form of the fix. While a row could be undeclared, every reader of
    // the table needed a guard and `custom` + `from` inherited the refusal. With the
    // arm removed the guard has nothing to check and the hatch cannot be poisoned.
    for (const preset of NAMED_SWARM_PRESETS) {
      expect(SWARM_PRESET_POINTS[preset].config).toBeDefined();
      expect(SWARM_PRESET_POINTS[preset].depth).toBeGreaterThan(0);
    }
  });
});

describe('custom seeded from a preset resolves on the axes the caller states', () => {
  test('`from` each named preset resolves, overriding only what differs', () => {
    // The escape hatch the refusal text used to RECOMMEND while poisoning: a call
    // saying `preset:'custom', from:'research'` inherited the undeclared row's refusal,
    // so the way out named by the error did not work. Every base now seeds a
    // composition, including the three that used to refuse.
    for (const from of NAMED_SWARM_PRESETS) {
      const resolved = legal({
        preset: 'custom', from, label: `from-${from}`,
        task: 'beat the baseline', objective: MEASURED,
        // Three axes overridden, three inherited. A verified tree is legal over every
        // base, so this states one shape rather than one per row.
        config: {
          score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'none' },
        },
        depth: 3,
      });
      expect(resolved.preset).toBe('custom');
      expect(resolved.from).toBe(from);
      expect(resolved.config.advance).toEqual({ kind: 'uct' });
      // The row supplied every axis the call did not.
      expect(resolved.config.unit).toEqual(SWARM_PRESET_POINTS[from].config.unit);
      expect(resolved.config.expand).toEqual(SWARM_PRESET_POINTS[from].config.expand);
      // The stated cap wins; the row's other cap is inherited.
      expect(resolved.caps.depth).toEqual({ value: 3, origin: 'call' });
      expect(resolved.caps.branches?.origin).toBe('preset');
    }
  });

  test('a composition inherits the row\'s caps where it states none', () => {
    const resolved = legal({
      preset: 'custom', from: 'redteam', label: 'from-redteam',
      task: 'cover the tactics', key: 'tactic', objective: MEASURED,
      // One axis overridden: this run publishes its cells where `redteam` keeps them.
      config: { carry: { kind: 'artifacts', threshold: 0.8 } },
    });
    // Everything else is the row's, caps included.
    expect(resolved.config.advance).toEqual({ kind: 'archive', novelty: 0.4 });
    expect(resolved.caps.depth).toEqual({ value: 1, origin: 'preset' });
    expect(resolved.caps.branches).toEqual({ value: 4, origin: 'preset' });
  });
});

describe('a judged tree is funded at the ensemble it was admitted at', () => {
  test('the pool a judged run funds realises the WHOLE request', () => {
    // THE DEFECT, at its arithmetic. `swarm-run.ts` borrowed the MCTS engine's
    // per-evaluation dial — `maxEvalLLMCalls: 4`, sized for that engine's own
    // `judgeSamples: 3` — so a swarm validity admitted at 20 realised
    // `min(20, 4 − 1) = 3`. The floor is not lowered; the pool is sized to it.
    const budget = judgeCallBudget({
      judgeSamples: JUDGE_MARGINALISATION_MIN,
      maxLLMCalls: judgeCallPool(JUDGE_MARGINALISATION_MIN),
      offersRunnableCode: true,
    });
    expect(budget.ensemble).toBe(JUDGE_MARGINALISATION_MIN);
    // And the check suite is still bought: the pool is the ensemble PLUS that one
    // call, which is the split `judgeCallBudget` already documents.
    expect(budget.generatesChecks).toBe(true);
  });

  test('a prose candidate is funded at the same ensemble, with the suite call unspent', () => {
    const budget = judgeCallBudget({
      judgeSamples: JUDGE_MARGINALISATION_MIN,
      maxLLMCalls: judgeCallPool(JUDGE_MARGINALISATION_MIN),
      offersRunnableCode: false,
    });
    expect(budget.ensemble).toBe(JUDGE_MARGINALISATION_MIN);
    expect(budget.generatesChecks).toBe(false);
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
    // Kept as the counter-example the fix is stated against, so a future change that
    // reintroduces the borrow fails here rather than in production. This is what every
    // judged swarm ran at.
    expect(judgeCallBudget({
      judgeSamples: JUDGE_MARGINALISATION_MIN,
      maxLLMCalls: DEFAULT_CONFIG.mcts.maxEvalLLMCalls,
      offersRunnableCode: true,
    }).ensemble).toBe(3);
  });

  test('the marginalisation floor is unchanged, because the evidence for it is unchanged', () => {
    // #178: a gate is not lowered to make something pass. Koh Table 4 at fixed node
    // expansions — a marginalised weaker judge scores 30.0% against an unmarginalised
    // stronger one's 28.5%, and SC(1)→SC(20) is worth +8.5. The number stays; what
    // changed is that a run admitted at it now runs at it.
    expect(JUDGE_MARGINALISATION_MIN).toBe(20);
  });
});

describe('`{preset, task}` is a complete call on every row', () => {
  // THE ERGONOMICS CONTRACT, and the reason it is a contract rather than a nicety.
  //
  // Five of the six rows score by `verify`, `verify` needs an instrument, and only one
  // instrument is registered. So the shortest call the surface advertises refused on
  // every row but `ideate`, and a live incident measured what that costs: a model spent
  // five of its ten available steps collecting one refusal per round trip — a missing
  // objective, an invented verifier kind, an empty spec, a missing coverage key — and
  // the fifth told it the instrument could not have run in that workspace at all.
  //
  // The engine is deliberately NOT run here. What is under test is the call boundary:
  // resolution and validity, which is where all five of those refusals were issued.

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
    // Each of the three axes that move reads a MEASUREMENT, so each of them is a lie
    // without one: an archive bins by the instrument's witness, a tree selects on the
    // value, and a record is keyed by the objective's identity. The fallback drops all
    // three rather than accepting them and ignoring them.
    for (const preset of NAMED_SWARM_PRESETS) {
      const row = SWARM_PRESET_POINTS[preset];
      if (row.config.score.kind !== 'verify') continue;
      const resolved = resolveSwarm({ preset, task: 'x' });
      if ('reason' in resolved) throw new Error(resolved.error);
      expect(resolved.config.score).toEqual({ kind: 'judge', samples: UNMEASURED_JUDGE_SAMPLES });
      expect(resolved.config.advance).toEqual({ kind: 'none' });
      expect(resolved.config.carry).toEqual({ kind: 'none' });
      expect(resolved.caps.depth?.value).toBe(1);
      // The width is the row's own: the fallback changes the scorer, not the shape's
      // breadth, so a bare `optimise` still fans the 3 its row declares.
      expect(resolved.caps.branches?.value).toBe(row.branches);
      // And the axes it did NOT touch stay the row's.
      expect(resolved.config.unit).toEqual(row.config.unit);
      expect(resolved.config.context).toBe(row.config.context);
    }
  });

  test('naming an `objective` restores the row the doctrine describes', () => {
    // The fallback is a fallback and not a replacement: everything a preset IS comes
    // back the moment there is an instrument to measure with.
    for (const preset of NAMED_SWARM_PRESETS) {
      const row = SWARM_PRESET_POINTS[preset];
      if (row.config.score.kind !== 'verify') continue;
      const resolved = legal(callFor(preset));
      expect(resolved.config).toEqual(row.config);
      expect(resolved.caps.depth?.value).toBe(row.depth);
    }
  });

  test('`custom` is NOT given the fallback — a composed `verify` still asks for its instrument', () => {
    // The exclusion is deliberate. `custom` requires `config`, so a caller who wrote
    // `score:{kind:'verify'}` asked for an instrument in as many words, and substituting
    // a judge under them would be the surface overruling a decision they had made.
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
    // And the way out it names has to be one `custom` can actually take. The old text
    // offered `score:"none"` to every preset, which a NAMED preset cannot set at all.
    expect(refusal.error).toContain('`config`');
  });

  test("the incident's call sequence collapses to one refusal, and it names a working call", () => {
    const task = 'reduce the oracle calls our solver spends';
    // CALL 1, the one the model actually made. It used to be refusal #1 of 5.
    const bare = resolveSwarm({ preset: 'optimise', task });
    if ('reason' in bare) throw new Error(bare.error);
    expect(swarmValidity(bare)).toBeNull();

    // A caller who volunteers an instrument anyway gets ONE refusal per mistake, and
    // each one ends with a call that works rather than with the field it rejected —
    // which is what turns five round trips into a choice between two.
    const invented = resolveSwarm({
      preset: 'optimise', task,
      objective: { ...MEASURED, verify: { kind: 'script', spec: { path: 'measure.py' } } },
    });
    if ('reason' in invented) throw new Error(invented.error);
    const kindRefusal = swarmValidity(invented);
    if (!kindRefusal) throw new Error('an unregistered kind must be refused');
    expect(kindRefusal.error).toContain('exec-ratio');
    expect(kindRefusal.error).toContain('{action:"swarm", preset:"optimise", task:"…"}');

    // An empty spec is refused ONCE naming every field, rather than one field per
    // round trip — the shape that consumed three of the incident's five steps.
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
    // THE ANTI-DRIFT PIN. `VERIFIER_KIND_DOC` lives in objective.ts because the
    // registry cannot be imported from `swarmValidity` without closing a cycle, so the
    // field list a refusal prints is not the schema that enforces it. This holds the
    // two together behaviourally, in both directions.
    for (const kind of VERIFIER_KINDS) {
      const fields = VERIFIER_KIND_DOC[kind].specFields;
      const full: JsonObject = Object.fromEntries(
        fields.map((field) => [field, EXEC_RATIO_SPEC[field]]),
      );
      // SUFFICIENT: a spec built from the documented fields ALONE binds. A field the
      // schema requires and this list omits would fail here.
      const bound = resolveVerifier({ kind, spec: full });
      if ('reason' in bound) throw new Error(`${kind}: documented fields did not bind: ${bound.error}`);
      // NECESSARY: dropping any one of them refuses. A field this list names that the
      // schema does not actually require would survive its own removal.
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
