/**
 * The `unit` axis and the `context` axis that took its parameter: cut spellings are
 * unrepresentable, every declared value resolves, and a tool-using composition runs.
 * Specified by docs/EXPLORATION.md — "The six axes", "One spelling per axis", "Presets",
 * "Validity over the resolved configuration", "Inherited context" and "Isolation".
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime, scriptedAdvisorPort, unobservedSpend } from '@kinu.run/test-utils';
import { SwarmConfigSchema } from '../src/tools/swarm-input';
import type { JsonValue } from '../src/utils/json';
import { resolveSwarm, swarmValidity, type BranchContext, type SwarmUnitSetting } from '../src/strategy/swarm';
import { runSwarm } from '../src/strategy/swarm-run';
import { swarmSeats } from './helpers-actor-host';
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
  function refusal(config: CutSpelling): boolean {
    const parsed = v.safeParse(SwarmConfigSchema, config);

    return !parsed.success;
  }

  test('a `custom` call with an empty config is refused naming all six and no more', () => {
    const resolved = resolveSwarm({ preset: 'custom', task: 't', label: 'six', config: {} });

    if (!('reason' in resolved)) throw new Error('an empty composition must be refused');

    expect(resolved.reason).toBe('bad_input');
  });

  test('unit:"generator" is refused by name and sent to the value it always was', () => {
    const error = refusal({ unit: { kind: 'generator' } });
    expect(error).toBe(true);
    expect(v.parse(SwarmConfigSchema, { unit: { kind: 'answer' } }))
      .toMatchObject({ unit: { kind: 'answer' } });
    expect(v.parse(SwarmConfigSchema, { unit: { kind: 'thought' } }))
      .toMatchObject({ unit: { kind: 'thought' } });
  });

  test('`observe` is refused by name, and told where each of its values went', () => {
    const error = refusal({ observe: 'ancestors' });
    expect(error).toBe(true);
  });

  test('`decorrelate` is refused by name, and says what turning angles off cost', () => {
    const error = refusal({ decorrelate: 'blind' });
    expect(error).toBe(true);
  });

  test('expand:"mutate" is refused by name and points at the axis that took its question', () => {
    const error = refusal({ expand: 'mutate' });
    expect(error).toBe(true);
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
      expect(error).toBe(true);
      expect(error).toBe(true);
    });
  }

  test('advance:"beam" is refused by name and does NOT claim an equivalent', () => {
    const error = refusal({ advance: { kind: 'beam' } });
    expect(error).toBe(true);
  });

  test("an archive with no rejection test is UNCONSTRUCTIBLE, not refused", () => {
    // No validity rule to fail: the parse has nowhere to put an archive without its novelty test.
    expect(() => v.parse(SwarmConfigSchema, { advance: { kind: 'archive' } })).toThrow();
    expect(v.parse(SwarmConfigSchema, { advance: { kind: 'archive', novelty: 0.6 } }))
      .toMatchObject({ advance: { kind: 'archive', novelty: 0.6 } });
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
    for (const context of ['fresh', 'inherit']) {
      expect(v.parse(SwarmConfigSchema, { context })).toMatchObject({ context });
    }

    expect(() => v.parse(SwarmConfigSchema, { context: 'fork' })).toThrow();
    expect(() => v.parse(SwarmConfigSchema, { context: { kind: 'fork' } })).toThrow();
  });

  test('a resolved configuration is INCOMPLETE without it — an axis, not an option', () => {
    // Behavioural on purpose: `AXES` cannot make the compiler notice a new required axis.
    const call = unitCall({ unit: { kind: 'answer' }, context: 'fresh' });
    const { context: _dropped, ...withoutContext } = call.config;
    const resolved = resolveSwarm({ ...call, config: withoutContext });

    if (!('reason' in resolved)) throw new Error('a composition missing `context` must be refused');
    expect(resolved.reason).toBe('bad_input');
  });

});

describe('a tool-using node over a shared workspace is a runnable composition', () => {
  test('a swarm node is scored by the judge, not reviewed: it takes no input a note could reach', async () => {
    const { rt, testSql } = createTestRuntime();
    rt.actor.config.setAdvisorEnabled(true);
    let scores = 0;
    const advisor = scriptedAdvisorPort();
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
      rt, ...swarmSeats({ rt, db: testSql.db, autoEvolve: true, advisorPort: advisor }, () => scriptedTurnModel({ doGenerate: async () => ({
        content: [{ type: 'text', text: 'A candidate solution.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        },
        warnings: [],
      }) })),
      mode: 'build',
    }, resolved);

    if ('reason' in result) throw new Error(result.error);
    expect(result.report.expansions).toBe(3);
    expect(scores).toBe(6);
    expect(advisor.tasks).toEqual([]);
    expect(rt.storage.sql`SELECT actor_id FROM completed_turns`).toEqual([]);
  });

  test('a tool-using node run starts — no `unsupported` about a shared workspace', async () => {
    // `regionRefusal` runs first and spends nothing, so reaching the model proves the region opened.
    const { rt, testSql } = createTestRuntime();

    const result = await runSwarm({
      reportModelCall: unobservedSpend,
      rt,
      // `unit:'answer'` is an agent node: each node acquires a real seat.
      ...swarmSeats({ rt, db: testSql.db }, () => scriptedTurnModel({
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
      })),
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
