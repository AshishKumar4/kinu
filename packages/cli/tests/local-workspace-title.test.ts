// An untitled agent is named by its first owner message; the title lives in the agent database, not the config ref.
import { scratchDir } from '../../test-utils/src/scratch';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initAgentConfigTable, type LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime } from '@kinu.run/cli-backend';

// `AGENT_HOME` is resolved at module load (config.ts), so the imports below are dynamic. Bun runs every file
// in one process, so the variable is restored once the imports have bound it.
const HOME = scratchDir('title-home');

const inheritedHome = process.env.KINU_HOME;

process.env.KINU_HOME = HOME;

const { autoTitleLocalWorkspace } = await import('../src/local-agent-client');

const { loadConfigFile, upsertAgentConfig } = await import('../src/config');

if (inheritedHome === undefined) delete process.env.KINU_HOME;
else process.env.KINU_HOME = inheritedHome;

const DUMMY_LLM: LLMProviderConfig = {
  name: 'openai-compat', baseURL: 'http://localhost:0', headers: { Authorization: 'x' }, model: 'fake-model',
};

async function workspace(name: string, stored: { displayName?: string; nameOrigin?: 'user' | 'auto' } = {}) {
  const dir = scratchDir('title-agent');
  const db = new Database(join(dir, 'agent.db'));
  const rt = createCLIRuntime(db, { dbPath: join(dir, 'agent.db'), llm: DUMMY_LLM });
  initAgentConfigTable(rt.storage.execRaw);
  const config = rt.actor.config;

  if (stored.displayName !== undefined) config.setDisplayName(stored.displayName);

  if (stored.nameOrigin) config.setNameOrigin(stored.nameOrigin);
  await upsertAgentConfig({ name, mode: 'local', localName: name, displayName: stored.displayName ?? name });

  return { rt, config };
}

const suggests = (title: string) => ({
  generate: async () => JSON.stringify({ title, slug: 'oauth-callback-audit' }),
});

/** An agent added to a virtual workspace starts untitled: titling from the shared mission would name every peer the same. */
describe('local agent auto-titling on its first owner message', () => {
  test('an agent added without a name is titled by that first message, once', async () => {
    const { rt, config } = await workspace('quiet-harbor-1a4e20', { displayName: '', nameOrigin: 'auto' });
    const refTitle = loadConfigFile().agents?.['quiet-harbor-1a4e20']?.displayName;

    const titleTask = autoTitleLocalWorkspace(
      'quiet-harbor-1a4e20', rt,
      { mission: 'Audit the OAuth callback flow' },
      suggests('Callback Audit'),
    );

    expect(config.getDisplayName()).toBe('Audit the OAuth callback flow');
    await titleTask;
    expect(config.getDisplayName()).toBe('Callback Audit');
    expect(loadConfigFile().agents?.['quiet-harbor-1a4e20']?.displayName).toBe(refTitle);

    await autoTitleLocalWorkspace(
      'quiet-harbor-1a4e20', rt,
      { mission: 'Now check the refresh path' },
      suggests('Something Else'),
    );
    expect(config.getDisplayName()).toBe('Callback Audit');
  });

  test('a name the owner typed is never replaced by a later message', async () => {
    const { rt, config } = await workspace('quiet-harbor-7f159a', { displayName: 'Jarvis', nameOrigin: 'user' });

    await autoTitleLocalWorkspace(
      'quiet-harbor-7f159a', rt,
      { mission: 'Audit the OAuth callback flow' },
      suggests('Callback Audit'),
    );

    expect(config.getDisplayName()).toBe('Jarvis');
    expect(config.getNameOrigin()).toBe('user');
  });
});
