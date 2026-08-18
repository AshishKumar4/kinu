/**
 * The executable-runtime refusal, proven red against the real degraded runtime
 * and green against the real production one.
 *
 * Not a mock of either. Both runtimes are constructed here exactly as their
 * callers construct them, because the whole defect was that one of them LOOKS
 * like the other: `createWorkspace` returns an `AgentRuntime` that satisfies the
 * type completely and cannot execute anything.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../../core/src/identity/index';
import { initWorkspaceSchema, type LLMProviderConfig } from '../../core/src/index';
import { openWorkspaceCLI, makeWorkspaceSchemaSql } from '../../cli-backend/src/index';
import { assertExecutableRuntime, createTestRuntime } from '../src/runtime';

// Never called: both runtimes are constructed and inspected, never asked to
// generate. The unroutable baseURL is deliberate — if anything here reaches the
// network, this test should fail rather than quietly succeed.
const LLM: LLMProviderConfig = {
  name: 'test', baseURL: 'http://127.0.0.1:1', headers: {}, model: 'unused',
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-exec-runtime-'));
  return { dir, dbPath: join(dir, 'agent.db') };
}

describe('assertExecutableRuntime', () => {
  test('REFUSES the birth runtime — the one two full eval runs were taken on', async () => {
    const { dir, dbPath } = scratch();
    const db = new Database(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const rt = await createWorkspace(db, { name: 'birth', purpose: 'birth', llm: LLM });
      // The exact shape of the defect: a complete AgentRuntime with no router.
      expect(rt.executionRouter).toBeFalsy();
      expect(() => assertExecutableRuntime(rt, 'behaviour eval'))
        .toThrow(/NO executionRouter/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ACCEPTS the runtime every running surface actually opens', async () => {
    const { dir, dbPath } = scratch();
    const birth = new Database(dbPath);
    try {
      birth.exec('PRAGMA journal_mode = WAL');
      await createWorkspace(birth, { name: 'open', purpose: 'open', llm: LLM });
      initWorkspaceSchema(makeWorkspaceSchemaSql(birth));
    } finally {
      birth.close();
    }
    const db = new Database(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const { rt } = await openWorkspaceCLI(db, dbPath, { llm: LLM });
      expect(rt.executionRouter).toBeTruthy();
      expect(rt.executionRouter?.getProviders().length ?? 0).toBeGreaterThan(0);
      expect(() => assertExecutableRuntime(rt, 'behaviour eval')).not.toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('REFUSES a router with zero providers — registered but empty is still unusable', () => {
    // `createTestRuntime`'s default. Legitimate for a unit test that never
    // executes; never legitimate for a tier that measures an agent's work.
    const { rt } = createTestRuntime();
    expect(rt.executionRouter?.getProviders()).toEqual([]);
    expect(() => assertExecutableRuntime(rt, 'some tier'))
      .toThrow(/ZERO registered providers/);
  });

  test('the message names the tier, so a failure says which harness was misconfigured', () => {
    const { rt } = createTestRuntime();
    expect(() => assertExecutableRuntime(rt, 'hard-task eval'))
      .toThrow(/^hard-task eval:/);
  });
});

describe('the birth runtime no longer fabricates an exploration result', () => {
  test('spawnBranch THROWS and names the runtime that implements it', async () => {
    const { dir, dbPath } = scratch();
    const db = new Database(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const rt = await createWorkspace(db, { name: 'birth', purpose: 'birth', llm: LLM });
      // It used to answer `{ text: 'exploration result' }`, which no consumer
      // could tell from a real exploration — so every MCTS-shaped measurement
      // taken on this runtime scored a fabricated string.
      expect(() => rt.spawnBranch('any')).toThrow(/does not implement spawnBranch/);
      expect(() => rt.spawnBranch('any')).toThrow(/openWorkspaceCLI/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
