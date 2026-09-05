import { describe, test, expect } from 'bun:test';
import { runSleepTimeCompute, applySleepTimeUpdate } from '../src/index';
import { createTestFactsStore, createJSONLLM, createScriptedLLM } from '@kinu.run/test-utils';

describe('Sleep-time compute', () => {
  test('parses valid LLM response', async () => {
    const judge = createJSONLLM({
      upserts: [{ key: 'user.tz', value: 'America/Los_Angeles', confidence: 0.9, rationale: 'mentioned in turn' }],
      decay: ['stale.fact'],
    });
    const update = await runSleepTimeCompute(judge, {
      task: 'configure deploy', output: '...', toolCalls: ['workspace.exec'],
      currentFacts: [],
    });
    expect(update).not.toBeNull();
    expect(update!.upserts.length).toBe(1);
    expect(update!.decay).toEqual(['stale.fact']);
  });

  test('prompt explicitly lists existing keys for exact reuse', async () => {
    const judge = createScriptedLLM(['{"upserts":[],"decay":[]}']);
    const currentFacts = Array.from({ length: 31 }, (_, index) => ({
      key: `existing.key_${index}`,
      value: index,
      confidence: 1,
    }));
    await runSleepTimeCompute(judge, {
      task: 'inspect runtime', output: 'done', toolCalls: [],
      currentFacts,
    });

    expect(judge.prompts[0]).toContain('Existing fact keys (reuse these exact keys');
    expect(judge.prompts[0]).toContain('existing.key_0');
    expect(judge.prompts[0]).toContain('existing.key_30');
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

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'new.fact', value: 42, confidence: 0.9, rationale: '' }],
      decay: ['decay.this'],
    });

    expect(summary.upserted).toBe(1);
    expect(summary.decayed).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(facts.recall('decay.this')!.confidence).toBeLessThan(1.0);
  });

  test('rejects an update with a missing fact value before any write', async () => {
    const { facts } = createTestFactsStore();
    const judge = createScriptedLLM([
      '{"upserts":[{"key":"ok.1","value":"fine","confidence":1,"rationale":""},{"key":"bad","confidence":1,"rationale":""}],"decay":[]}',
    ]);
    const update = await runSleepTimeCompute(judge, {
      task: 't', output: 'o', toolCalls: [], currentFacts: [],
    });

    expect(update).toBeNull();
    expect(facts.recall('ok.1')).toBeNull();
    expect(facts.recall('bad')).toBeNull();
  });

  test('canonicalizes upsert keys before writing', () => {
    const { facts } = createTestFactsStore();
    const summary = applySleepTimeUpdate(facts, {
      upserts: [{
        key: '  Sandbox.NPM   Version  ', value: 'npm v10', confidence: 0.9, rationale: '',
      }],
      decay: [],
    });

    expect(summary.upserted).toBe(1);
    expect(facts.recall('sandbox.npm_version')?.value).toBe('npm v10');
    expect(facts.recall('  Sandbox.NPM   Version  ')?.value).toBe('npm v10');
  });

  test('same-value re-observation is not counted as an upsert or refreshed', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('sandbox.npm_version', 'npm v10');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'sandbox.npm_version'`;

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'Sandbox.NPM_Version', value: 'npm v10', confidence: 0.95, rationale: '' }],
      decay: [],
    });

    expect(summary.upserted).toBe(0);
    expect(facts.recall('sandbox.npm_version')?.lastObservedAt).toBe(1000);
    expect(facts.recall('sandbox.npm_version')?.confidence).toBe(0.95);
  });

  test('changed value is counted and refreshes the fact', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('sandbox.npm_version', 'npm v9');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'sandbox.npm_version'`;

    const summary = applySleepTimeUpdate(facts, {
      upserts: [{ key: 'sandbox.npm_version', value: 'npm v10', confidence: 0.9, rationale: '' }],
      decay: [],
    });

    expect(summary.upserted).toBe(1);
    expect(facts.recall('sandbox.npm_version')?.value).toBe('npm v10');
    expect(facts.recall('sandbox.npm_version')?.lastObservedAt).toBeGreaterThan(1000);
  });

  test('rejects an update with out-of-range confidence before any write', async () => {
    const { facts } = createTestFactsStore();
    const judge = createScriptedLLM([
      '{"upserts":[{"key":"ok.1","value":"fine","confidence":99,"rationale":""}],"decay":[]}',
    ]);
    const update = await runSleepTimeCompute(judge, {
      task: 't', output: 'o', toolCalls: [], currentFacts: [],
    });

    expect(update).toBeNull();
    expect(facts.recall('ok.1')).toBeNull();
  });
});
