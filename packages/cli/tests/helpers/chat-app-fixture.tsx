/** @jsxImportSource @opentui/react */
import { createTestRenderer } from '@opentui/core/testing';
import { createRoot, flushSync } from '@opentui/react';
import type { EvolutionConfigView } from '@kinu.run/core';

import type {
  AgentClient,
  AgentClientEvent,
  AgentClientStatus,
  DeviceConsentSurface,
  LocalSessionControls,
} from '../../src/agent-client';
import type { AgentModelMenu } from '../../src/model-catalog';
import { createCliSession } from '../../src/session';
import { ChatApp, type ChatAppOpts } from '../../src/tui/chat-app';
import type { TuiHubData } from '../../src/tui/hubs';
import type { TuiAgentSource } from '../../src/tui/tui-shell';

const EVOLUTION: EvolutionConfigView = {
  autoPromoteScaffold: false,
  gepaEvalBudget: 0,
  shadowSampleRate: 0,
  scaffoldExploreShare: 0,
  advisorEnabled: false,
  advisorMinSeverity: 'concern',
};
export const TURN = { text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };
/** Teardowns run synchronously: the unmount they flush must complete before
 *  the renderer that owns those renderables is destroyed. */
const mounted: Array<() => void> = [];

export function cleanupChats(): void {
  for (const destroy of mounted.splice(0)) destroy();
}

/** One workspace with one agent and the built-in role, held in memory. What a
 *  surface that never opens its hub still needs the hub reader to answer. */
export function soloHub(client: AgentClient): TuiHubData {
  return {
    agents: [{
      id: client.agentName, label: client.agentName, kind: 'main', status: 'idle',
      roleId: 'general', tierId: 'default', workspace: client.agentName,
    }],
    profile: {
      envelope: {
        authority: { kind: 'local' },
        version: 1,
        digest: 'fixture',
        catalog: {
          roles: { general: { description: 'General work', instructions: 'Work directly.', tier: 'default', preset: 'ideate' } },
          tiers: { default: { model: 'openai/gpt-5.5', reasoningEffort: 'medium' } },
        },
      },
      activeRoleId: 'general',
      allowedRoleIds: ['general'],
    },
  };
}

interface FakeClientOptions {
  name: string;
  mode?: 'local' | 'cloud';
  status?: () => Promise<AgentClientStatus>;
  consents?: DeviceConsentSurface | null;
  /** Lets command tests supply an honest local boundary without mutating the
   * readonly AgentClient surface after construction. */
  localControls?: LocalSessionControls;
  listModels?: () => Promise<AgentModelMenu>;
  send?: AgentClient['send'];
  setModel?: AgentClient['setModel'];
  connect?: AgentClient['connect'];
  history?: AgentClient['history'];
  rename?: AgentClient['rename'];
}

export function fakeClient(options: FakeClientOptions) {
  const listeners = new Set<(event: AgentClientEvent) => void>();
  const state = { closed: 0 };
  let evolution: EvolutionConfigView = { ...EVOLUTION };
  const mode = options.mode ?? 'local';
  const client: AgentClient = {
    mode,
    agentName: options.name,
    cliSession: createCliSession(options.name, { noTranscript: true }),
    consents: options.consents ?? null,
    localControls: mode === 'local' ? (options.localControls ?? {
      getAlwaysActiveSkills: () => [],
      setAlwaysActiveSkills: () => {},
      getShellApprovalMode: () => 'strict',
      setShellApprovalMode: (approval) => approval,
      setShellApprovalHandler: () => () => {},
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
  const rename = options.rename ?? (mode === 'local'
    ? async (displayName: string) => ({ name: options.name, displayName })
    : undefined);
  if (rename) Object.assign(client, { rename });
  return {
    client,
    state,
    /** What still listens to this client. A mounted chat surface holds one; a
     *  torn-down one holds none, because its effect cleanup ran. */
    listenerCount: () => listeners.size,
    emit(event: AgentClientEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

export async function mountChat(
  client: AgentClient,
  options: {
    listWorkspaces?: () => Array<{ name: string; label: string; mode: 'local' | 'cloud'; cloudName?: string; cwd?: string; workspaceId?: string }>;
    onWorkspaceSelect?: (name: string) => Promise<AgentClient>;
    hubData?: TuiHubData;
    /** How a mounted surface re-reads its hub after a switch. Left alone, it
     *  answers with the same fixture data for whatever client asks. The point
     *  is that it answers from memory: the product's own reader goes to the
     *  profile authority, which on a signed-in machine is a network read, and
     *  a unit test that waits on one is measuring the network. */
    readHub?: ChatAppOpts['readHub'];
    onNewAgent?: ChatAppOpts['onNewAgent'];
    width?: number;
    /** What "mounted" means for this test; defaults to the ready composer. */
    settled?: (frame: string) => boolean;
    /** Drive keys as a kitty-protocol terminal encodes them. A test that
     *  needs a chord the legacy byte set cannot express — Shift+Enter, or a
     *  Ctrl+J that is not byte-identical with Enter — asks for this. */
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
      onExit={() => {}}
      workspaceSource={workspaceSource}
      onWorkspaceSelect={options.onWorkspaceSelect}
      hubData={options.hubData}
      readHub={options.readHub ?? (async (target) => options.hubData ?? soloHub(target))}
      onNewAgent={options.onNewAgent}
      profileMutations={{
        setModel: (spec) => client.setModel(spec),
        setReasoningEffort: (effort) => client.setReasoningEffort(effort),
      }}
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
  const settled = options.settled ?? ((view: string) => view.includes('Send a message'));
  await waitFor('the chat surface to settle', () => settled(frame()));
  mounted.push(() => {
    // Two things a teardown here has to know. `root.render()` builds a NEW
    // container on every call, so painting an empty box over the app leaves it
    // mounted, subscribed and committing — and the renderer's own DESTROY hook
    // can only unmount the LAST container it was handed. And this is a
    // concurrent root, so `unmount()` merely SCHEDULES the removal: flushed
    // synchronously, every effect releases what it holds before `destroy()`
    // frees the renderables those effects still point at.
    flushSync(() => { root.unmount(); });
    testRenderer.renderer.destroy();
  });
  return { ...testRenderer, frame, waitFor };
}

