/**
 * THE PUBLIC SESSION'S WIRING, credential-free.
 *
 * Everything in `session.ts` that is a property of the HARNESS rather
 * than of an agent is checkable without a deployment, and this is where it is
 * checked: the frame codec against recorded fixtures, the skip remedies, the
 * cloud-only gate, and the bridge that puts route-shaped run events under the
 * production scorers. It costs nothing and it runs in every tier, which is the
 * point — the live arm is minutes and a shared account, so a defect that can be
 * caught here must not be discovered there.
 *
 * WHAT EACH GROUP GUARDS, stated because a test whose failure mode is unclear
 * gets deleted by the next person:
 *
 *   frames        the accumulator pairs a tool output to its own call, counts
 *                 steps, joins text deltas, and stays idempotent across the
 *                 replay a resumed stream sends from chunk zero. Break any of
 *                 those and a live turn reports the wrong trajectory while the
 *                 suite stays green — the class of defect this whole tier
 *                 exists for.
 *   gating        the live arm is reachable ONLY under `KINU_EVAL_BACKEND=cloud`,
 *                 and every refusal names the command or variable that would
 *                 make the run happen. A skip that says nothing is the false
 *                 green the tier was rebuilt to remove.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import * as v from 'valibot';
import type { UIMessageChunk } from 'ai';

import {
  BUILTIN_PROFILE_CATALOG, isAgentRpcMethod, JOB_OUTPUT_EVENT, JsonValueSchema, profileCatalogDigest, READS_CHANGED_EVENT, renderSoulMarkdown,
  type ProfileCatalog, type RunEvent, type JsonValue,
} from '../../packages/core/src/index';
import { DeploymentAnswer, EVAL_WEB_IDENTITY_ENV, INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import {
  decodeFrame, encodeChatRequest, encodeRpcRequest,
  recordPublicTurn, HeardStreams, type PublicResponseFrame, type PublicTurnRecorder,
} from './session-protocol';
import {
  resolvePublicSessionPlan, resolveWebIdentity,
  KinuPublicSession, openPublicSession, WORKSPACE_LEASE_MS, type InspectionAnswer,
} from './session';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { SubordinateInspectionRequestSchema } from '../../packages/core/src/subordinates/inspection';
import { measurePromptUsage } from './results';
import {
  BROADCAST_FRAME, FILE_TURN_CHUNKS, FIXTURE_REQUEST_ID,
  RECOVERY_TURN_CHUNKS, chatChunkFrame, chatErrorFrame, chatTerminalFrame, chatTurnFrames, rpcReplyFrame,
  streamResumingFrame,
} from './fixtures/session-frames';

const DEPLOYMENT = 'https://kinu.run';

/** The suite name the gating probes resolve under. NOT a real suite's name:
 *  `liveModelTarget` prints `[skip] <suite>` when it refuses, and a probe
 *  borrowing one would put a skip line for a suite this file does not
 *  run into every credential-free tier's log. */
const PROBE_SUITE = 'Public Session Gate Probe';

/**
 * The two frames this session SENDS, parsed back the way the DO parses them.
 *
 * A schema rather than a field read through an assertion, for the reason every
 * boundary in this tree uses one: an assertion fabricates the shape it then
 * trusts, so a request that lost `init.body` would read as one that carries it.
 * The DO's own parse is the authority these mirror — `readTurnContinuity` reads
 * `body.oneShot` and the chat request's `messages` are UI messages
 * (actor-agent.ts:464-478).
 */
const ChatRequestFrameSchema = v.object({
  type: v.string(),
  id: v.string(),
  init: v.object({ method: v.string(), body: v.string() }),
});

const ChatRequestBodySchema = v.object({
  trigger: v.string(),
  oneShot: v.optional(v.boolean()),
  messages: v.array(v.object({
    role: v.string(),
    parts: v.array(v.object({ type: v.string(), text: v.optional(v.string()) })),
  })),
});

const RpcRequestFrameSchema = v.object({
  type: v.string(),
  id: v.string(),
  method: v.string(),
  args: v.array(v.unknown()),
});

/** Feed a turn's frames through the decoder and the accumulator, exactly as the
 *  session's own socket handler does: text off the wire, `decodeFrame`, then the
 *  recorder. One path, so a green here is a statement about the live path. */
function replay(frames: readonly string[]): PublicTurnRecorder {
  const recorder = recordPublicTurn();

  for (const raw of frames) {
    const frame = decodeFrame(raw);

    if (frame?.kind === 'response') recorder.apply(frame.frame);
  }

  return recorder;
}

/** A fixture socket's rpc handler: answers each request with `answer(request)`, or leaves it pending when that is undefined. */
function answerRpcs(answer: (request: v.InferOutput<typeof RpcRequestFrameSchema>) => JsonValue | undefined) {
  return (socket: ServerWebSocket, message: string | Buffer): void => {
    const request = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));
    const result = answer(request);

    if (result !== undefined) socket.send(rpcReplyFrame({ requestId: request.id, result }));
  };
}

/** A fixture deployment's HTTP half: teardown's DELETE is answered, the socket upgrades, and nothing else is served. */
function socketOnly(request: Request, server: Server<undefined>): Response | undefined {
  if (request.method === 'DELETE') return Response.json({ ok: true });

  if (server.upgrade(request)) return;

  return new Response('not found', { status: 404 });
}

test("a helper's own jobs are the RPC's actor, and a helper dismissed since the roster was read has none", async () => {
  const asked: unknown[][] = [];

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: {
      message(socket, message) {
        const request = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));

        asked.push(request.args);

        if (request.args[1] === 'gone-helper') {
          socket.send(rpcReplyFrame({ requestId: request.id, error: '"gone-helper" is not an agent of this workspace.' }));

          return;
        }

        socket.send(rpcReplyFrame({ requestId: request.id, result: [{ id: 'bgjob-tests', kind: 'shell', status: 'running', label: 'workspace: npm test', createdAt: 1 }] }));
      },
    },
  });

  const session = new KinuPublicSession({ origin: server.url.origin, identity: { kind: 'loopback' },
    workspace: 'probe', purpose: 'helper jobs probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    expect((await session.backgroundJobs('task-helper')).map((job) => job.id)).toEqual(['bgjob-tests']);
    expect(await session.backgroundJobs('gone-helper')).toEqual([]);
    expect(await session.backgroundJobs()).toHaveLength(1);
    expect(asked).toEqual([[50, 'task-helper'], [50, 'gone-helper'], [50]]);
  } finally { await session.teardown(); await server.stop(true); }
});

