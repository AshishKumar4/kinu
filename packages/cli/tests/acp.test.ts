/** `kinu acp` over a real ACP stream pair; only the AgentClient behind the adapter is a double. */

import { describe, test, expect } from 'bun:test';
import {
  client,
  ndJsonStream,
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  type ClientContext,
  type ContentBlock,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ShellApprovalHandler } from '@kinu.run/cli-backend';
import type { ShellApprovalOutcome, ShellApprovalRequest } from '@kinu.run/core';
import { createAcpAgent } from '../src/acp/agent';
import { createCliSession } from '../src/session';
import type { AgentClient, AgentClientEvent, AgentPrompt, AgentSendResult } from '../src/agent-client';
import * as v from 'valibot';
import { present } from '@kinu.run/test-utils';

const TURN: AgentSendResult = { landed: 'turn', text: '', toolCalls: [], steps: 1, durationMs: 1, hadError: false };

interface FakeOptions {
  events?: AgentClientEvent[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Resolves when send() is called, so a test can cancel mid-turn. */
  hold?: Promise<void>;
}

interface Fake {
  client: AgentClient;
  sent: Array<{ prompt: AgentPrompt; cwd?: string }>;
  readonly stopped: number;
  readonly closed: number;
  approval: ShellApprovalHandler | null;
}

interface FakeState {
  sent: Array<{ prompt: AgentPrompt; cwd?: string }>;
  stopped: number;
  closed: number;
  approval: ShellApprovalHandler | null;
}

function fakeClient(opts: FakeOptions = {}): Fake {
  const listeners = new Set<(e: AgentClientEvent) => void>();
  const state: FakeState = { sent: [], stopped: 0, closed: 0, approval: null };

  const agentClient: AgentClient = {
    mode: 'local',
    agentName: 'test',
    cliSession: createCliSession('test', { noTranscript: true }),
    inlineAttachmentLimitBytes: 1024,
    consents: null,
    checkpoints: null,
    plans: null,
    localControls: {
      getAlwaysActiveSkills: () => [],
      setAlwaysActiveSkills: () => {},
      getShellApprovalMode: () => 'strict',
      setShellApprovalMode: (mode) => mode,
      setShellApprovalHandler: (handler: ShellApprovalHandler | null) => {
        state.approval = handler;

        return () => { state.approval = null; };
      },
      listModelProviders: async () => [],
      listDeferredApprovals: async () => [],
      decideDeferredApprovals: async () => ({ decided: [] }),
      listInstructionApprovals: async () => ({ status: 'end' as const, items: [] }),
      readInstructionApproval: async () => null,
      approveInstruction: async () => ({ ok: true as const, path: '', digest: '' }),
      revokeInstruction: async () => ({ ok: true as const, path: '', digest: '' }),
    },
    connect: async () => {},
    subscribe: (listener: (e: AgentClientEvent) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    send: async (prompt, sendOpts) => {
      state.sent.push({ prompt, cwd: sendOpts?.cwd });

      if (opts.hold) await opts.hold;

      for (const event of opts.events ?? []) for (const listener of listeners) listener(event);

      return TURN;
    },
    branch: () => false,
    fork: async () => ({ client: agentClient, label: 'test' }),
    stop: () => {
      state.stopped += 1;

      return [];
    },
    close: async () => { state.closed += 1; },
    history: async () => (opts.history ?? []).map((m, i) => ({ id: String(i), role: m.role, content: m.content })),
    status: async () => ({ name: 'test', purpose: 'test', model: null, reasoningEffort: null }),
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
    getModelSpec: async () => null,
    setModel: async (spec) => ({ spec }),
    setRole: async (role) => ({ role }),
    getReasoningEffort: async () => null,
    setReasoningEffort: async (effort) => ({ effort }),
    getEvolutionConfig: async () => { throw new Error('no evolution config'); },
    setEvolutionConfig: async () => { throw new Error('no evolution config'); },
    listModels: async () => ({ models: [], failures: [] }),
  };

  return {
    client: agentClient,
    sent: state.sent,
    get stopped() { return state.stopped; },
    get closed() { return state.closed; },
    get approval() { return state.approval; },
    set approval(handler) { state.approval = handler; },
  };
}

async function withConnection<T>(
  fake: Fake,
  op: (ctx: ClientContext, updates: SessionNotification[]) => Promise<T>,
  onPermission?: () => RequestPermissionResponse,
): Promise<T> {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();

  const agentApp = createAcpAgent({
    name: 'kinu',
    version: '0.0.0-test',
    openClient: async () => fake.client,
  });

  const agentConnection = agentApp.connect(ndJsonStream(toClient.writable, toAgent.readable));

  const updates: SessionNotification[] = [];

  const clientApp = client({ name: 'test-editor' })
    .onNotification(CLIENT_METHODS.session_update, (ctx) => { updates.push(ctx.params); });

  if (onPermission) {
    clientApp.onRequest(CLIENT_METHODS.session_request_permission, () => onPermission());
  }

  try {
    return await clientApp.connectWith(
      ndJsonStream(toAgent.writable, toClient.readable),
      (ctx) => op(ctx, updates),
    );
  } finally {
    agentConnection.close();
  }
}

async function newSession(ctx: ClientContext, cwd = '/work'): Promise<string> {
  await ctx.request(AGENT_METHODS.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const session = await ctx.request(AGENT_METHODS.session_new, { cwd, mcpServers: [] });

  return session.sessionId;
}

async function promptUpdates(fake: Fake): Promise<SessionNotification['update'][]> {
  return withConnection(fake, async (ctx, collected) => {
    const sessionId = await newSession(ctx);
    await ctx.request(AGENT_METHODS.session_prompt, { sessionId, prompt: [{ type: 'text', text: 'go' }] });

    return collected.map((u) => u.update);
  });
}

describe('kinu acp — initialization', () => {
  test('reports the protocol version and the capabilities it actually implements', async () => {
    const fake = fakeClient();

    const result = await withConnection(fake, async (ctx) => ctx.request(AGENT_METHODS.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    }));

    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.agentInfo?.name).toBe('kinu');
    expect(result.agentCapabilities?.loadSession).toBe(true);
    expect(result.agentCapabilities?.promptCapabilities?.image).toBe(true);
    // session/close is handled, so it must be advertised.
    expect(result.agentCapabilities?.sessionCapabilities?.close).toEqual({});
  });
});

describe('kinu acp — prompt turn', () => {
  test('text deltas stream as agent_message_chunk and the turn ends with end_turn', async () => {
    const fake = fakeClient({
      events: [
        { type: 'text-delta', delta: 'Hello' },
        { type: 'text-delta', delta: ' world' },
      ],
    });

    const { stop, updates } = await withConnection(fake, async (ctx, collected) => {
      const sessionId = await newSession(ctx);

      const response = await ctx.request(AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });

      return { stop: response.stopReason, updates: collected };
    });

    expect(stop).toBe('end_turn');

    const chunks = updates
      .map((u) => u.update)
      .filter((u) => u.sessionUpdate === 'agent_message_chunk');

    expect(chunks.map((chunk) => v.parse(v.object({ text: v.string() }), chunk.content).text))
      .toEqual(['Hello', ' world']);
    expect(fake.sent).toEqual([{ prompt: 'hi', cwd: '/work' }]);
  });

  test('a tool call is reported with its id, kind and title, then settled as completed', async () => {
    const fake = fakeClient({
      events: [
        { type: 'tool-call', toolName: 'shell', toolCallId: 'tc-1', args: { command: 'ls -la' } },
        { type: 'tool-result', toolName: 'shell', toolCallId: 'tc-1', result: 'a\nb', success: true },
      ],
    });

    const updates = await promptUpdates(fake);

    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'execute',
      // `shell` shows the command, because that is what a user is judging.
      title: 'ls -la',
      status: 'in_progress',
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
    }));
  });

  test('a failed tool settles as failed rather than completed', async () => {
    const fake = fakeClient({
      events: [
        { type: 'tool-call', toolName: 'shell', toolCallId: 'tc-9', args: { command: 'false' } },
        { type: 'tool-result', toolName: 'shell', toolCallId: 'tc-9', result: 'exit 1', success: false, reason: null },
      ],
    });

    const updates = await promptUpdates(fake);

    expect(updates).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call_update', toolCallId: 'tc-9', status: 'failed',
    }));
  });

  test('concurrent calls to the same tool settle independently by id', async () => {
    const fake = fakeClient({
      events: [
        { type: 'tool-call', toolName: 'shell', toolCallId: 'a', args: { command: 'one' } },
        { type: 'tool-call', toolName: 'shell', toolCallId: 'b', args: { command: 'two' } },
        { type: 'tool-result', toolName: 'shell', toolCallId: 'b', result: 'second', success: true },
        { type: 'tool-result', toolName: 'shell', toolCallId: 'a', result: 'first', success: false, reason: null },
      ],
    });

    const updates = await promptUpdates(fake);

    const settled = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    expect(settled).toEqual([
      expect.objectContaining({ toolCallId: 'b', status: 'completed' }),
      expect.objectContaining({ toolCallId: 'a', status: 'failed' }),
    ]);
  });

  test('evolution markers surface as thoughts, not as the answer', async () => {
    const fake = fakeClient({
      events: [{ type: 'evolution', event: 'scaffold', message: 'promoted v2' }],
    });

    const updates = await promptUpdates(fake);

    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'agent_thought_chunk' }));
    expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(false);
  });
});

