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
  JUDGE_MARGINALISATION_MIN, NAMED_SWARM_PRESETS, SWARM_PRESET_POINTS, judgeCallPool,
  resolveSwarm, swarmValidity,
  type ResolvedSwarm, type SwarmInput,
} from '../src/strategy/swarm';
import { judgeCallBudget } from '../src/mcts/evaluation';
import { DEFAULT_CONFIG } from '../src/config';
import type { Objective } from '../src/strategy/objective';

/** A measurable objective naming a REGISTERED instrument, which is what every
 *  verifying preset requires and what the archive presets bin their cells by. */
const MEASURED: Objective = {
  kind: 'scalar', metric: 'oracle calls', unit: 'count', direction: 'minimise',
  scale: 'linear', target: 23,
  verify: { kind: 'exec-ratio', spec: {} },
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
      expect(resolved.config.unit).toBeDefined();
      expect(resolved.config.expand).toBeDefined();
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
