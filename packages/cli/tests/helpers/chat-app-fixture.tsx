/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import { missingSubordinateHistory, type EvolutionConfigView } from '@kinu.run/core';

import type {
  AgentClient,
  AgentClientEvent,
  AgentClientStatus,
  DeviceConsentSurface,
  LocalSessionControls,
  PlanReviewSurface,
} from '../../src/agent-client';
import type { AgentModelMenu } from '@kinu.run/core';
import { createCliSession } from '../../src/session';
import { ChatApp, type ChatAppOpts } from '../../src/tui/chat-app';
import type { TuiHubData } from '../../src/tui/hubs';
import type { TuiAgentSource } from '../../src/tui/tui-shell';
import { createMemoryTuiPreferenceStore } from './tui-preferences';

const EVOLUTION: EvolutionConfigView = {
  autoPromoteScaffold: false,
  gepaEvalBudget: 0,
  shadowSampleRate: 0,
  scaffoldExploreShare: 0,
  advisorEnabled: false,
  advisorMinSeverity: 'concern',
};

export const TURN = { landed: 'turn' as const, text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };

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
    subordinates: [],
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
  listModels?: () => Promise<AgentModelMenu>;
  send?: AgentClient['send'];
  setModel?: AgentClient['setModel'];
  connect?: AgentClient['connect'];
  history?: AgentClient['history'];
  rename?: AgentClient['rename'];
  inspectSubordinate?: AgentClient['inspectSubordinate'];
  workspaceSpend?: AgentClient['workspaceSpend'];
}