describe('kinu acp — prompt content', () => {
  test('text, resource context and an image all cross into one Kinu prompt', async () => {
    const fake = fakeClient();

    const prompt: ContentBlock[] = [
      { type: 'text', text: 'explain this' },
      { type: 'resource', resource: { uri: 'file:///a.ts', mimeType: 'text/plain', text: 'const a = 1;' } },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ];

    await withConnection(fake, async (ctx) => {
      const sessionId = await newSession(ctx);

      return ctx.request(AGENT_METHODS.session_prompt, { sessionId, prompt });
    });

    const sent = v.parse(v.object({
      text: v.string(),
      files: v.array(v.object({ url: v.string(), mediaType: v.string() })),
    }), fake.sent[0].prompt);

    expect(sent.text).toContain('explain this');
    expect(sent.text).toContain('const a = 1;');
    expect(sent.text).toContain('file:///a.ts');
    expect(sent.files).toEqual([
      expect.objectContaining({ mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }),
    ]);
  });
});

describe('kinu acp — cancellation', () => {
  test('session/cancel stops the live turn and the prompt reports cancelled', async () => {
    let release = () => {};

    const hold = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeClient({ hold });

    const stop = await withConnection(fake, async (ctx) => {
      const sessionId = await newSession(ctx);

      const pending = ctx.request(AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'long job' }],
      });

      // Cancel only once the turn is genuinely in flight.
      while (fake.sent.length === 0) await new Promise((r) => setTimeout(r, 1));
      await ctx.notify(AGENT_METHODS.session_cancel, { sessionId });
      release();

      return (await pending).stopReason;
    });

    expect(stop).toBe('cancelled');
    expect(fake.stopped).toBe(1);
  });
});

