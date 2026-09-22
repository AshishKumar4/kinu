/**
 * One turn through the product's public surface in the pool: WebSocket upgrade, the agents-SDK chat rail in the owning DO,
 * and the transcript read back over HTTP (`get-messages`), so what is asserted is what the object durably recorded.
 * Model seam is openai-compat over global fetch, not the `AI` service binding: measured 2026-09-16, the RPC-bound
 * stream's EOF never arrived (`llm_call.deferred_rejected`, callee cancelled as hung). No clock: every wait ends on a `done` frame.
 */
import { env } from 'cloudflare:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ChatHistoryEntrySchema, ORCHESTRATOR_AGENT_SLUG, hostedActorSocketPath, pageSchema, type JsonValue,
} from '@kinu.run/core';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Loopback: the one host `authenticateRequest` accepts without an identity secret (auth/session.ts:200-213). */
const ORIGIN = 'http://localhost';

const PROMPT = 'ping from the pool';

const WorkspaceEntrySchema = v.object({ name: v.string() });

const HistorySchema = v.array(v.object({
  role: v.string(),
  parts: v.optional(v.array(v.object({ type: v.string(), text: v.optional(v.string()) }))),
}));

const FrameSchema = v.object({
  type: v.string(),
  id: v.optional(v.string()),
  body: v.optional(v.string()),
  done: v.optional(v.boolean()),
  error: v.optional(v.union([v.boolean(), v.string()])),
  success: v.optional(v.boolean()),
  result: v.optional(v.unknown()),
});

const SetModelSchema = v.object({ spec: v.string() });

const FIXTURE_CREDENTIAL = {
  kind: 'openai-compat',
  baseURL: 'http://fake-models.invalid/v1',
  apiKey: 'probe-fixture-key',
};

const PINNED_MODEL = 'openai-compat/probe';

async function publicJson<T>(path: string, schema: v.GenericSchema<T>, init?: RequestInit): Promise<T> {
  const response = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}${path}`, init);
  const text = await response.text();

  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}: ${text.slice(0, 400)}`);

  return v.parse(schema, JSON.parse(text));
}

/** The SDK exports no constant for the `rpc` type word, hence the literal. */
function rpcRequest(id: string, method: string, args: readonly JsonValue[]): string {
  return JSON.stringify({ type: 'rpc', id, method, args: [...args] });
}

/** By the SDK's own constant, so a rename there is a compile error rather than a silent hang. */
function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
    id,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }],
        trigger: 'submit-message',
      }),
    },
  });
}

const CreatedActorSchema = v.object({ name: v.string() });

/** Used as both request id and prompt, so a frame naming either is traceable to its pane. */
const ROOT_MARKER = 'root-pane-marker';

const ACTOR_MARKER = 'actor-pane-marker';

/** `frames` is every raw frame in arrival order, which makes an absence assertable. */
interface Pane {
  send(frame: string): void;
  /** The reject path carries the runtime's own words. */
  settled(requestId: string): Promise<void>;
  responseIds(): string[];
  transcriptsCarrying(text: string): number;
  rpc<T>(id: string, schema: v.GenericSchema<T>): Promise<T>;
  close(): void;
}

