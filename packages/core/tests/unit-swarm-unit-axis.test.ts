/**
 * The `unit` axis and the `context` axis that took its parameter: cut spellings are
 * unrepresentable, every declared value resolves, and a tool-using composition runs.
 * Specified by docs/EXPLORATION.md — "The six axes", "One spelling per axis", "Presets",
 * "Validity over the resolved configuration", "Inherited context" and "Isolation".
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, unobservedSpend } from '@kinu.run/test-utils';
import { SwarmConfigSchema } from '../src/tools/swarm-input';
import type { JsonValue } from '../src/utils/json';
import {
  resolveSwarm, swarmValidity, SWARM_CONTEXTS, SWARM_UNITS,
  type BranchContext, type SwarmUnitSetting,
} from '../src/strategy/swarm';
import { runSwarm } from '../src/strategy/swarm-run';
import { hostedSeatsOver } from './helpers-actor-host';
import { scriptedTurnModel } from '@kinu.run/test-utils';

/** Needed for a preset's measured row; without an objective a preset resolves to its judged sweep. */
const MEASURED = {
  kind: 'scalar' as const, metric: 'oracle calls', unit: 'count',
  direction: 'minimise' as const, scale: 'linear' as const, target: 8,
  verify: {
    kind: 'exec-ratio' as const,
    spec: {
      params: { n: 8 },
      reference: 'export function solve(input, oracle) { return oracle(input); }',
      body: 'export function solve(input, oracle) { return oracle(input); }',
      targetOps: 8,
      lowerBoundOps: 4,
    },
  },
};

/** Legal except for the axis under test, so a refusal can only be about `unit` or `context`. */
function unitCall(over: { unit: SwarmUnitSetting; context: BranchContext }) {
  return {
    preset: 'custom' as const,
    task: 'find the cheapest correct implementation',
    label: 'unit-axis',
    config: {
      unit: over.unit,
      context: over.context,
      expand: 'sample' as const,
      score: { kind: 'none' as const },
      advance: { kind: 'none' as const },
      carry: { kind: 'none' as const },
    },
    depth: 1,
    branches: 3,
  };
}

describe('the unit axis names what a node produces, and nothing else', () => {
  test('the two units are exactly answer/thought', () => {
    expect([...SWARM_UNITS]).toEqual(['answer', 'thought']);
  });

  /** Dotted path per issue: a refusal naming another axis is a different defect from acceptance. */
  function refusedAt(input: JsonValue): string[] {
    const result = v.safeParse(SwarmConfigSchema, input);

    if (result.success) throw new Error(`parsed a cut spelling: ${JSON.stringify(input)}`);

    return result.issues.map((issue) => (issue.path ?? []).map((step) => String(step.key)).join('.'));
  }

  test('the cut spellings are UNREPRESENTABLE, not merely refused', () => {
    // Accepting a cut value beside the current set is a second spelling.
    expect(refusedAt({ unit: { kind: 'trajectory', inherit: true } })).toEqual(['unit.kind']);
    expect(refusedAt({ unit: { kind: 'step' } })).toEqual(['unit.kind']);
    // No unit carries a parameter: inheritance is the `context` axis.
    expect(refusedAt({ unit: { kind: 'answer', inherit: true } })).toEqual(['unit.inherit']);
  });

  test('a bare axis string is not a unit — the tag IS the value', () => {
    expect(refusedAt({ unit: 'answer' })).toEqual(['unit']);
  });

  test('every declared unit resolves, so no declared value is unreachable', () => {
    for (const kind of SWARM_UNITS) {
      const call = unitCall({ unit: { kind }, context: 'fresh' });
      const resolved = resolveSwarm(call);

      if ('reason' in resolved) throw new Error(`unit:${kind} did not resolve: ${resolved.error}`);
      expect(resolved.config.unit).toEqual({ kind });
    }
  });
});

