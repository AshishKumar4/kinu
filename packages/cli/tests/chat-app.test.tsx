/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from 'bun:test';

import type { AgentClient, AgentClientStatus } from '../src/agent-client';
import type { AgentModelMenu } from '../src/model-catalog';
import { TURN, cleanupChats, fakeClient, mountChat } from './helpers/chat-app-fixture';

afterEach(cleanupChats);
describe('ChatApp terminal interaction', () => {
  test('command palette exposes only truthful local and cloud capabilities', async () => {
    const local = fakeClient({ name: 'local' });
    const localScreen = await mountChat(local.client);
    expect(localScreen.frame()).not.toContain('⠋ null');
    localScreen.mockInput.pressKey('k', { ctrl: true });
    await localScreen.waitFor('the local command palette', () => localScreen.frame().includes('Filter commands'));
    expect(localScreen.frame()).toContain('/role');
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
  test('failed workspace connection keeps the current workspace usable', async () => {
    const controlled = fakeClient({ name: 'alpha' });
    const candidate = fakeClient({
      name: 'missing',
      mode: 'cloud',
      connect: async () => { throw new Error('Workspace is unavailable'); },
    });
    const screen = await mountChat(controlled.client, {
      listWorkspaces: () => [
        { name: 'alpha', label: 'Alpha', mode: 'local' },
        { name: 'missing', label: 'Missing', mode: 'cloud', cloudName: 'missing' },
      ],
      onWorkspaceSelect: async () => candidate.client,
      width: 80,
    });
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
    // The selection starts on the open agent; the cloud section below it
    // expands first, then its workspace row opens.
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
      listWorkspaces: () => [
        { name: 'alpha', label: 'Alpha', mode: 'local' },
        { name: 'beta', label: 'Beta', mode: 'cloud', cloudName: 'beta' },
      ],
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
      listWorkspaces: () => [{ name: 'alpha', label: 'Alpha', mode: 'local' }],
      width: 80,
    });
    await screen.mockInput.typeText('/status');
    screen.mockInput.pressEnter();
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the blocked switch explanation', () =>
      screen.frame().includes('Finish or stop the active workspace action'));
    expect(screen.frame()).not.toContain('Filter workspaces');
    pending.resolve({ name: 'alpha', purpose: 'alpha', model: null, reasoningEffort: null });
    await screen.waitFor('the completed status action', () => screen.frame().includes('Workspace Status'));
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
      listWorkspaces: () => [
        { name: 'alpha', label: 'Alpha', mode: 'local' },
        { name: 'beta', label: 'Beta', mode: 'cloud', cloudName: 'beta' },
      ],
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
});
