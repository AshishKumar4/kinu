/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { InputRenderable, TextareaRenderable } from '@opentui/core';
import { createRoot, flushSync } from '@opentui/react';
import type { EvolutionConfigView } from '@kinu.run/core';
import { fakeAgentClient, fakeLocalControls } from './agent-client';

import type {
  AgentClient,
  AgentClientEvent,
  AgentClientStatus,
  DeviceConsentSurface,
  LocalSessionControls,
  PlanReviewSurface,
  OwnerQuestionSurface,
  WaitingApprovalSurface,
} from '../../src/agent-client';
import type { AgentModelMenu } from '@kinu.run/core';
import { ChatApp, type ChatAppOpts } from '../../src/tui/chat-app';
import type { ListedAgent } from '../../src/agent-list';
import type { TuiHubData } from '../../src/tui/hubs';
import type { TuiAgentSource } from '../../src/tui/tui-shell';
import { createMemoryTuiPreferenceStore } from './tui-preferences';
import { endedNearSilence } from '../../../../scripts/row-verdicts';

const EVOLUTION: EvolutionConfigView = {
  learning: true,
  crafting: true,
  advisorEnabled: false,
  advisorMinSeverity: 'concern',
};

export { TURN } from './agent-client';

/** Synchronous: the flushed unmount must finish before the renderer owning those renderables is destroyed. */
const mounted: Array<() => void> = [];

export function cleanupChats(): void {
  for (const destroy of mounted.splice(0)) destroy();
}

export function soloHub(client: AgentClient): TuiHubData {
  return {
    agents: [{
      id: client.agentName, label: client.agentName, kind: 'main', status: 'idle',
      roleId: 'task', tierId: 'default', workspace: client.agentName,
    }],
    subagents: [],
    work: [],
    taskSubagents: [],
    profile: {
      envelope: {
        authority: { kind: 'local' },
        version: 1,
        digest: 'fixture',
        catalog: {
          roles: { task: { description: 'General work', instructions: 'Work directly.', tier: 'default', preset: 'ideate' } },
          tiers: { default: { model: 'openai/gpt-5.5', reasoningEffort: 'medium' } },
        },
      },
      activeRoleId: 'task',
      allowedRoleIds: ['task'],
    },
  };
}

interface FakeClientOptions {
  name: string;
  mode?: 'local' | 'cloud';
  status?: () => Promise<AgentClientStatus>;
  consents?: DeviceConsentSurface | null;
  localControls?: LocalSessionControls;
  plans?: PlanReviewSurface | null;
  questions?: OwnerQuestionSurface | null;
  approvals?: WaitingApprovalSurface | null;
  listModels?: () => Promise<AgentModelMenu>;
  testModel?: AgentClient['testModel'];
  send?: AgentClient['send'];
  setModel?: AgentClient['setModel'];
  connect?: AgentClient['connect'];
  history?: AgentClient['history'];
  rename?: AgentClient['rename'];
  inspectSubagent?: AgentClient['inspectSubagent'];
  workspaceWork?: AgentClient['workspaceWork'];
  listJobs?: AgentClient['listJobs'];
  workspaceSpend?: AgentClient['workspaceSpend'];
}

