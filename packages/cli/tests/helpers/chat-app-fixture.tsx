/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import type { EvolutionConfigView } from '@kinu.run/core';

import type {
  AgentClient,
  AgentClientEvent,
  AgentClientStatus,
  DeviceConsentSurface,
  SessionHistorySurface,
} from '../../src/agent-client';
import type { AgentModelMenu } from '../../src/model-catalog';
import { createCliSession, type CliSessionInfo } from '../../src/session';
import { ChatApp } from '../../src/tui/chat-app';

const EVOLUTION: EvolutionConfigView = {
  reviewModel: null,
  autoPromoteScaffold: false,
  gepaEvalBudget: 0,
  shadowSampleRate: 0,
  scaffoldExploreShare: 0,
  advisorEnabled: false,
  advisorMinSeverity: 'concern',
};
export const TURN = { text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };
const mounted: Array<() => Promise<void>> = [];

export async function cleanupChats(): Promise<void> {
  for (const destroy of mounted.splice(0)) await destroy();
}

interface FakeClientOptions {
  name: string;
  mode?: 'local' | 'cloud';
  status?: () => Promise<AgentClientStatus>;
  consents?: DeviceConsentSurface | null;
  sessionHistory?: SessionHistorySurface | null;
  listModels?: () => Promise<AgentModelMenu>;
  setModel?: AgentClient['setModel'];
  connect?: AgentClient['connect'];
  history?: AgentClient['history'];
}

export function fakeClient(options: FakeClientOptions) {
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
    connect: options.connect ?? (async () => {}),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    send: async () => TURN,
    steer: () => false,
    branch: () => false,
    fork: async () => ({ client, label: options.name }),
    stop: () => [],
    history: options.history ?? (async () => []),
    close: async () => { state.closed += 1; },
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
    setModel: options.setModel ?? (async (spec) => ({ spec })),
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

export async function mountChat(
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

export function session(id: string): CliSessionInfo {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    agent: 'alpha',
    cwd: '/workspace',
    startedAt: '2026-08-22T00:00:00.000Z',
    modifiedAt: 1,
    entries: 2,
    firstUserText: 'Earlier task',
  };
}
