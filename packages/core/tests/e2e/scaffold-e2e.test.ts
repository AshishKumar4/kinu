/**
 * E2E test: Scaffold evolution with real LLM through 4-gate pipeline.
 *
 * Requires env vars: AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH
 * Skips gracefully if not set.
 */

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
  makeSql, makeExecRaw, createMemoryVFS, createMemoryMemory,
  createMemoryCraftStore, createMockExecutor, createMemorySchedule,
} from '../helpers';

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
    releaseBranch: async () => {},
  };
  return { rt };
}

describe.skipIf(!isE2EConfigured())('E2E scaffold evolution', () => {
  test('LLM generates valid scaffold code that passes 4-gate', async () => {
    const { primary } = loadAIGatewayProviders();
    const { rt } = createScaffoldTestRuntime(primary);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
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

    // What a live model writes is not a contract, so the verdict is: the pipeline
    // never half-applies, and either way the LIVE scaffold is untouched — gate 4
    // writes a proposal to `<path>.v<n>` precisely so shadow eval has two
    // different files to compare. The assertion that stood here was
    // `expect([true, false]).toContain(result.ok)` over a `boolean`, which no
    // behaviour of the four gates could falsify.
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);

    if (result.ok) {
      const { version } = result;
      // An accept with no version is a promotion nothing can address.
      if (version === undefined) throw new Error(`accepted with no version: ${JSON.stringify(result)}`);
      expect(version).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
      expect(await rt.identity.scaffold.version()).toBe(version);
      // The proposal is on disk as a pending version, and it is the model's text.
      const pending = await rt.storage.vfs.readFile(
        `${rt.identity.scaffold.path}.v${String(version)}`, { encoding: 'utf8' },
      );
      expect(pending).toBe(generated);
      expect(pending).not.toBe(INITIAL_SCAFFOLD_SOURCE);
    } else {
      const { stage } = result;
      // A refusal that names no gate is a verdict the pipeline cannot explain.
      if (stage === undefined) throw new Error(`refused with no stage: ${JSON.stringify(result)}`);
      expect([1, 2, 3]).toContain(stage);
      expect(result.error?.length ?? 0).toBeGreaterThan(0);
      expect(result.version).toBeUndefined();
      // A refused proposal mints no version at all.
      expect(await rt.identity.scaffold.version()).toBe(0);
    }
  }, 60_000);

  test('full scaffold lifecycle: bootstrap -> modify -> rollback', async () => {
    const { primary } = loadAIGatewayProviders();
    const { rt } = createScaffoldTestRuntime(primary);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
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

    // The live file does NOT move on accept. This test used to assert
    // `read() === validCode`, which was the behaviour before gate 4 started
    // writing proposals to the versioned path — modify.ts states the reason: a
    // live file equal to the pending one makes shadow eval compare the new code
    // to itself, and promotion a flag flip with no on-disk consequence. Because
    // the whole describe is skipIf(!isE2EConfigured()), nothing ever ran the
    // stale assertion to say so.
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);
    expect(await rt.storage.vfs.readFile(
      `${rt.identity.scaffold.path}.v1`, { encoding: 'utf8' },
    )).toBe(validCode);

    // v0 was backed up on the way in, so rollback has somewhere to go.
    const rbResult = await rollbackScaffold(rt, 0);
    expect(rbResult.ok).toBe(true);
    expect(await rt.identity.scaffold.read()).toBe(INITIAL_SCAFFOLD_SOURCE);

    // Rolling back to a version nobody wrote is refused, with a reason.
    const missing = await rollbackScaffold(rt, 99);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('99');
  }, 60_000);
});