export function fakeClient(options: FakeClientOptions) {
  const listeners = new Set<(event: AgentClientEvent) => void>();
  const state = { closed: 0 };
  let evolution: EvolutionConfigView = { ...EVOLUTION };
  let shellApprovalHandler: Parameters<LocalSessionControls['setShellApprovalHandler']>[0] = null;
  const mode = options.mode ?? 'local';

  const client: AgentClient = {
    mode,
    agentName: options.name,
    cliSession: createCliSession(options.name, { noTranscript: true }),
    consents: options.consents ?? null,
    plans: options.plans ?? null,
    localControls: mode === 'local' ? (options.localControls ?? {
      getAlwaysActiveSkills: () => [],
      setAlwaysActiveSkills: () => {},
      getShellApprovalMode: () => 'strict',
      setShellApprovalMode: (approval) => approval,
      setShellApprovalHandler: (handler) => {
        shellApprovalHandler = handler;

        return () => { shellApprovalHandler = null; };
      },
      listDeferredApprovals: async () => [],
      decideDeferredApprovals: async () => ({ decided: [] }),
      listModelProviders: async () => [],
      listInstructionApprovals: async () => ({ status: 'end' as const, items: [] }),
      readInstructionApproval: async () => null,
      approveInstruction: async () => ({ ok: true as const, path: '', digest: '' }),
      revokeInstruction: async () => ({ ok: true as const, path: '', digest: '' }),
    }) : null,
    checkpoints: null,
    inlineAttachmentLimitBytes: 1024,
    connect: options.connect ?? (async () => {}),
    subscribe: (listener) => {
      listeners.add(listener);

      return () => { listeners.delete(listener); };
    },
    send: options.send ?? (async () => TURN),
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
    refinements: async () => ({ requests: [], debt: { turnIds: [], owed: false, key: '', summary: 'no unresolved corrections — nothing is owed a refinement' } }),
    decideRefinement: async () => ({ ok: false as const, error: 'not in this fixture' }),
    showRefinement: async () => ({ ok: false as const, error: 'not in this fixture' }),
    requestRefinement: async () => ({ id: 'refine-test', trigger: 'explicit' as const, scope: 'workspace' as const, stage: 'refused' as const, turnIds: [], routes: [], detail: 'no outcome-labeled turns yet', createdAt: 0 }),
    revertChangelogEntry: async () => ({ ok: false }),
    readMemory: async () => '',
    searchNodes: async () => [],
    listJobs: async () => [],
    latestTakes: async () => null,
    pickTake: async () => { throw new Error('no takes'); },
    getModelSpec: async () => 'openai/gpt-5.5',
    setModel: options.setModel ?? (async (spec) => ({ spec })),
    setRole: async (role) => ({ role }),
    getReasoningEffort: async () => 'medium',
    setReasoningEffort: async (effort) => ({ effort }),
    getProviderAccounts: async () => ({}),
    setProviderAccount: async () => ({}),
    workspaceSpend: options.workspaceSpend ?? (async () => { throw new Error('no spend in this fixture'); }),
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
    inspectSubordinate: options.inspectSubordinate ?? (async (request) => missingSubordinateHistory(request.path)),
  };

  const rename = options.rename ?? (mode === 'local'
    ? async (displayName: string) => ({ name: options.name, displayName })
    : undefined);

  if (rename) Object.assign(client, { rename });

  return {
    client,
    state,
    requestShellApproval(request: Parameters<NonNullable<typeof shellApprovalHandler>>[0]) {
      if (!shellApprovalHandler) throw new Error('No shell approval handler installed');

      return shellApprovalHandler(request);
    },
    listenerCount: () => listeners.size,
    emit(event: AgentClientEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

export interface FixtureWorkspace {
  name: string;
  label: string;
  mode: 'local' | 'cloud';
  cloudName?: string;
  cwd?: string;
  workspaceId?: string;
}

export async function mountChat(
  client: AgentClient,
  options: {
    tui?: ChatAppOpts['tui'];
    listWorkspaces?: () => FixtureWorkspace[];
    onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
    hubData?: TuiHubData;
    /** Answers from memory: the product reader hits the profile authority, a network read when signed in. */
    readHub?: ChatAppOpts['readHub'];
    onNewAgent?: ChatAppOpts['onNewAgent'];
    width?: number;
    settled?: (frame: string) => boolean;
    /** Kitty-protocol keys, for chords the legacy byte set cannot express (Shift+Enter, Ctrl+J distinct from Enter). */
    kittyKeyboard?: boolean;
  } = {},
) {
  const testRenderer = await createTestRenderer({
    width: options.width ?? 96,
    height: 30,
    useThread: false,
    maxFps: Number.POSITIVE_INFINITY,
    kittyKeyboard: options.kittyKeyboard === true,
  });

  const root = createRoot(testRenderer.renderer);

  const workspaceSource: TuiAgentSource | undefined = options.listWorkspaces
    ? {
        load: () => {
          const items = options.listWorkspaces?.() ?? [];

          return { items, total: items.length, nextCursor: null };
        },
      }
    : undefined;

  root.render(
    <ChatApp
      client={client}
      tui={options.tui ?? { preferenceStore: createMemoryTuiPreferenceStore() }}
      onExit={() => {}}
      workspaceSource={workspaceSource}
      onWorkspaceSelect={options.onWorkspaceSelect}
      hubData={options.hubData}
      readHub={options.readHub ?? (async (target) => options.hubData ?? soloHub(target))}
      onNewAgent={options.onNewAgent}
    />,
  );
  const frame = () => testRenderer.captureCharFrame();

  const { renderer } = testRenderer;

  /** The next rendered frame; only the renderer's teardown ends the wait otherwise. */
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

  /** Re-reads `predicate` after each rendered frame and the promise work it settled; no clock ends it. */
  const waitFor = async (what: string, predicate: () => boolean) => {
    await testRenderer.renderOnce();

    while (!predicate()) {
      await nextFrame(what);
      await new Promise<void>((resolve) => { process.nextTick(resolve); });
    }
  };

  const settled = options.settled ?? ((view: string) => view.includes('Send a message'));
  await waitFor('the chat surface to settle', () => settled(frame()));
  mounted.push(() => {
    // `root.render()` builds a new container per call and destroy unmounts only the last one, so unmount
    // explicitly; on a concurrent root `unmount()` only schedules, so flush it before `destroy()`.
    flushSync(() => { root.unmount(); });
    testRenderer.renderer.destroy();
  });

  return { ...testRenderer, frame, waitFor };
}