describe('the surface has SIX axes, and each cut value is refused by its own name', () => {
  interface CutSpelling {
    readonly unit?: { readonly kind: string };
    readonly observe?: string;
    readonly decorrelate?: string;
    readonly expand?: string;
    readonly score?: { readonly kind: string };
    readonly advance?: { readonly kind: string; readonly novelty?: number };
  }

  /** The message a composition comes back with, or '' when it was accepted. */
  function refusal(config: CutSpelling): string {
    const parsed = v.safeParse(SwarmConfigSchema, config);

    return parsed.success ? '' : parsed.issues.map((issue) => issue.message).join(' ');
  }

  test('a `custom` call with an empty config is refused naming all six and no more', () => {
    const resolved = resolveSwarm({ preset: 'custom', task: 't', label: 'six', config: {} });

    if (!('reason' in resolved)) throw new Error('an empty composition must be refused');

    for (const axis of ['unit', 'context', 'expand', 'score', 'advance', 'carry']) {
      expect(resolved.error).toContain(axis);
    }

    expect(resolved.error).not.toContain('observe');
    expect(resolved.error).not.toContain('decorrelate');
  });

  test('unit:"generator" is refused by name and sent to the value it always was', () => {
    const error = refusal({ unit: { kind: 'generator' } });
    expect(error).toContain('unit:"generator" was cut');
    expect(error).toContain('NOTHING EVER READ THE DIFFERENCE');
    expect(error).toContain('unit:{kind:"answer"}');
    expect(v.parse(SwarmConfigSchema, { unit: { kind: 'answer' } }))
      .toMatchObject({ unit: { kind: 'answer' } });
    expect(v.parse(SwarmConfigSchema, { unit: { kind: 'thought' } }))
      .toMatchObject({ unit: { kind: 'thought' } });
  });

  test('`observe` is refused by name, and told where each of its values went', () => {
    const error = refusal({ observe: 'ancestors' });
    expect(error).toContain('`observe` was cut entirely');
    expect(error).toContain('context:"inherit"');
  });

  test('`decorrelate` is refused by name, and says what turning angles off cost', () => {
    const error = refusal({ decorrelate: 'blind' });
    expect(error).toContain('`decorrelate` was cut entirely');
    expect(error).toContain('behaving identically');
    expect(error).toContain('can no longer be turned OFF');
  });

  test('expand:"mutate" is refused by name and points at the axis that took its question', () => {
    const error = refusal({ expand: 'mutate' });
    expect(error).toContain('expand:"mutate" was cut');
    expect(error).toContain('`context`');
    expect(v.parse(SwarmConfigSchema, { expand: 'sample' })).toMatchObject({ expand: 'sample' });
    expect(v.parse(SwarmConfigSchema, { expand: 'aggregate' })).toMatchObject({ expand: 'aggregate' });
  });

  // A retired score is refused by name and says where its behaviour went.
  const retiredScores = [
    { name: 'score:"agree" is refused by name as the judge it always was', kind: 'agree', points_at: 'samples' },
    { name: 'score:"novelty" is refused by name and says it MOVED rather than went', kind: 'novelty', points_at: 'advance:{kind:"archive", novelty:' },
  ] as const;

  for (const c of retiredScores) {
    test(c.name, () => {
      const error = refusal({ score: { kind: c.kind } });
      expect(error).toContain(`score:"${c.kind}" was cut`);
      expect(error).toContain(c.points_at);
    });
  }

  test('advance:"beam" is refused by name and does NOT claim an equivalent', () => {
    const error = refusal({ advance: { kind: 'beam' } });
    expect(error).toContain('advance:"beam" was cut');
    expect(error).toContain('COSTS SOMETHING');
    expect(error).toContain('LEVEL-SYNCHRONISED ORDER');
  });

  test("an archive with no rejection test is UNCONSTRUCTIBLE, not refused", () => {
    // No validity rule to fail: the parse has nowhere to put an archive without its novelty test.
    expect(() => v.parse(SwarmConfigSchema, { advance: { kind: 'archive' } })).toThrow();
    expect(v.parse(SwarmConfigSchema, { advance: { kind: 'archive', novelty: 0.6 } }))
      .toMatchObject({ advance: { kind: 'archive', novelty: 0.6 } });
  });

  test('the three archive presets resolve, at the CONVERTED Rainbow filter', () => {
    // τ=0.6 is a similarity ceiling; this axis is a distance floor, so the row states 1 − 0.6.
    for (const preset of ['research', 'audit', 'redteam'] as const) {
      const resolved = resolveSwarm({
        preset, task: 'probe it', key: 'behaviour', objective: MEASURED,
      });

      if ('reason' in resolved) throw new Error(`${preset} must resolve: ${resolved.error}`);
      expect(resolved.config.advance).toEqual({ kind: 'archive', novelty: 0.4 });
      expect(resolved.settle).toBe('archive');
    }
  });

  test('`prove` is constructible, and it is a checker preset', () => {
    const resolved = resolveSwarm({
      preset: 'prove',
      task: 'show every reachable state is safe',
      objective: {
        kind: 'scalar', metric: 'obligations discharged', unit: 'count', direction: 'maximise',
        scale: 'linear', target: 12, verify: { kind: 'exec-ratio', spec: {} },
      },
    });

    if ('reason' in resolved) throw new Error(`prove did not resolve: ${resolved.error}`);
    expect(resolved.config.unit).toEqual({ kind: 'answer' });
    expect(resolved.config.score).toEqual({ kind: 'verify' });
    expect(resolved.config.advance).toEqual({ kind: 'best-first' });
    expect(resolved.config.carry).toEqual({ kind: 'artifacts', threshold: 1 });
    expect(resolved.caps.depth?.value).toBe(7);
    expect(resolved.settle).toBe('best');
  });

  test('`prove` without a checker takes the judged sweep rather than refusing', () => {
    // A bare `prove` resolves to the judged sweep; naming a checker buys the best-first tree.
    const resolved = resolveSwarm({ preset: 'prove', task: 'show it' });

    if ('reason' in resolved) throw new Error(`prove must RESOLVE: ${resolved.error}`);
    expect(swarmValidity(resolved)).toBeNull();
    expect(resolved.config.score.kind).toBe('judge');
    expect(resolved.config.advance).toEqual({ kind: 'none' });
    expect(resolved.caps.depth?.value).toBe(1);

    const checked = resolveSwarm({ preset: 'prove', task: 'show it', objective: MEASURED });

    if ('reason' in checked) throw new Error(checked.error);
    expect(swarmValidity(checked)).toBeNull();
    expect(checked.config.score).toEqual({ kind: 'verify' });
    expect(checked.config.advance).toEqual({ kind: 'best-first' });
    expect(checked.caps.depth?.value).toBe(7);
  });
});

