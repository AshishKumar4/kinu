/**
 * `createWorkspace` returns a type-complete `AgentRuntime` that cannot execute, so both
 * runtimes are built exactly as their callers build them.
 */
import { scratchDir } from '../src/scratch';
import { describe, test, expect } from 'bun:test';
import { workspaceDatabase } from '../src/database';

import { join } from 'node:path';
import { createWorkspace } from '../../core/src/workspace-birth';
import { initWorkspaceSchema, type LLMProviderConfig } from '../../core/src/index';
import { openWorkspaceCLI, makeWorkspaceSchemaSql, workspaceHome } from '../../cli-backend/src/index';
import { assertExecutableRuntime, createTestRuntime } from '../src/runtime';

// Never called; the unroutable baseURL makes any network use fail.
const LLM: LLMProviderConfig = {
  name: 'test', baseURL: 'http://127.0.0.1:1', headers: {}, model: 'unused',
};

function scratch() {
  const dir = scratchDir('exec-runtime');

  return { dir, dbPath: join(dir, 'agent.db') };
}

describe('assertExecutableRuntime', () => {
  test('REFUSES the birth runtime — the one two full eval runs were taken on', async () => {
    const { dbPath } = scratch();
    const db = workspaceDatabase(dbPath);

    try {
      const rt = await createWorkspace(db, { name: 'birth', purpose: 'birth', llm: LLM, home: workspaceHome(db) });
      // A complete AgentRuntime with no router.
      expect(rt.executionRouter).toBeFalsy();
      expect(() => assertExecutableRuntime(rt, 'behaviour eval'))
        .toThrow(/NO executionRouter/);
    } finally {
      db.close();
    }
  });

  test('ACCEPTS the runtime every running surface actually opens', async () => {
    const { dbPath } = scratch();
    const birth = workspaceDatabase(dbPath);

    try {
      await createWorkspace(birth, { name: 'open', purpose: 'open', llm: LLM, home: workspaceHome(birth) });
      initWorkspaceSchema(makeWorkspaceSchemaSql(birth));
    } finally {
      birth.close();
    }

    const db = workspaceDatabase(dbPath);

    try {
      const { rt } = await openWorkspaceCLI(db, dbPath, { llm: LLM, cwd: scratchDir('exec-runtime-folder') });
      expect(rt.executionRouter).toBeTruthy();
      expect(rt.executionRouter?.getProviders().length ?? 0).toBeGreaterThan(0);
      expect(() => assertExecutableRuntime(rt, 'behaviour eval')).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('REFUSES a router with zero providers — registered but empty is still unusable', () => {
    // `createTestRuntime`'s default: fine for a unit test, never for a tier measuring agent work.
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
