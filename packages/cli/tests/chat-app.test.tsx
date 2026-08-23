/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { afterEach, describe, expect, test } from 'bun:test';
import type { EvolutionConfigView } from '@kinu.run/core';

import type {
  AgentClient,
  AgentClientEvent,
  AgentClientStatus,
  DeviceConsentSurface,
  SessionHistorySurface,
} from '../src/agent-client';
import type { AgentModelMenu } from '../src/model-catalog';
import { createCliSession, type CliSessionInfo } from '../src/session';
import { ChatApp } from '../src/tui/chat-app';

const EVOLUTION: EvolutionConfigView = {
  reviewModel: null,
  autoPromoteScaffold: false,
  gepaEvalBudget: 0,
  shadowSampleRate: 0,
  scaffoldExploreShare: 0,
  advisorEnabled: false,
  advisorMinSeverity: 'concern',
};
const TURN = { text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };
const mounted: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const destroy of mounted.splice(0)) await destroy();
});
interface FakeClientOptions {
  name: string;
  mode?: 'local' | 'cloud';
  status?: () => Promise<AgentClientStatus>;
  consents?: DeviceConsentSurface | null;
  sessionHistory?: SessionHistorySurface | null;
  listModels?: () => Promise<AgentModelMenu>;
}

function fakeClient(options: FakeClientOptions) {
  const listeners = new Set<(event: AgentClientEvent) => void>();
  const state = { closed: 0 };
  let evolution: EvolutionConfigView = { ...EVOLUTION };
  const mode = options.mode ?? 'local';
  const client: AgentClient = {
    mode,
    agentName: options.name,
    cliSession: createCliSession(options.name, { noSession: true }),
    consents: options.consents ?? null,
    localControls: mode === 'local' ? {
      getAlwaysActiveSkills: () => [],
      setAlwaysActiveSkills: () => {},
      getShellApprovalMode: () => 'strict',
      setShellApprovalMode: (approval) => approval,
      setShellApprovalHandler: () => () => {},
      listModelProviders: async () => [],
    } : null,
    checkpoints: null,
    sessionHistory: options.sessionHistory ?? (mode === 'local'
      ? { list: () => [], resume: async () => {} }
      : null),
    inlineAttachmentLimitBytes: 1024,
    connect: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    send: async () => TURN,
    steer: () => false,
    branch: () => false,
    fork: async () => ({ client, label: options.name }),
    stop: () => [],
    close: async () => { state.closed += 1; },
    history: async () => [],
    status: options.status ?? (async () => ({
      name: options.name,
      purpose: `${options.name} purpose`,
      model: 'openai/gpt-5.5',
      reasoningEffort: 'medium',
    })),
    describeTools: async () => ({ builtIn: [], crafted: [] }),
    changelog: async () => ({ entries: [], unseenCount: 0 }),
    revertChangelogEntry: async () => ({ ok: false }),
    readMemory: async () => '',
    searchNodes: async () => [],
    listJobs: async () => [],
    latestTakes: async () => null,
    pickTake: async () => { throw new Error('no takes'); },
    getModelSpec: async () => 'openai/gpt-5.5',
    setModel: async (spec) => ({ spec }),
    getReasoningEffort: async () => 'medium',
    setReasoningEffort: async (effort) => ({ effort }),
    getEvolutionConfig: async () => evolution,
    setEvolutionConfig: async (next) => {
      evolution = { ...evolution, ...next };
      return evolution;
    },
    listModels: options.listModels ?? (async () => ({
      models: [{
        provider: 'openai',
        label: 'GPT 5.5',
        spec: 'openai/gpt-5.5',
        capabilities: ['tools', 'streaming'],
      }],
      failures: [],
    })),
  };
  return {
    client,
    state,
    emit(event: AgentClientEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

async function mountChat(
  client: AgentClient,
  options: {
    listWorkspaces?: () => Array<{ name: string; label: string; mode: 'local' | 'cloud'; cloudName?: string }>;
    onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
  } = {},
) {
  const testRenderer = await createTestRenderer({
    width: 96,
    height: 30,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
  });
  const root = createRoot(testRenderer.renderer);
  root.render(
    <ChatApp
      client={client}
      onExit={() => {}}
      listWorkspaces={options.listWorkspaces}
      onWorkspaceSelect={options.onWorkspaceSelect}
    />,
  );
  const frame = () => testRenderer.captureCharFrame();
  const waitFor = async (what: string, predicate: () => boolean, rounds = 400) => {
    for (let index = 0; index < rounds; index += 1) {
      await testRenderer.renderOnce();
      if (predicate()) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await waitFor('the composer to accept input', () => frame().includes('Send a message'));
  mounted.push(async () => {
    root.render(<box />);
    await testRenderer.renderOnce();
    testRenderer.renderer.destroy();
  });
  return { ...testRenderer, frame, waitFor };
}

const session = (id: string): CliSessionInfo => ({
  id,
  path: `/tmp/${id}.jsonl`,
  agent: 'alpha',
  cwd: '/workspace',
  startedAt: '2026-08-22T00:00:00.000Z',
  modifiedAt: 1,
  entries: 2,
  firstUserText: 'Earlier task',
});

describe('ChatApp terminal interaction', () => {
  test('command palette exposes only truthful local and cloud capabilities', async () => {
    const local = fakeClient({ name: 'local' });
    const localScreen = await mountChat(local.client);
    localScreen.mockInput.pressKey('k', { ctrl: true });
    await localScreen.waitFor('the local command palette', () => localScreen.frame().includes('Filter commands'));
    expect(localScreen.frame()).toContain('/resume');
    localScreen.mockInput.pressEscape();
    await localScreen.waitFor('the command palette to close', () =>
      !localScreen.frame().includes('Filter commands'));
    localScreen.mockInput.pressKey('g', { ctrl: true });
    await localScreen.waitFor('interactive settings', () =>
      localScreen.frame().includes('Filter settings'));
    expect(localScreen.frame()).toContain('Reasoning effort');
    expect(localScreen.frame()).toContain('Local shell');
    localScreen.mockInput.pressArrow('down');
    localScreen.mockInput.pressEnter();
    await localScreen.waitFor('the selected setting to apply', () =>
      localScreen.frame().includes('Reasoning effort: low'));
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
    expect(cloudScreen.frame()).toContain('/connect');
  });
  test('resume picker starts in the current folder and expands on Tab', async () => {
    const resumed: string[] = [];
    const controlled = fakeClient({
      name: 'alpha',
      sessionHistory: {
        list: () => [session('older')],
        resume: async (id) => { resumed.push(id); },
      },
    });
    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/resume');
    screen.mockInput.pressEnter();
    await screen.waitFor('the folder-scoped resume picker', () =>
      screen.frame().includes('No conversations in this folder'));
    screen.mockInput.pressTab();
    await screen.waitFor('all recorded conversations', () =>
      screen.frame().includes('Earlier task'));
    screen.mockInput.pressEnter();
    await screen.waitFor('the selected conversation to resume', () => resumed.length === 1);
    expect(resumed).toEqual(['older']);
  });

  test('failed resume restores a usable composer and keeps the failure actionable', async () => {
    const controlled = fakeClient({
      name: 'alpha',
      sessionHistory: {
        list: () => [session('older')],
        resume: async () => { throw new Error('Unauthorized model provider'); },
      },
    });
    const screen = await mountChat(controlled.client);
    await screen.mockInput.typeText('/resume 1');
    screen.mockInput.pressEnter();
    await screen.waitFor('the resume failure', () =>
      screen.frame().includes('Unauthorized model provider'));
    await screen.waitFor('the composer after failed resume', () =>
      screen.frame().includes('Send a message'));
    await screen.mockInput.typeText('/status');
    screen.mockInput.pressEnter();
    await screen.waitFor('a command after failed resume', () =>
      screen.frame().includes('Workspace Status'));
    expect(screen.frame()).not.toContain('Still connecting.');
  });

  test('device consent owns every key until the decision closes it', async () => {
    const decisions: string[] = [];
    const pending = {
      consentId: 'consent-1',
      deviceLabel: 'Workstation',
      method: 'run',
      command: 'bun test',
    };
    const controlled = fakeClient({
      name: 'cloudish',
      consents: {
        listPending: async () => [pending],
        resolve: async (_id, decision) => {
          decisions.push(decision);
          return { ok: true };
        },
      },
    });
    const screen = await mountChat(controlled.client);
    controlled.emit({ type: 'turn-start', kind: 'user', text: 'run the suite' });
    await screen.waitFor('the consent overlay', () => screen.frame().includes('Use your PC?'));
    await screen.mockInput.typeText('hidden draft');
    screen.mockInput.pressKey('p', { ctrl: true });
    screen.mockInput.pressTab();
    await screen.renderOnce();
    expect(screen.frame()).not.toContain('hidden draft');
    expect(screen.frame()).not.toContain('Select model');
    expect(screen.frame()).not.toContain('queued');
    screen.mockInput.pressKey('n');
    await screen.waitFor('the consent decision', () => decisions.length === 1);
    expect(decisions).toEqual(['deny']);
  });


  test('closing a loading model panel cannot reopen it from a stale result', async () => {
    const pending = Promise.withResolvers<AgentModelMenu>();
    const controlled = fakeClient({
      name: 'alpha',
      listModels: () => pending.promise,
    });
    const screen = await mountChat(controlled.client);
    screen.mockInput.pressKey('p', { ctrl: true });
    await screen.waitFor('the loading model panel', () => screen.frame().includes('Loading models'));
    screen.mockInput.pressEscape();
    await screen.waitFor('the model panel to close', () =>
      !screen.frame().includes('Select model'));
    pending.resolve({ models: [], failures: [] });
    for (let index = 0; index < 6; index += 1) await screen.renderOnce();
    expect(screen.frame()).not.toContain('Select model');
    expect(screen.frame()).toContain('Send a message');
  });
  test('Ctrl+O switches workspaces without retaining the previous status', async () => {
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
    });
    const screen = await mountChat(alpha.client, {
      listWorkspaces: () => [
        { name: 'alpha', label: 'Alpha', mode: 'local' },
        { name: 'beta', label: 'Beta', mode: 'cloud', cloudName: 'beta' },
      ],
      onWorkspaceSelect: async () => beta.client,
    });
    expect(screen.frame()).not.toContain('Filter workspaces');
    screen.mockInput.pressKey('o', { ctrl: true });
    await screen.waitFor('the workspace drawer', () => screen.frame().includes('Filter workspaces'));
    screen.mockInput.pressArrow('down');
    screen.mockInput.pressEnter();
    await screen.waitFor('the selected cloud workspace', () => screen.frame().includes('Beta Cloud'));
    expect(screen.frame()).not.toContain('alpha local');
    expect(alpha.state.closed).toBe(1);
  });
});
