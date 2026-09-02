/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type { AgentClient, AgentClientStatus } from '../src/agent-client';
import type { AgentModelMenu } from '../src/model-catalog';
import type { TuiHubData } from '../src/tui/hubs';
import { asFetchFunction } from '@kinu.run/core';

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
    // The whole chain reaches the person; the composer says the truth about readiness.
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

  const HUB_FIXTURE: TuiHubData = {
    agents: [{
      id: 'agent-main', label: 'Checkout', kind: 'main', status: 'idle',
      roleId: 'general', tierId: 'default', workspace: 'shop',
    }],
    profile: {
      envelope: {
        authority: { kind: 'local' },
        version: 1,
        digest: 'digest',
        catalog: {
          roles: { general: { description: 'General work', instructions: 'Work directly.', tier: 'default', preset: 'ideate' } },
          tiers: { default: { model: 'workers-ai/deepseek', reasoningEffort: 'medium' } },
        },
      },
      activeRoleId: 'general',
      allowedRoleIds: ['general'],
    },
  };

  test('the Agent Hub creates a local peer with one key and opens its conversation', async () => {
    const main = fakeClient({ name: 'checkout' });
    const peer = fakeClient({ name: 'agent-1', status: async () => ({
      name: 'agent-1', purpose: '', model: 'openai/gpt-5.5', reasoningEffort: 'medium',
    }) });
    const cwd = process.cwd();
    let created = 0;
    const screen = await mountChat(main.client, {
      hubData: HUB_FIXTURE,
      listWorkspaces: () => [
        { name: 'checkout', label: 'Checkout', mode: 'local', cwd, workspaceId: 'shop' },
        ...(created > 0 ? [{ name: 'agent-1', label: '', mode: 'local' as const, cwd, workspaceId: 'shop' }] : []),
      ],
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
    // The one-key affordance is announced; no form ever appears.
    expect(screen.frame()).toContain('new agent');
    screen.mockInput.pressKey('n');
    await screen.waitFor('the created peer conversation', () => screen.frame().includes('Connected to agent-1'));
    expect(created).toBe(1);
    expect(screen.frame()).not.toContain('Role:');
    expect(screen.frame()).not.toContain('Mission:');

    // Reopened, the hub lists the workspace's members with the untitled peer
    // as "New agent" — the current, open conversation.
    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the refreshed hub roster', () => screen.frame().includes('New agent'));
    expect(screen.frame()).toContain('Checkout · main');
    expect(screen.frame()).toContain('New agent · main');
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

  test('a hub with no wired creator offers no new-agent key', async () => {
    const local = fakeClient({ name: 'solo' });
    const screen = await mountChat(local.client, { hubData: HUB_FIXTURE });
    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the agent hub', () => screen.frame().includes('Agent Hub'));
    expect(screen.frame()).not.toContain('new agent');
    screen.mockInput.pressKey('n');
    // Nothing was created and the hub stays put — n is not a hub action here.
    expect(screen.frame()).toContain('Agent Hub');
    screen.mockInput.pressEscape();
  });

  test('drafts stay with their conversation across a workspace switch', async () => {
    const alpha = fakeClient({ name: 'alpha' });
    const beta = fakeClient({ name: 'beta' });
    const screen = await mountChat(alpha.client, {
      listWorkspaces: () => [
        { name: 'alpha', label: 'Alpha', mode: 'local' },
        { name: 'beta', label: 'Beta', mode: 'local' },
      ],
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
    // Selection opens on the current agent's row; one step reaches the peer.
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the beta workspace', () => screen.frame().includes('Connected to beta'));
    // Beta's composer starts clean — alpha's draft did not travel.
    expect(screen.frame()).not.toContain('half a thought for alpha');
    await screen.mockInput.typeText('beta draft');
    screen.mockInput.pressKey('w', { meta: true });
    await screen.waitFor('the workspace drawer again', () => screen.frame().includes('Esc close'));
    screen.mockInput.pressArrow('up');
    screen.mockInput.pressEnter();
    await screen.waitFor('alpha back with its own draft', () => screen.frame().includes('half a thought for alpha'));
    expect(screen.frame()).not.toContain('beta draft');
  });

  // One process mounts many chat surfaces, one after another. Rendering an
  // empty box over a mounted app does not take it down: `createRoot().render()`
  // builds a NEW container each call, so the app stays mounted, keeps its
  // client subscription, and goes on committing into renderables that the
  // renderer is about to free — `EditorView is destroyed` inside React's commit,
  // a later surface that never receives its own async result, and a segfault
  // once the freed memory is touched again.
  test('a torn-down chat surface releases its client, and the next one lands its async work', async () => {
    const first = fakeClient({ name: 'first' });
    const firstScreen = await mountChat(first.client, { hubData: HUB_FIXTURE });
    await firstScreen.mockInput.typeText('a draft the composer is still holding');
    expect(first.listenerCount()).toBe(1);
    cleanupChats();
    // Gone, not painted over: the effect cleanup released the client.
    expect(first.listenerCount()).toBe(0);

    const second = fakeClient({ name: 'second' });
    const peer = fakeClient({ name: 'agent-9' });
    const cwd = process.cwd();
    let created = 0;
    const reported: unknown[] = [];
    const consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { reported.push(args[0]); });
    try {
      const screen = await mountChat(second.client, {
        hubData: HUB_FIXTURE,
        listWorkspaces: () => [
          { name: 'second', label: 'Second', mode: 'local', cwd, workspaceId: 'shop' },
          ...(created > 0 ? [{ name: 'agent-9', label: '', mode: 'local' as const, cwd, workspaceId: 'shop' }] : []),
        ],
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
    // The dead surface reported nothing into the live one's run.
    expect(reported).toEqual([]);
  });

  // A workspace switch clears the hub and re-reads it, and that read is
  // asynchronous — the CLI's own reader asks the profile authority, which is a
  // network read on a signed-in machine. A key pressed inside that window used
  // to be dropped on the floor: the surface stayed closed, nothing was said,
  // and no later frame could recover it, because only another keypress could.
  test('the hub key pressed while its read is in flight still opens the hub', async () => {
    const client = fakeClient({ name: 'slowhub' });
    const read = Promise.withResolvers<void>();
    const readHub = async () => {
      await read.promise;
      return HUB_FIXTURE;
    };
    const screen = await mountChat(client.client, { readHub });
    // The read has not answered, so there is no hub yet.
    expect(screen.frame()).not.toContain('Agent Hub');
    screen.mockInput.pressKey('a', { meta: true });
    await screen.waitFor('the hub surface to own the composer hint', () => screen.frame().includes('Agents ›'));
    expect(screen.frame()).not.toContain('Agent Hub');
    read.resolve();
    await screen.waitFor('the hub the key asked for', () => screen.frame().includes('Agent Hub'));
    // The row is the open conversation, relabelled live from its own status.
    expect(screen.frame()).toContain('slowhub · main');
  });

  // No unit test may read the developer's home. The hub's re-read used to go
  // through the CLI's own profile reader, whose account authority is a live
  // network read of the machine's signed-in session — measured at 1,567 ms
  // against the real home, inside a unit test. The runner's preload mints a
  // throwaway home so that read cannot leave the machine, and the fixture
  // answers from memory so it never even reaches a store; this test holds
  // both: a switch's hub refresh crosses no network boundary at all.
  test('a workspace switch refreshes the hub without one network request', async () => {
    const alpha = fakeClient({ name: 'alpha' });
    const beta = fakeClient({ name: 'beta' });
    const realFetch = globalThis.fetch;
    const seen: unknown[] = [];
    // Records every outbound request and still answers — a spy, not a stub.
    globalThis.fetch = asFetchFunction(async (input) => {
      seen.push(input);
      return realFetch(input);
    });
    try {
      const screen = await mountChat(alpha.client, {
        hubData: HUB_FIXTURE,
        listWorkspaces: () => [
          { name: 'alpha', label: 'Alpha', mode: 'local' },
          { name: 'beta', label: 'Beta', mode: 'local' },
        ],
        onWorkspaceSelect: async () => beta.client,
      });
      screen.mockInput.pressKey('w', { meta: true });
      await screen.waitFor('the workspace drawer', () => screen.frame().includes('Esc close'));
      screen.mockInput.pressArrow('down');
      screen.mockInput.pressEnter();
      await screen.waitFor('the beta workspace', () => screen.frame().includes('Connected to beta'));
      // Give the refresh every chance to fire, then prove the network stayed
      // closed across the whole switch.
      screen.mockInput.pressKey('a', { meta: true });
      await screen.waitFor('the hub after the switch', () => screen.frame().includes('Agent Hub'));
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
