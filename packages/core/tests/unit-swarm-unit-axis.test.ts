/**
 * The `unit` axis, and the axis that took its parameter.
 *
 * THIS FILE USED TO ASSERT A REFUSAL. `unit:'trajectory'` named a tool-using agent
 * node and `regionRefusal` refused it, because nodes share one workspace and a node
 * cannot be graded on what it changed when every node changed the same tree. §8.6
 * measured that region at 18% — models compose the shape CORRECTLY, the design blocked
 * it, and nothing on the surface said so — so the refusal's own wording was the
 * contract under test.
 *
 * The blocker was real and it was mis-sited. It bounds the GRADING SIGNAL, not the tool
 * surface: a node holding a shell can still be graded, as long as it is graded on what
 * it REPORTS. So the shape runs now, the value that named it is gone because it is what
 * `answer` and `generator` ARE, and what these tests assert is the migration itself —
 * the old spellings are unrepresentable, the new ones resolve, and the composition that
 * was permanently refused is no longer refused at all.
 *
 * The inheritance question `unit:'trajectory'` carried did not vanish; it moved to the
 * `context` axis, which asks it once for the caller-to-root edge and every branch edge
 * (§8.4). That is the second half of what is asserted here.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createTestRuntime } from '@proteus/test-utils';
import { SwarmConfigSchema } from '../src/tools/swarm-input';
import {
  resolveSwarm, swarmValidity, SWARM_CONTEXTS, SWARM_UNITS,
  type BranchContext, type SwarmUnitSetting,
} from '../src/strategy/swarm';
import { runSwarm } from '../src/strategy/swarm-run';
import { MockLanguageModelV3 } from 'ai/test';

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
  test('the three units are exactly answer/generator/thought', () => {
    expect([...SWARM_UNITS]).toEqual(['answer', 'generator', 'thought']);
  });

  test('the removed spellings are UNREPRESENTABLE, not merely refused', () => {
    // The migration guard. `trajectory` named the shape two of the three values now
    // have, and `step` never executed — accepting either beside the current set would
    // be the second spelling §6.4's first reason exists to prevent.
    expect(() => v.parse(SwarmConfigSchema, { unit: { kind: 'trajectory', inherit: true } })).toThrow();
    expect(() => v.parse(SwarmConfigSchema, { unit: { kind: 'step' } })).toThrow();
    // And no unit carries a parameter any more: the one it had is the `context` axis.
    expect(() => v.parse(SwarmConfigSchema, { unit: { kind: 'answer', inherit: true } })).toThrow();
  });

  test('a bare axis string is not a unit — the tag IS the value', () => {
    expect(() => v.parse(SwarmConfigSchema, { unit: 'answer' })).toThrow();
  });

  test('every declared unit resolves, so the rename removed no reachable value', () => {
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
   *  surface no longer has. Named rather than `object`, because the shape these
   *  tests send is exactly the thing under test. */
  interface CutSpelling {
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

  test('`observe` is refused by name, and told where each of its values went', () => {
    const error = refusal({ observe: 'ancestors' });
    expect(error).toContain('`observe` was cut entirely');
    expect(error).toContain('context:"fork"');
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
    // The load-bearing half of the re-homing. There is no longer a validity rule to
    // fail: the parse itself has nowhere to put an archive without its novelty test.
    expect(() => v.parse(SwarmConfigSchema, { advance: { kind: 'archive' } })).toThrow();
    expect(v.parse(SwarmConfigSchema, { advance: { kind: 'archive', novelty: 0.6 } }))
      .toMatchObject({ advance: { kind: 'archive', novelty: 0.6 } });
  });

  test('the three archive presets stopped resolving, and say why rather than guessing', () => {
    // The cost stated plainly: `redteam` USED to resolve and now does not, because
    // §6.3 never declared the threshold its archive arm now requires.
    for (const preset of ['research', 'audit', 'redteam'] as const) {
      const resolved = resolveSwarm({ preset, task: 'probe it', key: 'behaviour' });
      if (!('reason' in resolved)) throw new Error(`${preset} must be refused as undeclared`);
      expect(resolved.error).toContain(preset);
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
    expect(resolved.config.unit).toEqual({ kind: 'generator' });
    expect(resolved.config.score).toEqual({ kind: 'verify' });
    expect(resolved.config.advance).toEqual({ kind: 'best-first' });
    expect(resolved.config.carry).toEqual({ kind: 'artifacts', threshold: 1 });
    expect(resolved.caps.depth?.value).toBe(7);
    expect(resolved.settle).toBe('best');
  });

  test('`prove` without a checker is refused — the objective IS the checker', () => {
    // Two steps, as shipped: §6.3 resolves the row, §6.5 checks the resolved tuple.
    // `prove` scores by `verify`, and `verify` with nothing to measure is the refusal.
    const resolved = resolveSwarm({ preset: 'prove', task: 'show it' });
    if ('reason' in resolved) throw new Error(`prove must RESOLVE: ${resolved.error}`);
    const illegal = swarmValidity(resolved);
    if (!illegal) throw new Error('a prove call with no objective must be refused');
    expect(illegal.error).toContain('objective');
  });
});

describe('the context axis carries the inheritance question, at one spelling', () => {
  test('both values parse, and the axis is a bare picklist rather than a tagged value', () => {
    for (const context of SWARM_CONTEXTS) {
      expect(v.parse(SwarmConfigSchema, { context })).toMatchObject({ context });
    }
    expect(() => v.parse(SwarmConfigSchema, { context: 'inherit' })).toThrow();
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

  test('a named preset supplies it from §6.3s row, the verifier presets inheriting', () => {
    // The verifier presets take `fork` because that is what the cut
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
    expect(optimise.config.context).toBe('fork');

    const ideate = resolveSwarm({ preset: 'ideate', task: 'name some approaches' });
    if ('reason' in ideate) throw new Error(`ideate did not resolve: ${ideate.error}`);
    expect(ideate.config.context).toBe('fresh');
  });
});

describe('the composition that was permanently refused is no longer refused', () => {
  test('a tool-using node run starts — no `unsupported` about a shared workspace', async () => {
    // Reaching the model at all is the claim: `regionRefusal` is the first thing
    // `runSwarm` does and it spends nothing, so a refusal would come back before any
    // call. This model answers once and stops, which is the smallest run that proves
    // the region opened; what an agent node DOES with its tools is the behavioural
    // suite's subject, not this one's.
    const { rt } = createTestRuntime();
    const result = await runSwarm({
      rt,
      model: new MockLanguageModelV3({
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
      maxSteps: 2,
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
