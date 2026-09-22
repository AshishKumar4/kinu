/**
 * An unknown `fact` action must be refused and leave the store untouched;
 * a fallthrough default once deleted the named key.
 */

import { describe, test, expect } from 'bun:test';
import { buildBuiltinTools } from '../src/tools/builtins';
import { toolExecute } from '@kinu.run/test-utils';
import { createTestRuntime, storesFor } from './helpers';
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
  const tools = buildBuiltinTools({ rt, facts, history: storesFor(rt).history });

  return {
    execute: toolExecute<MemoryToolProbeInput, JsonValue>(tools.memory),
  };
}

describe('the memory tool refuses actions it does not know', () => {
  test('a misspelled action is named back to the model, not guessed at', async () => {
    const facts = recordingFacts();
    await expect(memoryTool(facts).execute({ action: 'forgt', key: 'deploy.target' }))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('forgt') });
  });

  test('and it deletes nothing on the way', async () => {
    const facts = recordingFacts();
    facts.upsert('deploy.target', 'production');

    await expect(memoryTool(facts).execute({ action: 'forgt', key: 'deploy.target' })).rejects.toMatchObject({ code: 'bad_input' });

    expect(facts.forgotten).toEqual([]);
    expect(facts.recall('deploy.target')?.value).toBe('production');
  });

  test('no unknown action reaches a mutating branch, whatever it is called', async () => {
    const facts = recordingFacts();
    facts.upsert('user.tz', 'UTC');
    const tool = memoryTool(facts);

    // Near-misses: a prefix/substring dispatch would let these through.
    for (const action of ['delete', 'remove', 'forget_all', 'rememberr', 'Forget', 'recall_all', '']) {
      await expect(tool.execute({ action, key: 'user.tz' })).rejects.toMatchObject({ code: 'bad_input' });
    }

    expect(facts.forgotten).toEqual([]);
    expect(facts.remembered).toEqual(['user.tz']);
    expect(facts.recall('user.tz')?.value).toBe('UTC');
  });

  test('the real actions still work — the guard is not just refusing everything', async () => {
    // Guards against a tool that does nothing passing the assertions above.
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

    await expect(memoryTool(facts).execute({ action: 'forget' })).rejects.toMatchObject({ code: 'bad_input' });

    expect(facts.forgotten).toEqual([]);
    expect(facts.recall('a')).not.toBeNull();
    expect(facts.recall('b')).not.toBeNull();
  });
});
