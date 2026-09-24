/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { AgentClient, AgentClientStatus } from '../src/agent-client';
import { missingSubordinateHistory, type AgentModelMenu, type SubordinateRosterEntry } from '@kinu.run/core';
import type { TuiHubData } from '../src/tui/hubs';
import { asFetchFunction, codenameFor } from '@kinu.run/core';

import { TURN, cleanupChats, fakeClient, mountChat, type FixtureWorkspace } from './helpers/chat-app-fixture';
import { createMemoryTuiPreferenceStore } from './helpers/tui-preferences';
import { SelectRenderable, TextareaRenderable } from '@opentui/core';
import { flushSync } from '@opentui/react';

afterEach(cleanupChats);

const ALPHA_LOCAL: FixtureWorkspace = { name: 'alpha', label: 'Alpha', mode: 'local' };

const BETA_LOCAL: FixtureWorkspace = { name: 'beta', label: 'Beta', mode: 'local' };

const BETA_CLOUD: FixtureWorkspace = { name: 'beta', label: 'Beta', mode: 'cloud', cloudName: 'beta' };

const MISSING_CLOUD: FixtureWorkspace = {
  name: 'missing', label: 'Missing', mode: 'cloud', cloudName: 'missing',
};

interface HubWorkspaces {
  open: string;
  label: string;
  peer: string;
  created: boolean;
}

function hubWorkspaces({ open, label, peer, created }: HubWorkspaces): FixtureWorkspace[] {
  const cwd = process.cwd();
  const rows: FixtureWorkspace[] = [{ name: open, label, mode: 'local', cwd, workspaceId: 'shop' }];

  if (created) rows.push({ name: peer, label: '', mode: 'local', cwd, workspaceId: 'shop' });

  return rows;
}

test('draft undo restores the previous deletion burst and is isolated after send', async () => {
  const screen = await mountChat(fakeClient({ name: 'undo-draft' }).client, { kittyKeyboard: true });
  await screen.mockInput.typeText('draft to keep');
  screen.mockInput.pressBackspace();
  screen.mockInput.pressBackspace();
  const input = screen.renderer.currentFocusedRenderable;

  if (!(input instanceof TextareaRenderable)) throw new Error('composer not focused');
  expect(input.plainText).toBe('draft to ke');
  screen.mockInput.pressKey('-', { ctrl: true });
  await screen.renderOnce();
  expect(input.plainText).toBe('draft to keep');
  flushSync(() => screen.mockInput.pressEnter());
  screen.mockInput.pressKey('-', { ctrl: true });
  await screen.renderOnce();
  expect(input.plainText).toBe('');
});

test('draft undo retains only the newest 64 snapshots', async () => {
  const screen = await mountChat(fakeClient({ name: 'undo-ring' }).client, { kittyKeyboard: true });
  const input = screen.renderer.currentFocusedRenderable;

  if (!(input instanceof TextareaRenderable)) throw new Error('composer not focused');

  for (let index = 0; index < 70; index += 1) {
    input.setText(`draft ${String(index).padStart(2, '0')}`);
    screen.mockInput.pressArrow('right');
  }

  for (let index = 0; index < 70; index += 1) screen.mockInput.pressKey('-', { ctrl: true });
  await screen.renderOnce();
  expect(input.plainText).toBe('draft 05');
});