async function openPane(path: string): Promise<Pane> {
  const upgrade = await env.PUBLIC_SURFACE.fetch(new Request(`${ORIGIN}${path}`, {
    headers: { Upgrade: 'websocket' },
  }));

  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;

  if (socket === null) throw new Error(`${path} answered 101 without a WebSocket`);
  socket.accept();

  const frames: string[] = [];
  const rpcs = new Map<string, PromiseWithResolvers<unknown>>();
  const turns = new Map<string, PromiseWithResolvers<void>>();

  const waiter = <T>(held: Map<string, PromiseWithResolvers<T>>, id: string): PromiseWithResolvers<T> => {
    const found = held.get(id);

    if (found !== undefined) return found;
    const fresh = Promise.withResolvers<T>();
    held.set(id, fresh);

    return fresh;
  };

  socket.addEventListener('message', (event) => {
    const raw = v.is(v.string(), event.data) ? event.data : '';
    frames.push(raw);
    const frame = v.safeParse(FrameSchema, raw.startsWith('{') ? JSON.parse(raw) : {});

    if (!frame.success || frame.output.id === undefined) return;

    if (frame.output.type === 'rpc' && frame.output.success !== undefined) {
      if (frame.output.success) waiter(rpcs, frame.output.id).resolve(frame.output.result);
      else waiter(rpcs, frame.output.id).reject(new Error(`${frame.output.id} was refused: ${JSON.stringify(frame.output.error)}`));

      return;
    }

    if (frame.output.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || frame.output.done !== true) return;

    if (frame.output.error === true) {
      waiter(turns, frame.output.id).reject(new Error(`the turn failed: ${frame.output.body ?? 'no body'}`));

      return;
    }

    waiter(turns, frame.output.id).resolve();
  });

  socket.addEventListener('close', () => {
    for (const pending of rpcs.values()) pending.reject(new Error(`${path} closed before its rpc answered`));

    for (const pending of turns.values()) pending.reject(new Error(`${path} closed before its turn finished`));
  });

  const parsed = (): v.InferOutput<typeof FrameSchema>[] => frames.flatMap((raw) => {
    const frame = v.safeParse(FrameSchema, raw.startsWith('{') ? JSON.parse(raw) : {});

    return frame.success ? [frame.output] : [];
  });

  return {
    send: (frame) => { socket.send(frame); },
    settled: async (requestId) => { await waiter(turns, requestId).promise; },
    rpc: async (id, schema) => v.parse(schema, await waiter(rpcs, id).promise),
    responseIds: () => parsed()
      .filter((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE)
      .flatMap((frame) => frame.id === undefined ? [] : [frame.id]),
    transcriptsCarrying: (text) => frames
      .filter((raw) => raw.includes(`"${CHAT_MESSAGE_TYPES.CHAT_MESSAGES}"`) && raw.includes(text)).length,
    close: () => { socket.close(); },
  };
}

describe('the public surface, driven inside the pool', () => {
  it('creates a workspace over REST and answers one socket turn', async () => {
    // The fixture credential routes the pinned model to the fake via the product's credential store, not a flag.
    await publicJson(`/api/user/credentials/openai-compat.default`, v.object({ ok: v.boolean() }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FIXTURE_CREDENTIAL),
    });

    const created = await publicJson('/api/user/workspaces', WorkspaceEntrySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No `purpose`: a mission would queue a genesis turn, and this file's subject is one turn.
      body: JSON.stringify({ name: 'pool-public', displayName: 'Pool Public Surface' }),
    });

    const socketPath = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(created.name)}`;

    const upgrade = await env.PUBLIC_SURFACE.fetch(new Request(`${ORIGIN}${socketPath}`, {
      headers: { Upgrade: 'websocket' },
    }));

    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;

    if (socket === null) throw new Error('the public chat route answered 101 without a WebSocket');
    socket.accept();

    const pinned = Promise.withResolvers<unknown>();
    const turn = Promise.withResolvers<void>();
    socket.addEventListener('message', (event) => {
      const raw = v.is(v.string(), event.data) ? event.data : '';
      const frame = v.safeParse(FrameSchema, raw.startsWith('{') ? JSON.parse(raw) : {});

      if (!frame.success) return;

      if (frame.output.type === 'rpc' && frame.output.id === 'pin' && frame.output.success !== undefined) {
        if (frame.output.success) pinned.resolve(frame.output.result);
        else pinned.reject(new Error(`setModel was refused: ${JSON.stringify(frame.output.error)}`));

        return;
      }

      if (frame.output.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) return;

      if (frame.output.id !== PROMPT) return;

      // `error` also rides non-terminal frames (a broken relay, chat-transport.ts:432-446): only a `done` frame
      // carrying `error` is a failed turn.
      if (frame.output.done !== true) return;

      if (frame.output.error === true) {
        turn.reject(new Error(`the turn failed: ${frame.output.body ?? 'no body'}`));

        return;
      }

      turn.resolve();
    });
    socket.addEventListener('close', () => {
      turn.reject(new Error('the public chat socket closed before the turn finished'));
    });

    // Asserted by containment because the deployment normalizes a spec; a substitution would answer from another lane.
    socket.send(rpcRequest('pin', 'setModel', [PINNED_MODEL]));
    expect(v.parse(SetModelSchema, await pinned.promise).spec).toContain(PINNED_MODEL);

    socket.send(chatRequest(PROMPT, PROMPT));
    await turn.promise;

    const history = await publicJson(`${socketPath}/get-messages`, HistorySchema);

    const said = history.map((row) => ({
      role: row.role,
      text: (row.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
    }));

    expect(said.filter((row) => row.role === 'user' || row.role === 'assistant')).toEqual([
      { role: 'user', text: PROMPT },
      { role: 'assistant', text: `echo:${PROMPT}` },
    ]);

    socket.close();
    // The fake's log is shared by every bound worker and `two-turn.test.ts:281` reads it unfiltered: hand it back empty.
    await env.SURFACE_CONTROL.resetModelLog();
  });
});

describe('two panes on one workspace object are two chat rooms', () => {
  /**
   * Pins: one workspace is one DO, so `broadcast` reached every socket and actors' transcripts rendered in each other's panes
   * (measured on main 9c801574b). Asserts the recipient set in both directions, so a room that answers nothing cannot read as scoped.
   */
  it('keeps the root chat and a hosted actor chat on separate sockets', async () => {
    await publicJson(`/api/user/credentials/openai-compat.default`, v.object({ ok: v.boolean() }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FIXTURE_CREDENTIAL),
    });

    const created = await publicJson('/api/user/workspaces', WorkspaceEntrySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pool-panes', displayName: 'Pool Two Panes' }),
    });

    const rootPath = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(created.name)}`;
    const root = await openPane(rootPath);

    root.send(rpcRequest('pin', 'setModel', [PINNED_MODEL]));
    expect((await root.rpc('pin', SetModelSchema)).spec).toContain(PINNED_MODEL);

    // The `+` tab's own call, so the actor exists exactly as the product makes it.
    root.send(rpcRequest('hire', 'createSubordinateAgent', []));
    const actorName = (await root.rpc('hire', CreatedActorSchema)).name;

    root.send(chatRequest(ROOT_MARKER, ROOT_MARKER));
    await root.settled(ROOT_MARKER);

    // Opened after the root's turn landed: the seed frame is what the browser caught leaking.
    const actor = await openPane(`${rootPath}/${hostedActorSocketPath(actorName)}`);

    actor.send(chatRequest(ACTOR_MARKER, ACTOR_MARKER));
    await actor.settled(ACTOR_MARKER);

    expect(root.responseIds()).toContain(ROOT_MARKER);
    expect(actor.responseIds()).toContain(ACTOR_MARKER);
    expect(root.transcriptsCarrying(ROOT_MARKER)).toBeGreaterThan(0);
    expect(actor.transcriptsCarrying(ACTOR_MARKER)).toBeGreaterThan(0);

    expect(actor.responseIds()).not.toContain(ROOT_MARKER);
    expect(root.responseIds()).not.toContain(ACTOR_MARKER);
    expect(actor.transcriptsCarrying(ROOT_MARKER)).toBe(0);
    expect(root.transcriptsCarrying(ACTOR_MARKER)).toBe(0);

    root.close();
    actor.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });
});

