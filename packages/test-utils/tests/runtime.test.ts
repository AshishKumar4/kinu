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

  const unsupported: readonly (readonly [string, () => Promise<void>])[] = [
    ['code execution', async () => { await rt.executor.execute('return 1', []); }],
    ['a model call', async () => { await rt.llm.complete('score this'); }],
    ['a memory write', () => rt.memory.write('MEMORY.md', 'kept?')],
    ['a crafted-tool write', async () => {
      rt.craftStore.create({
        name: 'double', description: 'doubles', code: 'async (n) => n * 2',
      });
    }],
    ['a delayed callback', () => rt.schedule.after(10, async () => {})],
    ['a durable fiber', async () => { await rt.schedule.fiber('work', async () => 'done'); }],
    ['a scaffold read', async () => { await rt.identity.scaffold.read(); }],
  ];

  for (const [capability, ask] of unsupported) {
    test(`${capability} fails by name`, async () => {
      const outcome = ask();

      await expect(outcome).rejects.toBeInstanceOf(UnsupportedTestCapability);
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