test('prompt history recalls sent and cleared drafts, searches, and persists per workspace', async () => {
  const sent: unknown[] = [];
  const store = createMemoryTuiPreferenceStore();

  const agent = fakeClient({ name: 'recall', send: async (input) => {
    sent.push(input);

    return TURN;
  } });

  const screen = await mountChat(agent.client, { tui: { preferenceStore: store }, kittyKeyboard: true });

  for (const prompt of ['first prompt', 'second prompt', 'third prompt']) {
    await screen.mockInput.typeText(prompt);
    flushSync(() => screen.mockInput.pressEnter());
    await screen.waitFor('prompt sent and saved', () => sent.length === ['first prompt', 'second prompt', 'third prompt'].indexOf(prompt) + 1
      && Object.values(store.read().promptHistory ?? {}).some((entries) => entries.at(-1) === prompt));
  }

  screen.mockInput.pressArrow('up');
  await screen.renderOnce();
  expect(Object.values(store.read().promptHistory ?? {})).toEqual([['first prompt', 'second prompt', 'third prompt']]);
  const firstRecall = screen.renderer.currentFocusedRenderable;

  if (!(firstRecall instanceof TextareaRenderable)) throw new Error('composer not focused');
  expect(firstRecall.plainText).toBe('third prompt');
  screen.mockInput.pressArrow('up');
  await screen.renderOnce();
  const input = screen.renderer.currentFocusedRenderable;
  expect(input).toBeInstanceOf(TextareaRenderable);

  if (!(input instanceof TextareaRenderable)) throw new Error('composer not focused');
  expect(input.plainText).toBe('second prompt');
  screen.mockInput.pressKey('r', { ctrl: true });
  await screen.waitFor('history search', () => screen.frame().includes('Search sent and cleared prompts'));
  await screen.mockInput.typeText('sec');
  await screen.waitFor('filtered history', () => {
    const results = screen.renderer.root.findDescendantById('prompt-history-results');

    return results instanceof SelectRenderable && results.options.length === 1;
  });
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('selected history', () => !screen.frame().includes('Search sent and cleared prompts'));
  expect(input.plainText).toBe('second prompt');
  flushSync(() => input.setText('cleared draft'));
  flushSync(() => screen.mockInput.pressKey('c', { ctrl: true }));
  await screen.renderOnce();
  expect(input.plainText).toBe('');
  screen.mockInput.pressArrow('up');
  await screen.renderOnce();
  expect(input.plainText).toBe('cleared draft');
  cleanupChats();

  const other = await mountChat(fakeClient({ name: 'other' }).client, { tui: { preferenceStore: store } });
  other.mockInput.pressArrow('up');
  await other.renderOnce();
  expect(other.frame()).not.toContain('cleared draft');
  cleanupChats();
  const restored = await mountChat(fakeClient({ name: 'recall' }).client, { tui: { preferenceStore: store } });
  restored.mockInput.pressArrow('up');
  await restored.renderOnce();
  expect(restored.frame()).toContain('cleared draft');
});

test('Up and Down inside a multiline draft move the cursor and boundary history preserves the draft', async () => {
  const agent = fakeClient({ name: 'history-boundary' });
  const store = createMemoryTuiPreferenceStore();
  const screen = await mountChat(agent.client, { tui: { preferenceStore: store } });
  await screen.mockInput.typeText('previous prompt');
  flushSync(() => screen.mockInput.pressEnter());
  await screen.waitFor('sent prompt', () => Object.values(store.read().promptHistory ?? {}).some((entries) => entries.includes('previous prompt')));
  const input = screen.renderer.currentFocusedRenderable;

  if (!(input instanceof TextareaRenderable)) throw new Error('composer not focused');
  input.setText('first line\nmiddle line\nlast line');
  input.setCursor(1, 4);
  screen.mockInput.pressArrow('up');
  await screen.renderOnce();
  expect(input.plainText).toBe('first line\nmiddle line\nlast line');
  expect(input.logicalCursor.row).toBe(0);
  screen.mockInput.pressArrow('up');
  await screen.waitFor('boundary recall', () => input.plainText === 'previous prompt');
  expect(input.plainText).toBe('previous prompt');
  screen.mockInput.pressArrow('down');
  await screen.renderOnce();
  expect(input.plainText).toBe('first line\nmiddle line\nlast line');
  input.setCursor(1, 4);
  screen.mockInput.pressArrow('down');
  await screen.renderOnce();
  expect(input.logicalCursor.row).toBe(2);
});