export function fakeClient(options: FakeClientOptions) {
  const listeners = new Set<(event: AgentClientEvent) => void>();
  const state = { closed: 0, connected: 0 };
  let evolution: EvolutionConfigView = { ...EVOLUTION };
  let shellApprovalHandler: Parameters<LocalSessionControls['setShellApprovalHandler']>[0] = null;
  const mode = options.mode ?? 'local';

  const client = fakeAgentClient({
    mode,
    agentName: options.name,
    consents: options.consents ?? null,
    plans: options.plans ?? null,
    questions: options.questions ?? null,
    approvals: options.approvals ?? null,
    localControls: mode === 'local' ? (options.localControls ?? fakeLocalControls({
      setShellApprovalHandler: (handler) => {
        shellApprovalHandler = handler;

        return () => { shellApprovalHandler = null; };
      },
    })) : null,
    connect: async () => {
      await options.connect?.();
      state.connected += 1;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => { listeners.delete(listener); };
    },
    ...options.send && { send: options.send },
    ...options.history && { history: options.history },
    close: async () => { state.closed += 1; },
    status: options.status ?? (async () => ({
      name: options.name,
      purpose: `${options.name} purpose`,
      model: 'openai/gpt-5.5',
      reasoningEffort: 'medium',
    })),
    ...options.listJobs && { listJobs: options.listJobs },
    getModelSpec: async () => 'openai/gpt-5.5',
    ...options.setModel && { setModel: options.setModel },
    getReasoningEffort: async () => 'medium',
    ...options.workspaceSpend && { workspaceSpend: options.workspaceSpend },
    // This fixture's workspace keeps its evolution settings, as a real one does.
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
        reasoningEfforts: ['low', 'medium', 'high'],
      }],
      failures: [],
    })),
    ...options.testModel && { testModel: options.testModel },
    ...options.inspectSubagent && { inspectSubagent: options.inspectSubagent },
    ...options.workspaceWork && { workspaceWork: options.workspaceWork },
  });

  const rename = options.rename ?? (mode === 'local'
    ? async (displayName: string) => ({ name: options.name, displayName })
    : undefined);

  if (rename) Object.assign(client, { rename });

  return {
    client,
    state,
    /** `signal` stands for another surface deciding the ask's row first. */
    requestShellApproval(request: Parameters<NonNullable<typeof shellApprovalHandler>>[0], signal = new AbortController().signal) {
      if (!shellApprovalHandler) throw new Error('No shell approval handler installed');

      return shellApprovalHandler(request, signal);
    },
    listenerCount: () => listeners.size,
    emit(event: AgentClientEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

export type FixtureWorkspace = ListedAgent;

export async function mountChat(
  client: AgentClient,
  options: {
    tui?: ChatAppOpts['tui'];
    workspaceSource?: TuiAgentSource;
    listWorkspaces?: () => FixtureWorkspace[];
    onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
    hubData?: TuiHubData;
    /** Answers from memory: the product reader hits the profile authority, a network read when signed in. */
    readHub?: ChatAppOpts['readHub'];
    onNewAgent?: ChatAppOpts['onNewAgent'];
    width?: number;
    terminalOutput?: boolean;
    settled?: (frame: string) => boolean;
    /** False selects basic escape-byte keys; Kitty distinguishes Escape from a prefix and represents Ctrl+comma. */
    kittyKeyboard?: boolean;
    /** The TUI asked to quit (Esc on an empty, fresh session, or /exit). */
    onExit?: () => void;
  } = {},
) {
  const testRenderer = await createTestRenderer({
    width: options.width ?? 96,
    height: 30,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
    kittyKeyboard: options.kittyKeyboard !== false,
    ...(options.terminalOutput && { stdout: process.stdout, bufferedOutput: 'stdout' }),
  });

  const root = createRoot(testRenderer.renderer);

  const workspaceSource: TuiAgentSource | undefined = options.workspaceSource ?? (options.listWorkspaces
    ? {
        load: () => {
          const items = options.listWorkspaces?.() ?? [];

          return { items, total: items.length, nextCursor: null };
        },
      }
    : undefined);

  root.render(
    <ChatApp
      client={client}
      tui={options.tui ?? { preferenceStore: createMemoryTuiPreferenceStore() }}
      onExit={options.onExit ?? (() => {})}
      workspaceSource={workspaceSource}
      onWorkspaceSelect={options.onWorkspaceSelect}
      hubData={options.hubData}
      readHub={options.readHub ?? (async (target) => options.hubData ?? soloHub(target))}
      onNewAgent={options.onNewAgent}
    />,
  );
  const frame = () => testRenderer.captureCharFrame();

  const { renderer } = testRenderer;

  const nextFrame = (what: string) => new Promise<void>((resolve, reject) => {
    const onFrame = () => {
      renderer.off('destroy', onDestroy);
      resolve();
    };

    const onDestroy = () => {
      renderer.off('frame', onFrame);
      reject(new Error(`the renderer was destroyed while waiting for ${what}`));
    };

    renderer.once('frame', onFrame);
    renderer.once('destroy', onDestroy);
  });

  /**
   * Waits until `predicate` holds. A wait has no clock: one whose predicate never holds is reported when the runner says
   * the run's silence nears its bound (`endedNearSilence`), naming what it waited on and showing the screen, so the case
   * fails with a verdict before the runner's kill takes the whole run.
   */
  const waitFor = async (what: string, predicate: () => boolean) => endedNearSilence((async () => {
    await testRenderer.renderOnce();

    while (!predicate()) {
      await nextFrame(what);
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
    }
  })(), async () => {}, () => `${what}. The screen:\n${frame()}`);

  const composerFocused = () => renderer.currentFocusedRenderable instanceof TextareaRenderable
    && !(renderer.currentFocusedRenderable instanceof InputRenderable)
    && renderer.currentFocusedRenderable.focused;

  const filterFocused = () => renderer.currentFocusedRenderable instanceof InputRenderable
    && renderer.currentFocusedRenderable.focused;

  mounted.push(() => {
    // `root.render()` builds a new container per call and destroy unmounts only the last one, so unmount
    // explicitly; on a concurrent root `unmount()` only schedules, so flush it before `destroy()`.
    flushSync(() => { root.unmount(); });
    testRenderer.renderer.destroy();
  });
  await waitFor('the chat surface to settle', () => options.settled ? options.settled(frame()) : composerFocused());

  const mockInput = {
    ...testRenderer.mockInput,
    typeText: (text: string) => flushSync(() => testRenderer.mockInput.typeText(text)),
  };

  return { ...testRenderer, mockInput, frame, waitFor, composerFocused, filterFocused };
}