test('trial usage walks retained descendants and every run and event page without merging actor identities', async () => {
  const step = (index: number, input: number, cacheRead: number, output: number) => ({
    type: 'step_finish', runId: 'shared-run-id', eventIndex: index, stepIndex: index,
    timestamp: `2026-10-02T19:00:0${String(index)}Z`, usage: { input, cacheRead, output },
  } satisfies Extract<RunEvent, { type: 'step_finish' }>);

  const child = (name: string) => ({ name, status: 'idle', lifetime: 'workspace', actorReference: { actorId: name } });
  const run = (runId: string) => ({ runId, startedAt: 10, status: 'completed', userMessage: 'work' });

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: { message: answerRpcs((request) => {
      const query = v.parse(SubordinateInspectionRequestSchema, request.args[0]);

      if (query.view === 'children') {
        const items = [];

        if (query.path.length === 0) items.push(child('helper'));
        else if (query.actor === 'helper') items.push(child('nested'));

        return v.parse(JsonValueSchema, { view: 'children', page: { status: 'end', items } });
      }

      if (query.view === 'runs') {
        const runId = query.actor === 'helper' ? 'later-run' : 'shared-run-id';

        const page = query.actor === 'helper' && query.page.cursor === undefined
          ? { status: 'more', items: [run('shared-run-id')], next: { after: 'first-run' } }
          : { status: 'end', items: [run(runId)] };

        return v.parse(JsonValueSchema, { view: 'runs', page });
      }

      if (query.view === 'events') {
        let page: Extract<InspectionAnswer, { view: 'events' }>['page'];

        if (query.actor === 'nested') page = { status: 'end', items: [step(4, 500, 400, 7)] };
        else if (query.runId === 'later-run') page = { status: 'end', items: [{ ...step(3, 50, 0, 3), runId: 'later-run' }] };
        else if (query.query.since === 0) page = { status: 'more', items: [step(1, 100, 60, 5)], next: 2 };
        else page = { status: 'end', items: [step(2, 200, 180, 9)] };

        return v.parse(JsonValueSchema, { view: 'events', page });
      }

      throw new Error('unexpected inspector view');
    }) },
  });

  const session = new KinuPublicSession({ origin: server.url.origin, identity: { kind: 'loopback' },
    workspace: 'probe', purpose: 'request accounting',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();

    const usage = measurePromptUsage(await session.actorLedgers([step(0, 100, 20, 10)]));

    expect(usage).toMatchObject({ inputTokens: 950, outputTokens: 34, metadata: { cacheReadTokens: 660 } });
    expect(usage.metadata.steps.map(({ actor, stepIndex }) => [actor, stepIndex])).toEqual([
      ['main', 0], ['helper', 1], ['helper', 2], ['helper', 3], ['nested', 4],
    ]);
    expect(usage.metadata.cache?.ema).toBeCloseTo(0.41856, 14);
  } finally { await session.teardown(); await server.stop(true); }
});

test('executor RPC decoding preserves refusal provenance and successful refusal-shaped stdout', async () => {
  let response: JsonValue = { stdout: 'failed', stderr: 'remote error', exitCode: 1,
    refusal: { reason: 'io', error: 'remote error', execution: { exitCode: 7 } } };

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: { message: answerRpcs(() => response) },
  });

  const session = new KinuPublicSession({ origin: server.url.origin, identity: { kind: 'loopback' },
    workspace: 'probe', purpose: 'executor protocol probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    expect(await session.execute('device', 'work')).toEqual(response);
    response = { stdout: '{"reason":"denied","error":"historical incident"}', stderr: '', exitCode: 0 };
    expect(await session.execute('device', 'read')).toEqual(response);
  } finally { await session.teardown(); await server.stop(true); }
});

test('clearing a conversation waits for the clear the deployment tells another socket, not the sender', async () => {
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const connections = new Set<ServerWebSocket>();
  let messages = [{ id: 'old', role: 'user', parts: [{ type: 'text', text: 'previous conversation' }] }];

  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (new URL(request.url).pathname.endsWith('/get-messages')) return Response.json(messages);

      return socketOnly(request, upgrading);
    },
    websocket: {
      open(socket) { connections.add(socket); },
      close(socket) { connections.delete(socket); },
      async message(socket, data) {
        if (v.parse(v.object({ type: v.string() }), JSON.parse(data.toString())).type !== 'cf_agent_chat_clear') return;
        requested.resolve();
        await release.promise;
        messages = [];

        for (const peer of connections) {
          if (peer !== socket) peer.send(JSON.stringify({ type: 'cf_agent_chat_clear' }));
        }
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'fresh conversation',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    let cleared = false;
    const clear = session.clearConversation().then(() => { cleared = true; });

    await requested.promise;
    expect(await session.history()).toEqual([{ id: 'old', role: 'user', text: 'previous conversation' }]);
    expect(cleared).toBe(false);
    release.resolve();
    await clear;
    expect(await session.history()).toEqual([]);
  } finally {
    release.resolve();
    await session.teardown();
    await server.stop(true);
  }
});

test('an rpc after the platform closed the idle socket redials and answers, never hangs', async () => {
  // The incident: the runtime deactivated the instance and closed the idle socket (1006); the next
  // rpc was written into the CLOSED socket, which discards a frame without an error, and waited
  // until the tier's deadline killed it. Unfixed, this test hangs to its timeout.
  let upgrades = 0;
  let firstServerSocket: ServerWebSocket | undefined;
  const response: JsonValue = { stdout: 'ok', stderr: '', exitCode: 0 };

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      if (upgrading.upgrade(request)) {
        upgrades += 1;

        return;
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) { firstServerSocket ??= socket; },
      // A request naming `hold` is never answered: its rejection is the signal that the close landed.
      message: answerRpcs((request) => (JSON.stringify(request.args).includes('hold') ? undefined : response)),
    },
  });

  const session = new KinuPublicSession({ origin: server.url.origin, identity: { kind: 'loopback' },
    workspace: 'probe', purpose: 'idle close probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    const held = session.execute('device', 'hold');
    firstServerSocket?.close(1012, 'instance no longer active');
    await expect(held).rejects.toThrow('the workspace socket closed (code 1012, instance no longer active)');

    expect(await session.execute('device', 'after the close')).toEqual(response);
    expect(upgrades).toBe(2);
  } finally { await session.teardown(); await server.stop(true); }
});

// RollingSilkworm's gap 4, 2026-10-01: a detached build printed for minutes and the hang watch heard nothing of it.
test("a running job's output frame is heard as live output, as a head's words are", async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: {
      message(socket, message) {
        const request = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));

        socket.send(JSON.stringify({ type: JOB_OUTPUT_EVENT, jobId: 'bgjob-build', seq: 4, dropped: 0, chunks: [{ stream: 'stdout', text: 'compiled\n' }] }));
        socket.send(rpcReplyFrame({ requestId: request.id, result: [] }));
      },
    },
  });

  const session = new KinuPublicSession({ origin: server.url.origin, identity: { kind: 'loopback' },
    workspace: 'probe', purpose: 'job output probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    const before = session.heard();

    // The frame arrives before the answer to the read that follows it on the same socket.
    await session.agents();

    expect(session.heard()).toBe(before + 1);
  } finally { await session.teardown(); await server.stop(true); }
});

// What the settle reads again on, and what keeps two reads from counting as quiet (`workspace-completion.ts`).
test('a frame naming a live read moves that read before the answer to a later call, and a socket opened moves every read', async () => {
  let firstServerSocket: ServerWebSocket | undefined;

  const lead = {
    key: 'main', label: 'Main', category: 'main', activity: 'working', parent: null, open: { kind: 'chat', path: null }, tab: true,
    input: true, actorId: 'actor-main', figures: { tokens: null, usd: null, wallMs: null, cacheEma: null },
  };

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: {
      open(socket) { firstServerSocket ??= socket; },
      message(socket, message) {
        const request = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));

        // Never answered: its rejection is the close landing.
        if (request.method === 'listSubordinates') return;
        // The tick that wrote ends with its frame, ahead of the answer to any call after the write.
        socket.send(JSON.stringify({ type: READS_CHANGED_EVENT, reads: ['listBackgroundJobs', 'getMemoryContent'] }));
        socket.send(rpcReplyFrame({ requestId: request.id, result: [lead] }));
      },
    },
  });

  const session = new KinuPublicSession({ origin: server.url.origin, identity: { kind: 'loopback' },
    workspace: 'probe', purpose: 'reads moved probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  const moved = () => [session.readsMoved(['listBackgroundJobs']), session.readsMoved(['listWorkspaceAgents'])];

  try {
    await session.connect();
    const moving = session.readsMoving;

    // The agents read is one the room serves a workspace socket.
    expect(isAgentRpcMethod('listWorkspaceAgents')).toBe(true);
    expect(moved()).toEqual([1, 1]);
    expect(await session.agents()).toEqual([{ label: 'Main', category: 'main', activity: 'working', open: { kind: 'chat', path: null } }]);
    expect(moving.aborted).toBe(true);
    expect(moved()).toEqual([2, 1]);

    const held = session.subordinates();
    firstServerSocket?.close(1012, 'instance no longer active');
    await expect(held).rejects.toThrow('the workspace socket closed (code 1012, instance no longer active)');

    // A frame sent while no socket was open is lost: the redial moves every read.
    await session.agents();
    expect(moved()).toEqual([4, 2]);
  } finally { await session.teardown(); await server.stop(true); }
});

