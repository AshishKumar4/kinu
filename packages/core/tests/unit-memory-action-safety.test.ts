/**
 * A malformed tool call must never destroy state.
 *
 * The defect this locks: the old `fact` tool dispatched with
 * `if (action === 'remember') … if (action === 'recall') …` and then simply
 * fell through to `forget`. Every action name the model got wrong — a typo, a
 * hallucinated verb, a stale name from an older prompt — deleted the key it
 * named. The most destructive branch was the one you reached by NOT matching
 * anything, which is the worst possible place to put it.
 *
 * The suite never caught it because the tests all called the three real
 * actions, and all three behaved correctly. The bug lived entirely in the
 * space of inputs nobody tested — which is where a fallthrough default always
 * lives.
 *
 * So these are degenerate-input tests by design: they assert that the unknown
 * action is REFUSED, and, separately, that the store was not touched. Refusing
 * and quietly deleting look identical if you only check the return value.
 */

import { describe, test, expect } from 'bun:test';
import { buildBuiltinTools } from '../src/tools/builtins';
import { toolExecute } from '@kinu/test-utils';
import { createTestRuntime } from './helpers';
import type { Fact, FactsStore } from '../src/memory/facts';
import type { JsonValue } from '../src/utils/json';

interface MemoryToolProbeInput {
  action: string;
  key?: string;
  value?: JsonValue;
}

interface RecordingFacts extends FactsStore {
  forgotten: string[];
  remembered: string[];
}

/** An in-memory FactsStore that also records every mutation attempted on it. */
function recordingFacts(): RecordingFacts {
  const rows = new Map<string, Fact>();
  const forgotten: string[] = [];
  const remembered: string[] = [];
  return {
    forgotten,
    remembered,
    upsert(key, value, opts) {
      remembered.push(key);
      const existing = rows.has(key);
      rows.set(key, {
        key,
        value,
        confidence: opts?.confidence ?? 1,
        source: opts?.source ?? 'tool',
        lastObservedAt: 0,
      });
      return existing ? 'changed' : 'created';
    },
    recall(key) {
      return rows.get(key) ?? null;
    },
    forget(key) {
      forgotten.push(key);
      rows.delete(key);
    },
    recentTopK(k) {
      return [...rows.values()].slice(0, k);
    },
    all() {
      return [...rows.values()];
    },
  };
}

function memoryTool(facts: FactsStore) {
  const { rt } = createTestRuntime();
  const tools = buildBuiltinTools({ rt, facts });
  return {
    execute: toolExecute<MemoryToolProbeInput, JsonValue>(tools.memory),
  };
}

describe('the memory tool refuses actions it does not know', () => {
  test('a misspelled action is named back to the model, not guessed at', async () => {
    const facts = recordingFacts();
    const result = await memoryTool(facts).execute({ action: 'forgt', key: 'deploy.target' });

    // Naming the action back is what lets the model correct itself; a generic
    // "invalid input" leaves it retrying the same wrong verb.
    expect(JSON.stringify(result)).toContain('forgt');
  });

  test('and it deletes nothing on the way', async () => {
    const facts = recordingFacts();
    facts.upsert('deploy.target', 'production');

    await memoryTool(facts).execute({ action: 'forgt', key: 'deploy.target' });

    expect(facts.forgotten).toEqual([]);
    expect(facts.recall('deploy.target')?.value).toBe('production');
  });

  test('no unknown action reaches a mutating branch, whatever it is called', async () => {
    const facts = recordingFacts();
    facts.upsert('user.tz', 'UTC');
    const tool = memoryTool(facts);

    // Names chosen to sit next to the real ones: near-misses are what a model
    // actually emits, and a prefix/substring dispatch would let them through.
    for (const action of ['delete', 'remove', 'forget_all', 'rememberr', 'Forget', 'recall_all', '']) {
      await tool.execute({ action, key: 'user.tz' });
    }

    expect(facts.forgotten).toEqual([]);
    expect(facts.remembered).toEqual(['user.tz']); // only the setup call
    expect(facts.recall('user.tz')?.value).toBe('UTC');
  });

  test('the real actions still work — the guard is not just refusing everything', async () => {
    // Without this, every assertion above would pass on a tool that does
    // nothing at all.
    const facts = recordingFacts();
    const tool = memoryTool(facts);

    await tool.execute({ action: 'remember', key: 'user.tz', value: 'Europe/Berlin' });
    expect(await tool.execute({ action: 'recall', key: 'user.tz' }))
      .toMatchObject({ found: true, value: 'Europe/Berlin' });

    await tool.execute({ action: 'forget', key: 'user.tz' });
    expect(facts.forgotten).toEqual(['user.tz']);
    expect(await tool.execute({ action: 'recall', key: 'user.tz' })).toMatchObject({ found: false });
  });

  test('forget still requires a key rather than treating a missing one as "all"', async () => {
    const facts = recordingFacts();
    facts.upsert('a', 1);
    facts.upsert('b', 2);

    await memoryTool(facts).execute({ action: 'forget' });

    expect(facts.forgotten).toEqual([]);
    expect(facts.recall('a')).not.toBeNull();
    expect(facts.recall('b')).not.toBeNull();
  });
});
