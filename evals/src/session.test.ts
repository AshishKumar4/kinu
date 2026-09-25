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

import { isAgentRpcMethod, renderSoulMarkdown, type RunEvent, type JsonValue } from '../../packages/core/src/index';
import { DeploymentAnswer, INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import {
  PUBLIC_IDENTITY_ENV, decodeFrame, encodeChatRequest, encodeRpcRequest,
  recordPublicTurn, resolvePublicSessionPlan, resolveWebIdentity,
  type PublicTurnRecorder,
  KinuPublicSession, openPublicSession,
} from './session';
import {
  BROADCAST_FRAME, FILE_TURN_CHUNKS, FIXTURE_REQUEST_ID,
  RECOVERY_TURN_CHUNKS, chatErrorFrame, chatTerminalFrame, chatTurnFrames, rpcReplyFrame,
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

test('a turn survives a dropped socket: the redial resumes its stream and the answer lands', async () => {
  // Browser parity: the socket drops mid-turn (1006 at the edge), the turn is durable up there, and
  // the redial's stream-resume frames finish it. Unfixed, the close rejected the turn and cost the trial.
  let upgrades = 0;
  let requestId = '';
  const replayed = Promise.withResolvers<void>();

  const start: RunEvent = {
    type: 'run_start', runId: 'turn-run', eventIndex: 0, timestamp: '2000-01-01T00:00:00.000Z', agentId: 'root',
  };

  const end: RunEvent = {
    type: 'run_end', runId: 'turn-run', eventIndex: 1, timestamp: '9999-01-01T00:00:00.000Z', reason: 'completed',
  };

  const server = Bun.serve<{ connection: number }>({ port: 0, hostname: '127.0.0.1',
    async fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      // Numbered at the upgrade: Bun opens the socket inside `upgrade`, before a counter bumped after it.
      if (upgrading.upgrade(request, { data: { connection: upgrades + 1 } })) {
        upgrades += 1;

        return;
      }

      // The ledger answers only after the resumed stream went out, so the turn settles from the stream.
      await replayed.promise;
      const path = new URL(request.url).pathname;

      if (path.endsWith('/runs')) return Response.json({ status: 'end', items: [{ runId: 'turn-run' }] });

      if (path.endsWith('/events')) return Response.json([start, end]);

      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open(socket) {
        if (socket.data.connection === 2) socket.send(streamResumingFrame(requestId));
      },
      message(socket, message) {
        if (socket.data.connection === 1) {
          requestId = v.parse(ChatRequestFrameSchema, JSON.parse(message.toString())).id;
          socket.close(1012, 'dropped mid-turn');

          return;
        }

        // The resume ack: replay the whole stream, terminal frame included.
        for (const frame of chatTurnFrames({ requestId, chunks: FILE_TURN_CHUNKS, replay: true })) socket.send(frame);
        replayed.resolve();
      },
    },
  });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'dropped socket',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await session.connect();
    const result = await session.submit('Write note.txt.').settled;

    if (result.landed !== 'turn') throw new Error('expected the turn itself to land');
    expect(result.text).toBe('Wrote note.txt.');
    expect(upgrades).toBe(2);
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

  test('a replayed stream does not double the answer', () => {
    // The DO replays a resumed stream FROM CHUNK ZERO on every ack
    // (agents/dist/chat/index.js:666-675), so a session that applied what
    // arrived would render the answer twice — and a trajectory that counted the
    // steps twice would report a turn that took twice the work it did.
    const live = chatTurnFrames({ requestId: FIXTURE_REQUEST_ID, chunks: FILE_TURN_CHUNKS });
    const recorder = recordPublicTurn();

    for (const raw of live.slice(0, 5)) {
      const frame = decodeFrame(raw);

      if (frame?.kind === 'response') recorder.apply(frame.frame);
    }

    expect(recorder.settled()).toBeNull();

    const replayed = chatTurnFrames({
      requestId: FIXTURE_REQUEST_ID, chunks: FILE_TURN_CHUNKS, replay: true,
    });

    for (const raw of replayed) {
      const frame = decodeFrame(raw);

      if (frame?.kind === 'response') recorder.apply(frame.frame);
    }

    const turn = recorder.settled();

    if (turn === null || turn.landed !== 'turn') throw new Error('the replayed terminal frame did not settle the turn');
    expect(turn.text).toBe('Wrote note.txt.');
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.steps).toBe(2);
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
    expect(resolution.remedy).toContain(PUBLIC_IDENTITY_ENV);
    expect(resolution.remedy).toContain('wrangler secret put DEV_IDENTITY_SECRET');
    // And WHY the tier's own credential is not enough, so the next reader does
    // not spend an afternoon trying it.
    expect(resolution.remedy).toContain('/api/cli');
  });

  test('the secret is taken from the environment, and loopback needs none', () => {
    expect(resolveWebIdentity(DEPLOYMENT, { [PUBLIC_IDENTITY_ENV]: 'sekret' }))
      .toEqual({ kind: 'ready', identity: { kind: 'secret', secret: 'sekret' } });
    // A developer's own machine is already the trust boundary — the same rule
    // `authenticateRequest` applies (auth/session.ts:164).
    expect(resolveWebIdentity('http://127.0.0.1:8787', {}))
      .toEqual({ kind: 'ready', identity: { kind: 'loopback' } });
    // Blank is absent, never a secret: an empty export would otherwise send an
    // empty header and read as a rejected identity at the deployment.
    expect(resolveWebIdentity(DEPLOYMENT, { [PUBLIC_IDENTITY_ENV]: '   ' }).kind).toBe('absent');
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
  function fakeDeployment() {
    const creates: unknown[] = [];
    const wire: { method: string; args: readonly unknown[] }[] = [];

    const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
      async fetch(request, upgrading) {
        const url = new URL(request.url);

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

    return { server, creates, wire };
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
