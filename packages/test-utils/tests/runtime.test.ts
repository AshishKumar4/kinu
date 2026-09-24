/**
 * Defends: the shared test runtime answered unsupported work with success-shaped values (an
 * executor resolving `{ result: undefined }`, memory and crafted-tool writes discarded, an echo
 * model), so a test could pass on work nothing performed (CQ-009).
 */
import { describe, expect, test } from 'bun:test';
import type { ExecuteResult } from '@kinu.run/core';
import { createScriptedLLM } from '../src/llm';
import { createTestRuntime, UnsupportedTestCapability } from '../src/runtime';

describe('createTestRuntime refuses work it does not perform', () => {
  const { rt } = createTestRuntime();

  const unsupported: readonly (readonly [string, () => Promise<void>, string])[] = [
    ['code execution', async () => { await rt.executor.execute('return 1', []); }, 'opts.executor'],
    ['a model call', async () => { await rt.llm.complete('score this'); }, 'opts.llm'],
    ['a memory write', () => rt.memory.write('MEMORY.md', 'kept?'), 'opts.memory'],
    ['a crafted-tool write', async () => {
      rt.craftStore.create({
        name: 'double', description: 'doubles', params: null, code: 'async (n) => n * 2', scope: 'local',
      });
    }, 'opts.craftStore'],
    ['a delayed callback', () => rt.schedule.after(10, async () => {}), 'opts.schedule'],
    ['a durable fiber', async () => { await rt.schedule.fiber('work', async () => 'done'); }, 'opts.schedule'],
    ['a scaffold write', () => rt.identity.scaffold.write('export default {}'), 'scaffold surface'],
    ['a branch exploration', async () => { await rt.spawnBranch('try another angle'); }, 'spawns branches'],
  ];

  for (const [capability, ask, option] of unsupported) {
    test(`${capability} fails by name and says what to pass`, async () => {
      const outcome = ask();

      await expect(outcome).rejects.toBeInstanceOf(UnsupportedTestCapability);
      await expect(outcome).rejects.toThrow(option);
    });
  }
});

describe('a supplied capability does the work the default refuses', () => {
  test('a test that brings an executor and a model gets their answers', async () => {
    const ran: string[] = [];

    const { rt } = createTestRuntime({
      llm: createScriptedLLM(['0.8']),
      executor: {
        languages: ['javascript'],
        execute: async (code): Promise<ExecuteResult> => {
          ran.push(code);

          return { result: 2 };
        },
      },
    });

    expect(await rt.executor.execute('return 1 + 1', [])).toEqual({ result: 2 });
    expect(ran).toEqual(['return 1 + 1']);
    expect(await rt.llm.complete('score this')).toBe('0.8');
  });
});
