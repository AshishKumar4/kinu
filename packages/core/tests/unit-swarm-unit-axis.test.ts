/**
 * The `unit` axis, and the axis that took its parameter.
 *
 * A TOOL-USING NODE RUNS, and the bound that could make it look illegal is a bound on
 * the GRADING SIGNAL rather than on the tool surface: nodes share one workspace, so a
 * node cannot be graded on what it CHANGED — every node changed the same tree — but it
 * can be graded on what it REPORTS. `answer` IS that shape, so no separate value names
 * it, and models compose the shape correctly without one.
 *
 * What these tests assert is *One spelling per axis*, held across the cut: the cut
 * spellings are UNREPRESENTABLE rather than merely refused, every declared value
 * resolves, and a tool-using composition starts instead of coming back `unsupported`.
 *
 * The inheritance question a unit-level flag would carry is asked once on the
 * `context` axis, for the caller-to-root edge and every branch edge (*Inherited
 * context*). That is the second half of what is asserted here.
 *
 * Specified by docs/EXPLORATION.md — "The six axes", "One spelling per axis", "Presets",
 * "Validity over the resolved configuration", "Inherited context" and "Isolation".
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from '@kinu.run/test-utils';
import { SwarmConfigSchema } from '../src/tools/swarm-input';
import type { JsonValue } from '../src/utils/json';
import {
  resolveSwarm, swarmValidity, SWARM_CONTEXTS, SWARM_UNITS,
  type BranchContext, type SwarmUnitSetting,
} from '../src/strategy/swarm';
import { runSwarm } from '../src/strategy/swarm-run';
import { hostedSeatsOver } from './helpers-actor-host';
import { scriptedTurnModel } from '@kinu.run/test-utils';

/**
 * A bindable objective naming the one registered instrument.
 *
 * Needed wherever a test wants a preset's MEASURED row: `verify` means an instrument,
 * so a call that names none resolves to the row's judged sweep instead — the archive,
 * the tree and the depth cap all arrive with the objective rather than with the name.
 */
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