describe('the context axis carries the inheritance question, at one spelling', () => {
  test('both values parse, and the axis is a bare picklist rather than a tagged value', () => {
    for (const context of SWARM_CONTEXTS) {
      expect(v.parse(SwarmConfigSchema, { context })).toMatchObject({ context });
    }

    expect(() => v.parse(SwarmConfigSchema, { context: 'fork' })).toThrow('renamed');
    expect(() => v.parse(SwarmConfigSchema, { context: { kind: 'fork' } })).toThrow();
  });

  test('a resolved configuration is INCOMPLETE without it — an axis, not an option', () => {
    // Behavioural on purpose: `AXES` cannot make the compiler notice a new required axis.
    const call = unitCall({ unit: { kind: 'answer' }, context: 'fresh' });
    const { context: _dropped, ...withoutContext } = call.config;
    const resolved = resolveSwarm({ ...call, config: withoutContext });

    if (!('reason' in resolved)) throw new Error('a composition missing `context` must be refused');
    expect(resolved.error).toContain('context');
  });

  test('a named preset supplies it from the row *Presets* fixes, the verifier presets inheriting', () => {
    // Verifier presets inherit (a continued conversation carries ancestor measurements);
    // `ideate` has no branch edge, so `fresh`.
    const optimise = resolveSwarm({
      preset: 'optimise',
      task: 'make it faster',
      objective: {
        kind: 'scalar', metric: 'ms', unit: 'ms', direction: 'minimise', scale: 'linear',
        target: 1, verify: { kind: 'exec-ratio', spec: {} },
      },
    });

    if ('reason' in optimise) throw new Error(`optimise did not resolve: ${optimise.error}`);
    expect(optimise.config.context).toBe('inherit');

    const ideate = resolveSwarm({ preset: 'ideate', task: 'name some approaches' });

    if ('reason' in ideate) throw new Error(`ideate did not resolve: ${ideate.error}`);
    expect(ideate.config.context).toBe('fresh');
  });
});

