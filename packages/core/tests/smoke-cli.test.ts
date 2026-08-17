/**
 * Layer 3: CLI smoke test — instantiate a full runtime with temp SQLite,
 * verify 6 primitives, run minimal MCTS, verify DB tables and rows.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  makeSql,
  makeExecRaw,
  createMemoryVFS,
  createMemoryMemory,
  createMemoryCraftStore,
  createMockLLM,
  createMockExecutor,
  createMemorySchedule,
  createMockSession,
} from './helpers.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { Identity } from '../src/types/primitives.js';
import { initSearchTables } from '../src/mcts/schemas.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';
import { initCraftScoreTables } from '../src/craft/schemas.js';
import { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from '../src/scaffold/bootstrap.js';
import { runMCTS } from '../src/mcts/engine.js';

function createFullCLIRuntime() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const vfs = createMemoryVFS(db);
  const memory = createMemoryMemory(db, vfs);
  const craftStore = createMemoryCraftStore(db);
  const llm = createMockLLM({
    'Summarize': '- approach A worked\n- clean separation',
  });
  const executor = createMockExecutor();
  const schedule = createMemorySchedule(db);

  // Stable identity
  execRaw('CREATE TABLE IF NOT EXISTS workspace_identity (id TEXT, name TEXT)');
  const agentId = crypto.randomUUID();
  db.run('INSERT INTO workspace_identity (id, name) VALUES (?, ?)', [agentId, 'cli-agent']);

  const identity: Identity = {
    id: agentId,
    name: 'cli-agent',
    scaffold: {
      path: 'scaffold/agent.js',
      exists: () => vfs.exists('scaffold/agent.js'),
      read: async () => v.parse(v.string(), await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })),
      write: (code) => vfs.writeFile('scaffold/agent.js', code),
      version: async () => (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };

  const rt: AgentRuntime = {
    storage: { vfs, sql, execRaw },
    memory,
    executor,
    llm,
    schedule,
    identity,
    craftStore,
    judgeModel: llm,
    spawnBranch: async () => ({
      explore: async () => ({ text: 'cli branch explored' }),
      generateReflection: async () => ({ text: 'cli branch reflection' }),
    }),
    abortBranch: async () => {},
    releaseBranch: async () => {},
  };

  return { rt, db };
}

describe('CLI smoke test', () => {
  test('6 primitives are available and functional', async () => {
    const { rt } = createFullCLIRuntime();

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

    // 6. Identity: scaffold
    expect(rt.identity.id).toBeTruthy();
    expect(rt.identity.name).toBe('cli-agent');
  });

  test('bootstrap creates scaffold on cold start', async () => {
    const { rt } = createFullCLIRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);

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
    const { rt, db } = createFullCLIRuntime();
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftScoreTables(rt.storage.execRaw);

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

    // Verify craft_scores table exists
    const csCount = db.query<{ c: number }, []>(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='craft_scores'",
    ).get();
    if (!csCount) throw new Error('expected craft table count');
    expect(csCount.c).toBe(1);

    // Verify memory has entries
    const memContent = await rt.memory.read('memory/MEMORY.md');
    expect(memContent).toBeTruthy();
    expect(memContent).toContain('Successful approach');
  });
});