/** A composition legal in every respect except the axis under test, so a refusal can
 *  only ever be about `unit` or `context`. */
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

  /** Where the schema points when it refuses `input`: one dotted path per issue.
   *  A refusal that names another axis, or none, is a different defect from
   *  acceptance, and `toThrow()` alone cannot tell the three apart. */
  function refusedAt(input: JsonValue): string[] {
    const result = v.safeParse(SwarmConfigSchema, input);

    if (result.success) throw new Error(`parsed a cut spelling: ${JSON.stringify(input)}`);

    return result.issues.map((issue) => (issue.path ?? []).map((step) => String(step.key)).join('.'));
  }

  test('the cut spellings are UNREPRESENTABLE, not merely refused', () => {
    // The one-spelling guard. `trajectory` named the shape two of the three values
    // have, and `step` never executed — accepting either beside the current set is the
    // second spelling *One spelling per axis* exists to prevent.
    expect(refusedAt({ unit: { kind: 'trajectory', inherit: true } })).toEqual(['unit.kind']);
    expect(refusedAt({ unit: { kind: 'step' } })).toEqual(['unit.kind']);
    // And no unit carries a parameter: inheritance is the `context` axis.
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
  /** A config as a caller might still spell it, INCLUDING the axes and values the
   *  surface does not have. Named rather than `object`, because the shape these
   *  tests send is exactly the thing under test. */
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
    // The honest half: it is not a re-homing, it is a value that never did anything.
    expect(error).toContain('NOTHING EVER READ THE DIFFERENCE');
    expect(error).toContain('unit:{kind:"answer"}');
    // The survivors still parse, and neither carries a parameter.
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
    // The honest half: all three values behaved identically, AND something was lost.
    expect(error).toContain('behaving identically');
    expect(error).toContain('can no longer be turned OFF');
  });

  test('expand:"mutate" is refused by name and points at the axis that took its question', () => {
    const error = refusal({ expand: 'mutate' });
    expect(error).toContain('expand:"mutate" was cut');
    expect(error).toContain('`context`');
    // The survivors still parse.
    expect(v.parse(SwarmConfigSchema, { expand: 'sample' })).toMatchObject({ expand: 'sample' });
    expect(v.parse(SwarmConfigSchema, { expand: 'aggregate' })).toMatchObject({ expand: 'aggregate' });
  });

  test('score:"agree" is refused by name as the judge it always was', () => {
    const error = refusal({ score: { kind: 'agree' } });
    expect(error).toContain('score:"agree" was cut');
    expect(error).toContain('samples');
  });

  test('score:"novelty" is refused by name and says it MOVED rather than went', () => {
    const error = refusal({ score: { kind: 'novelty' } });
    expect(error).toContain('score:"novelty" was cut');
    expect(error).toContain('advance:{kind:"archive", novelty:');
  });

  test('advance:"beam" is refused by name and does NOT claim an equivalent', () => {
    const error = refusal({ advance: { kind: 'beam' } });
    expect(error).toContain('advance:"beam" was cut');
    expect(error).toContain('COSTS SOMETHING');
    expect(error).toContain('LEVEL-SYNCHRONISED ORDER');
  });

  test("an archive with no rejection test is UNCONSTRUCTIBLE, not refused", () => {
    // The load-bearing half of the re-homing: there is no validity rule to fail,
    // because the parse itself has nowhere to put an archive without its novelty test.
    expect(() => v.parse(SwarmConfigSchema, { advance: { kind: 'archive' } })).toThrow();
    expect(v.parse(SwarmConfigSchema, { advance: { kind: 'archive', novelty: 0.6 } }))
      .toMatchObject({ advance: { kind: 'archive', novelty: 0.6 } });
  });

  test('the three archive presets resolve, at the CONVERTED Rainbow filter', () => {
    // Every row declares the threshold the archive arm requires; a row that does not
    // refuses, and the advertised preset is unusable. τ=0.6 is a similarity CEILING
    // and this axis is a distance FLOOR, so the row states 1 − 0.6. The conversion is
    // the point: 0.6 written here unconverted is a stricter archive than the evidence
    // describes.
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
    // Refusing a `prove` call with no `objective` is the defect: `prove` scores by
    // `verify`, `verify` needs an instrument, so the shortest legal `prove` call would
    // be unreachable without authoring a whole spec — and five of the six presets have
    // the same property. A measured incident spent five of a model's ten steps
    // collecting those refusals one at a time, and the last of them said the
    // instrument could not have run in that workspace at all.
    //
    // The checker is what `prove` IS, and naming one buys the depth-7 best-first tree
    // below. Omitting it yields a run rather than a scolding.
    const resolved = resolveSwarm({ preset: 'prove', task: 'show it' });

    if ('reason' in resolved) throw new Error(`prove must RESOLVE: ${resolved.error}`);
    expect(swarmValidity(resolved)).toBeNull();
    expect(resolved.config.score.kind).toBe('judge');
    expect(resolved.config.advance).toEqual({ kind: 'none' });
    expect(resolved.caps.depth?.value).toBe(1);

    // And with a checker it is the preset the doctrine describes.
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
    // The completeness check is behavioural on purpose (`AXES` cannot force the
    // compiler to notice a new required axis), so this is the assertion that holds the
    // direction the type cannot: a composition that omits `context` is refused naming
    // it.
    const call = unitCall({ unit: { kind: 'answer' }, context: 'fresh' });
    const { context: _dropped, ...withoutContext } = call.config;
    const resolved = resolveSwarm({ ...call, config: withoutContext });

    if (!('reason' in resolved)) throw new Error('a composition missing `context` must be refused');
    expect(resolved.error).toContain('context');
  });

  test('a named preset supplies it from the row *Presets* fixes, the verifier presets inheriting', () => {
    // The verifier presets take `inherit` because that is what the cut
    // `observe:'ancestors'` WAS: a continued conversation carries the ancestor
    // chain's measurements transitively. `ideate` takes `fresh` — it has no branch
    // edge at all.
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
  test('a tool-using node run starts — no `unsupported` about a shared workspace', async () => {
    // Reaching the model at all is the claim: `regionRefusal` is the first thing
    // `runSwarm` does and it spends nothing, so a refusal would come back before any
    // call. This model answers once and stops, which is the smallest run that proves
    // the region opened; what an agent node DOES with its tools is the behavioural
    // suite's subject, not this one's.
    const { rt, testSql } = createTestRuntime();

    const result = await runSwarm({
      rt,
      // `unit:'answer'` is an agent node, so the run acquires one seat per node
      // — a real one, over this runtime's own database, because a node that got
      // no actor is exactly the composition this case says must run.
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
  }, 60_000);
});
