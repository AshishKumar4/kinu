// Local workspaces created before mission-derived titling still show their raw
// directory name. Opening one heals it: the deterministic title lands before
// the client is handed back, the model call runs behind it, and both the agent
// database and ~/.proteus/config.json (what `proteus list` reads) end up with
// the same title. The decision itself is proven in @proteus/core.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAgentConfigStore, initAgentConfigTable, type LLMProviderConfig } from '@proteus/core';
import { createCLIRuntime } from '@proteus/cli-backend';

const HOME = mkdtempSync(join(tmpdir(), 'proteus-title-home-'));
process.env.PROTEUS_HOME = HOME;
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
const { autoTitleLocalWorkspace } = await import('../src/local-agent-client.js');
const { loadConfigFile, upsertAgentConfig } = await import('../src/config.js');

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};
const MISSION = 'Audit the OAuth callback flow';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(name: string, stored: { displayName?: string; nameOrigin?: 'user' | 'auto' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-title-agent-'));
  tempDirs.push(dir);
  const db = new Database(':memory:');
  const rt = createCLIRuntime(db as never, { dbPath: join(dir, 'agent.db'), llm: DUMMY_LLM });
  initAgentConfigTable(rt.storage.execRaw);
  const config = createAgentConfigStore(rt.storage.sql);
  if (stored.displayName !== undefined) config.setDisplayName(stored.displayName);
  if (stored.nameOrigin) config.setNameOrigin(stored.nameOrigin);
  upsertAgentConfig({ name, mode: 'local', localName: name, displayName: stored.displayName ?? name });
  return { rt, config };
}

/** The heal's model step, as an injected generator (the create path's seam). */
const suggests = (title: string) => ({
  generate: async () => JSON.stringify({ title, slug: 'oauth-callback-audit' }),
});

describe('local workspace auto-titling on open', () => {
  test('a legacy slug title heals into the agent db and the CLI config, once', async () => {
    const { rt, config } = workspace('workspace-1a4e20');

    autoTitleLocalWorkspace('workspace-1a4e20', rt, MISSION, suggests('OAuth Callback Audit'));
    // The deterministic title is in place synchronously — opening never waits.
    expect(config.getDisplayName()).toBe(MISSION);
    expect(config.getNameOrigin()).toBe('auto');

    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('OAuth Callback Audit');
    expect(loadConfigFile().agents?.['workspace-1a4e20']?.displayName).toBe('OAuth Callback Audit');

    // Opening it again is a no-op: the title is no longer a placeholder.
    autoTitleLocalWorkspace('workspace-1a4e20', rt, MISSION, suggests('Something Else'));
    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('OAuth Callback Audit');
  });

  test('a name the operator chose is never touched', async () => {
    const { rt, config } = workspace('jarvis', { displayName: 'jarvis', nameOrigin: 'user' });

    autoTitleLocalWorkspace('jarvis', rt, MISSION, suggests('OAuth Callback Audit'));
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe('jarvis');
    expect(config.getNameOrigin()).toBe('user');
    expect(loadConfigFile().agents?.jarvis?.displayName).toBe('jarvis');
  });

  test('a failing model call leaves the deterministic title and never throws', async () => {
    const { rt, config } = workspace('workspace-7f159a');

    autoTitleLocalWorkspace('workspace-7f159a', rt, MISSION, {
      generate: async () => { throw new Error('no provider configured'); },
    });
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe(MISSION);
    expect(config.getNameOrigin()).toBe('auto');
    expect(loadConfigFile().agents?.['workspace-7f159a']?.displayName).toBe(MISSION);
  });

  test('a workspace with nothing to title from is left alone', async () => {
    const { rt, config } = workspace('workspace-ff708d');

    autoTitleLocalWorkspace('workspace-ff708d', rt, '', suggests('OAuth Callback Audit'));
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe(null);
    expect(config.getNameOrigin()).toBe(null);
    expect(loadConfigFile().agents?.['workspace-ff708d']?.displayName).toBe('workspace-ff708d');
  });
});
