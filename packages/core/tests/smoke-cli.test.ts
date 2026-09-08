/**
 * Layer 3: CLI smoke test — one full runtime over the PRODUCTION workspace
 * schema, six primitives exercised through it, then a minimal MCTS run and the
 * rows it leaves behind.
 *
 * The runtime comes from `createTestRuntime`, not from a fixture of its own.
 * The fixture this file used to carry declared `workspace_identity (id TEXT,
 * name TEXT)` by hand and inserted a row into it, which is a workspace no
 * composition root can produce: the real column list carries `owner_user_id`,
 * and the actor DIRECTORY the identity binds through was never created at all.
 * A seeded identity row is also the signal `createTestActor` reads to take the
 * OPEN path — `openWorkspaceMainActor` — so every test here died in the fixture
 * on `no such column: owner_user_id` before reaching an assertion. Hand-written
 * DDL beside a real schema is how a harness ends up testing a shape production
 * never has.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createMockSession } from './helpers';
import { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from '../src/scaffold/bootstrap';
import { runMCTS } from '../src/mcts/engine';

const LLM_RESPONSES = { Summarize: '- approach A worked\n- clean separation' };

describe('CLI smoke test', () => {
  test('6 primitives are available and functional', async () => {
    const { rt } = createTestRuntime({ llmResponses: LLM_RESPONSES });

    // 1. Storage: VFS write + read
    await rt.storage.vfs.writeFile('test/hello.txt', 'world');
    const content = await rt.storage.vfs.readFile('test/hello.txt', { encoding: 'utf8' });
    expect(content).toBe('world');

    // 2. Memory: write + search
    await rt.memory.write('memory/test.md', 'test content for searching');
    await rt.memory.index('memory/test.md');
    const results = await rt.memory.search('searching');
    expect(results.length).toBeGreaterThan(0);

    // 3. Executor: parse check
    const execResult = await rt.executor.execute('return 42', []);
    expect(execResult.error).toBeUndefined();

    // 4. LLM: complete
    const completion = await rt.llm.complete('hello');
    expect(completion.length).toBeGreaterThan(0);

    // 5. Schedule: fiber
    const fiberResult = await rt.schedule.fiber('test-fiber', async (ctx) => {
      ctx.stash({ step: 1 });
      return 'fiber-done';
    });
    expect(fiberResult).toBe('fiber-done');

    // 6. Identity: the scaffold surface answers over the real per-actor ledger —
    // a version read on a workspace that has published none is 0, not a throw,
    // which is the answer only the production schema can give.
    expect(await rt.identity.scaffold.exists()).toBe(true);
    expect(await rt.identity.scaffold.version()).toBe(0);
  });

  test('bootstrap creates scaffold on cold start', async () => {
    const { rt } = createTestRuntime({ llmResponses: LLM_RESPONSES });

    // Ensure no scaffold exists (simulate cold start)
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

    // Verify result
    expect(result.converged).toBe(true);

    // Verify DB tables exist and have rows
    const nodeCount = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM search_nodes').get();
    if (!nodeCount) throw new Error('expected search node count');
    expect(nodeCount.c).toBe(5); // 1 root + 2 iterations × 2 branches

    // Verify scaffold_versions table exists
    const svCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='scaffold_versions'",
    ).get();
    if (!svCount) throw new Error('expected scaffold table count');
    expect(svCount.c).toBe(1);

    // Verify the crafted-tools quality columns exist
    const cols = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('crafted_tools')",
    ).all().map((r) => r.name);
    expect(cols).toContain('score');

    // Verify memory has entries
    const memContent = await rt.memory.read('memory/MEMORY.md');
    expect(memContent).toContain('Successful approach');
  });
});
