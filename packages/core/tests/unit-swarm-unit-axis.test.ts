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
  resolveSwarm, SWARM_CONTEXTS, SWARM_UNITS,
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
      observe: 'none' as const,
      expand: 'sample' as const,
      decorrelate: 'angles' as const,
      score: { kind: 'none' as const },
      advance: 'none' as const,
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

  test('a named preset supplies it from §6.3s row, verifier presets forking', () => {
    // The two verifier presets take `fork` because a fork IS the cut
    // `observe:'ancestors'` by construction; the archive presets take `fresh` because a
    // probe of a new coverage cell wants the parent's RESULTS, not its transcript.
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
