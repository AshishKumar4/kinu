/** Scaffold evolution with a real LLM. Needs AI_GATEWAY_BASE_URL and AI_GATEWAY_AUTH; skips otherwise. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { isE2EConfigured, loadAIGatewayProviders } from './ai-gateway-llm';
import { modifyScaffold } from '../../src/scaffold/modify';
import { rollbackScaffold } from '../../src/scaffold/rollback';
import { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from '../../src/scaffold/bootstrap';
import { initScaffoldTables } from '../../src/scaffold/schemas';
import type { AgentRuntime } from '../../src/types/agent-runtime';
import type { LLM } from '../../src/types/primitives';
import {
  makeSql, makeExecRaw, createTestActor, createMemoryVFS, createMemoryMemory,
  createMemoryCraftStore, createMockExecutor, createMemorySchedule,
} from '../helpers';

function createScaffoldTestRuntime(llm: LLM) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const vfs = createMemoryVFS(db);

  const actor = createTestActor(sql, execRaw, crypto.randomUUID(), 'scaffold-test');

  const rt: AgentRuntime = {
    actor,
    storage: { vfs, sql, execRaw, transactionSync: write => db.transaction(write)() },
    memory: createMemoryMemory(db, vfs),
    executor: createMockExecutor(),
    llm, schedule: createMemorySchedule(db, actor),
    identity: {
      id: 'scaffold-test', name: 'scaffold-test',
      scaffold: {
        path: 'scaffold/agent.js',
        exists: () => vfs.exists('scaffold/agent.js'),
        read: async () => v.parse(v.string(), await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })),
        write: (code) => vfs.writeFile('scaffold/agent.js', code),
        version: async () => (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v
          FROM scaffold_versions WHERE actor_id = ${actor.actorId}`)[0]?.v ?? 0,
      },
    },
    craftStore: createMemoryCraftStore(db),
    spawnBranch: async () => ({ explore: async () => ({ text: '' }), generateReflection: async () => ({ text: '' }), release: async () => {} }),
    abortBranch: async () => {},
  };

  return { rt };
}

describe.skipIf(!isE2EConfigured())('E2E scaffold evolution', () => {
  test('LLM generates valid scaffold code that passes 4-gate', async () => {
    const { primary } = loadAIGatewayProviders();
    const { rt } = createScaffoldTestRuntime(primary);
    initScaffoldTables(rt.storage.execRaw);
    await bootstrapScaffold(rt);

    const generated = await primary.complete(
      `Write a JavaScript async generator function with this exact signature:\n\n` +
      `async function* run(rt, task) {\n  // your implementation here\n}\n\n` +
      `The function should yield objects like { type: "chunk", data: "text" }.\n` +
      `Use only the rt parameter. No imports, no require, no globalThis, no eval.\n` +
      `Return ONLY the function code, no markdown, no explanation.`,
    );

    const result = await modifyScaffold(
      rt,
      'LLM-generated scaffold improvement: adds basic task processing with chunked output.',
      generated,
    );

    // Live model output is not a contract: assert the pipeline never half-applies and the live scaffold is untouched.
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);

    if (result.ok) {
      const { version } = result;

      if (version === undefined) throw new Error(`accepted with no version: ${JSON.stringify(result)}`);
      expect(version).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
      expect(await rt.identity.scaffold.version()).toBe(version);

      const pending = await rt.storage.vfs.readFile(
        `${rt.identity.scaffold.path}.v${String(version)}`, { encoding: 'utf8' },
      );

      expect(pending).toBe(generated);
      expect(pending).not.toBe(INITIAL_SCAFFOLD_SOURCE);
    } else {
      const { stage } = result;

      if (stage === undefined) throw new Error(`refused with no stage: ${JSON.stringify(result)}`);
      expect([1, 2, 3]).toContain(stage);
      expect(result.error?.length ?? 0).toBeGreaterThan(0);
      expect(result.version).toBeUndefined();
      expect(await rt.identity.scaffold.version()).toBe(0);
    }
  });

  test('full scaffold lifecycle: bootstrap -> modify -> rollback', async () => {
    const { primary } = loadAIGatewayProviders();
    const { rt } = createScaffoldTestRuntime(primary);
    initScaffoldTables(rt.storage.execRaw);
    await bootstrapScaffold(rt);

    const v0 = await rt.identity.scaffold.read();
    expect(v0).toBe(INITIAL_SCAFFOLD_SOURCE);

    const validCode = `async function* run(rt, task) {
  yield { type: "chunk", data: "Processing: " + task.slice(0, 100) };
}`;

    const modResult = await modifyScaffold(
      rt,
      'Evolved scaffold with task classification: simple tasks get quick answers, complex get structured processing.',
      validCode,
    );

    expect(modResult.ok).toBe(true);
    expect(modResult.version).toBe(1);

    // Gate 4 writes the proposal to the versioned path, so the live file does not move (modify.ts).
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
    expect(await rt.storage.vfs.readFile(
      `${rt.identity.scaffold.path}.v1`, { encoding: 'utf8' },
    )).toBe(validCode);

    const rbResult = await rollbackScaffold(rt, 0);
    expect(rbResult.ok).toBe(true);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);

    const missing = await rollbackScaffold(rt, 99);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('99');
  });
});
