import { describe, test, expect } from 'bun:test';
import { renderFactsBlock } from '../src/memory/facts';
import { createTestFactsStore } from '@proteus/test-utils';

describe('agent_facts', () => {
  test('upsert + recall round-trip', () => {
    const { facts } = createTestFactsStore();
    facts.upsert('user.tz', 'America/Los_Angeles');
    const f = facts.recall('user.tz');
    expect(f?.key).toBe('user.tz');
    expect(f?.value).toBe('America/Los_Angeles');
    expect(f?.confidence).toBe(1);
  });

  test('upsert is idempotent: second write overwrites', () => {
    const { facts } = createTestFactsStore();
    expect(facts.upsert('deploy.target', 'foo.workers.dev')).toBe('created');
    expect(facts.upsert('deploy.target', 'bar.workers.dev', { confidence: 0.8, source: 'cli' })).toBe('changed');
    const f = facts.recall('deploy.target');
    expect(f?.value).toBe('bar.workers.dev');
    expect(f?.confidence).toBe(0.8);
    expect(f?.source).toBe('cli');
  });

  test('same-value re-observation preserves the changelog timestamp', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('sandbox.npm_version', 'npm v10');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'sandbox.npm_version'`;

    expect(facts.upsert('sandbox.npm_version', 'npm v10', {
      confidence: 0.9,
      source: 'sleep-time-compute',
    })).toBe('unchanged');

    const fact = facts.recall('sandbox.npm_version');
    expect(fact?.lastObservedAt).toBe(1000);
    expect(fact?.confidence).toBe(0.9);
    expect(fact?.source).toBe('sleep-time-compute');
  });

  test('value change advances the changelog timestamp', () => {
    const { facts, testSql } = createTestFactsStore();
    facts.upsert('sandbox.npm_version', 'npm v9');
    void testSql.sql`UPDATE agent_facts SET last_observed_at = 1000
                WHERE key = 'sandbox.npm_version'`;

    expect(facts.upsert('sandbox.npm_version', 'npm v10')).toBe('changed');
    expect(facts.recall('sandbox.npm_version')?.lastObservedAt).toBeGreaterThan(1000);
  });

  test('forget removes the key', () => {
    const { facts } = createTestFactsStore();
    facts.upsert('temp', 'value');
    expect(facts.recall('temp')).not.toBeNull();
    facts.forget('temp');
    expect(facts.recall('temp')).toBeNull();
  });

  test('recall returns null for unset keys', () => {
    const { facts } = createTestFactsStore();
    expect(facts.recall('missing')).toBeNull();
  });

  test('JSON values round-trip', () => {
    const { facts } = createTestFactsStore();
    const value = { project: 'proteus', stage: 'audit', open_tasks: 3 };
    facts.upsert('current', value);
    const f = facts.recall('current');
    expect(f?.value).toEqual(value);
  });

  test('recentTopK returns most-recent first', async () => {
    const { facts } = createTestFactsStore();
    facts.upsert('a', 1);
    await new Promise(r => setTimeout(r, 5));
    facts.upsert('b', 2);
    await new Promise(r => setTimeout(r, 5));
    facts.upsert('c', 3);
    const top = facts.recentTopK(2);
    expect(top.length).toBe(2);
    expect(top[0].key).toBe('c');
    expect(top[1].key).toBe('b');
  });

  test('renderFactsBlock truncates at maxChars and DISCLOSES what it dropped', () => {
    const { facts } = createTestFactsStore();
    for (let i = 0; i < 100; i++) facts.upsert(`k${i}`, `v${i}`.repeat(20));
    const block = renderFactsBlock(facts.recentTopK(50), { maxChars: 200 });
    const [disclosure, ...factLines] = block.split('\n').reverse();
    expect(factLines.join('\n').length).toBeLessThanOrEqual(200);
    expect(disclosure).toMatch(/…and \d+ more facts not shown/);
  });

  test('renderFactsBlock empty input returns empty string', () => {
    expect(renderFactsBlock([])).toBe('');
  });
});
