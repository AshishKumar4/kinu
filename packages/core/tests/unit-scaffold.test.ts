/** Scaffold gate validation and rollback. */

import { describe, test, expect } from 'bun:test';
import { createTestActors, createTestSql } from '@kinu.run/test-utils';
import { jsonSchema, tool } from 'ai';
import { createTestRuntime } from './helpers';
import { modifyScaffold } from '../src/scaffold/modify';
import { rollbackScaffold } from '../src/scaffold/rollback';
import { initScaffoldTables } from '../src/scaffold/schemas';
import {
  createScaffoldCallTool, initToolEffectClaimTable, withEffectClaims,
  type EffectClaimDeps,
} from '../src/index';

describe('Scaffold modification (4-gate)', () => {
  test('rejects rationale shorter than 50 chars', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    const result = await modifyScaffold(rt, 'too short', 'async function* run(rt, task) {}');
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
  });

  const refusedSources = [
    { name: 'rejects code with import statement', code: 'import fs from "fs";\nasync function* run(rt, task) {}', says: 'Forbidden pattern' },
    { name: 'rejects code with require()', code: 'const x = require("fs");\nasync function* run(rt, task) {}', says: null },
    { name: 'rejects code with eval()', code: 'eval("malicious"); async function* run(rt, task) {}', says: null },
    { name: 'rejects code with globalThis', code: 'globalThis.fetch("evil"); async function* run(rt, task) {}', says: null },
    { name: 'rejects code without required signature', code: 'function wrongSignature() { return 42; }', says: 'async function* run(rt, task)' },
  ];

  for (const c of refusedSources) {
    test(c.name, async () => {
      const { rt } = createTestRuntime();
      initScaffoldTables(rt.storage.execRaw);

      const result = await modifyScaffold(
        rt,
        'This is a long enough rationale to pass the 50 char minimum check.',
        c.code,
      );

      expect(result.ok).toBe(false);
      expect(result.stage).toBe(1);

      if (c.says !== null) expect(result.error).toContain(c.says);
    });
  }

  test('accepts valid scaffold code', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);

    const validCode = `async function* run(rt, task) {
      yield { type: "chunk", data: "hello" };
    }`;

    const result = await modifyScaffold(
      rt,
      'Simplified scaffold to return hello — improves response time for basic queries.',
      validCode,
    );

    expect(result.ok).toBe(true);
    expect(result.version).toBeDefined();
  });

  test('pending writes to versioned file, NOT live scaffold/agent.js', async () => {
    // Pending goes to scaffold/agent.js.v{N}; the live file changes only on applyPromotion,
    // or shadow eval would compare a file to itself.
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    await rt.identity.scaffold.write('async function* run(rt, task) { yield "v0"; }');
    const before = await rt.identity.scaffold.read();

    const pendingCode = `async function* run(rt, task) {
      yield { type: "chunk", data: "pending" };
    }`;

    const result = await modifyScaffold(
      rt,
      'Pending scaffold proposal — should land in versioned file, not live.',
      pendingCode,
    );

    expect(result.ok).toBe(true);
    const liveAfter = await rt.identity.scaffold.read();
    expect(liveAfter).toBe(before);

    const pending = await rt.storage.vfs.readFile(
      `scaffold/agent.js.v${result.version}`,
      { encoding: 'utf8' },
    );

    const pendingText = pending instanceof Uint8Array ? new TextDecoder().decode(pending) : pending;
    expect(pendingText).toBe(pendingCode);
  });
});

describe('Scaffold rollback', () => {
  test('restores prior version', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);

    // A version needs its metadata row to be the current pointer.
    await rt.storage.vfs.writeFile('scaffold/agent.js.v0', 'original code');
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale)
                   VALUES (${rt.actor.actorId}, 0, ${Date.now()}, ${'original'})`;

    const result = await rollbackScaffold(rt, 0);
    expect(result.ok).toBe(true);

    const restored = await rt.identity.scaffold.read();
    expect(restored).toBe('original code');
  });

  test('returns error for nonexistent version', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);

    const result = await rollbackScaffold(rt, 999);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('999');
  });
});

describe('scaffold host callTool ids', () => {
  test('scope-less calls under a frozen clock each run their effect', async () => {
    // Ids must be unique within a millisecond, or the tool-effect claim replays the first result.
    const { sql, execRaw } = createTestSql();
    initToolEffectClaimTable(execRaw);

    const deps: EffectClaimDeps = {
      sql, actor: createTestActors(sql, execRaw).main, turnId: () => 'turn-1',
    };

    const calls: string[] = [];

    const entry = tool({
      description: 'send the invoice',
      inputSchema: jsonSchema<{ to: string }>({
        type: 'object', properties: { to: { type: 'string' } }, required: ['to'],
      }),
      execute: async (input: { to: string }) => {
        calls.push(input.to);

        return { sent: input.to, attempt: calls.length };
      },
    });

    const claimed = () => withEffectClaims({ shell: entry }, deps);
    const firstHost = createScaffoldCallTool(claimed);
    const secondHost = createScaffoldCallTool(claimed);
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;

    try {
      const first = await firstHost('shell', { to: 'ops@example.test' });
      const second = await firstHost('shell', { to: 'ops@example.test' });
      const third = await secondHost('shell', { to: 'ops@example.test' });
      expect(calls).toEqual(['ops@example.test', 'ops@example.test', 'ops@example.test']);
      expect(first).toEqual({ sent: 'ops@example.test', attempt: 1 });
      expect(second).toEqual({ sent: 'ops@example.test', attempt: 2 });
      expect(third).toEqual({ sent: 'ops@example.test', attempt: 3 });
    } finally {
      Date.now = realNow;
    }
  });
});
