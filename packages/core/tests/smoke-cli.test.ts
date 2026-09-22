/**
 * CLI smoke test over the production workspace schema via `createTestRuntime`;
 * hand-written DDL would test a shape production never has.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createMockSession } from './helpers';
import { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from '../src/scaffold/bootstrap';
import { runMCTS } from '../src/mcts/engine';

const LLM_RESPONSES = { Summarize: '- approach A worked\n- clean separation' };

describe('CLI smoke test', () => {
  test('6 primitives are available and functional', async () => {
    const { rt } = createTestRuntime({ llmResponses: LLM_RESPONSES });

    await rt.storage.vfs.writeFile('test/hello.txt', 'world');
    const content = await rt.storage.vfs.readFile('test/hello.txt', { encoding: 'utf8' });
    expect(content).toBe('world');

    await rt.memory.write('memory/test.md', 'test content for searching');
    await rt.memory.index('memory/test.md');
    const results = await rt.memory.search('searching');
    expect(results.length).toBeGreaterThan(0);

    const execResult = await rt.executor.execute('return 42', []);
    expect(execResult.error).toBeUndefined();

    const completion = await rt.llm.complete('hello');
    expect(completion.length).toBeGreaterThan(0);

    const fiberResult = await rt.schedule.fiber('test-fiber', async (ctx) => {
      ctx.stash({ step: 1 });

      return 'fiber-done';
    });

    expect(fiberResult).toBe('fiber-done');

    // A workspace that published no scaffold reads version 0, not a throw.
    expect(await rt.identity.scaffold.exists()).toBe(true);
    expect(await rt.identity.scaffold.version()).toBe(0);
  });

  test('bootstrap creates scaffold on cold start', async () => {
    const { rt } = createTestRuntime({ llmResponses: LLM_RESPONSES });

    if (await rt.storage.vfs.exists('scaffold/agent.js')) {
      await rt.storage.vfs.unlink('scaffold/agent.js');
    }

    await bootstrapScaffold(rt);

    const exists = await rt.identity.scaffold.exists();
    expect(exists).toBe(true);

    const code = await rt.identity.scaffold.read();
    expect(code).toBe(INITIAL_SCAFFOLD_SOURCE);
  });

  test('full MCTS cycle creates correct DB tables and rows', async () => {
    const { rt, db } = createTestRuntime({ llmResponses: LLM_RESPONSES });

    const session = createMockSession();

    const result = await runMCTS(rt, session, 'Improve error handling', {
      budget: 2,
      branches: 2,
    });

    expect(result.converged).toBe(true);

    const nodeCount = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM search_nodes').get();

    if (!nodeCount) throw new Error('expected search node count');
    expect(nodeCount.c).toBe(5); // 1 root + 2 iterations × 2 branches

    const svCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='scaffold_versions'",
    ).get();

    if (!svCount) throw new Error('expected scaffold table count');
    expect(svCount.c).toBe(1);

    const cols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('crafted_tools')",
    ).all().map((r) => r.name);

    expect(cols).toContain('score');

    const memContent = await rt.memory.read('memory/MEMORY.md');
    expect(memContent).toContain('Successful approach');
  });
});
