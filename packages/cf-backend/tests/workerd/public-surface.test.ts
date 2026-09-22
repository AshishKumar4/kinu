/**
 * ONE turn through the product's PUBLIC surface, inside the pool.
 *
 * WHAT IS PLATFORM HERE, by this layer's own rule. The subject is not the
 * orchestrator's arithmetic — it is the three runtime mechanisms the public door
 * is built out of, none of which `bun test` has: a WebSocket UPGRADE answered by
 * a Worker and carried back to its caller (101 plus a live `response.webSocket`,
 * which bun's fetch cannot produce), the agents-SDK chat rail running inside the
 * Durable Object that owns the conversation, and the durable transcript read
 * back over HTTP from that same object's SQLite. Until this file the whole door
 * was measured only against a deployment (`tests/evals/public-session.ts`), so a
 * break in the route table, the upgrade, or the identity gate was findable only
 * after a deploy.
 *
 * THE PATH, all of it the product's own: `POST /api/user/workspaces` creates the
 * workspace (`handleCreateWorkspaceRequest`, the same handler the CLI plane
 * calls), the socket is opened at `/agents/orchestrator-agent/<name>` and the
 * turn is a `cf_agent_use_chat_request` frame carrying one UIMessage, and the
 * ANSWER is read from `GET /agents/.../get-messages` — the route the web pane is
 * seeded from — rather than from the stream, so what is asserted is what the
 * object durably recorded.
 *
 * THE MODEL SEAM IS THE HTTP ONE, pinned over the product's own `setModel`, and
 * that choice is a measurement rather than a preference: driven instead through
 * the `AI` SERVICE binding on 2026-09-16, the turn's answer still arrived and
 * committed but the model stream's EOF did not — four `llm_call.deferred_rejected`
 * lines, one `chat.stream_observe_failed`, and workerd cancelling the abandoned
 * callee as hung — because the adapter reads the stream's head eagerly and pulls
 * the rest lazily (`direct-workers-ai-fetch.ts:279-330`) and an RPC response body
 * cannot be read after its invocation ends; reproduced identically with the socket
 * opened on the workspace object's own stub, so it is the model plane's shape.
 * Production's `AI` is a Workers AI binding over a subrequest
 * (`wrangler.jsonc:373`), so the seam under test here — openai-compat over the
 * global fetch — is the shape production actually takes.
 *
 * The fake's turn lane answers `echo:<last typed user line>`, so the assertion is
 * an exact string: the answer in the transcript is this test's prompt, echoed,
 * which is only true if the frame reached the DO, the turn ran, and the
 * transcript was written.
 *
 * NO CLOCK. Every wait here ends on a frame the runtime sent — the terminal
 * `done` frame, or the `done` frame that carries the DO's own failure words.
 */
import { env } from 'cloudflare:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ChatHistoryEntrySchema, ORCHESTRATOR_AGENT_SLUG, hostedActorSocketPath, pageSchema, type JsonValue,
} from '@kinu.run/core';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Loopback: the one host `authenticateRequest` accepts without an identity
 *  secret, because possession of the machine is the boundary there
 *  (auth/session.ts:200-213). */
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

/** The credential the pinned model resolves through — the same fixture the
 *  two-turn probe installs, whose `baseURL` is the Node-side fake's host. */
const FIXTURE_CREDENTIAL = {
  kind: 'openai-compat',
  baseURL: 'http://fake-models.invalid/v1',
  apiKey: 'probe-fixture-key',
};

/** The model the fake echoes for. `openai-compat` is the provider the static
 *  credential above serves, so the spec is the product's own spelling. */
const PINNED_MODEL = 'openai-compat/probe';

async function publicJson<T>(path: string, schema: v.GenericSchema<T>, init?: RequestInit): Promise<T> {
  const response = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}${path}`, init);
  const text = await response.text();

  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}: ${text.slice(0, 400)}`);

  return v.parse(schema, JSON.parse(text));
}

/** One `{type:'rpc', …}` frame — the shape the agents-SDK client sends for a
 *  callable method, which is what the web client's `rpc()` wrapper is bound to.
 *  The type word is a literal because the SDK exports no constant for it. */
function rpcRequest(id: string, method: string, args: readonly JsonValue[]): string {
  return JSON.stringify({ type: 'rpc', id, method, args: [...args] });
}

/** The chat frame the web client's transport sends, by the SDK's own constant so
 *  a rename there is a compile error rather than a silent hang. */
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

/** One marker per side, used as BOTH the request id and the prompt: a frame
 *  that names either is traceable to the pane that sent it, whichever field
 *  carried it. */
const ROOT_MARKER = 'root-pane-marker';

const ACTOR_MARKER = 'actor-pane-marker';

/** One pane's socket, with everything read off it. `frames` is every raw
 *  frame in arrival order, which is what makes an absence assertable: the
 *  question is not "did the right frame come" but "did the wrong one". */