test('a tool call is in flight from its input to its last output, and only while its turn is heard', async () => {
  // The ledger writes a call only at its end: on 2026-10-01 a lead's `agents` hire ran 840 s with nothing written.
  const opened = Promise.withResolvers<(frames: readonly string[]) => void>();
  let requestId = '';

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      if (upgrading.upgrade(request)) return;

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) {
        requestId = v.parse(ChatRequestFrameSchema, JSON.parse(message.toString())).id;
        opened.resolve((frames) => { for (const frame of frames) socket.send(frame); });
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'tool calls in flight',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  // A stage is over once its last frame reached the session.
  const stage = async (send: (frames: readonly string[]) => void, chunks: readonly UIMessageChunk[], done = false) => {
    const heard = Promise.withResolvers<void>();
    const last = done ? 'done' : chunks.at(-1)?.type;

    session.onChunk = (type) => { if (type === last) heard.resolve(); };

    send([...chunks.map((chunk) => chatChunkFrame({ requestId, chunk })), ...done ? [chatTerminalFrame({ requestId })] : []]);
    await heard.promise;
  };

  try {
    await session.connect();
    const turn = session.submit('Hire a helper.').settled;
    const send = await opened.promise;

    await stage(send, [{ type: 'start' }, { type: 'start-step' }, { type: 'tool-input-available', toolCallId: 'call-hire', toolName: 'agents', input: {} }]);
    expect(session.toolCallsInFlight()).toEqual(['call-hire']);
    await stage(send, [{ type: 'tool-output-available', toolCallId: 'call-hire', output: 'hired', preliminary: true }]);
    expect(session.toolCallsInFlight()).toEqual(['call-hire']);
    await stage(send, [
      { type: 'tool-output-available', toolCallId: 'call-hire', output: 'the helper answered' },
      { type: 'tool-input-available', toolCallId: 'call-shell', toolName: 'shell', input: {} },
    ]);
    expect(session.toolCallsInFlight()).toEqual(['call-shell']);
    await stage(send, [
      { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'call-shell' },
      { type: 'tool-input-available', toolCallId: 'call-file', toolName: 'file', input: {} },
    ]);
    expect(session.toolCallsInFlight()).toEqual(['call-file']);
    await stage(send, [{ type: 'finish-step' }, { type: 'finish' }], true);
    await turn;
    expect(session.toolCallsInFlight()).toEqual([]);
  } finally { await session.teardown(); await server.stop(true); }
});

/** One frame of `stream` as the decoder hands it on: `chunk` its body, the rest as the deployment set them. */
function heardFrame(stream: string, chunk: UIMessageChunk | null, extra: Omit<PublicResponseFrame, 'id' | 'body'> = {}): PublicResponseFrame {
  return { id: stream, ...(chunk === null ? { body: '' } : { body: JSON.stringify(chunk) }), ...extra };
}

describe('a socket hears the streams of its room', () => {
  test('a call runs from its input to its last output, per stream, and its stream\'s end ends it', () => {
    const heard = new HeardStreams();

    heard.hear('turn', heardFrame('turn', { type: 'tool-input-available', toolCallId: 'hire', toolName: 'agents', input: {} }));
    heard.hear('wake', heardFrame('wake', { type: 'tool-input-available', toolCallId: 'build', toolName: 'shell', input: {} }));
    heard.hear('turn', heardFrame('turn', { type: 'tool-output-available', toolCallId: 'hire', output: 'hired', preliminary: true }));
    expect(heard.running()).toEqual(['hire', 'build']);

    heard.hear('turn', heardFrame('turn', { type: 'tool-output-available', toolCallId: 'hire', output: 'the helper answered' }));
    heard.hear('wake', heardFrame('wake', { type: 'tool-approval-request', approvalId: 'approval', toolCallId: 'build' }));
    heard.hear('wake', heardFrame('wake', { type: 'tool-input-available', toolCallId: 'test', toolName: 'shell', input: {} }));
    expect(heard.running()).toEqual(['test']);

    heard.hear('wake', heardFrame('wake', null, { done: true }));
    expect(heard.running()).toEqual([]);
  });

  test('a replay is not live output, and the calls it sends again run as the stream left them', () => {
    const heard = new HeardStreams();
    const call: UIMessageChunk = { type: 'tool-input-available', toolCallId: 'install', toolName: 'shell', input: {} };

    expect(heard.hear('wake', heardFrame('wake', call, { replay: true }))).toEqual({ live: false, chunk: { type: call.type, toolCallId: 'install' } });
    expect(heard.hear('wake', heardFrame('wake', { type: 'text-delta', id: 'text', delta: 'npm i' })).live).toBe(true);
    expect(heard.running()).toEqual(['install']);
  });
});

