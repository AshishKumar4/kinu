/**
 * One turn through the product's public surface in the pool: WebSocket upgrade, the agents-SDK chat rail in the owning DO,
 * and the transcript read back over HTTP (`get-messages`), so what is asserted is what the object durably recorded.
 * Model seam is openai-compat over global fetch, not the `AI` service binding: measured 2026-09-16, the RPC-bound
 * stream's EOF never arrived (`llm_call.deferred_rejected`, callee cancelled as hung). No clock: every wait ends on a `done` frame.
 */
import { env } from 'cloudflare:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import {
  ChatHistoryEntrySchema, ORCHESTRATOR_AGENT_SLUG, hostedActorSocketPath, pageSchema, positionPageSchema, workspaceSlug, type JsonValue,
} from '@kinu.run/core';
import { describe, expect, it, vi } from 'vitest';
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
  /** Every frame heard, parsed, in arrival order. */
  heard(): v.InferOutput<typeof FrameSchema>[];
  /** Resolves once a frame `holds` has been heard. */
  until(holds: (frame: v.InferOutput<typeof FrameSchema>) => boolean): Promise<void>;
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
  const watchers: { readonly holds: (frame: v.InferOutput<typeof FrameSchema>) => boolean; readonly resolve: () => void }[] = [];
  // An answer is held as what it was, refusal included, until the test reads it: one may arrive before its read.
  const rpcs = new Map<string, PromiseWithResolvers<{ readonly result: unknown } | { readonly refused: Error }>>();
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

    if (frame.success) {
      for (const watcher of watchers.splice(0)) {
        if (watcher.holds(frame.output)) watcher.resolve();
        else watchers.push(watcher);
      }
    }

    if (!frame.success || frame.output.id === undefined) return;

    if (frame.output.type === 'rpc' && frame.output.success !== undefined) {
      if (frame.output.success) waiter(rpcs, frame.output.id).resolve({ result: frame.output.result });
      else waiter(rpcs, frame.output.id).resolve({ refused: new Error(`${frame.output.id} was refused: ${JSON.stringify(frame.output.error)}`) });

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
    for (const pending of rpcs.values()) pending.resolve({ refused: new Error(`${path} closed before its rpc answered`) });

    for (const pending of turns.values()) pending.reject(new Error(`${path} closed before its turn finished`));
  });

  const parsed = (): v.InferOutput<typeof FrameSchema>[] => frames.flatMap((raw) => {
    const frame = v.safeParse(FrameSchema, raw.startsWith('{') ? JSON.parse(raw) : {});

    return frame.success ? [frame.output] : [];
  });

  return {
    send: (frame) => { socket.send(frame); },
    settled: async (requestId) => { await waiter(turns, requestId).promise; },
    rpc: async (id, schema) => {
      const answer = await waiter(rpcs, id).promise;

      if ('refused' in answer) throw answer.refused;

      return v.parse(schema, answer.result);
    },
    responseIds: () => parsed()
      .filter((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE)
      .flatMap((frame) => frame.id === undefined ? [] : [frame.id]),
    transcriptsCarrying: (text) => frames
      .filter((raw) => raw.includes(`"${CHAT_MESSAGE_TYPES.CHAT_MESSAGES}"`) && raw.includes(text)).length,
    heard: parsed,
    until: async (holds) => {
      if (parsed().some(holds)) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      watchers.push({ holds, resolve });
      await promise;
    },
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
   * (measured on main e59e99cb6). Asserts the recipient set in both directions, so a room that answers nothing cannot read as scoped.
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

/** One page of a chat, as text: the actor's by id, or the socket's own with none named. */
const pageText = async (pane: Pane, id: string, actor?: string): Promise<string> => {
  pane.send(rpcRequest(id, 'getChatHistoryPage', [{ ...(actor !== undefined && { actor }), limit: 40 }]));
  const page = await pane.rpc(id, pageSchema(ChatHistoryEntrySchema));

  return page.items.map((entry) => entry.content).join('\n');
};

describe('a hosted actor pane reads its own chat back from nothing', () => {
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

describe('what a page may call on its workspace', () => {
  // A misplaced decorator once left the Work read uncallable from the page and made the egress recorder callable.
  it('reads the overview and Work, and is refused the egress recorder and the scaffold runner', async () => {
    const { rootPath } = await workspaceWithTwoChats('pool-page-callables');
    const pane = await openPane(rootPath);
    const answers: Record<string, string> = {};

    const calls: ReadonlyArray<readonly [string, JsonValue[]]> = [
      ['listWorkspaceWork', []], ['getWorkspaceGitHub', []], ['listWorkspaceAgents', []],
      ['recordGitHubEgress', [[]]], ['runScaffoldOnce', ['probe task']],
    ];

    for (const [name, args] of calls) {
      pane.send(rpcRequest(name, name, args));

      try {
        await pane.rpc(name, v.unknown());
        answers[name] = 'answered';
      } catch (error) {
        answers[name] = String(error);
      }
    }

    pane.close();
    expect(answers).toEqual({
      listWorkspaceWork: 'answered', getWorkspaceGitHub: 'answered', listWorkspaceAgents: 'answered',
      recordGitHubEgress: expect.stringContaining('was refused'), runScaffoldOnce: expect.stringContaining('was refused'),
    });
  });
});

describe('a workspace created over REST with a role, a model and an effort', () => {
  const StatusSchema = v.object({ status: v.looseObject({ roleId: v.string(), model: v.string(), reasoningEffort: v.nullish(v.string()) }) });

  /** The create route's answer, refused or not, and what it said. */
  const create = async (body: Record<string, string>): Promise<{ status: number; text: string }> => {
    const response = await env.PUBLIC_SURFACE.fetch(`${ORIGIN}/api/user/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    return { status: response.status, text: await response.text() };
  };

  /** What the new workspace's own socket says it runs on, before any turn has run. */
  const runsOn = async (name: string): Promise<{ roleId: string; model: string; effort: string | null; pinned: string | null }> => {
    const pane = await openPane(`/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(name)}`);

    pane.send(rpcRequest('status', 'getWorkspaceSnapshot', []));
    const { status } = await pane.rpc('status', StatusSchema);
    pane.send(rpcRequest('pinned', 'getStoredModelSpec', []));
    const { spec } = await pane.rpc('pinned', v.object({ spec: v.nullable(v.string()) }));

    pane.close();

    return { roleId: status.roleId, model: status.model, effort: status.reasoningEffort ?? null, pinned: spec };
  };

  it('reaches the new workspace before its first turn, and a refused request leaves no workspace', async () => {
    await publicJson(`/api/user/credentials/openai-compat.default`, v.object({ ok: v.boolean() }), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(FIXTURE_CREDENTIAL),
    });

    expect((await create({ name: 'pool-auditor', role: 'auditor', model: PINNED_MODEL, reasoningEffort: 'high' })).status).toBe(201);
    expect(await runsOn('pool-auditor')).toEqual({ roleId: 'auditor', model: PINNED_MODEL, effort: 'high', pinned: PINNED_MODEL });

    // One that names none, or the starting role, keeps the starting role and pins no model: it follows the account default.
    expect((await create({ name: 'pool-plain', role: 'task' })).status).toBe(201);
    expect(await runsOn('pool-plain')).toMatchObject({ roleId: 'task', pinned: null });

    const unknownEffort = await create({ name: 'pool-ultra', reasoningEffort: 'ultra' });
    const longName = await create({ name: 'a'.repeat(32) });

    expect([unknownEffort.status, longName.status]).toEqual([400, 400]);
    expect(longName.text).toContain('31');
    expect((await create({ name: workspaceSlug(crypto.randomUUID()) })).status).toBe(201);

    const roster = JSON.stringify(await publicJson('/api/user/workspaces', v.unknown()));

    expect(roster).toContain('pool-auditor');
    expect([roster.includes('pool-ultra'), roster.includes('a'.repeat(32))]).toEqual([false, false]);
  });
});

describe('a chat longer than one page', () => {
  const PageSchema = positionPageSchema(ChatHistoryEntrySchema);

  /** Every id, oldest first, by `limit` at a time from the newest, and the pages it took. */
  const walk = async (pane: Pane, id: string, limit: number, actor?: string): Promise<{ ids: string[]; pages: number }> => {
    const ids: string[] = [];
    let cursor: { before: number } | undefined;

    for (let pages = 1; ; pages += 1) {
      pane.send(rpcRequest(`${id}-${String(pages)}`, 'getChatHistoryPage', [{ ...(actor !== undefined && { actor }), limit, ...(cursor !== undefined && { cursor }) }]));
      const page = await pane.rpc(`${id}-${String(pages)}`, PageSchema);
      ids.unshift(...page.items.map((entry) => entry.id));

      if (page.status === 'end') return { ids, pages };
      cursor = page.next;
    }
  };

  it('is read page by page to its first word, each word once, for the workspace and for each actor apart', async () => {
    const { rootPath, actorName, actorPath } = await workspaceWithTwoChats('pool-paged-chat');
    const window = await openPane(actorPath);

    for (const marker of ['actor-second-word', 'actor-third-word']) {
      window.send(chatRequest(marker, marker));
      await window.settled(marker);
    }

    window.send(rpcRequest('own', 'getActorSnapshot', [actorName]));
    const { actorId } = await window.rpc('own', v.object({ actorId: v.string() }));
    window.send(rpcRequest('whole', 'getChatHistoryPage', [{ actor: actorId, limit: 40 }]));
    const whole = (await window.rpc('whole', PageSchema)).items.map((entry) => entry.id);
    const paged = await walk(window, 'walk', 2, actorId);

    window.close();
    expect(whole.length).toBeGreaterThanOrEqual(6);
    // Each word once, and the paged walk reads what one whole read does.
    expect(new Set(paged.ids).size).toBe(paged.ids.length);
    expect(paged.ids).toEqual(whole);
    expect(paged.pages).toBe(Math.ceil(whole.length / 2));

    // The workspace's own pager walks its own chat the same way, and none of the actor's words.
    const root = await openPane(rootPath);
    root.send(rpcRequest('root-whole', 'getChatHistoryPage', [{ limit: 40 }]));
    const rootWhole = (await root.rpc('root-whole', PageSchema)).items.map((entry) => entry.id);

    expect((await walk(root, 'root-walk', 1)).ids).toEqual(rootWhole);
    expect(rootWhole.some((id) => whole.includes(id))).toBe(false);

    // An actor that never spoke is an empty chat, whose walk ends at once.
    root.send(rpcRequest('quiet', 'createSubordinateAgent', []));
    const quietName = (await root.rpc('quiet', CreatedActorSchema)).name;
    root.send(rpcRequest('quiet-id', 'listSubordinates', []));
    const quiet = (await root.rpc('quiet-id', v.array(v.object({ name: v.string(), actorId: v.nullable(v.string()) })))).find((row) => row.name === quietName);
    root.send(rpcRequest('quiet-page', 'getChatHistoryPage', [{ actor: quiet?.actorId ?? '', limit: 10 }]));

    expect(await root.rpc('quiet-page', PageSchema)).toMatchObject({ status: 'end', items: [] });
    root.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });
});

describe('a pane that joins a room while its turn is in a tool call', () => {
  const ChunkSchema = v.looseObject({ type: v.string(), toolCallId: v.optional(v.string()) });

  /** The tool-call chunks `stream` carried to `pane`, in order. */
  const callChunks = (pane: Pane, stream: string): string[] => pane.heard().flatMap((frame) => {
    if (frame.type !== CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE || frame.id !== stream || frame.body === undefined || frame.body === '') return [];
    const chunk = v.safeParse(ChunkSchema, JSON.parse(frame.body));

    return chunk.success && chunk.output.toolCallId !== undefined ? [chunk.output.type] : [];
  });

  /** The room at `path` runs a `-TOOL` turn parked after its call; a second pane joins, resumes, and hears it end. */
  const joinMidCall = async (path: string, marker: string): Promise<{ chunks: string[]; ends: number }> => {
    const sender = await openPane(path);

    await env.SURFACE_CONTROL.holdParityModel('partial');

    try {
      sender.send(chatRequest(marker, `${marker}-TOOL`));
      await env.SURFACE_CONTROL.parityParked();
      const joiner = await openPane(path);

      joiner.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST }));
      await joiner.until((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING);
      const stream = joiner.heard().find((frame) => frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUMING)?.id ?? '';

      joiner.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK, id: stream }));
      await env.SURFACE_CONTROL.releaseParityModel();
      await joiner.until((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.id === stream && frame.done === true);
      await sender.settled(marker);
      const ends = joiner.heard().filter((frame) => frame.type === CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE && frame.id === stream && frame.done === true).length;

      joiner.close();
      sender.close();

      return { chunks: callChunks(joiner, stream), ends };
    } finally {
      await env.SURFACE_CONTROL.releaseParityModel();
      await env.SURFACE_CONTROL.resetModelLog();
    }
  };

  it('is told the call and hears the turn end once, in the workspace\'s room and in a hosted actor\'s alike', async () => {
    const { rootPath, actorPath } = await workspaceWithTwoChats('pool-join-mid-call');
    // The workspace's model, which its hosted actors answer on too.
    const root = await openPane(rootPath);

    root.send(rpcRequest('parity', 'setModel', ['openai-compat/probe-parity']));
    await root.rpc('parity', SetModelSchema);
    root.close();

    for (const [path, marker] of [[rootPath, 'root-joined'], [actorPath, 'actor-joined']] as const) {
      const joined = await joinMidCall(path, marker);

      // The call's input, whether or not it was streamed in parts, then its one outcome, then the turn's one end.
      const outcomes = joined.chunks.filter((chunk) => chunk.startsWith('tool-output-'));

      expect(joined.chunks.filter((chunk) => chunk === 'tool-input-available')).toHaveLength(1);
      expect(outcomes).toHaveLength(1);
      expect(joined.chunks.at(-1)).toMatch(/^tool-output-(available|error)$/u);
      expect(joined.chunks.indexOf('tool-input-available')).toBeLessThan(joined.chunks.length - 1);
      expect(joined.ends).toBe(1);
    }
  });
});

describe('a hosted actor\'s window acts only on its own actor', () => {
  /**
   * Every callable runs on the workspace's one object, so a call over an actor's socket once ran as the workspace's own
   * agent: a read with no actor id answered the workspace's chat, and the pane's Stop stopped the workspace's turn.
   */
  const ActorIdSchema = v.object({ actorId: v.string() });

  /** Refused by the actor's window, in words that name the method and the actor. */
  const refused = async (pane: Pane, id: string, method: string, actor: string): Promise<void> => {
    await expect(pane.rpc(id, v.unknown())).rejects.toThrow(new RegExp(`${method}.*${actor}`, 'u'));
  };

  it('reads only its own chat, and cannot revert the workspace\'s', async () => {
    const { rootPath, actorName, actorPath } = await workspaceWithTwoChats('pool-window-reads');
    const root = await openPane(rootPath);

    root.send(rpcRequest('sibling', 'createSubordinateAgent', []));
    const siblingName = (await root.rpc('sibling', CreatedActorSchema)).name;
    const sibling = await openPane(`${rootPath}/${hostedActorSocketPath(siblingName)}`);

    sibling.send(rpcRequest('sibling-id', 'getActorSnapshot', [siblingName]));
    const siblingId = (await sibling.rpc('sibling-id', ActorIdSchema)).actorId;

    sibling.close();
    root.send(rpcRequest('opening', 'getChatHistoryPage', [{ limit: 40 }]));
    const opening = (await root.rpc('opening', pageSchema(ChatHistoryEntrySchema))).items.find((entry) => entry.role === 'user');

    const window = await openPane(actorPath);

    window.send(rpcRequest('own', 'getActorSnapshot', [actorName]));
    const actorId = (await window.rpc('own', ActorIdSchema)).actorId;

    expect(await pageText(window, 'own-page', actorId)).toContain(ACTOR_MARKER);
    window.send(rpcRequest('unnamed', 'getChatHistoryPage', [{ limit: 40 }]));
    window.send(rpcRequest('stray', 'getChatHistoryPage', [{ actor: siblingId, limit: 40 }]));
    window.send(rpcRequest('stray-snapshot', 'getActorSnapshot', [siblingName]));
    window.send(rpcRequest('revert', 'revertConversation', [opening?.id ?? '']));
    await refused(window, 'unnamed', 'getChatHistoryPage', actorName);
    await refused(window, 'stray', 'getChatHistoryPage', actorName);
    await refused(window, 'stray-snapshot', 'getActorSnapshot', actorName);
    await refused(window, 'revert', 'revertConversation', actorName);
    window.close();

    expect(await pageText(root, 'root-page')).toContain(ROOT_MARKER);
    root.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });

  it('refuses a call whose arguments are not JSON values, which the runtime would still run on the workspace', async () => {
    const SWAPPED_MODEL = 'openai-compat/swapped-by-window';
    const { rootPath, actorName, actorPath } = await workspaceWithTwoChats('pool-window-overflow');
    const window = await openPane(actorPath);

    // `1e999` parses to Infinity: a frame whose arguments are not JSON values once skipped the gate, and the call ran.
    window.send('{"type":"rpc","id":"overflow","method":"getChatHistoryPage","args":[{"limit":40},1e999]}');
    window.send(`{"type":"rpc","id":"nested","method":"setModel","args":["${SWAPPED_MODEL}",{"cap":-1e999}]}`);
    await refused(window, 'overflow', 'getChatHistoryPage', actorName);
    await refused(window, 'nested', 'setModel', actorName);
    window.close();

    const root = await openPane(rootPath);

    root.send(rpcRequest('model', 'getStoredModelSpec', []));
    expect((await root.rpc('model', v.object({ spec: v.nullable(v.string()) }))).spec).toContain(PINNED_MODEL);
    root.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });

  it('answers the workspace\'s device consents and tools, and lists only its own agent\'s jobs', async () => {
    const { rootPath, actorName, actorPath } = await workspaceWithTwoChats('pool-window-workspace');
    const root = await openPane(rootPath);

    root.send(rpcRequest('sibling', 'createSubordinateAgent', []));
    const siblingName = (await root.rpc('sibling', CreatedActorSchema)).name;

    root.close();
    const window = await openPane(actorPath);

    window.send(rpcRequest('consents', 'listPendingConsents', []));
    window.send(rpcRequest('answer', 'resolveDeviceConsent', ['consent-never-asked', 'deny']));
    window.send(rpcRequest('tools', 'getToolDescriptions', []));
    window.send(rpcRequest('jobs', 'listBackgroundJobs', [20, actorName]));
    window.send(rpcRequest('workspace-jobs', 'listBackgroundJobs', [20]));
    window.send(rpcRequest('sibling-jobs', 'listBackgroundJobs', [20, siblingName]));
    expect(await window.rpc('consents', v.array(v.unknown()))).toEqual([]);
    expect(await window.rpc('answer', v.object({ ok: v.boolean() }))).toEqual({ ok: false });
    await window.rpc('tools', v.object({ builtIn: v.array(v.object({ name: v.string() })) }));
    expect(await window.rpc('jobs', v.array(v.unknown()))).toEqual([]);
    await refused(window, 'workspace-jobs', 'listBackgroundJobs', actorName);
    await refused(window, 'sibling-jobs', 'listBackgroundJobs', actorName);
    window.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });

  it('sends into its own agent\'s turn, never the workspace\'s', async () => {
    const SENT_MARKER = 'window-sent-marker';
    const { rootPath, actorName, actorPath } = await workspaceWithTwoChats('pool-window-send');
    const window = await openPane(actorPath);

    window.send(rpcRequest('own', 'getActorSnapshot', [actorName]));
    const actorId = (await window.rpc('own', ActorIdSchema)).actorId;
    let reads = 0;

    // A mid-turn send from the agent's pane: the words and the turn that answers them are the agent's.
    window.send(rpcRequest('send', 'send', [SENT_MARKER, 'window-send', [], 'build']));
    await window.rpc('send', v.unknown());
    await vi.waitFor(async () => {
      expect(await pageText(window, `actor-page-${String(++reads)}`, actorId)).toContain(`echo:${SENT_MARKER}`);
    }, { timeout: 20_000, interval: 250 });
    window.close();

    const root = await openPane(rootPath);

    expect(await pageText(root, 'root-page')).not.toContain(SENT_MARKER);
    root.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });

  it('stops its own agent, and leaves the workspace\'s running turn alone', async () => {
    const HELD_MARKER = 'root-held-marker';
    const { rootPath, actorPath } = await workspaceWithTwoChats('pool-window-stop');
    const root = await openPane(rootPath);

    root.send(rpcRequest('queue', 'setModel', ['openai-compat/probe-queue']));
    await root.rpc('queue', SetModelSchema);
    await env.SURFACE_CONTROL.holdQueuedModel();

    try {
      root.send(chatRequest(HELD_MARKER, HELD_MARKER));
      // The workspace's turn is running, parked in its model call.
      await env.SURFACE_CONTROL.modelCalledWith(HELD_MARKER);
      const window = await openPane(actorPath);

      window.send(rpcRequest('stop', 'cancelCurrentWork', []));
      await window.rpc('stop', v.unknown());
      window.close();
    } finally {
      await env.SURFACE_CONTROL.releaseQueuedModel();
    }

    await root.settled(HELD_MARKER);
    expect(await pageText(root, 'answered')).toContain(`echo:${HELD_MARKER}`);
    root.close();
    await env.SURFACE_CONTROL.resetModelLog();
  });
});
