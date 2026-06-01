/**
 * GEPA → CraftStore bridge tests.
 *
 * Uses a fake AgentRuntime with an in-memory CraftStore + VFS so we can
 * assert craftStore.update was called and a backup file was written.
 */

import { describe, test, expect } from 'bun:test';
import { runCraftedToolGepa } from './tool-bridge.js';
import { createTestRuntime } from '../../../tests/helpers.js';
import type { EvalInstance, MetricOutcome } from './types.js';

function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 0xffffffff;
    return s / 0xffffffff;
  };
}

const VALID_BODY = `async (args) => {
  return { ok: true };
}`;

const VALID_IMPROVED = `async (args) => {
  return { ok: true, improved: true };
}`;

describe('runCraftedToolGepa', () => {
  test('commits the winner to craftStore.update + writes a backup', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'foo-tool',
      description: 'demo',
      params: null,
      code: VALID_BODY,
      scope: 'local',
    });

    const evalSet: EvalInstance<string>[] = [{ id: 'i1', input: 'task' }];
    const metric = async (source: string): Promise<MetricOutcome> =>
      source.includes('improved') ? { score: 0.9, feedback: 'ok' } : { score: 0.5, feedback: 'meh' };
    const reflectionLm = async () => VALID_IMPROVED;

    const result = await runCraftedToolGepa({
      rt,
      toolName: 'foo-tool',
      evalSet,
      metric,
      reflectionLm,
      budget: { maxIterations: 2, maxMetricCalls: 50, minibatchSize: 1 },
      random: seededRng(3),
    });

    expect(result.promoted).toBe(true);
    expect(result.promotedAt).not.toBeNull();
    expect(result.backupPath).toMatch(/^memory\/crafted-tool-backups\/foo-tool\.v\d+\.js$/);

    // CraftStore now holds the improved code.
    expect(rt.craftStore.get('foo-tool')?.code).toContain('improved');

    // Backup file contains the prior body.
    const backupContent = await rt.storage.vfs.readFile(result.backupPath!, { encoding: 'utf8' });
    const backup = typeof backupContent === 'string' ? backupContent : new TextDecoder().decode(backupContent);
    expect(backup).toBe(VALID_BODY);
  });

  test('returns tool_not_found when the tool does not exist', async () => {
    const { rt } = createTestRuntime();
    const result = await runCraftedToolGepa({
      rt,
      toolName: 'does-not-exist',
      evalSet: [{ id: 'i1', input: 'x' }],
      metric: async () => ({ score: 0.5, feedback: '' }),
      reflectionLm: async () => 'irrelevant',
    });
    expect(result.promoted).toBe(false);
    expect(result.skipReason).toBe('tool_not_found');
  });

  test('does NOT commit when winner equals seed', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'noop-tool',
      description: 'demo',
      params: null,
      code: VALID_BODY,
      scope: 'local',
    });
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.5, feedback: '' });
    const reflectionLm = async () => VALID_BODY;
    const result = await runCraftedToolGepa({
      rt,
      toolName: 'noop-tool',
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 1, maxMetricCalls: 10, minibatchSize: 1 },
      random: seededRng(1),
    });
    expect(result.promoted).toBe(false);
    expect(result.skipReason).toBe('winner_equals_seed');
    expect(rt.craftStore.get('noop-tool')?.code).toBe(VALID_BODY);
  });

  test('dryRun does not commit even with improvement', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'dry-tool',
      description: 'demo',
      params: null,
      code: VALID_BODY,
      scope: 'local',
    });
    const metric = async (source: string): Promise<MetricOutcome> =>
      source.includes('improved') ? { score: 0.9, feedback: '' } : { score: 0.5, feedback: '' };
    const reflectionLm = async () => VALID_IMPROVED;
    const result = await runCraftedToolGepa({
      rt,
      toolName: 'dry-tool',
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 1, maxMetricCalls: 10, minibatchSize: 1 },
      random: seededRng(1),
      dryRun: true,
    });
    expect(result.promoted).toBe(false);
    expect(result.skipReason).toBe('dry_run');
    expect(rt.craftStore.get('dry-tool')?.code).toBe(VALID_BODY);
  });

  test('rejects bodies with forbidden patterns', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'guarded',
      description: 'demo',
      params: null,
      code: VALID_BODY,
      scope: 'local',
    });
    let n = 0;
    const reflectionLm = async () => {
      n++;
      switch (n) {
        case 1: return `import bad from "bad";\n${VALID_IMPROVED}`;
        case 2: return `globalThis.x = 1;\n${VALID_IMPROVED}`;
        default: return `eval("hax");\n${VALID_IMPROVED}`;
      }
    };
    const metric = async (): Promise<MetricOutcome> => ({ score: 0.9, feedback: '' });
    const result = await runCraftedToolGepa({
      rt,
      toolName: 'guarded',
      evalSet: [{ id: 'i1', input: 'x' }],
      metric,
      reflectionLm,
      budget: { maxIterations: 3, maxMetricCalls: 50, minibatchSize: 1 },
      random: seededRng(1),
    });
    // All proposals rejected; winner stays at seed.
    expect(result.gepa.winner.source).toBe(VALID_BODY);
    expect(result.promoted).toBe(false);
    expect(rt.craftStore.get('guarded')?.code).toBe(VALID_BODY);
  });
});