test("every live frame of the workspace's room is heard: the turn's own, a turn the product opened, a head's; no replay", async () => {
  const other: string[] = [];

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: {
      message(socket, message) {
        const requestId = v.parse(ChatRequestFrameSchema, JSON.parse(message.toString())).id;
        const wake = (chunk: UIMessageChunk, again = false) => chatChunkFrame({ requestId: 'wake-1', chunk, replay: again });

        // A background job's wake streaming beside the turn, a swarm node's words and its landed step, then the turn.
        for (const frame of [
          wake({ type: 'start' }, true), wake({ type: 'start' }), wake({ type: 'text-delta', id: 'text', delta: 'The job finished.' }),
          chatTerminalFrame({ requestId: 'wake-1' }),
          JSON.stringify({ type: 'head_stream', headId: 'node-1', kind: 'text', delta: 'Reading doc-001.' }),
          JSON.stringify({ type: 'head_activity', headId: 'node-1' }),
          BROADCAST_FRAME,
          ...chatTurnFrames({ requestId, chunks: FILE_TURN_CHUNKS }),
        ]) socket.send(frame);
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'rooms heard',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  session.onHeard = (room, type) => { other.push(`${room ?? 'workspace'} ${type}`); };

  try {
    await session.connect();
    expect(session.heard()).toBe(0);
    await session.submit('Write note.txt.').settled;

    // The wake's three live frames, the head's two, and the turn's chunks with its terminal frame.
    expect(session.heard()).toBe(3 + 2 + FILE_TURN_CHUNKS.length + 1);
    expect(other).toEqual(['workspace start', 'workspace text-delta', 'workspace done', 'workspace head_stream', 'workspace head_activity']);
  } finally { await session.teardown(); await server.stop(true); }
});

test('a socket that meets a turn the product opened acknowledges it, and hears the rest of it live', async () => {
  const acked: string[] = [];
  const call: UIMessageChunk = { type: 'tool-input-available', toolCallId: 'install', toolName: 'shell', input: {} };

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: socketOnly,
    websocket: {
      // A background job's wake streams when the socket opens: the deployment announces it and holds its live chunks back.
      open(socket) { socket.send(streamResumingFrame('wake-1')); },
      message(socket, message) {
        const frame = v.parse(v.looseObject({ type: v.string(), id: v.string() }), JSON.parse(message.toString()));

        if (frame.type === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK) {
          acked.push(frame.id);
          socket.send(chatChunkFrame({ requestId: 'wake-1', chunk: call, replay: true }));
          socket.send(chatChunkFrame({ requestId: 'wake-1', chunk: { type: 'text-delta', id: 'text', delta: 'Installing.' } }));

          return;
        }

        socket.send(rpcReplyFrame({ requestId: v.parse(RpcRequestFrameSchema, JSON.parse(message.toString())).id, result: [] }));
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'a wake met mid-stream',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    // Each read is answered after every frame sent before it: the first after the announcement, so the second goes out
    // after any acknowledgement, and the third is answered after what the acknowledgement brought.
    await session.backgroundJobs();
    await session.backgroundJobs();
    expect(acked).toEqual(['wake-1']);
    await session.backgroundJobs();

    expect(session.heard()).toBe(1);
    expect(session.toolCallsInFlight()).toEqual(['install']);
  } finally { await session.teardown(); await server.stop(true); }
});

test("a working helper is heard in its own room, on a socket that closes when the watch stops listening", async () => {
  const opened = Promise.withResolvers<string>();
  const closed = Promise.withResolvers<void>();
  const heardHelper = Promise.withResolvers<void>();

  const server = Bun.serve<{ path: string; room: boolean }>({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });
      const path = new URL(request.url).pathname;

      if (upgrading.upgrade(request, { data: { path, room: path.includes('/actor/') } })) return;

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) {
        if (!socket.data.room) return;
        opened.resolve(socket.data.path);

        // The helper's turn, as its window hears it: a call it started, then its words.
        for (const chunk of [{ type: 'start' }, { type: 'start-step' },
          { type: 'tool-input-available', toolCallId: 'helper-call', toolName: 'shell', input: {} },
          { type: 'text-delta', id: 'text', delta: 'Counting signups.' }] satisfies UIMessageChunk[]) {
          socket.send(chatChunkFrame({ requestId: 'helper-turn', chunk }));
        }
      },
      message() { /* the room is only listened to */ },
      close(socket) { if (socket.data.room) closed.resolve(); },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'a helper heard',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  session.onHeard = (room, type) => { if (room === 'task-helper' && type === 'text-delta') heardHelper.resolve(); };

  try {
    await session.connect();
    session.listen(['task-helper']);
    expect(await opened.promise).toBe('/agents/orchestrator-agent/probe/actor/task-helper');
    await heardHelper.promise;

    expect(session.heard()).toBe(4);
    expect(session.toolCallsInFlight()).toEqual(['helper-call']);

    session.listen([]);
    expect(session.toolCallsInFlight()).toEqual([]);
    await closed.promise;
  } finally { await session.teardown(); await server.stop(true); }
});

test("a helper's room opened mid-call acknowledges the turn once, and the replayed call runs until its output", async () => {
  const acked: string[] = [];
  const spoke = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const call: UIMessageChunk = { type: 'tool-input-available', toolCallId: 'helper-call', toolName: 'shell', input: {} };
  const room = Promise.withResolvers<ServerWebSocket<{ room: boolean }>>();

  const server = Bun.serve<{ room: boolean }>({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      if (upgrading.upgrade(request, { data: { room: new URL(request.url).pathname.includes('/actor/') } })) return;

      return new Response('not found', { status: 404 });
    },
    websocket: {
      // The helper's room announces its open turn on connect and again on request, and holds its live chunks back until the ack.
      open(socket) {
        if (!socket.data.room) return;
        room.resolve(socket);
        socket.send(streamResumingFrame('helper-turn'));
        socket.send(streamResumingFrame('helper-turn'));
      },
      message(socket, message) {
        const frame = v.parse(v.looseObject({ type: v.string(), id: v.optional(v.string()) }), JSON.parse(message.toString()));

        if (frame.type !== CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK || frame.id === undefined) return;
        acked.push(frame.id);
        socket.send(chatChunkFrame({ requestId: 'helper-turn', chunk: call, replay: true }));
        socket.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE, id: 'helper-turn', body: '', done: false, replay: true, replayComplete: true }));
        // Live, after the replay on the same socket: once it is heard, so is the replay.
        socket.send(chatChunkFrame({ requestId: 'helper-turn', chunk: { type: 'text-delta', id: 'text', delta: 'Still checking.' } }));
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'a helper joined mid-call',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  session.onHeard = (heard, type) => {
    if (heard === 'task-helper' && type === 'text-delta') spoke.resolve();

    if (heard === 'task-helper' && type === 'tool-output-available') ended.resolve();
  };

  try {
    await session.connect();
    session.listen(['task-helper']);
    await spoke.promise;
    expect({ acked, running: session.toolCallsInFlight() }).toEqual({ acked: ['helper-turn'], running: ['helper-call'] });

    (await room.promise).send(chatChunkFrame({ requestId: 'helper-turn', chunk: { type: 'tool-output-available', toolCallId: 'helper-call', output: 'ok' } }));
    await ended.promise;
    expect(session.toolCallsInFlight()).toEqual([]);
  } finally { await session.teardown(); await server.stop(true); }
});

/** The run that absorbs a spliced send: it starts before the send lands and ends after. */
const ABSORBING_START: RunEvent = {
  type: 'run_start', runId: 'absorbing', eventIndex: 0,
  timestamp: '2000-01-01T00:00:00.000Z', agentId: 'root',
};

const ABSORBING_END: RunEvent = {
  type: 'run_end', runId: 'absorbing', eventIndex: 2,
  timestamp: '9999-01-01T00:00:00.000Z', reason: 'completed',
};

/** The run that absorbed a dropped steer, named by its turn, and a later one still open when the session asks. */
const TURN_RUN_EVENTS: RunEvent[] = [
  { type: 'run_start', runId: 'absorbing', eventIndex: 0, timestamp: '2000-01-01T00:00:00.000Z', agentId: 'root', turn: { turnId: 'the-running-turn', messageId: 'answer-0', kind: 'user', text: 'Deploy.' } },
  ABSORBING_END,
  { type: 'run_start', runId: 'later', eventIndex: 0, timestamp: '2000-01-02T00:00:00.000Z', agentId: 'root' },
];

/**
 * A turn whose socket drops after its first step: connection 1 takes the request, streams step 1 and closes; a redial
 * is asked `awaitSend` for it and answers `state`, after dropping the first ask too when `dropAsk`. The conversation
 * holds its turn's answer, then a later turn's.
 */
async function turnAfterDrop(state: (requestId: string) => JsonValue, dropAsk = false) {
  let upgrades = 0;
  let requestId = '';
  const asked: JsonValue[] = [];

  const server = Bun.serve<{ connection: number }>({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      // Numbered at the upgrade: Bun opens the socket inside `upgrade`, before a counter bumped after it.
      if (upgrading.upgrade(request, { data: { connection: upgrades + 1 } })) {
        upgrades += 1;

        return;
      }

      const path = new URL(request.url).pathname;

      if (path.endsWith('/runs')) return Response.json({ status: 'end', items: [{ runId: 'absorbing' }, { runId: 'later' }] });

      if (path.endsWith('/events')) return Response.json(TURN_RUN_EVENTS);

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      message(socket, message) {
        if (socket.data.connection === 1) {
          requestId = v.parse(ChatRequestFrameSchema, JSON.parse(message.toString())).id;

          for (const chunk of FILE_TURN_CHUNKS.slice(0, 5)) socket.send(chatChunkFrame({ requestId, chunk }));
          socket.close(1012, 'dropped mid-turn');

          return;
        }

        const rpc = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));

        if (rpc.method === 'getChatHistoryPage') {
          const items = [
            { id: requestId, turnId: requestId, role: 'user', content: 'Write note.txt.' },
            { id: 'answer', turnId: requestId, role: 'assistant', content: 'Wrote note.txt.' },
            { id: 'later', turnId: 'later', role: 'user', content: 'And now?' },
            { id: 'later-answer', turnId: 'later', role: 'assistant', content: 'Not this one.' },
          ].map((entry, position) => ({ ...entry, position, createdAt: position }));

          socket.send(rpcReplyFrame({ requestId: rpc.id, result: { status: 'end', items } }));

          return;
        }

        asked.push([rpc.method, ...v.parse(v.array(JsonValueSchema), rpc.args)]);

        if (dropAsk && asked.length === 1) socket.close(1012, 'dropped while asked');
        else socket.send(rpcReplyFrame({ requestId: rpc.id, result: state(requestId) }));
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'dropped socket',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    const [settled] = await Promise.allSettled([session.submit('Write note.txt.').settled]);

    return { settled, asked: asked.map((call) => JSON.stringify(call).replace(requestId, 'the-send')), upgrades };
  } finally { await session.teardown(); await server.stop(true); }
}

test("a turn its socket dropped is asked how it ended, and ends on the answer its own turn recorded", async () => {
  const { settled, asked, upgrades } = await turnAfterDrop((turnId) => ({ status: 'settled', turnId, landed: 'turn', outcome: 'completed' }));

  if (settled.status === 'rejected' || settled.value.landed !== 'turn') throw new Error('expected the turn itself to land');
  const turn = settled.value;

  expect({ text: turn.text, tools: turn.toolCalls.map((call) => [call.name, call.result]), steps: turn.steps, hadError: turn.hadError })
    .toEqual({ text: 'Wrote note.txt.', tools: [['file', 'Wrote note.txt']], steps: 1, hadError: false });
  expect({ asked, upgrades }).toEqual({ asked: ['["awaitSend","the-send"]'], upgrades: 2 });
});

test('a socket that drops while the session asks is asked again on the next', async () => {
  const { settled, asked, upgrades } = await turnAfterDrop((turnId) => ({ status: 'settled', turnId, landed: 'turn', outcome: 'completed' }), true);

  expect(settled).toMatchObject({ status: 'fulfilled', value: { landed: 'turn', text: 'Wrote note.txt.' } });
  expect({ asked, upgrades }).toEqual({ asked: ['["awaitSend","the-send"]', '["awaitSend","the-send"]'], upgrades: 3 });
});

test('a dropped turn the workspace records as failed ends failed', async () => {
  const { settled } = await turnAfterDrop((turnId) => ({ status: 'settled', turnId, landed: 'turn', outcome: 'error' }));

  if (settled.status === 'rejected' || settled.value.landed !== 'turn') throw new Error('expected the turn itself to land');
  expect(settled.value.hadError).toBe(true);
});

test('a dropped send the running turn read lands mid-turn, answered by that turn\'s run', async () => {
  const { settled } = await turnAfterDrop(() => ({ status: 'settled', turnId: 'the-running-turn', landed: 'mid-turn', outcome: 'completed' }));

  expect(settled).toEqual({ status: 'fulfilled', value: { landed: 'mid-turn', absorbedBy: 'absorbing' } });
});

test('a dropped send no turn took fails as the infrastructure, never as an answer', async () => {
  const { settled } = await turnAfterDrop(() => ({ status: 'none' }));

  if (settled.status === 'fulfilled') throw new Error('a send no turn took settled');
  expect(String(settled.reason)).toContain(INFRA_FAILURE_MARKER);
  expect(String(settled.reason)).toContain('no turn took the message');
});

/** The absorbing run's stream from `cursor`: from its start, one step and the stream ends; from that step, the run's end. */
function absorbingRunStream(cursor: string): Response {
  const event: RunEvent = cursor === '0'
    ? { type: 'step_finish', runId: 'absorbing', eventIndex: 1, timestamp: ABSORBING_START.timestamp, stepIndex: 1 }
    : ABSORBING_END;

  return new Response(`event: message\ndata: ${JSON.stringify(event)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A socket that answers every send as landed inside the running turn. */
const EVERY_SEND_MID_TURN = { message(socket: { send(data: string): void }, message: string | Buffer) {
  const frame = v.parse(ChatRequestFrameSchema, JSON.parse(message.toString()));
  socket.send(chatTerminalFrame({ requestId: frame.id, landed: 'mid-turn' }));
} };

/** The run-event cursors a spliced send reads under each absorbing-run state:
 *  a running run is read twice, a refused one once, the rest never. */
function cursorsRead(state: string): string[] {
  if (state === 'running') return ['0', '1'];

  if (state === 'refused') return ['0'];

  return [];
}

test.each(['running', 'closed', 'missing', 'refused'])('a spliced send follows its absorbing run: %s', async (state) => {
  let reads = 0;
  const cursors: string[] = [];

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      if (upgrading.upgrade(request)) return;
      const path = new URL(request.url).pathname;

      if (path.endsWith('/runs')) {
        reads += 1;

        if (reads > 1) return new Response('Settlement must follow the selected run, not poll the workspace.', { status: 500 });

        return Response.json({ status: 'end', items: state === 'missing' ? [] : [{ runId: 'absorbing' }] });
      }

      if (path.endsWith('/events')) return Response.json(state === 'closed' ? [ABSORBING_START, ABSORBING_END] : [ABSORBING_START]);

      if (path.endsWith('/stream')) {
        const cursor = request.headers.get('Last-Event-ID') ?? '';
        cursors.push(cursor);

        return state === 'refused' ? new Response('Stream unavailable', { status: 503 }) : absorbingRunStream(cursor);
      }

      return new Response('Not found', { status: 404 });
    },
    websocket: EVERY_SEND_MID_TURN,
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'spliced send',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    const sent = session.prompt('Continue the running task.');

    if (state === 'refused') await expect(sent).rejects.toThrow('HTTP 503');
    else expect(await sent).toEqual({ landed: 'mid-turn', absorbedBy: state === 'missing' ? null : 'absorbing' });
    expect(reads).toBe(1);
    expect(cursors).toEqual(cursorsRead(state));
  } finally {
    await session.teardown();
    await server.stop(true);
  }
});

test('sends one run absorbed share one follower of that run', async () => {
  const cursors: string[] = [];

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      if (upgrading.upgrade(request)) return;
      const path = new URL(request.url).pathname;

      if (path.endsWith('/runs')) return Response.json({ status: 'end', items: [{ runId: 'absorbing' }] });

      if (path.endsWith('/events')) return Response.json([ABSORBING_START]);

      if (path.endsWith('/stream')) {
        const cursor = request.headers.get('Last-Event-ID') ?? '';
        cursors.push(cursor);

        return absorbingRunStream(cursor);
      }

      return new Response('Not found', { status: 404 });
    },
    websocket: EVERY_SEND_MID_TURN,
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'spliced sends',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    const sent = await Promise.all(Array.from({ length: 5 }, (_, i) => session.prompt(`Also do part ${String(i)}.`)));

    expect(sent).toEqual(Array.from({ length: 5 }, () => ({ landed: 'mid-turn', absorbedBy: 'absorbing' })));
    // One follower: its first stream ends short of the run's end, and it reopens once from the event it saw.
    expect(cursors).toEqual(['0', '1']);
  } finally {
    await session.teardown();
    await server.stop(true);
  }
});

test("the promoted build's ledger reads without the row types it still writes, and paging counts them", async () => {
  // The eval verdict's baseline leg runs the promoted build: kinu.run's 2f660875cc writes `step_partial` rows
  // (measured 2026-09-30), a type the candidate's harness no longer knows. Unfixed, the first read of a turn's ledger
  // throws. A page is full at 500 rows, and the left-out rows count toward it.
  const at = '2000-01-01T00:00:00.000Z';
  const partial = (eventIndex: number) => ({ type: 'step_partial', runId: 'r1', eventIndex, timestamp: at, stepIndex: 0, text: '', toolCalls: [] });
  const sinces: string[] = [];

  const pages = new Map<string, readonly object[]>([
    ['0', [{ type: 'run_start', runId: 'r1', eventIndex: 0, timestamp: at, agentId: 'root' }, ...Array.from({ length: 499 }, (_, i) => partial(i + 1))]],
    ['500', [partial(500), { type: 'run_end', runId: 'r1', eventIndex: 501, timestamp: at }]],
  ]);

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname.endsWith('/runs')) return Response.json({ status: 'end', items: [{ runId: 'r1' }] });

      if (url.pathname.endsWith('/events')) {
        sinces.push(url.searchParams.get('since') ?? '');

        return Response.json(pages.get(url.searchParams.get('since') ?? '') ?? []);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'an older build',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    expect((await session.runEvents()).map((event) => [event.type, event.eventIndex])).toEqual([['run_start', 0], ['run_end', 501]]);
    expect(sinces).toEqual(['0', '500']);

    pages.set('0', [{ type: 'run_start', runId: 'r1', eventIndex: 0, timestamp: at }]);
    await expect(new KinuPublicSession({
      origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'a broken row',
      llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
    }, 'probe').runEvents()).rejects.toThrow();
  } finally {
    await server.stop(true);
  }
});

describe('the public session speaks the frames the web client speaks', () => {
  test('the chat request carries the message, the trigger, and no one-shot flag', () => {
    const frame = decodeFrame(encodeChatRequest({ requestId: 'turn-1', text: 'write note.txt' }));
    // The envelope is not a `response`/`rpc`/resume frame — this is the frame
    // this session SENDS, so the decoder classifies it as one it does not
    // consume, which is the honest answer rather than a silent match.
    expect(frame?.kind).toBe('other');

    // The BODY is what the DO parses, so it is asserted rather than trusted: a
    // `oneShot` flag here would make every prompt an `independent_task`
    // (actor-agent.ts:470-478) and turn a multi-turn trajectory into a series of
    // unrelated one-shots — the exact opposite of what this arm measures.
    const request = v.parse(
      ChatRequestFrameSchema,
      JSON.parse(encodeChatRequest({ requestId: 'turn-1', text: 'write note.txt' })),
    );

    expect(request.init.method).toBe('POST');
    const body = v.parse(ChatRequestBodySchema, JSON.parse(request.init.body));
    expect(body.trigger).toBe('submit-message');
    expect(body.oneShot).toBeUndefined();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.parts).toEqual([{ type: 'text', text: 'write note.txt' }]);
  });

  test('an RPC request carries the method and its arguments', () => {
    const frame = decodeFrame(encodeRpcRequest({
      requestId: 'rpc-1', method: 'send', args: ['stop, use the file tool', 'steer-1', [], 'build'],
    }));

    // Same as above: an outbound frame is not one this session consumes.
    expect(frame?.kind).toBe('other');

    const sent = v.parse(RpcRequestFrameSchema, JSON.parse(encodeRpcRequest({
      requestId: 'rpc-1', method: 'setModel', args: ['@cf/x'],
    })));

    expect(sent).toEqual({ type: 'rpc', id: 'rpc-1', method: 'setModel', args: ['@cf/x'] });
  });

  test("a steer's landing is the DO's steer_status for its id, and only a decided one", () => {
    // The composer's steer is admitted under an id and answered by the
    // broadcast for that id: `landed` is the running turn reading it,
    // `turn` is the turn that reran it. `queued` decides nothing.
    const decode = (status: string) => decodeFrame(JSON.stringify({ type: 'steer_status', steerId: 'steer-1', text: 'use yaml', status }));

    expect(decode('landed')).toEqual({ kind: 'steer', steerId: 'steer-1', status: 'landed' });
    expect(decode('turn')).toEqual({ kind: 'steer', steerId: 'steer-1', status: 'turn' });
    expect(decode('returned')).toEqual({ kind: 'steer', steerId: 'steer-1', status: 'returned' });
    expect(decode('queued')).toEqual({ kind: 'steer', steerId: 'steer-1', status: 'queued' });
    // A status this session does not know is not a landing it may guess at.
    expect(decode('absorbed')).toEqual({ kind: 'other', type: 'steer_status' });
  });

  test('a file-producing turn decodes to its tool call, its text and its steps', () => {
    const recorder = replay(chatTurnFrames({
      requestId: FIXTURE_REQUEST_ID, chunks: FILE_TURN_CHUNKS,
    }));

    const turn = recorder.settled();

    if (turn === null || turn.landed !== 'turn') throw new Error('the terminal frame did not settle the turn');
    expect(turn.hadError).toBe(false);
    // Text deltas JOINED, not last-wins: a decoder that overwrote would report
    // the tail of an answer as the whole of it.
    expect(turn.text).toBe('Wrote note.txt.');
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe('file');
    // The output is paired to the call BY ID. This is the assertion that fails
    // when a decoder attributes a result to the wrong call, which reads as a
    // different tool being broken.
    expect(turn.toolCalls[0]?.result).toBe('Wrote note.txt');
    expect(turn.toolCalls[0]?.args).toEqual({
      action: 'write', path: 'note.txt', content: 'public session ok',
    });
    // Two `finish-step` chunks, two steps. The step count is the primary
    // instrument for the deployed loop's stop condition, so an off-by-one here
    // would corrupt the one number the cloud arm exists to read.
    expect(turn.steps).toBe(2);
  });

  test('a failed tool call is attributed to the call it belongs to, and the turn continues', () => {
    const turn = replay(chatTurnFrames({
      requestId: FIXTURE_REQUEST_ID, chunks: RECOVERY_TURN_CHUNKS,
    })).settled();

    if (turn === null || turn.landed !== 'turn') throw new Error('the terminal frame did not settle the turn');
    expect(turn.toolCalls).toHaveLength(2);
    expect(turn.toolCalls[0]?.result).toContain('Error (exit 1)');
    // A structured output is stringified rather than dropped: the second call
    // answered with an object, and a decoder that only handled strings would
    // report a successful call as having produced nothing.
    expect(turn.toolCalls[1]?.result).toBe('{"ok":true,"passed":1}');
    expect(turn.text).toBe('Fixed it.');
    // A tool failure is NOT a turn failure. Conflating them would file the
    // recovery case — whose whole subject is a failure the agent recovered from
    // — as a broken turn.
    expect(turn.hadError).toBe(false);
  });

  test('a terminal error frame settles the turn as failed', () => {
    const turn = replay([
      ...chatTurnFrames({ requestId: FIXTURE_REQUEST_ID, chunks: FILE_TURN_CHUNKS }).slice(0, 3),
      chatErrorFrame({ requestId: FIXTURE_REQUEST_ID, message: 'Internal Server Error' }),
    ]).settled();

    if (turn === null || turn.landed !== 'turn') throw new Error('the error frame did not settle the turn');
    expect(turn.hadError).toBe(true);
  });

  test('a turn its socket dropped keeps what it heard, and ends on the answer the workspace recorded', () => {
    const recorder = recordPublicTurn();

    for (const raw of chatTurnFrames({ requestId: FIXTURE_REQUEST_ID, chunks: FILE_TURN_CHUNKS }).slice(0, 8)) {
      const frame = decodeFrame(raw);

      if (frame?.kind === 'response') recorder.apply(frame.frame);
    }

    recorder.finish('Wrote note.txt.', false);
    const turn = recorder.settled();

    if (turn === null || turn.landed !== 'turn') throw new Error('finishing did not settle the turn');
    expect({ text: turn.text, calls: turn.toolCalls.length, steps: turn.steps, hadError: turn.hadError })
      .toEqual({ text: 'Wrote note.txt.', calls: 1, steps: 1, hadError: false });
  });

  test('the resume and RPC frames are recognised, and a broadcast is not a fault', () => {
    expect(decodeFrame(streamResumingFrame('turn-9'))).toEqual({ kind: 'resuming', id: 'turn-9' });
    expect(decodeFrame(rpcReplyFrame({ requestId: 'rpc-1', result: { spec: '@cf/x' } })))
      .toEqual({ kind: 'rpc', id: 'rpc-1', result: { spec: '@cf/x' }, error: null });
    expect(decodeFrame(rpcReplyFrame({ requestId: 'rpc-1', error: 'no such method' })))
      .toEqual({ kind: 'rpc', id: 'rpc-1', result: null, error: 'no such method' });
    // A frame this session does not read is `other`, never a throw: the DO fans
    // branch, head and search broadcasts down the same socket.
    expect(decodeFrame(BROADCAST_FRAME)).toEqual({ kind: 'other', type: 'branch_status' });
    // And unreadable text is dropped rather than raised — one malformed payload
    // is not evidence about an agent.
    expect(decodeFrame('not json at all')).toBeNull();
    expect(decodeFrame('{"no":"type"}')).toBeNull();
  });

  test('a frame for another turn is ignored by the turn it is not about', () => {
    const recorder = recordPublicTurn();
    const other = decodeFrame(chatTerminalFrame({ requestId: 'turn-other' }));

    if (other?.kind !== 'response') throw new Error('the terminal frame did not decode');
    // The session routes by id; this asserts the ROUTER's precondition — the
    // frame carries the id it belongs to, so a session holding two turns cannot
    // settle the wrong one.
    expect(other.frame.id).toBe('turn-other');
    expect(recorder.settled()).toBeNull();
  });
});

describe('the live arm is reachable only under KINU_EVAL_BACKEND=cloud', () => {
  test('the default and the local backend both refuse, naming the invocation', () => {
    for (const env of [{}, { KINU_EVAL_BACKEND: 'local' }]) {
      const resolution = resolvePublicSessionPlan(PROBE_SUITE, '@cf/model', env);

      if (resolution.kind !== 'unavailable') {
        throw new Error('a non-cloud backend resolved a public session plan, so this arm could '
          + 'run against an in-process runtime with no public surface at all');
      }

      // The remedy is the whole point of the refusal: it must name the knob AND
      // the command, because "unavailable" is not a remedy.
      expect(resolution.remedy).toContain('KINU_EVAL_BACKEND');
      expect(resolution.remedy).toContain('gate:first-run');
    }
  });

  test('a bad backend name is a refusal, not a skip', () => {
    // Someone meant that to run. The seam throws rather than skipping so the
    // typo cannot read as "no credential here".
    expect(() => resolvePublicSessionPlan(PROBE_SUITE, '@cf/model', {
      KINU_EVAL_BACKEND: 'production',
    })).toThrow(/KINU_EVAL_BACKEND/);
  });

  test('under cloud with no credential the skip names the tier that supplies one', () => {
    // `liveModelTarget` refuses without `KINU_EVAL_LIVE=1`, which only the tier
    // scripts set — so this is the path a developer running the suite by hand
    // takes, and it must say so.
    const resolution = resolvePublicSessionPlan(PROBE_SUITE, '@cf/model', {
      KINU_EVAL_BACKEND: 'cloud',
    });

    if (resolution.kind !== 'unavailable') {
      throw new Error('a public session plan resolved with no credential in the environment');
    }

    expect(resolution.remedy).toContain('gate:first-run');
  });

  test('every task loads under the runner `bun run evals` spells', () => {
    // Collecting a task imports it, under Bun as `bun run evals` runs it. On 2026-09-25 every task failed there at
    // import: `import { z } from 'zod'` in core came back undefined. A task resolves its target and the commit its
    // definitions are compared under as it loads, so collection names a loopback origin and a commit; nothing runs.
    const listed = spawnSync('bun', ['--bun', './node_modules/.bin/vitest', 'list', '--config', 'evals/vitest.config.ts', '--json'], {
      cwd: join(import.meta.dirname, '../..'),
      encoding: 'utf8',
      env: { ...process.env, KINU_EVAL_ORIGIN: 'http://127.0.0.1:9', KINU_EVAL_COMMIT: '0'.repeat(40) },
    });

    expect(listed.status, listed.stderr).toBe(0);
  });
});

describe('the browser plane names its own credential', () => {
  test('a remote origin with no secret prints both halves of the remedy', () => {
    const resolution = resolveWebIdentity(DEPLOYMENT, {});

    if (resolution.kind !== 'absent') {
      throw new Error('a deployed origin resolved a web identity out of an empty environment');
    }

    // The variable to export, and where the value comes from. Without the
    // second half the remedy is a name nobody can act on.
    expect(resolution.remedy).toContain(EVAL_WEB_IDENTITY_ENV.production);
    expect(resolution.remedy).toContain('wrangler secret put DEV_IDENTITY_SECRET');
    // And WHY the tier's own credential is not enough, so the next reader does
    // not spend an afternoon trying it.
    expect(resolution.remedy).toContain('/api/cli');
  });

  test('the secret is taken from the environment, and loopback needs none', () => {
    expect(resolveWebIdentity(DEPLOYMENT, { [EVAL_WEB_IDENTITY_ENV.production]: 'sekret' }))
      .toEqual({ kind: 'ready', identity: { kind: 'secret', secret: 'sekret' } });
    // A developer's own machine is already the trust boundary — the same rule
    // `authenticateRequest` applies (auth/session.ts:164).
    expect(resolveWebIdentity('http://127.0.0.1:8787', {}))
      .toEqual({ kind: 'ready', identity: { kind: 'loopback' } });
    // Blank is absent, never a secret: an empty export would otherwise send an
    // empty header and read as a rejected identity at the deployment.
    expect(resolveWebIdentity(DEPLOYMENT, { [EVAL_WEB_IDENTITY_ENV.production]: '   ' }).kind).toBe('absent');
  });
});

test('an explicitly missing file is an oracle miss; a failed answer is the build\'s, a relayed platform failure is not', async () => {
  let status = 404;
  let rpcError = 'the workspace has no snapshot';

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch: (request, upgrading) => upgrading.upgrade(request) ? undefined : new Response('fixture failure', { status }),
    websocket: {
      message(socket, message) {
        socket.send(rpcReplyFrame({ requestId: v.parse(RpcRequestFrameSchema, JSON.parse(message.toString())).id, error: rpcError }));
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'file-read oracle probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await expect(session.readFile('missing.txt', { allowMissing: true })).resolves.toBe('');
    await expect(session.readFile('missing.txt')).rejects.toBeInstanceOf(DeploymentAnswer);
    status = 403;
    await expect(session.readFile('missing.txt', { allowMissing: true })).rejects.toThrow(/over the files route: 403/);
    status = 503;
    await expect(session.readFile('missing.txt', { allowMissing: true })).rejects.toBeInstanceOf(DeploymentAnswer);

    await session.connect();
    await expect(session.snapshot()).rejects.toBeInstanceOf(DeploymentAnswer);
    rpcError = 'Network connection lost.';
    await expect(session.snapshot()).rejects.toThrow(INFRA_FAILURE_MARKER);
  } finally {
    session.disconnect();
    await server.stop(true);
  }
});

test('the workspace answering 404 once its own mark is a lease old is a sweep\'s doing, not the build\'s', async () => {
  // A machine that sleeps past the lease stops beating, another run's sweep deletes the workspace, and the trial
  // wakes to 404s on its own workspace.
  let status = 404;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no such workspace', { status }) });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'swept-workspace probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await expect(session.readFile('notes.txt')).rejects.toBeInstanceOf(DeploymentAnswer);
    session.lastMarked = Date.now() - WORKSPACE_LEASE_MS;
    await expect(session.readFile('notes.txt')).rejects.toThrow(`${INFRA_FAILURE_MARKER} — GET files notes.txt: the workspace was swept`);
    status = 500;
    await expect(session.readFile('notes.txt')).rejects.toBeInstanceOf(DeploymentAnswer);
  } finally {
    await server.stop(true);
  }
});

test('a beat on a workspace a sweep took marks nothing, so the next 404 is still the sweep\'s', async () => {
  // Asleep past the lease, the machine stopped beating and another run's sweep deleted the workspace. On waking, the
  // overdue beat fires first, and the roster that no longer holds the workspace refuses its mark with 404.
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ error: 'No such workspace.' }, { status: 404 }) });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'swept-workspace probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    const asleepSince = Date.now() - WORKSPACE_LEASE_MS;
    session.lastMarked = asleepSince;

    expect(await session.markLive()).toBe(false);
    expect(session.lastMarked).toBe(asleepSince);
    await expect(session.readFile('notes.txt')).rejects.toThrow(`${INFRA_FAILURE_MARKER} — GET files notes.txt: the workspace was swept`);
  } finally {
    await server.stop(true);
  }
});

/** One RPC method → the reply this fixture answers it with. */
const FixtureRpcMethodSchema = v.picklist(['listSubordinates']);

interface FixtureRpcAnswers {
  listSubordinates: JsonValue;
}

describe('the verifier reads speak the RPCs the web app is bound to', () => {
  // The fixture answers what it is told to, so a read of a method the product dropped would still pass here.
  test('every method the fixture answers is one the product serves', () => {
    expect(FixtureRpcMethodSchema.options.filter((method) => !isAgentRpcMethod(method))).toEqual([]);
  });

  const answers: FixtureRpcAnswers = {
    listSubordinates: [
      { name: 'alpha', status: 'dismissed', lifetime: 'task', createdBy: 'orchestrator',
        currentTask: null, createdAt: 1, dismissedAt: 2, actorReference: null, birth: null,
        deleteRequested: false, taskEventId: null },
    ],
  };

  /** Every RPC this fixture was ASKED, so a read that reached a different
   *  method than the one its doc names fails here rather than passing on a
   *  lenient parse. */
  const asked: { method: string; args: readonly unknown[] }[] = [];

  const open = () => {
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1', fetch: socketOnly,
      websocket: {
        message(socket, message) {
          const frame = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));
          asked.push({ method: frame.method, args: frame.args });
          const known = v.safeParse(FixtureRpcMethodSchema, frame.method);
          socket.send(rpcReplyFrame({ requestId: frame.id, result: known.success ? answers[known.output] : null }));
        },
      },
    });

    return {
      server,
      session: new KinuPublicSession({
        origin: server.url.origin, identity: { kind: 'loopback' },
        workspace: 'probe', purpose: 'verifier read probe',
        llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
      }, 'probe'),
    };
  };

  test('subordinates() is listSubordinates, narrowed to name, status and lifetime', async () => {
    const { server, session } = open();
    asked.length = 0;

    try {
      await session.connect();
      // `lifetime` is the point: it is the column no later state recovers, so
      // dropping it would make "a task hire retired itself" unaskable.
      expect(await session.subordinates())
        .toEqual([{ name: 'alpha', status: 'dismissed', lifetime: 'task' }]);

      expect(asked).toEqual([{ method: 'listSubordinates', args: [] }]);
    } finally { await session.teardown(); await server.stop(true); }
  });
});

/**
 * The `genesis: false` open, end to end against a fake deployment.
 *
 * The product's own surfaces do the work and the fake only records them: the
 * create POST's body, and the order RPCs arrive over the socket. What a green
 * states: a `genesis: false` create carries NO `purpose` — so the deployed
 * `beginGenesisTurn` finds the placeholder mission and queues nothing — and the
 * real mission is on SOUL.md before any prompt can run, because `setSoul` has
 * already answered before `openPublicSession` returns. The default arm proves
 * the mission still rides the create, so mission-first coverage stays covered.
 */
describe('the genesis flag on a public session', () => {
  const PROBE_PURPOSE = 'A deterministic probe mission that must reach the soul.';
  const PROBE_MODEL = '@cf/zai-org/glm-5.3';

  /** One workspace worth of fake deployment: the create REST, the chat socket
   *  and the DELETE teardown, recording what it was asked rather than parsing
   *  what the harness meant to send. */
  function fakeDeployment(catalog: ProfileCatalog = BUILTIN_PROFILE_CATALOG) {
    const creates: unknown[] = [];
    const wire: { method: string; args: readonly unknown[] }[] = [];
    const written: ProfileCatalog[] = [];
    const account = { catalog, version: 0, written };

    const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
      async fetch(request, upgrading) {
        const url = new URL(request.url);

        if (url.pathname === '/api/user/profile-catalog') {
          if (request.method === 'PUT') {
            const put = v.parse(v.object({ catalog: v.looseObject({}), expectedVersion: v.number() }), await request.json());

            account.catalog = { ...account.catalog, ...put.catalog };
            account.version += 1;
            account.written.push(account.catalog);
          }

          return Response.json({
            authority: { kind: 'account', accountId: 'eval-service' }, version: account.version,
            digest: profileCatalogDigest(account.catalog), catalog: account.catalog,
          });
        }

        if (url.pathname === '/api/user/workspaces' && request.method === 'POST') {
          const body = v.parse(v.object({
            name: v.string(), displayName: v.optional(v.string()), purpose: v.optional(v.string()),
          }), await request.json());

          creates.push(body);

          return Response.json({ name: body.name, displayName: body.displayName });
        }

        if (url.pathname.startsWith('/api/user/workspaces/') && request.method === 'DELETE') {
          return Response.json({ ok: true });
        }

        if (upgrading.upgrade(request)) return;

        return new Response('not found', { status: 404 });
      },
      websocket: { message(socket, message) {
        const frame = JSON.parse(message.toString());

        if (v.is(RpcRequestFrameSchema, frame)) {
          wire.push({ method: frame.method, args: frame.args });
          socket.send(rpcReplyFrame({
            requestId: frame.id,
            result: frame.method === 'setModel' ? { spec: frame.args[0] } : { ok: true },
          }));

          return;
        }

        if (v.is(ChatRequestFrameSchema, frame)) {
          wire.push({ method: 'prompt', args: [] });
          socket.send(chatTerminalFrame({ requestId: frame.id }));
        }
      } },
    });

    return { server, creates, wire, account };
  }

  function probeInput(server: Bun.Server<undefined>, genesis?: boolean) {
    return {
      origin: server.url.origin, identity: { kind: 'loopback' as const },
      workspace: 'probe', purpose: PROBE_PURPOSE, genesis,
      llm: { name: 'workers-ai', model: PROBE_MODEL, baseURL: server.url.origin, headers: {} },
    };
  }

  test('genesis: false creates without a mission and writes the soul before the first prompt', async () => {
    const { server, creates, wire } = fakeDeployment();
    const session = await openPublicSession(probeInput(server, false));

    try {
      // The create carries name and display name ONLY: with no `purpose` key
      // the deployment seeds the placeholder mission, which
      // `workspaceGenesisSignal` declines a turn on.
      expect(creates).toEqual([{ name: 'probe', displayName: 'Trajectory Evals' }]);

      // `open` has already resolved, so the soul write is behind the caller —
      // and it is the exact markdown a mission-first create would have seeded.
      expect(wire.map((entry) => entry.method)).toEqual(['setSoul', 'setModel']);
      expect(wire[0]?.args[0]).toBe(renderSoulMarkdown({
        name: 'Trajectory Evals', mission: PROBE_PURPOSE,
      }));
      expect(wire[0]?.args[0]).toContain(PROBE_PURPOSE);

      await session.prompt('hello');
      expect(wire.map((entry) => entry.method)).toEqual(['setSoul', 'setModel', 'prompt']);
    } finally {
      await session.teardown();
      await server.stop(true);
    }
  });

  test('the account the evals run as has "Beta: swarms" on before its first workspace, and it is written once', async () => {
    const { server, account } = fakeDeployment();
    const first = await openPublicSession(probeInput(server));
    const second = await openPublicSession(probeInput(server));

    try {
      expect(account.written.map((catalog) => catalog.betaSwarms)).toEqual([true]);
    } finally {
      await first.teardown();
      await second.teardown();
      await server.stop(true);
    }
  });

  test.each([undefined, true])('genesis=%s keeps the product path: purpose on the create, no setSoul', async (genesis) => {
    const { server, creates, wire } = fakeDeployment();
    const session = await openPublicSession(probeInput(server, genesis));

    try {
      expect(creates).toEqual([
        { name: 'probe', displayName: 'Trajectory Evals', purpose: PROBE_PURPOSE },
      ]);

      await session.prompt('hello');
      expect(wire.map((entry) => entry.method)).toEqual(['setModel', 'prompt']);
    } finally {
      await session.teardown();
      await server.stop(true);
    }
  });
});
