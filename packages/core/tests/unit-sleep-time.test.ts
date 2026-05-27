import { describe, test, expect } from 'bun:test';
import { runSleepTimeCompute, applySleepTimeUpdate } from '../src/index.ts';
import { createTestFactsStore, createJSONLLM, createScriptedLLM } from '@proteus/test-utils';

describe('Sleep-time compute', () => {
  test('parses valid LLM response', async () => {
    const judge = createJSONLLM({
      upserts: [{ key: 'user.tz', value: 'America/Los_Angeles', confidence: 0.9, rationale: 'mentioned in turn' }],
      decay: ['stale.fact'],
      scratchUpdate: 'User is configuring deploy targets.',
      workingSetAdds: ['foo.workers.dev', 'stripe key'],
    });
    const update = await runSleepTimeCompute(judge, {
      task: 'configure deploy', output: '...', toolCalls: ['workspace.exec'],
      currentFacts: [],
    });
    expect(update).not.toBeNull();
    expect(update!.upserts.length).toBe(1);
    expect(update!.decay).toEqual(['stale.fact']);
    expect(update!.scratchUpdate).toContain('deploy');
    expect(update!.workingSetAdds?.length).toBe(2);
  });

  test('returns null on unparseable response', async () => {
    const judge = createScriptedLLM(['No JSON here']);
    const update = await runSleepTimeCompute(judge, {
      task: 't', output: 'o', toolCalls: [], currentFacts: [],
    });
    expect(update).toBeNull();
  });

  test('applySleepTimeUpdate upserts facts + decays existing', () => {
    const { facts } = createTestFactsStore();
    facts.upsert('keep.this', 'value', { confidence: 1.0 });
    facts.upsert('decay.this', 'old', { confidence: 1.0 });

    const captured: Array<[string, string]> = [];
    const setBlock = (name: string, content: string) => { captured.push([name, content]); };

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'new.fact', value: 42, confidence: 0.9, rationale: '' }],
      decay: ['decay.this'],
      scratchUpdate: 'compressed summary',
      workingSetAdds: ['item-a', 'item-b'],
    }, setBlock);

    expect(summary.upserted).toBe(1);
    expect(summary.decayed).toBe(1);
    expect(summary.blocksWritten).toBe(2);
    expect(summary.skipped).toBe(0);
  });

  test('applySleepTimeUpdate skips non-serializable values atomically', () => {
    const { facts } = createTestFactsStore();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const summary = applySleepTimeUpdate(facts, {
      upserts: [
        { key: 'ok.1', value: 'fine', confidence: 1, rationale: '' },
        { key: 'bad', value: circular, confidence: 1, rationale: '' },
        { key: 'ok.2', value: 42, confidence: 1, rationale: '' },
      ],
      decay: [],
    });
    // Both safe upserts wrote; the circular one was skipped (no partial state).
    expect(summary.upserted).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(facts.recall('ok.1')?.value).toBe('fine');
    expect(facts.recall('ok.2')?.value).toBe(42);
    expect(facts.recall('bad')).toBeNull();
  });
});
