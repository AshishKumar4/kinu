/**
 * The `unit` axis, tagged — and the one thing the tag exists to make sayable.
 *
 * `fork`'s meaning was lifetime AND context: a child running on the caller's own
 * completed turns, against one starting blank. The context half had no spelling on
 * the swarm surface, and `decorrelate` is not it — that axis is sibling-to-sibling
 * ("how hard children are pushed apart"), while inheritance is caller-to-child. So
 * it lives on `unit:'trajectory'`, the only unit with a conversation to start FROM.
 *
 * These tests assert the two halves that are observable: the tag is REPRESENTABLE
 * only where it means something (the parse), and composing it produces §8.6's
 * disclosure rather than a silent redirect (the run). §8.6 measured the
 * `agent-trajectory-search` region at 18% because models compose the shape
 * CORRECTLY, the design blocks it, and nothing on the surface said so — so "the
 * refusal names the blocker" is the contract under test, not a wording preference.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { MockLanguageModelV3 } from 'ai/test';
import { createTestRuntime } from '@proteus/test-utils';
import { SwarmConfigSchema } from '../src/tools/swarm-input';
import { resolveSwarm } from '../src/strategy/swarm';
import { runSwarm } from '../src/strategy/swarm-run';

/** A composition legal in every respect except the axis under test, so a refusal can
 *  only ever be about `unit`. */
function trajectoryCall(inherit: boolean) {
  return {
    preset: 'custom' as const,
    task: 'find the cheapest correct implementation',
    label: 'unit-axis',
    config: {
      unit: { kind: 'trajectory' as const, inherit },
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

/**
 * `regionRefusal` is the first thing `runSwarm` does and it spends nothing, so the
 * refusal is observable without a model call ever being made — which is also the
 * ordering §2.3 requires (a run that will not start must not pay for a baseline).
 */
async function refusalFor(inherit: boolean) {
  const { rt } = createTestRuntime();
  const resolved = resolveSwarm(trajectoryCall(inherit));
  if ('reason' in resolved) throw new Error(`the fixture must resolve: ${resolved.error}`);
  const result = await runSwarm({ rt, model: new MockLanguageModelV3(), mode: 'build' }, resolved);
  if (!('reason' in result)) throw new Error('unit:"trajectory" must be refused, and was not');
  return result;
}

describe('the unit axis carries the caller-context question', () => {
  test('`inherit` is representable on trajectory and unrepresentable on every other unit', () => {
    // The point of tagging rather than adding a free field beside the axis: there is
    // no absent case to reason about, because the parameter cannot exist unless the
    // value that owns it does.
    expect(v.parse(SwarmConfigSchema, { unit: { kind: 'trajectory', inherit: true } }))
      .toMatchObject({ unit: { kind: 'trajectory', inherit: true } });
    expect(v.parse(SwarmConfigSchema, { unit: { kind: 'trajectory', inherit: false } }))
      .toMatchObject({ unit: { kind: 'trajectory', inherit: false } });

    // A node with no conversation cannot be asked whether it inherits one.
    for (const kind of ['step', 'answer', 'generator']) {
      expect(() => v.parse(SwarmConfigSchema, { unit: { kind, inherit: true } })).toThrow();
    }
    // And trajectory cannot DECLINE to answer: absent is not false here.
    expect(() => v.parse(SwarmConfigSchema, { unit: { kind: 'trajectory' } })).toThrow();
  });

  test('a bare axis string is not a unit — the tag IS the value', () => {
    // Guards the migration itself: `unit:'answer'` was the old spelling, and accepting
    // it beside the tagged form would be the second spelling §6.4's first reason
    // exists to prevent.
    expect(() => v.parse(SwarmConfigSchema, { unit: 'answer' })).toThrow();
  });

  test('every declared unit still resolves, so tagging removed no value', () => {
    const base = trajectoryCall(false);
    for (const kind of ['step', 'answer', 'generator'] as const) {
      const resolved = resolveSwarm({ ...base, config: { ...base.config, unit: { kind } } });
      if ('reason' in resolved) throw new Error(`unit:${kind} did not resolve: ${resolved.error}`);
      expect(resolved.config.unit).toEqual({ kind });
    }
  });
});

describe('§8.6: the blocked composition is SAID, not omitted', () => {
  test('unit:"trajectory" refuses as `unsupported`, naming the blocker and its remedy', async () => {
    const refusal = await refusalFor(false);
    // `unsupported`, not `bad_input`: the composition is CORRECT for the task and
    // permanently unrunnable here, and the two codes are the retry/permanent line.
    expect(refusal.reason).toBe('unsupported');
    // The blocker itself — the reason a node cannot be graded, not merely that it
    // cannot. This sentence is what the measured 18% was missing.
    expect(refusal.error).toContain('shares ONE workspace');
    expect(refusal.error).toContain('graded on what it changed');
    // What would unblock it, stated as the only thing that would.
    expect(refusal.error).toContain('per-node workspace isolation');
    // ONE imperative, per §7.2 — a refusal offering two remedies was measured being
    // corrected to the wrong one.
    expect(refusal.error).toContain('unit:"answer"');
    // And it does NOT offer "wait for isolation", which is not something a caller can
    // do about it.
    expect(refusal.error).not.toMatch(/wait for|once isolation|when isolation/i);
  });

  test('inheriting the caller\'s turns does not change the verdict, and the refusal says why', async () => {
    // The interesting half: `inherit` is the capability the delegation ladder used to
    // spell as a verb, so a caller who sets it is asking for the closest thing to the
    // old `fork`. It is still refused, and the refusal separates the blocker from the
    // thing the caller actually asked for — otherwise the natural next move is to
    // toggle `inherit` and try again.
    const inherited = await refusalFor(true);
    expect(inherited.reason).toBe('unsupported');
    expect(inherited.error).toContain('the blocker is the shared workspace, not the context');

    // The uninherited form does NOT carry that sentence, so this is a real
    // discrimination rather than boilerplate on both arms.
    const fresh = await refusalFor(false);
    expect(fresh.error).not.toContain('the blocker is the shared workspace, not the context');
  });

  test('the refusal is reason-FIRST, so a clamp cannot cut the discriminator off', async () => {
    const serialized = JSON.stringify(await refusalFor(true));
    expect(serialized.indexOf('"reason"')).toBeLessThan(serialized.indexOf('"error"'));
  });
});