describe('a tool-using node over a shared workspace is a runnable composition', () => {
  test('the advisor reviews agent nodes, not the judge samples scoring those nodes', async () => {
    const { rt, testSql } = createTestRuntime();
    rt.actor.config.setAdvisorEnabled(true);
    let reviews = 0;
    let scores = 0;
    rt.advisorLlm = {
      async *stream() { yield ''; },
      complete: async () => {
        reviews++;

        return JSON.stringify({ note: 'The result omitted the requested verification.', severity: 'nit', class: 'wrong-work' });
      },
    };
    rt.judgeModel = {
      async *stream() { yield ''; },
      complete: async () => { scores++;

 return '{"score":0.7}'; },
    };
    const call = unitCall({ unit: { kind: 'answer' }, context: 'fresh' });
    const resolved = resolveSwarm({ ...call, config: { ...call.config, score: { kind: 'judge', samples: 2 } } });

    if ('reason' in resolved) throw new Error(resolved.error);

    const result = await runSwarm({
      reportModelCall: unobservedSpend,
      rt, hostNode: hostedSeatsOver({ rt, db: testSql.db, autoEvolve: true }).hostNode,
      mode: 'build',
      model: scriptedTurnModel({ doGenerate: async () => ({
        content: [{ type: 'text', text: 'A candidate solution.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        },
        warnings: [],
      }) }),
    }, resolved);

    if ('reason' in result) throw new Error(result.error);
    expect(result.report.expansions).toBe(3);
    expect(scores).toBe(6);
    expect(reviews).toBe(3);
    expect(rt.storage.sql`SELECT actor_id FROM completed_turns`).toEqual([]);
    expect(rt.storage.sql<{ actor_id: string }>`SELECT actor_id FROM evolution_events WHERE type = 'advisor_note'`)
      .toHaveLength(3);
  });

  test('a tool-using node run starts — no `unsupported` about a shared workspace', async () => {
    // `regionRefusal` runs first and spends nothing, so reaching the model proves the region opened.
    const { rt, testSql } = createTestRuntime();

    const result = await runSwarm({
      reportModelCall: unobservedSpend,
      rt,
      // `unit:'answer'` is an agent node: each node acquires a real seat.
      hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
      model: scriptedTurnModel({
        provider: 'fake',
        modelId: 'fake-unit-axis',
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'one approach' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
          warnings: [],
        }),
      }),
      mode: 'build',
    }, (() => {
      const resolved = resolveSwarm(unitCall({ unit: { kind: 'answer' }, context: 'fresh' }));

      if ('reason' in resolved) throw new Error(`the fixture must resolve: ${resolved.error}`);

      return resolved;
    })());

    if ('reason' in result) {
      throw new Error(`a tool-using node composition must run: ${result.error}`);
    }

    expect(result.report.expansions).toBe(3);
  });
});
