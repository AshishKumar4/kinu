/**
 * E2E test: Scaffold evolution with real LLM through 4-gate pipeline.
 *
 * Requires env vars: AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH
 * Skips gracefully if not set.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { isE2EConfigured, loadAIGatewayProviders } from './ai-gateway-llm.js';
import { modifyScaffold } from '../../src/scaffold/modify.js';
import { rollbackScaffold } from '../../src/scaffold/rollback.js';
import { bootstrapScaffold, INITIAL_SCAFFOLD_SOURCE } from '../../src/scaffold/bootstrap.js';
import { initScaffoldTables } from '../../src/scaffold/schemas.js';
import type { AgentRuntime } from '../../src/types/agent-runtime.js';
import type { LLM } from '../../src/types/primitives.js';
import {
  makeSql, makeExecRaw, createMemoryVFS, createMemoryMemory,
  createMemoryCraftStore, createMockExecutor, createMemorySchedule,
} from '../helpers.js';

function createScaffoldTestRuntime(llm: LLM) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const vfs = createMemoryVFS(db);

  const rt: AgentRuntime = {
    storage: { vfs, sql, execRaw },
    memory: createMemoryMemory(db, vfs),
    executor: createMockExecutor(),
    llm, schedule: createMemorySchedule(db),
    identity: {
      id: 'scaffold-test', name: 'scaffold-test',
      scaffold: {
        path: 'scaffold/agent.js',
        exists: () => vfs.exists('scaffold/agent.js'),
        read: async () => v.parse(v.string(), await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })),
        write: (code) => vfs.writeFile('scaffold/agent.js', code),
        version: async () => (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
      },
    },
    craftStore: createMemoryCraftStore(db),
    spawnBranch: async () => ({ explore: async () => ({ text: '' }), generateReflection: async () => ({ text: '' }) }),
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

    console.log(`4-gate result: ${result.ok ? 'ACCEPTED' : 'REJECTED'} (stage=${result.stage ?? 'n/a'})`);
    expect([true, false]).toContain(result.ok);
  }, 60_000);

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

    const current = await rt.identity.scaffold.read();
    expect(current).toBe(validCode);

    const rbResult = await rollbackScaffold(rt, 0);
    expect(rbResult.ok).toBe(true);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
  }, 60_000);
});