describe('ChatApp terminal interaction', () => {
  test('command palette exposes only truthful local and cloud capabilities', async () => {
    const local = fakeClient({ name: 'local' });
    const localScreen = await mountChat(local.client);
    expect(localScreen.frame()).not.toContain('⠋ null');
    localScreen.mockInput.pressKey('k', { ctrl: true });
    await localScreen.waitFor('the local command palette', () => localScreen.frame().includes('Filter commands'));
    expect(localScreen.frame()).toContain('/role');
    expect(localScreen.frame()).toContain('/rename');
    localScreen.mockInput.pressEscape();
    await localScreen.waitFor('the command palette to close', () =>
      !localScreen.frame().includes('Filter commands'));
    await localScreen.mockInput.typeText('/settings');
    localScreen.mockInput.pressEnter();
    await localScreen.waitFor('interactive settings', () =>
      localScreen.frame().includes('Filter settings'));
    expect(localScreen.frame()).toContain('Reasoning effort');
    expect(localScreen.frame()).toContain('Local shell');
    localScreen.mockInput.pressArrow('down');
    localScreen.mockInput.pressEnter();
    await localScreen.waitFor('the selected setting to apply', () =>
      localScreen.frame().includes('Reasoning effort: low'));
    await localScreen.waitFor('the composer after applying settings', () =>
      !localScreen.frame().includes('Filter settings')
      && localScreen.frame().includes('Send a message'));
    await localScreen.mockInput.typeText('/settings');
    localScreen.mockInput.pressEnter();
    await localScreen.waitFor('settings through the command path', () =>
      localScreen.frame().includes('Filter settings'));
    localScreen.mockInput.pressEscape();
    expect(localScreen.frame()).not.toContain('/connect');

    const cloud = fakeClient({

      name: 'cloud',
      mode: 'cloud',
      consents: { listPending: async () => [], resolve: async () => ({ ok: true }) },
    });

    const cloudScreen = await mountChat(cloud.client);
    cloudScreen.mockInput.pressKey('k', { ctrl: true });
    await cloudScreen.waitFor('the cloud command palette', () => cloudScreen.frame().includes('Filter commands'));
    expect(cloudScreen.frame()).not.toContain('/resume');
    expect(cloudScreen.frame()).toContain('/role');

    expect(cloudScreen.frame()).not.toContain('/rename');
  });
  test('Ctrl+K preserves the draft under the command palette', async () => {
    const controlled = fakeClient({ name: 'alpha' });
    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('preserve this draft');

    for (let index = 0; index < 5; index += 1) screen.mockInput.pressArrow('left');
    screen.mockInput.pressKey('k', { ctrl: true });
    await screen.waitFor('the command palette', () => screen.frame().includes('Filter commands'));
    screen.mockInput.pressEscape();
    await screen.waitFor('the preserved composer', () =>
      !screen.frame().includes('Filter commands'));
    expect(screen.frame()).toContain('preserve this draft');
  });
  test('closing a loading model panel cannot reopen it from a stale result', async () => {
    const pending = Promise.withResolvers<AgentModelMenu>();

    const controlled = fakeClient({
      name: 'alpha',
      listModels: () => pending.promise,
    });

    const screen = await mountChat(controlled.client);
    screen.mockInput.pressKey('l', { ctrl: true });
    await screen.waitFor('the loading model panel', () => screen.frame().includes('Loading models'));
    screen.mockInput.pressEscape();
    pending.resolve({ models: [], failures: [] });
    await screen.waitFor('the model panel to close', () =>
      !screen.frame().includes('Select model'));

    for (let index = 0; index < 6; index += 1) await screen.renderOnce();
    expect(screen.frame()).not.toContain('Select model');
    expect(screen.frame()).toContain('Send a message');
  });

  test('failed model selection closes once and restores an actionable error', async () => {
    const controlled = fakeClient({
      name: 'alpha',
      setModel: async () => { throw new Error('Unavailable model'); },
    });

    const screen = await mountChat(controlled.client);
    screen.mockInput.pressKey('l', { ctrl: true });
    await screen.waitFor('the model picker', () => screen.frame().includes('Select model'));
    screen.mockInput.pressEnter();
    await screen.waitFor('the model failure', () => screen.frame().includes('Unavailable model'));
    expect(screen.frame()).not.toContain('Select model');
    expect(screen.frame()).toContain('Send a message');
  });

  test('a model picker row starts with the model, not an empty field and a separator', async () => {
    const screen = await mountChat(fakeClient({ name: 'alpha' }).client);
    screen.mockInput.pressKey('l', { ctrl: true });
    await screen.waitFor('the model row', () => screen.frame().includes('openai/gpt-5.5'));
    const row = screen.frame().split('\n').find((line) => line.includes('openai/gpt-5.5')) ?? '';

    expect(row).toMatch(/GPT 5\.5 · openai · openai\/gpt-5\.5/u);
    expect(row).not.toMatch(/· GPT 5\.5/u);
  });

  test('in a wide chat the workspace key is named in /help, not drawn over the header', async () => {
    const screen = await mountChat(fakeClient({ name: 'alpha' }).client, { width: 140 });
    await screen.waitFor('the header', () => screen.frame().includes('alpha'));
    // Drawn over the rule, the hint's spaces show the rule through: `Alt+W─hide─workspaces`.
    expect(screen.frame()).not.toMatch(/Alt\+W.{1,6}workspaces/u);

    await screen.mockInput.typeText('/help');
    screen.mockInput.pressEnter();
    await screen.waitFor('the keyboard help', () => screen.frame().includes('Show or hide workspaces'));

    for (const label of ['Command palette', 'Model picker', 'Agent Hub', 'Settings']) expect(screen.frame()).toContain(label);
  });


  test('a slow model selection blocks newer surfaces until it settles', async () => {
    const pending = Promise.withResolvers<{ spec: string }>();

    const controlled = fakeClient({
      name: 'alpha',
      setModel: () => pending.promise,
    });

    const screen = await mountChat(controlled.client);
    screen.mockInput.pressKey('l', { ctrl: true });
    await screen.waitFor('the model picker', () => screen.frame().includes('Select model'));
    screen.mockInput.pressEnter();
    screen.mockInput.pressKey('g', { ctrl: true });

    for (let index = 0; index < 4; index += 1) await screen.renderOnce();
    expect(screen.frame()).not.toContain('Filter settings');
    pending.resolve({ spec: 'openai/gpt-5.5' });
    await screen.waitFor('the selected model result', () =>
      screen.frame().includes('Model: openai/gpt-5.5'));
  });

  test('a failed initial connection reports the whole cause chain', async () => {
    const controlled = fakeClient({
      name: 'alpha',
      connect: async () => {
        throw new Error('the workspace socket refused', { cause: new Error('ECONNREFUSED 127.0.0.1') });
      },
    });

    const screen = await mountChat(controlled.client, {
      settled: (frame) => frame.includes('the workspace socket refused'),
    });

    expect(screen.frame()).toContain('Error: the workspace socket refused: ECONNREFUSED 127.0.0.1');
    expect(screen.frame()).toContain('Connecting…');
  });

  test('a failed slash command reports the whole cause chain', async () => {
    const controlled = fakeClient({
      name: 'alpha',
      rename: async () => {
        throw new Error('the rename was refused', { cause: new Error('name already taken') });
      },
    });

    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/rename beta');
    screen.mockInput.pressEnter();
    await screen.waitFor('the submit failure with its chain', () =>
      screen.frame().includes('Error: the rename was refused: name already taken'));
  });
  test('failed workspace connection keeps the current workspace usable', async () => {
    const controlled = fakeClient({ name: 'alpha' });

    const candidate = fakeClient({
      name: 'missing',
      mode: 'cloud',
      connect: async () => { throw new Error('Workspace is unavailable'); },
    });

    const screen = await mountChat(controlled.client, {
      listWorkspaces: () => [ALPHA_LOCAL, MISSING_CLOUD],
      onWorkspaceSelect: async () => candidate.client,
      width: 80,
    });

    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the expanded cloud section', () => screen.frame().includes('Missing'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the workspace failure', () =>
      screen.frame().includes('Workspace is unavailable'));
    expect(screen.frame()).not.toContain('Filter workspaces');
    expect(screen.frame()).toContain('alpha');
    expect(screen.frame()).toContain('Send a message');
    expect(controlled.state.closed).toBe(0);
    expect(candidate.state.closed).toBe(1);
  });

  test('workspace selection is single-flight while the candidate connects', async () => {
    const alpha = fakeClient({ name: 'alpha' });
    const beta = fakeClient({ name: 'beta', mode: 'cloud' });
    const candidate = Promise.withResolvers<AgentClient>();
    let selections = 0;

    const screen = await mountChat(alpha.client, {
      listWorkspaces: () => [ALPHA_LOCAL, BETA_CLOUD],
      onWorkspaceSelect: () => {
        selections += 1;

        return candidate.promise;
      },
      width: 80,
    });

    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the expanded cloud section', () => screen.frame().includes('Beta'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    screen.mockInput.pressEnter();

    for (let index = 0; index < 4; index += 1) await screen.renderOnce();
    expect(selections).toBe(1);
    candidate.resolve(beta.client);
    await screen.waitFor('the single selected workspace', () => screen.frame().includes('beta'));
  });

  test('workspace switching waits for an in-flight workspace action', async () => {
    const pending = Promise.withResolvers<AgentClientStatus>();
    let statusCalls = 0;

    const controlled = fakeClient({
      name: 'alpha',
      status: async () => {
        statusCalls += 1;

        if (statusCalls === 1) {
          return { name: 'alpha', purpose: 'alpha', model: null, reasoningEffort: null };
        }

        return pending.promise;
      },
    });

    const screen = await mountChat(controlled.client, {
      listWorkspaces: () => [ALPHA_LOCAL],
      width: 80,
    });

    await screen.mockInput.typeText('/status');
    screen.mockInput.pressEnter();
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the blocked switch explanation', () =>
      screen.frame().includes('Finish or stop the active workspace action'));
    expect(screen.frame()).not.toContain('Filter workspaces');
    pending.resolve({ name: 'alpha', purpose: 'alpha', model: null, reasoningEffort: null });
    await screen.waitFor('the completed status action', () => screen.frame().includes('Workspace status'));
  });
  test('Alt+W switches workspaces without retaining the previous status', async () => {
    const alpha = fakeClient({ name: 'alpha' });

    const beta = fakeClient({
      name: 'beta',
      mode: 'cloud',
      status: async () => ({
        name: 'Beta Cloud',
        purpose: 'Cloud work',
        model: 'workers-ai/@cf/model',
        reasoningEffort: 'high',
      }),
      history: async () => [{
        id: 'persisted-result',
        role: 'tool_result',
        content: 'Recovered once',
        success: true,
      }],
    });

    beta.client.connect = async () => {
      beta.emit({ type: 'evolution', event: 'startup', message: 'Recovered buffered event' });
      beta.emit({ type: 'turn-start', kind: 'programmatic', text: 'recovered turn' });
      beta.emit({
        type: 'tool-result',
        toolName: 'file',
        toolCallId: 'recovered-tool',
        result: 'Recovered once',
        success: true,
      });
      beta.emit({ type: 'turn-end', turn: TURN });
    };

    const screen = await mountChat(alpha.client, {
      listWorkspaces: () => [ALPHA_LOCAL, BETA_CLOUD],
      onWorkspaceSelect: async () => beta.client,
      width: 80,
    });

    expect(screen.frame()).not.toContain('Filter workspaces');
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the expanded cloud section', () => screen.frame().includes('Beta'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the selected cloud workspace', () => screen.frame().includes('Beta Cloud'));
    expect(screen.frame()).toContain('Recovered buffered event');
    expect(screen.frame().split('Recovered once')).toHaveLength(2);
    expect(screen.frame()).not.toContain('⟳ processing');
    expect(screen.frame()).not.toContain('alpha local');
    expect(alpha.state.closed).toBe(1);
  });