describe('a hosted actor pane reads its own chat back from nothing', () => {
  /** Every socket closed again, so what follows reads durable rows only. */
  async function workspaceWithTwoChats(name: string): Promise<{ rootPath: string; actorName: string; actorPath: string }> {
    await publicJson(`/api/user/credentials/openai-compat.default`, v.object({ ok: v.boolean() }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FIXTURE_CREDENTIAL),
    });

    const created = await publicJson('/api/user/workspaces', WorkspaceEntrySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, displayName: name }),
    });

    const rootPath = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(created.name)}`;
    const root = await openPane(rootPath);

    root.send(rpcRequest('pin', 'setModel', [PINNED_MODEL]));
    expect((await root.rpc('pin', SetModelSchema)).spec).toContain(PINNED_MODEL);
    root.send(rpcRequest('hire', 'createSubordinateAgent', []));
    const actorName = (await root.rpc('hire', CreatedActorSchema)).name;
    const actorPath = `${rootPath}/${hostedActorSocketPath(actorName)}`;

    root.send(chatRequest(ROOT_MARKER, ROOT_MARKER));
    await root.settled(ROOT_MARKER);
    const actor = await openPane(actorPath);

    actor.send(chatRequest(ACTOR_MARKER, ACTOR_MARKER));
    await actor.settled(ACTOR_MARKER);
    actor.close();
    root.close();

    return { rootPath, actorName, actorPath };
  }

  const pageText = async (pane: Pane, id: string, actor: string): Promise<string> => {
    pane.send(rpcRequest(id, 'getChatHistoryPage', [{ actor, limit: 40 }]));
    const page = await pane.rpc(id, pageSchema(ChatHistoryEntrySchema));

    return page.items.map((entry) => entry.content).join('\n');
  };

  it('serves the actor its own words, not the workspace\'s, on both of the pane\'s reads', async () => {
    const { actorName, actorPath } = await workspaceWithTwoChats('pool-kept-chat');

    // Naming no actor id in the pager answers the root's rows.
    const seed = await publicJson(`${actorPath}/get-messages`, HistorySchema);
    const seedText = seed.flatMap((row) => row.parts ?? []).map((part) => part.text ?? '').join('\n');
    const pane = await openPane(actorPath);

    pane.send(rpcRequest('snapshot', 'getActorSnapshot', [actorName]));
    const { actorId } = await pane.rpc('snapshot', v.object({ actorId: v.string() }));
    const paged = await pageText(pane, 'page', actorId);

    pane.close();

    expect(seedText, 'the seed').toContain(ACTOR_MARKER);
    expect(seedText, 'the seed').not.toContain(ROOT_MARKER);
    expect(paged, 'the pager').toContain(ACTOR_MARKER);
    expect(paged, 'the pager').not.toContain(ROOT_MARKER);
    await env.SURFACE_CONTROL.resetModelLog();
  });

  it('keeps a dismissed actor\'s row and words readable on the workspace socket while its own stays shut', async () => {
    const { rootPath, actorName, actorPath } = await workspaceWithTwoChats('pool-dismissed-chat');
    const workspace = await openPane(rootPath);
    const RowSchema = v.object({ name: v.string(), actorId: v.nullable(v.string()), displayName: v.string(), role: v.string(), status: v.string() });

    workspace.send(rpcRequest('rename', 'renameSubordinateAgent', [actorName, 'Kept Title']));
    const { subordinate: employed } = await workspace.rpc('rename', v.object({ subordinate: RowSchema }));

    // No `keepHistory`: the conversation is kept.
    workspace.send(rpcRequest('dismiss', 'dismissSubordinate', [actorName]));
    await workspace.rpc('dismiss', v.object({ historyKept: v.literal(true) }));

    // Dismissal changes the row's status and nothing else.
    workspace.send(rpcRequest('roster', 'listSubordinates', []));
    const kept = (await workspace.rpc('roster', v.array(RowSchema))).find((row) => row.name === actorName);

    expect(kept).toEqual({ ...employed, status: 'dismissed' });
    const paged = await pageText(workspace, 'page', kept?.actorId ?? '');

    expect(paged).toContain(ACTOR_MARKER);
    expect(paged).not.toContain(ROOT_MARKER);
    await expect(pageText(workspace, 'stranger', 'actor-this-workspace-never-had')).rejects.toThrow(/not registered in this workspace/);
    workspace.close();

    expect((await env.PUBLIC_SURFACE.fetch(`${ORIGIN}${actorPath}/get-messages`)).status).toBe(404);
    await env.SURFACE_CONTROL.resetModelLog();
  });
});