interface Pane {
  send(frame: string): void;
  /** Settle when a `use_chat_response` for this request id says `done`; the
   *  reject path carries the runtime's own words. */
  settled(requestId: string): Promise<void>;
  /** The request id of every chat response this socket received. */
  responseIds(): string[];
  /** How many transcript frames this socket received carrying this text. */
  transcriptsCarrying(text: string): number;
  /** One RPC reply, admitted by the caller's own schema at this boundary. */
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
    // The Settings pane's own route: the fixture credential is what the pinned
    // model resolves its baseURL and key through, so the turn's requests are
    // addressed at the fake by the product's credential store, not by a flag.
    await publicJson(`/api/user/credentials/openai-compat.default`, v.object({ ok: v.boolean() }), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(FIXTURE_CREDENTIAL),
    });

    const created = await publicJson('/api/user/workspaces', WorkspaceEntrySchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // No `purpose`: a mission on the create would queue the workspace's own
      // genesis turn, and this file's subject is ONE turn, the one it sends.
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

      // An RPC REPLY, told from a request by the field only a reply carries.
      if (frame.output.type === 'rpc' && frame.output.id === 'pin' && frame.output.success !== undefined) {
        if (frame.output.success) pinned.resolve(frame.output.result);
        else pinned.reject(new Error(`setModel was refused: ${JSON.stringify(frame.output.error)}`));

        return;
      }

      if (frame.output.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE) return;

      if (frame.output.id !== PROMPT) return;

      // `error` is carried on non-terminal frames too — a broken RELAY is
      // reported that way while the turn goes on (chat-transport.ts:432-446) —
      // so what settles this wait is the DO saying `done`, and only a `done`
      // frame that also carries `error` is a failed turn, in its own words.
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

    // Pin the arm's model before the prompt, the call the web client makes for
    // the model menu. The accepted spec is asserted by CONTAINMENT because the
    // deployment normalizes a spec, and what matters is that no substitution
    // happened: a turn on the account default would answer from another lane.
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
    // The model fake's captured log is one Node-side module for every worker
    // bound to it, and `two-turn.test.ts:281` reads it unfiltered: this file
    // borrows the log and hands it back empty.
    await env.SURFACE_CONTROL.resetModelLog();
  });
});

describe('two panes on one workspace object are two chat rooms', () => {
  /**
   * THE DEFECT THIS PINS, measured on main 9c801574b through the browser:
   * one workspace is one Durable Object, so `broadcast` reached every socket
   * and the chat rail had no idea which actor a socket had addressed. The
   * root's transcript rendered in a just-created agent's pane and the agent's
   * words rendered in the root's.
   *
   * Driven the way the product is: one socket on the workspace, one on
   * `/actor/<name>` after the `+` tab's own RPC created the actor, one message
   * on each. What is asserted is the RECIPIENT SET — a socket sees its own
   * actor's `cf_agent_use_chat_response` and `cf_agent_chat_messages` frames
   * and none of the other's — with both positive directions asserted too, so
   * a room that answers nothing at all cannot read as scoped.
   *
   * NO CLOCK. Each side's wait ends on the `done` frame its own request gets.
   * The hosted turn itself runs on the actor's durable wake and is not waited
   * for: admission closes the request, which is the contract the pane's hook
   * is written against.
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

    // The `+` tab's own call, so the actor exists exactly as the product makes
    // it — no fixture registration beside the shipped path.
    root.send(rpcRequest('hire', 'createSubordinateAgent', []));
    const actorName = (await root.rpc('hire', CreatedActorSchema)).name;

    root.send(chatRequest(ROOT_MARKER, ROOT_MARKER));
    await root.settled(ROOT_MARKER);

    // Opened AFTER the root's turn landed: a pane that connects onto a
    // workspace with words already in it is the direction the browser caught,
    // because the seed frame is the first thing it receives.
    const actor = await openPane(`${rootPath}/${hostedActorSocketPath(actorName)}`);

    actor.send(chatRequest(ACTOR_MARKER, ACTOR_MARKER));
    await actor.settled(ACTOR_MARKER);

    // Each room answered its OWN request, and each pane was handed a
    // transcript carrying its own words.
    expect(root.responseIds()).toContain(ROOT_MARKER);
    expect(actor.responseIds()).toContain(ACTOR_MARKER);
    expect(root.transcriptsCarrying(ROOT_MARKER)).toBeGreaterThan(0);
    expect(actor.transcriptsCarrying(ACTOR_MARKER)).toBeGreaterThan(0);

    // And neither room reached the other's socket.
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
  /** A workspace whose root and one hosted actor each said one marker, with
   *  every socket closed again, so what follows reads durable rows only. */
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

    // The pane's two reads, on fresh sockets: the seed on its own path, then the
    // pager named by its snapshot's actor id (naming none answers the root's rows).
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

    // The Dismiss dialog's call: no `keepHistory`, so the conversation is kept.
    workspace.send(rpcRequest('dismiss', 'dismissSubordinate', [actorName]));
    await workspace.rpc('dismiss', v.object({ historyKept: v.literal(true) }));

    // The kept pane's reads: its row off the roster, its page off this socket
    // by the row's actor id. Dismissal changes the row's status and nothing else.
    workspace.send(rpcRequest('roster', 'listSubordinates', []));
    const kept = (await workspace.rpc('roster', v.array(RowSchema))).find((row) => row.name === actorName);

    expect(kept).toEqual({ ...employed, status: 'dismissed' });
    const paged = await pageText(workspace, 'page', kept?.actorId ?? '');

    expect(paged).toContain(ACTOR_MARKER);
    expect(paged).not.toContain(ROOT_MARKER);
    await expect(pageText(workspace, 'stranger', 'actor-this-workspace-never-had')).rejects.toThrow(/not registered in this workspace/);
    workspace.close();

    // It no longer executes: the chat path it had is refused at the edge.
    expect((await env.PUBLIC_SURFACE.fetch(`${ORIGIN}${actorPath}/get-messages`)).status).toBe(404);
    await env.SURFACE_CONTROL.resetModelLog();
  });
});
