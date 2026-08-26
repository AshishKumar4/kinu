/**
 * Unit tests: scaffold 4-gate validation + rollback.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers';
import { modifyScaffold } from '../src/scaffold/modify';
import { rollbackScaffold } from '../src/scaffold/rollback';
import { initScaffoldTables } from '../src/scaffold/schemas';

describe('Scaffold modification (4-gate)', () => {
  test('rejects rationale shorter than 50 chars', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const result = await modifyScaffold(rt, 'too short', 'async function* run(rt, task) {}');
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
  });

  test('rejects code with import statement', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const result = await modifyScaffold(
      rt,
      'This is a long enough rationale to pass the 50 char minimum check.',
      'import fs from "fs";\nasync function* run(rt, task) {}',
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.error).toContain('Forbidden pattern');
  });

  test('rejects code with require()', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const result = await modifyScaffold(
      rt,
      'This is a long enough rationale to pass the 50 char minimum check.',
      'const x = require("fs");\nasync function* run(rt, task) {}',
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
  });

  test('rejects code with eval()', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const result = await modifyScaffold(
      rt,
      'This is a long enough rationale to pass the 50 char minimum check.',
      'eval("malicious"); async function* run(rt, task) {}',
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
  });

  test('rejects code with globalThis', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const result = await modifyScaffold(
      rt,
      'This is a long enough rationale to pass the 50 char minimum check.',
      'globalThis.fetch("evil"); async function* run(rt, task) {}',
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
  });

  test('rejects code without required signature', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    const result = await modifyScaffold(
      rt,
      'This is a long enough rationale to pass the 50 char minimum check.',
      'function wrongSignature() { return 42; }',
    );
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
    expect(result.error).toContain('async function* run(rt, task)');
  });

  test('accepts valid scaffold code', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
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
    // Closure of `kinu-scaffold-gap`: modifyScaffold used to overwrite the
    // live file at proposal time, which made shadow eval compare a file to
    // itself. The fix routes pending into scaffold/agent.js.v{N} only — the
    // live file remains the current scaffold's content until applyPromotion
    // runs.
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
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
    // Live file must be untouched.
    const liveAfter = await rt.identity.scaffold.read();
    expect(liveAfter).toBe(before);
    // Pending code must be readable from the versioned file.
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
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);

    // Write initial version — source file plus its metadata row, since a
    // version without a row cannot be the current pointer.
    await rt.storage.vfs.writeFile('scaffold/agent.js.v0', 'original code');
    void rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale)
                   VALUES (0, ${Date.now()}, ${'original'})`;

    const result = await rollbackScaffold(rt, 0);
    expect(result.ok).toBe(true);

    const restored = await rt.identity.scaffold.read();
    expect(restored).toBe('original code');
  });

  test('returns error for nonexistent version', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);

    const result = await rollbackScaffold(rt, 999);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('999');
  });
});