test('when a turn ends, the next keys still land in the composer', async () => {
  const agent = fakeClient({ name: 'keeps-typing' });

  const screen = await mountChat(agent.client);
  agent.emit({ type: 'turn-start', kind: 'user', text: 'count the notes' });
  await screen.waitFor('the turn thinking', () => screen.frame().includes('thinking'));
  agent.emit({ type: 'turn-end', turn: TURN });
  await screen.waitFor('the turn to end', () => !screen.frame().includes('thinking'));
  await screen.mockInput.typeText('and again');
  await screen.waitFor('the next draft in the composer', () => screen.frame().includes('and again'));
});

test('a turn waiting on a rate limit names the provider, not thinking', async () => {
  const agent = fakeClient({ name: 'wait-visible' });

  const screen = await mountChat(agent.client, { kittyKeyboard: true });
  agent.emit({ type: 'turn-start', kind: 'user', text: 'fix the coupon' });
  await screen.waitFor('the turn thinking', () => screen.frame().includes('thinking'));
  agent.emit({
    type: 'run-event',
    event: {
      type: 'provider_wait',
      eventIndex: 3,
      runId: 'run-1',
      timestamp: new Date().toISOString(),
      provider: 'anthropic',
      waitMs: 30_000,
      attempt: 1,
      status: 429,
      source: 'header',
    },
  });
  await screen.waitFor('the phase line to name the wait', () =>
    screen.frame().includes('waiting on anthropic (retry in 30s)'));
  expect(screen.frame()).not.toContain('thinking');
});

  const HUB_FIXTURE: TuiHubData = {
    agents: [{
      id: 'agent-main', label: 'Checkout', kind: 'main', status: 'idle',
      roleId: 'task', tierId: 'default', workspace: 'shop',
    }],
    subordinates: [],
    profile: {
      envelope: {
        authority: { kind: 'local' },
        version: 1,
        digest: 'digest',
        catalog: {
          roles: { task: { description: 'General work', instructions: 'Work directly.', tier: 'default', preset: 'ideate' } },
          tiers: { default: { model: 'workers-ai/deepseek', reasoningEffort: 'medium' } },
        },
      },
      activeRoleId: 'task',
      allowedRoleIds: ['task'],
    },
  };

  test('the Agent Hub creates a local peer with one key and opens its conversation', async () => {
    const main = fakeClient({ name: 'checkout' });

    const peer = fakeClient({ name: 'agent-1', status: async () => ({
      name: 'agent-1', purpose: '', model: 'openai/gpt-5.5', reasoningEffort: 'medium',
    }) });

    let created = 0;

    const screen = await mountChat(main.client, {
      hubData: HUB_FIXTURE,
      listWorkspaces: () => hubWorkspaces({ open: 'checkout', label: 'Checkout', peer: 'agent-1', created: created > 0 }),
      onWorkspaceSelect: async (name) => {
        if (name !== 'agent-1') throw new Error(`unexpected switch to ${name}`);

        return peer.client;
      },
      onNewAgent: async (client) => {
        created += 1;
        expect(client.mode).toBe('local');

        return { name: 'agent-1', displayName: '', kind: 'local-peer' };
      },
    });

    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the agent hub', () => screen.frame().includes('Agent Hub'));
    expect(screen.frame()).toContain('new agent');
    screen.mockInput.pressKey('n');
    await screen.waitFor('the created peer conversation', () => screen.frame().includes('Connected to agent-1'));
    expect(created).toBe(1);
    expect(screen.frame()).not.toContain('Role:');
    expect(screen.frame()).not.toContain('Mission:');

    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the refreshed hub roster', () => screen.frame().includes(codenameFor('agent-1')));
    expect(screen.frame()).toContain('Checkout · main');
    expect(screen.frame()).toContain(`${codenameFor('agent-1')} · main`);
    expect(screen.frame()).toContain('· open');
    screen.mockInput.pressEscape();
  });

  test('the Agent Hub opens and renames a cloud additional agent', async () => {
    const cloud = fakeClient({ name: 'shop-cloud', mode: 'cloud' });
    const renamed: string[] = [];

    const child = fakeClient({
      name: 'sub-1',
      mode: 'cloud',
      rename: async (displayName) => {
        renamed.push(displayName);

        return { name: 'sub-1', displayName };
      },
    });

    let created = 0;

    const screen = await mountChat(cloud.client, {
      hubData: HUB_FIXTURE,
      onNewAgent: async (client) => {
        created += 1;
        expect(client.mode).toBe('cloud');

        return {
          name: 'sub-1',
          displayName: '',
          kind: 'cloud-additional',
          client: child.client,
        };
      },
    });

    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the agent hub', () => screen.frame().includes('Agent Hub'));
    screen.mockInput.pressKey('n');
    await screen.waitFor('the created cloud conversation', () => screen.frame().includes('Connected to sub-1'));
    expect(created).toBe(1);

    await screen.mockInput.typeText('/rename Research partner');
    screen.mockInput.pressEnter();
    await screen.waitFor('the cloud rename result', () => screen.frame().includes('Renamed to Research partner.'));
    expect(renamed).toEqual(['Research partner']);
  });

  test('a conversation the Agent Hub opens takes keys at once, while the previous client still closes', async () => {
    const parent = fakeClient({ name: 'shop-cloud', mode: 'cloud' });
    const closing = Promise.withResolvers<void>();
    parent.client.close = () => closing.promise;
    const child = fakeClient({ name: 'sub-2', mode: 'cloud' });

    const screen = await mountChat(parent.client, {
      hubData: HUB_FIXTURE,
      onNewAgent: async () => ({ name: 'sub-2', displayName: '', kind: 'cloud-additional', client: child.client }),
    });

    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the agent hub', () => screen.frame().includes('Agent Hub'));
    screen.mockInput.pressKey('n');
    await screen.waitFor('the new conversation', () => screen.frame().includes('Connected to sub-2'));
    await screen.mockInput.typeText('typed while closing');
    await screen.waitFor('the draft in the new conversation', () => screen.frame().includes('typed while closing'));
    closing.resolve();
  });

  test('a hub with no wired creator offers no new-agent key', async () => {
    const local = fakeClient({ name: 'solo' });
    const screen = await mountChat(local.client, { hubData: HUB_FIXTURE });
    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the agent hub', () => screen.frame().includes('Agent Hub'));
    expect(screen.frame()).not.toContain('new agent');
    screen.mockInput.pressKey('n');
    // n is not a hub action here.
    expect(screen.frame()).toContain('Agent Hub');
    screen.mockInput.pressEscape();
  });

  test('the Agent Hub lists the subagents the open agent hired, and Enter opens one\'s conversation', async () => {
    const scout: SubordinateRosterEntry = {
      name: 'scout',
      actorReference: null,
      birth: {
        creationId: 'birth-scout',
        seed: { name: 'scout', displayName: 'Scout', nameOrigin: 'user', role: 'task', tier: 'default', mission: 'Survey the logs', lifetime: 'durable' },
        assignment: null,
      },
      deleteRequested: false,
      createdBy: 'orchestrator',
      status: 'working',
      currentTask: 'Survey the logs',
      createdAt: 1,
      dismissedAt: null,
      lifetime: 'durable',
      taskEventId: null,
    };

    const dismissed: SubordinateRosterEntry = {
      ...scout,
      name: 'retired-helper',
      birth: null,
      status: 'dismissed',
      dismissedAt: 2,
    };

    const main = fakeClient({
      name: 'checkout',
      inspectSubordinate: async (request) => {
        if (request.view === 'children') return { view: 'children', path: request.path, page: { status: 'end', items: [scout, dismissed] } };

        if (request.view !== 'history' || request.path.join('/') !== 'scout') return missingSubordinateHistory(request.path);

        return {
          view: 'history',
          path: request.path,
          page: {
            status: 'end',
            items: [
              { id: 'h1', role: 'user', content: 'Look through app.log for errors', createdAt: 1 },
              { id: 'h2', role: 'assistant', content: 'Found 3 errors in app.log', createdAt: 2 },
            ],
          },
        };
      },
    });

    const screen = await mountChat(main.client, { hubData: HUB_FIXTURE });
    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the hired subagent in the hub', () => screen.frame().includes('Scout · agent · task/default'));
    expect(screen.frame()).toContain('Survey the logs');
    expect(screen.frame()).not.toContain('retired-helper');
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the subagent conversation', () => screen.frame().includes('Found 3 errors in app.log'));
    expect(screen.frame()).toContain('Look through app.log for errors');
    screen.mockInput.pressEscape();
    await screen.waitFor('back in the Agent Hub', () => screen.frame().includes('Agent Hub'));
    expect(screen.frame()).not.toContain('Found 3 errors in app.log');
  });

  test('drafts stay with their conversation across a workspace switch', async () => {
    const alpha = fakeClient({ name: 'alpha' });
    const beta = fakeClient({ name: 'beta' });

    const screen = await mountChat(alpha.client, {
      listWorkspaces: () => [ALPHA_LOCAL, BETA_LOCAL],
      onWorkspaceSelect: async (name) => {
        if (name === 'alpha') return alpha.client;

        if (name === 'beta') return beta.client;
        throw new Error(`unexpected switch to ${name}`);
      },
      width: 80,
    });

    await screen.mockInput.typeText('half a thought for alpha');
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the beta workspace', () => screen.frame().includes('Connected to beta'));
    expect(screen.frame()).not.toContain('half a thought for alpha');
    await screen.mockInput.typeText('beta draft');
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer again', () => screen.frame().includes('Esc close'));
    screen.mockInput.pressArrow('up');
    screen.mockInput.pressEnter();
    await screen.waitFor('alpha back with its own draft', () => screen.frame().includes('half a thought for alpha'));
    expect(screen.frame()).not.toContain('beta draft');
  });

  // `createRoot().render()` builds a new container each call, so rendering over a mounted app leaves
  // it committing into freed renderables (segfault); unmount must release the client.
  test('a torn-down chat surface releases its client, and the next one lands its async work', async () => {
    const first = fakeClient({ name: 'first' });
    const firstScreen = await mountChat(first.client, { hubData: HUB_FIXTURE });
    await firstScreen.mockInput.typeText('a draft the composer is still holding');
    expect(first.listenerCount()).toBe(1);
    cleanupChats();
    expect(first.listenerCount()).toBe(0);

    const second = fakeClient({ name: 'second' });
    const peer = fakeClient({ name: 'agent-9' });
    let created = 0;
    const reported: unknown[] = [];
    const consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { reported.push(args[0]); });

    try {
      const screen = await mountChat(second.client, {
        hubData: HUB_FIXTURE,
        listWorkspaces: () => hubWorkspaces({ open: 'second', label: 'Second', peer: 'agent-9', created: created > 0 }),
        onWorkspaceSelect: async () => peer.client,
        onNewAgent: async () => {
          created += 1;

          return { name: 'agent-9', displayName: '', kind: 'local-peer' };
        },
      });

      screen.mockInput.pressKey('a', { meta: true });
      await screen.waitFor('the agent hub', () => screen.frame().includes('Agent Hub'));
      screen.mockInput.pressKey('n');
      await screen.waitFor('the created peer conversation', () => screen.frame().includes('Connected to agent-9'));
      expect(created).toBe(1);
    } finally {
      consoleError.mockRestore();
    }

    expect(reported).toEqual([]);
  });

  // The hub re-read after a workspace switch is async; a key pressed in that window must still open the hub.
  test('the hub key pressed while its read is in flight still opens the hub', async () => {
    const client = fakeClient({ name: 'slowhub' });
    const read = Promise.withResolvers<void>();

    const readHub = async () => {
      await read.promise;

      return HUB_FIXTURE;
    };

    const screen = await mountChat(client.client, { readHub });
    expect(screen.frame()).not.toContain('Agent Hub');
    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the hub surface to own the composer hint', () => screen.frame().includes('Agents ›'));
    expect(screen.frame()).not.toContain('Agent Hub');
    read.resolve();
    await screen.waitFor('the hub the key asked for', () => screen.frame().includes('Agent Hub'));
    expect(screen.frame()).toContain('slowhub · main');
  });

  // A switch's hub refresh must cross no network boundary; the CLI profile reader hits the live account authority.
  test('a workspace switch refreshes the hub without one network request', async () => {
    const alpha = fakeClient({ name: 'alpha' });
    const beta = fakeClient({ name: 'beta' });
    const realFetch = globalThis.fetch;
    const seen: unknown[] = [];
    globalThis.fetch = asFetchFunction(async (input) => {
      seen.push(input);

      return realFetch(input);
    });

    try {
      const screen = await mountChat(alpha.client, {
        hubData: HUB_FIXTURE,
        listWorkspaces: () => [ALPHA_LOCAL, BETA_LOCAL],
        onWorkspaceSelect: async () => beta.client,
      });

      screen.mockInput.pressKey('w', { meta: true });
      await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
      screen.mockInput.pressArrow('down');
      screen.mockInput.pressEnter();
      await screen.waitFor('the beta workspace', () => screen.frame().includes('Connected to beta'));
      screen.mockInput.pressKey('a', { meta: true });
      await screen.waitFor('the hub after the switch', () => screen.frame().includes('Agent Hub'));
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
