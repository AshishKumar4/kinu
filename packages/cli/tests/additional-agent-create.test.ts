import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';

import { join } from 'node:path';

const HOME = scratchDir('additional-agent-home');

const PROJECT = scratchDir('additional-agent-project');

describe('local additional-agent creation', () => {
  test('inherits the stored placeholder mission when the workspace has no custom mission', () => {
    // config.ts binds KINU_HOME at module load; a subprocess makes the isolated home authoritative.
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
      env: {
        ...process.env, HOME, KINU_HOME: HOME,
        KINU_BASE_URL: 'http://localhost:1/v1', KINU_AUTH: 'Bearer fixture', KINU_MODEL: 'fixture-model',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe('Help the user with the work they assign.');
  });
});
