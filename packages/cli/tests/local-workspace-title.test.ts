// Local workspaces created before mission-derived titling still show their raw
// directory name. Opening one heals it: the deterministic title lands before
// the client is handed back, the model call runs behind it, and both the agent
// database and ~/.kinu/config.json (what `kinu list` reads) end up with
// the same title. The decision itself is proven in @kinu.run/core.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createAgentConfigStore, initAgentConfigTable, type LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime } from '@kinu.run/cli-backend';

// `AGENT_HOME` is resolved at MODULE LOAD (config.ts), so the only way this file
// can name its own home is to assign the variable and then import — which is why
// the two imports below are dynamic.
//
// And why the variable goes back afterwards. Bun runs every file of an
// invocation in ONE process: left assigned, this named a directory that `afterAll`
// then deleted, for every later file that reads `KINU_HOME` or spawns a child
// from `process.env`. Once the imports have bound it, the variable has done its
// work and the process is put back the way it was found.
const HOME = mkdtempSync(join(tmpdir(), 'kinu-title-home-'));
const inheritedHome = process.env.KINU_HOME;
process.env.KINU_HOME = HOME;
const { autoTitleLocalWorkspace } = await import('../src/local-agent-client');
const { loadConfigFile, upsertAgentConfig } = await import('../src/config');
if (inheritedHome === undefined) delete process.env.KINU_HOME;
else process.env.KINU_HOME = inheritedHome;
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};
const MISSION = 'Audit the OAuth callback flow';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(name: string, stored: { displayName?: string; nameOrigin?: 'user' | 'auto' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-title-agent-'));
  tempDirs.push(dir);
  const db = new Database(':memory:');
  const rt = createCLIRuntime(db, { dbPath: join(dir, 'agent.db'), llm: DUMMY_LLM });
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
  test('a legacy slug title heals in the agent db while its config ref stays placement-only', async () => {
    const { rt, config } = workspace('workspace-1a4e20');
    const refTitle = loadConfigFile().agents?.['workspace-1a4e20']?.displayName;
    autoTitleLocalWorkspace('workspace-1a4e20', rt, { mission: MISSION, trigger: 'legacy-heal' }, suggests('OAuth Callback Audit'));
    // The deterministic title is in place synchronously — opening never waits.
    expect(config.getDisplayName()).toBe(MISSION);
    expect(config.getNameOrigin()).toBe('auto');

    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('OAuth Callback Audit');
    expect(loadConfigFile().agents?.['workspace-1a4e20']?.displayName).toBe(refTitle);

    // Opening it again is a no-op: the title is no longer a placeholder.
    autoTitleLocalWorkspace('workspace-1a4e20', rt, { mission: MISSION, trigger: 'legacy-heal' }, suggests('Something Else'));
    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('OAuth Callback Audit');
  });

  test('a name the operator chose is never touched', async () => {
    const { rt, config } = workspace('jarvis', { displayName: 'jarvis', nameOrigin: 'user' });

    autoTitleLocalWorkspace('jarvis', rt, { mission: MISSION, trigger: 'legacy-heal' }, suggests('OAuth Callback Audit'));
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe('jarvis');
    expect(config.getNameOrigin()).toBe('user');
    expect(loadConfigFile().agents?.jarvis?.displayName).toBe('jarvis');
  });

  test('a failing model call leaves the deterministic title and never throws', async () => {
    const { rt, config } = workspace('workspace-7f159a');
    const refTitle = loadConfigFile().agents?.['workspace-7f159a']?.displayName;

    autoTitleLocalWorkspace('workspace-7f159a', rt, { mission: MISSION, trigger: 'legacy-heal' }, {
      generate: async () => { throw new Error('no provider configured'); },
    });
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe(MISSION);
    expect(config.getNameOrigin()).toBe('auto');
    expect(loadConfigFile().agents?.['workspace-7f159a']?.displayName).toBe(refTitle);
  });

  test('a workspace with nothing to title from is left alone', async () => {
    const { rt, config } = workspace('workspace-ff708d');

    autoTitleLocalWorkspace('workspace-ff708d', rt, { mission: '', trigger: 'legacy-heal' }, suggests('OAuth Callback Audit'));
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe(null);
    expect(config.getNameOrigin()).toBe(null);
    expect(loadConfigFile().agents?.['workspace-ff708d']?.displayName).toBe('workspace-ff708d');
  });
});

/**
 * An agent the owner ADDED to a virtual workspace inherits that workspace's
 * mission, which every peer in it shares. Titling from that would name the
 * whole group the same thing, so it starts with no title and the first thing
 * the owner says to it is what names it.
 */
describe('local agent auto-titling on its first owner message', () => {
  test('an agent added without a name is titled by that first message, once', async () => {
    const { rt, config } = workspace('quiet-harbor-1a4e20', { displayName: '', nameOrigin: 'auto' });
    const refTitle = loadConfigFile().agents?.['quiet-harbor-1a4e20']?.displayName;

    // The mission it inherited must NOT name it: the legacy heal, which is the
    // only mission-sourced pass, skips a deliberately blank title.
    autoTitleLocalWorkspace(
      'quiet-harbor-1a4e20', rt,
      { mission: 'Keep the release train moving.', trigger: 'legacy-heal' },
      suggests('Release Train'),
    );
    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('');

    autoTitleLocalWorkspace(
      'quiet-harbor-1a4e20', rt,
      { mission: 'Audit the OAuth callback flow', trigger: 'first-message' },
      suggests('Callback Audit'),
    );
    // The deterministic title lands synchronously; the model upgrades it after.
    expect(config.getDisplayName()).toBe('Audit the OAuth callback flow');
    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('Callback Audit');
    expect(loadConfigFile().agents?.['quiet-harbor-1a4e20']?.displayName).toBe(refTitle);

    // The next message is not a second naming pass.
    autoTitleLocalWorkspace(
      'quiet-harbor-1a4e20', rt,
      { mission: 'Now check the refresh path', trigger: 'first-message' },
      suggests('Something Else'),
    );
    await Bun.sleep(20);
    expect(config.getDisplayName()).toBe('Callback Audit');
  });

  test('a name the owner typed is never replaced by a later message', async () => {
    const { rt, config } = workspace('quiet-harbor-7f159a', { displayName: 'Jarvis', nameOrigin: 'user' });

    autoTitleLocalWorkspace(
      'quiet-harbor-7f159a', rt,
      { mission: 'Audit the OAuth callback flow', trigger: 'first-message' },
      suggests('Callback Audit'),
    );
    await Bun.sleep(20);

    expect(config.getDisplayName()).toBe('Jarvis');
    expect(config.getNameOrigin()).toBe('user');
  });
});