interface PermissionCase {
  name: string;
  command: string;
  hits: ShellApprovalRequest['review']['hits'];
  answer: RequestPermissionResponse;
  outcome: ShellApprovalOutcome;
}

const PERMISSION_CASES: PermissionCase[] = [
  {
    name: 'a gated command is put to the client and an allow answer comes back',
    command: 'sudo systemctl restart nginx',
    hits: [{ decision: 'gate', rule: 'sudo', explanation: 'root' }],
    answer: { outcome: { outcome: 'selected', optionId: 'allow_always' } },
    outcome: 'allow_always',
  },
  {
    name: 'a rejected command comes back as deny',
    command: 'rm -rf build',
    hits: [],
    answer: { outcome: { outcome: 'selected', optionId: 'deny' } },
    outcome: 'deny',
  },
  {
    name: 'a cancelled permission request denies the command',
    command: 'sudo reboot',
    hits: [],
    answer: { outcome: { outcome: 'cancelled' } },
    outcome: 'deny',
  },
];

describe('kinu acp — permission', () => {
  for (const permission of PERMISSION_CASES) {
    test(permission.name, async () => {
      const fake = fakeClient();

      const outcome = await withConnection(
        fake,
        async (ctx) => {
          await newSession(ctx);

          return present(fake.approval, 'the fake client approval hook')({
            command: permission.command,
            executor: 'device',
            review: { decision: 'gate', hits: permission.hits },
          });
        },
        () => permission.answer,
      );

      expect(outcome).toBe(permission.outcome);
    });
  }
});

describe('kinu acp — session lifecycle', () => {
  test('session/load replays the conversation as user and agent chunks', async () => {
    const fake = fakeClient({
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    });

    const updates = await withConnection(fake, async (ctx, collected) => {
      const sessionId = await newSession(ctx);
      await ctx.request(AGENT_METHODS.session_load, { sessionId, cwd: '/work', mcpServers: [] });

      return collected.map((u) => u.update);
    });

    expect(updates).toEqual([
      expect.objectContaining({ sessionUpdate: 'user_message_chunk' }),
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    ]);
  });

  test('session/close releases the underlying workspace client', async () => {
    const fake = fakeClient();
    await withConnection(fake, async (ctx) => {
      const sessionId = await newSession(ctx);

      return ctx.request(AGENT_METHODS.session_close, { sessionId });
    });

    expect(fake.closed).toBe(1);
    expect(fake.approval).toBe(null);
  });

  test('prompting an unknown session is a protocol error, not a crash', async () => {
    const fake = fakeClient();

    const failure = await withConnection(fake, async (ctx) => {
      await newSession(ctx);

      try {
        await ctx.request(AGENT_METHODS.session_prompt, {
          sessionId: 'nope',
          prompt: [{ type: 'text', text: 'hi' }],
        });

        return null;
      } catch (cause) {
        return cause instanceof Error ? cause : new Error(String(cause));
      }
    });

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('nope');
  });
});
