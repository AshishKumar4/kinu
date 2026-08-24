import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'kinu-additional-agent-home-'));
const PROJECT = mkdtempSync(join(tmpdir(), 'kinu-additional-agent-project-'));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(PROJECT, { recursive: true, force: true });
});

describe('local additional-agent creation', () => {
  test('inherits the stored placeholder mission when the workspace has no custom mission', () => {
    // config.ts binds KINU_HOME at module load. A subprocess makes the isolated
    // home authoritative even when another test imported config.ts first.
    const scenario = `
      import { Database } from 'bun:sqlite';
      import { createCliAgent, createLocalPeerAgent } from './packages/cli/src/agent-create.ts';
      import { agentDbPath } from './packages/cli/src/config.ts';
      await createCliAgent({
        name: 'workspace-root', displayName: 'Workspace root', nameOrigin: 'auto',
        purpose: 'Help the user with the work they assign.', mode: 'local',
        cwd: ${JSON.stringify(PROJECT)}, workspaceId: 'placeholder-workspace',
      });
      const created = await createLocalPeerAgent({
        cwd: ${JSON.stringify(PROJECT)}, workspaceId: 'placeholder-workspace',
      });
      const db = new Database(agentDbPath(created.name), { readonly: true });
      console.log(db.query('SELECT mission FROM workspace_identity LIMIT 1').get().mission);
      db.close();
    `;
    const result = Bun.spawnSync(['bun', '-e', scenario], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, KINU_HOME: HOME },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe('Help the user with the work they assign.');
  });
});
