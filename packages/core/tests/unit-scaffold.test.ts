/**
 * Unit tests: scaffold 4-gate validation + rollback.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { modifyScaffold } from '../src/scaffold/modify.js';
import { rollbackScaffold } from '../src/scaffold/rollback.js';
import { initScaffoldTables } from '../src/scaffold/schemas.js';

describe('Scaffold modification (4-gate)', () => {
  test('rejects rationale shorter than 50 chars', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
    const result = await modifyScaffold(rt, 'too short', 'async function* run(rt, task) {}');
    expect(result.ok).toBe(false);
    expect(result.stage).toBe(1);
  });

  test('rejects code with import statement', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);
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
    initScaffoldTables(rt.storage.execRaw);
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
    initScaffoldTables(rt.storage.execRaw);
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
    initScaffoldTables(rt.storage.execRaw);
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
    initScaffoldTables(rt.storage.execRaw);
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
});

describe('Scaffold rollback', () => {
  test('restores prior version', async () => {
    const { rt } = createTestRuntime();
    initScaffoldTables(rt.storage.execRaw);

    // Write initial version
    await rt.storage.vfs.writeFile('scaffold/agent.js.v0', 'original code');

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
