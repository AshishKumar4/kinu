/**
 * THE PUBLIC SESSION'S WIRING, credential-free.
 *
 * Everything in `public-session.ts` that is a property of the HARNESS rather
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
 *   ledger        events fetched over the public route score through the SAME
 *                 seven instruments a local episode scores through, with the
 *                 same denominators. A second scoring path would make a cloud
 *                 number incomparable with a local one, silently.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import {
  BEHAVIOUR_SCORERS, EPISODE_TRANSCRIPT_FILES, EVIDENCE_GRACE_MS, handClock, ledgerTotalsFromEvents,
  projectRunEventProvenance, retainEpisodeTranscript, scratchDir, TASK_OUTCOME, withEpisodeEvidence,
  liveModelSpend, resetLiveModelSpend,
} from '@kinu.run/test-utils';
import { REAL_CLOCK, renderSoulMarkdown, RunEventSchema, type RunEvent, type WorkspaceSpend, type JsonValue } from '../../packages/core/src/index';
import {
  PUBLIC_IDENTITY_ENV, decodeFrame, encodeChatRequest, encodeRpcRequest,
  recordPublicTurn, resolvePublicSessionPlan, resolveWebIdentity, scorePublicLedger,
  type PublicTurnRecorder,
  KinuPublicSession, openPublicSession,
} from './public-session';
import {
  BROADCAST_FRAME, DEGENERATE_EVENTS, FILE_TURN_CHUNKS, FIXTURE_REQUEST_ID, LEDGER_EVENTS,
  RECOVERY_TURN_CHUNKS, chatErrorFrame, chatTerminalFrame, chatTurnFrames, rpcReplyFrame,
  streamResumingFrame,
} from './fixtures/public-session-frames';

const STAGING = 'https://staging.kinu.run';

/** The suite name the gating probes resolve under. NOT the trajectory suite's own
 *  name: `liveModelTarget` prints `[skip] <suite>` when it refuses, and a probe
 *  borrowing the real name would put a skip line for a suite this file does not
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

test('executor RPC decoding preserves refusal provenance and successful refusal-shaped stdout', async () => {
  let response: JsonValue = { stdout: 'failed', stderr: 'remote error', exitCode: 1,
    refusal: { reason: 'io', error: 'remote error', execution: { exitCode: 7 } } };

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1',
    fetch(request, upgrading) {
      if (request.method === 'DELETE') return Response.json({ ok: true });

      if (upgrading.upgrade(request)) return;

      return new Response('not found', { status: 404 });
    },
    websocket: { message(socket, message) {
      const request = v.parse(RpcRequestFrameSchema, JSON.parse(message.toString()));
      socket.send(rpcReplyFrame({ requestId: request.id, result: response }));
    } },
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

  const start: RunEvent = {
    type: 'run_start', runId: 'absorbing', eventIndex: 0,
    timestamp: '2000-01-01T00:00:00.000Z', agentId: 'root',
  };

  const end: RunEvent = {
    type: 'run_end', runId: 'absorbing', eventIndex: 2,
    timestamp: '9999-01-01T00:00:00.000Z', reason: 'completed',
  };

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

      if (path.endsWith('/events')) return Response.json(state === 'closed' ? [start, end] : [start]);

      if (path.endsWith('/stream')) {
        const cursor = request.headers.get('Last-Event-ID') ?? '';
        cursors.push(cursor);

        if (state === 'refused') return new Response('Stream unavailable', { status: 503 });

        const event: RunEvent = cursor === '0'
          ? { type: 'step_finish', runId: 'absorbing', eventIndex: 1, timestamp: start.timestamp, stepIndex: 1 }
          : end;

        return new Response(`event: message\ndata: ${JSON.stringify(event)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      return new Response('Not found', { status: 404 });
    },
    websocket: { message(socket, message) {
      const frame = v.parse(ChatRequestFrameSchema, JSON.parse(message.toString()));
      socket.send(chatTerminalFrame({ requestId: frame.id, landed: 'mid-turn' }));
    } },
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
      expect(resolution.remedy).toContain('evals:cloud');
    }
  });

  test('a bad backend name is a refusal, not a skip', () => {
    // Someone meant that to run. The seam throws rather than skipping so the
    // typo cannot read as "no credential here".
    expect(() => resolvePublicSessionPlan(PROBE_SUITE, '@cf/model', {
      KINU_EVAL_BACKEND: 'staging',
    })).toThrow(/KINU_EVAL_BACKEND/);
  });

  test('under cloud with no credential the skip names the tier that supplies one', () => {
    // `liveModelTarget` refuses without `KINU_EVAL_LIVE=1`, which only
    // `scripts/eval-tier.sh` sets — so this is the path a developer running the
    // suite by hand takes, and it must say so.
    const resolution = resolvePublicSessionPlan(PROBE_SUITE, '@cf/model', {
      KINU_EVAL_BACKEND: 'cloud',
    });

    if (resolution.kind !== 'unavailable') {
      throw new Error('a public session plan resolved with no credential in the environment');
    }

    expect(resolution.remedy).toContain('evals:cloud');
  });
});

describe('the browser plane names its own credential', () => {
  test('a remote origin with no secret prints both halves of the remedy', () => {
    const resolution = resolveWebIdentity(STAGING, {});

    if (resolution.kind !== 'absent') {
      throw new Error('a staging origin resolved a web identity out of an empty environment');
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
    expect(resolveWebIdentity(STAGING, { [PUBLIC_IDENTITY_ENV]: 'sekret' }))
      .toEqual({ kind: 'ready', identity: { kind: 'secret', secret: 'sekret' } });
    // A developer's own machine is already the trust boundary — the same rule
    // `authenticateRequest` applies (auth/session.ts:164).
    expect(resolveWebIdentity('http://127.0.0.1:8787', {}))
      .toEqual({ kind: 'ready', identity: { kind: 'loopback' } });
    // Blank is absent, never a secret: an empty export would otherwise send an
    // empty header and read as a rejected identity at the deployment.
    expect(resolveWebIdentity(STAGING, { [PUBLIC_IDENTITY_ENV]: '   ' }).kind).toBe('absent');
  });
});

/** `collection.json` as a reader must be able to read it back: one row per
 *  channel, the status, and the reason a channel that did not land carries. */
const CollectionSchema = v.array(v.object({
  channel: v.string(), status: v.string(), reason: v.optional(v.string()),
}));

describe('route-shaped run events score through the production instruments', () => {
  test('the ledger reduction reads the deployment\'s own events', () => {
    const totals = ledgerTotalsFromEvents(LEDGER_EVENTS);
    expect(totals.turns).toBe(2);
    expect(totals.toolCalls).toBe(4);
    expect(totals.steps).toBe(2);
    expect(totals.tokensIn).toBe(2_700);
    expect(totals.toolNames).toEqual(['file', 'shell', 'file', 'shell']);
  });

  test('every instrument scores, and the failing tool call is counted as one', () => {
    const rows = scorePublicLedger(LEDGER_EVENTS);
    const byName = new Map(rows.map((row) => [row.name, row]));
    // Every declared scorer, over one store: this is the assertion that the
    // bridge did not quietly narrow the panel.
    expect(rows.map((row) => row.name).sort()).toEqual(BEHAVIOUR_SCORERS.map((scorer) => scorer.name).sort());
    // The process exit is producer evidence, not a pattern in rendered output.
    const outcomes = byName.get('tool_outcomes');
    expect(outcomes?.eligible).toBe(4);
    expect(outcomes?.passed).toBe(3);
    expect(outcomes?.measured).toEqual({ succeeded: 3, failed: 1, unmeasured: 0 });
    // `edit_landing` reports attempts against applied, so its rate is below 1
    // here rather than a vacuous 1/1.
    expect(byName.get('edit_landing')?.eligible).toBe(2);
    expect(byName.get('edit_landing')?.passed).toBe(1);
    // `completion_honesty` INVERTS: an unconverted gate is the honest ending.
    expect(byName.get('completion_honesty')?.eligible).toBe(1);
    expect(byName.get('completion_honesty')?.passed).toBe(1);
    // A mechanism this trajectory never exercised reports ABSENT, never zero:
    // `0/0` is a fact about the task and `0/7` is a fact about the agent.
    expect(byName.get('craft_reuse')?.eligible).toBe(0);
    expect(byName.get('craft_reuse')?.rate).toBeNull();
    // And the outcome row is NOT one of these: the primary metric is the suite's
    // own verdict over the workspace, not a covariate off the ledger.
    expect(byName.has(TASK_OUTCOME)).toBe(false);
  });

  test('a degenerate trajectory reduces to nothing gradable', () => {
    // The precondition the suite refuses on. Scoring is still well-defined —
    // every instrument reports an absent denominator — which is why the REFUSAL
    // has to be a separate decision rather than something a zero score implies.
    const totals = ledgerTotalsFromEvents(DEGENERATE_EVENTS);
    expect(totals.turns).toBe(1);
    expect(totals.toolCalls).toBe(0);

    for (const row of scorePublicLedger(DEGENERATE_EVENTS)) {
      expect(row.eligible).toBe(0);
      expect(row.rate).toBeNull();
    }
  });

  test('an empty ledger scores nothing rather than throwing', () => {
    // A workspace whose turn never closed answers the route with an empty array,
    // and a bridge that threw on it would report a harness fault where the
    // finding is "the turn wrote no row".
    for (const row of scorePublicLedger([])) expect(row.eligible).toBe(0);
  });

  test('the record\'s provenance is the ledger\'s shape with every payload stripped', () => {
    // Fed in REVERSE so the ordering is proven rather than inherited from the
    // fixture: a projection that kept route order would publish a trail whose
    // "later call of the same tool ran clean" reads backwards.
    const provenance = projectRunEventProvenance([...LEDGER_EVENTS].reverse());
    expect(provenance.totalEvents).toBe(LEDGER_EVENTS.length);
    expect(provenance.events.map((event) => event.eventIndex))
      .toEqual(LEDGER_EVENTS.map((event) => event.eventIndex));
    // The failing `shell` keeps its CLASS and its name; the clean one keeps no class.
    const calls = provenance.events.filter((event) => event.type === 'tool_call_end');
    expect(calls.map((event) => event.name)).toEqual(['file', 'shell', 'file', 'shell']);
    expect(calls.map((event) => event.failureClass ?? null)).toEqual([null, 'exit_1', null, null]);
    expect(calls.map((event) => event.durationMs)).toEqual([12, 900, 20, 850]);
    expect(calls[1]?.outcome).toEqual({ success: false, reason: null, execution: { exitCode: 1 } });
    // Nothing that was SAID survives: not the command, not the result text.
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain('bun test broken.test.ts');
    expect(serialized).not.toContain('1 fail');
    expect(serialized).not.toContain('args');
  });

  test('the bound clips the slice and says so, never the count', () => {
    const long = Array.from({ length: 1_203 }, (_, index): RunEvent => ({
      type: 'step_finish', runId: 'run-9', eventIndex: index, timestamp: '2026-08-30T12:00:00.000Z', stepIndex: index,
      reason: 'tool-calls',
    }));

    const provenance = projectRunEventProvenance(long);
    expect(provenance.totalEvents).toBe(1_203);
    expect(provenance.events).toHaveLength(provenance.bound);
    expect(provenance.events.at(-1)?.eventIndex).toBe(provenance.bound - 1);
  });

  test('a retained episode is readable back as the ledger, the transcript and the verdicts', () => {
    const root = scratchDir('public-session-retention');
    const history = [{ role: 'user', text: 'write it' }, { role: 'assistant', text: 'DONE' }];
    const subgoals = [{ what: 'artifact', reached: false, detail: 'the file was empty' }];

    const dir = retainEpisodeTranscript(root, 'public-file-artifact', {
      events: LEDGER_EVENTS, history, subgoals,
    });

    expect(dir).toBe(join(root, 'public-file-artifact'));
    // ONE EVENT A LINE, every one the canonical union: a clipped or concatenated
    // read is still a parse of what was written, and a foreign shape fails here
    // rather than in a reader a month later.
    const lines = readFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.events), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(LEDGER_EVENTS.length);
    const events = lines.map((line) => v.parse(RunEventSchema, JSON.parse(line)));
    expect(ledgerTotalsFromEvents(events)).toEqual({
      turns: 2, toolCalls: 4, toolNames: ['file', 'shell', 'file', 'shell'],
      tokensIn: 2700, tokensOut: 520, reasoningOut: 0, steps: 2, failures: ['shell: exit_1'],
    });
    expect(JSON.parse(readFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.history), 'utf8'))).toEqual(history);
    expect(JSON.parse(readFileSync(join(dir, EPISODE_TRANSCRIPT_FILES.subgoals), 'utf8'))).toEqual(subgoals);
    // An episode with no events leaves an EMPTY file, not a file holding one
    // blank line that a reader would parse as a malformed event.
    const empty = retainEpisodeTranscript(root, 'no-events', { events: [], history: [], subgoals: [] });
    expect(existsSync(join(empty, EPISODE_TRANSCRIPT_FILES.events))).toBe(true);
    expect(readFileSync(join(empty, EPISODE_TRANSCRIPT_FILES.events), 'utf8')).toBe('');
  });

  test('an operation failure still retains its ledger and spend exactly once', async () => {
    resetLiveModelSpend();
    const root = scratchDir('failed-episode-evidence');

    const spend: WorkspaceSpend = {
      total: {
        calls: 8, callsWithoutUsage: 0, unpricedCalls: 8, floorPricedCalls: 0,
        usage: { input: 234433, output: 29531 },
      },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 8, measured: 8, reported: 1, silent: [], partial: [] },
    };

    const reader = {
      async runEvents() { return LEDGER_EVENTS; },
      async history() { return [{ role: 'assistant', text: 'partial answer' }]; },
      async spend() { return spend; },
    };

    try {
      await expect(withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'failure', modelCalls: 'expected', clock: REAL_CLOCK }, async () => {
        throw new Error('failed after model work');
      })).rejects.toThrow('failed after model work');
      expect(liveModelSpend().calls).toBe(8);
      expect(JSON.parse(readFileSync(join(root, 'failure/spend.json'), 'utf8'))).toEqual(spend);
      const events = readFileSync(join(root, 'failure/events.jsonl'), 'utf8').split('\n').map((line) => v.parse(RunEventSchema, JSON.parse(line)));
      expect(ledgerTotalsFromEvents(events).turns).toBe(2);
      expect(readFileSync(join(root, 'failure/failure.json'), 'utf8')).toContain('failed after model work');

      resetLiveModelSpend();
      await expect(withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'assertion', modelCalls: 'expected', clock: REAL_CLOCK }, async (_reader, collect) => {
        await collect();
        throw new Error('subgoal missed');
      })).rejects.toThrow('subgoal missed');
      expect(liveModelSpend().calls).toBe(8);

      resetLiveModelSpend();
      await expect(withEpisodeEvidence(async () => ({ ...reader, async spend() { throw new Error('spend endpoint unavailable'); } }),
        { transcripts: root, taskId: 'outage', modelCalls: 'expected', clock: REAL_CLOCK }, async () => 'finished')).rejects.toThrow('spend endpoint unavailable');
      expect(liveModelSpend().episodesUnmeasured).toBe(1);
      expect(readFileSync(join(root, 'outage/history.json'), 'utf8')).toContain('partial answer');
      expect(JSON.parse(readFileSync(join(root, 'outage/collection.json'), 'utf8'))).toContainEqual({
        channel: 'spend', status: 'failed', reason: 'spend endpoint unavailable',
      });
    } finally {
      resetLiveModelSpend();
    }
  });

  test('a spent episode budget tells the operation, retains the evidence as found, and fails on the budget', async () => {
    resetLiveModelSpend();
    const root = scratchDir('budget-evidence');

    const spend: WorkspaceSpend = {
      total: { calls: 3, callsWithoutUsage: 0, unpricedCalls: 3, floorPricedCalls: 0, usage: { input: 10, output: 5 } },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 3, measured: 3, reported: 1, silent: [], partial: [] },
    };

    const reader = {
      async runEvents() { return LEDGER_EVENTS; },
      async history() { return [{ role: 'assistant', text: 'still waiting' }]; },
      async spend() { return spend; },
    };

    try {
      // The operation is a wait the product never ends; the budget is the
      // subject's own configuration, and the operation stops on its signal.
      // The budget runs on a clock the test hands it, so "the budget was
      // spent" is the advance below, never a sleep racing a real timer.
      let told = false;
      const clock = handClock();

      const episode = withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'budget', modelCalls: 'expected', clock, budgetMs: 20 },
        async (_reader, _collect, budget) => {
          await new Promise<void>((resolve) => { budget.addEventListener('abort', () => resolve(), { once: true }); });
          told = true;

          return 'never';
        });

      await clock.whenArmed(1);
      clock.advance(20);
      await expect(episode).rejects.toThrow('the episode budget of 20 ms was spent');
      expect(told).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'budget/failure.json'), 'utf8'))).toMatchObject({ phase: 'budget' });
      expect(readFileSync(join(root, 'budget/history.json'), 'utf8')).toContain('still waiting');
      expect(readFileSync(join(root, 'budget/events.jsonl'), 'utf8').split('\n')).toHaveLength(LEDGER_EVENTS.length);
      expect(JSON.parse(readFileSync(join(root, 'budget/spend.json'), 'utf8'))).toEqual(spend);
    } finally {
      resetLiveModelSpend();
    }
  });

  test('a ledger the wedged product never answers ends at the grace, keeping what did answer', async () => {
    resetLiveModelSpend();
    const root = scratchDir('wedged-episode-evidence');

    const spend: WorkspaceSpend = {
      total: { calls: 3, callsWithoutUsage: 0, unpricedCalls: 3, floorPricedCalls: 0, usage: { input: 10, output: 5 } },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 3, measured: 3, reported: 1, silent: [], partial: [] },
    };

    // THE WEDGED SHAPE, as the deployed build answered it: the Durable Object
    // holds the turn it never closed, so the run-event route never answers
    // while the two routes served elsewhere still do. Before the read had an
    // end of its own this episode never settled at all — the budget fired,
    // the operation stopped, and the collection it was waiting on stayed
    // pending until the runner killed the process with no verdict.
    const reader = {
      runEvents(): Promise<readonly RunEvent[]> { return new Promise<readonly RunEvent[]>(() => undefined); },
      async history() { return [{ role: 'assistant', text: 'still waiting' }]; },
      async spend() { return spend; },
    };

    try {
      const clock = handClock();

      const episode = withEpisodeEvidence(async () => reader,
        { transcripts: root, taskId: 'wedged', modelCalls: 'expected', clock, budgetMs: 20 },
        async (_reader, collect) => collect());

      await clock.whenArmed(2);
      clock.advance(20 + EVIDENCE_GRACE_MS);

      await expect(episode).rejects.toThrow('the episode budget of 20 ms was spent');
      expect(JSON.parse(readFileSync(join(root, 'wedged/failure.json'), 'utf8'))).toMatchObject({ phase: 'budget' });

      const collection = v.parse(CollectionSchema, JSON.parse(readFileSync(join(root, 'wedged/collection.json'), 'utf8')));

      expect(collection.find((row) => row.channel === 'events')?.status).toBe('failed');
      expect(collection.find((row) => row.channel === 'events')?.reason).toContain(String(EVIDENCE_GRACE_MS));
      expect(existsSync(join(root, 'wedged/events.jsonl'))).toBe(false);

      // What DID answer is still the episode's evidence.
      expect(collection.filter((row) => row.status === 'retained').map((row) => row.channel)).toEqual(['history', 'spend']);
      expect(readFileSync(join(root, 'wedged/history.json'), 'utf8')).toContain('still waiting');
      expect(JSON.parse(readFileSync(join(root, 'wedged/spend.json'), 'utf8'))).toEqual(spend);
    } finally {
      resetLiveModelSpend();
    }
  });

  test('an opening failure retains the cause and unavailable channels without inventing measurements', async () => {
    resetLiveModelSpend();
    const root = scratchDir('opening-evidence');
    const failure = new Error('created workspace but connection failed');

    try {
      await expect(withEpisodeEvidence(async () => { throw failure; },
        { transcripts: root, taskId: 'opening', modelCalls: 'expected', clock: REAL_CLOCK },
        async () => { throw new Error('unreachable operation'); })).rejects.toBe(failure);
      expect(JSON.parse(readFileSync(join(root, 'opening/failure.json'), 'utf8'))).toMatchObject({ phase: 'open', message: failure.message });
      expect(JSON.parse(readFileSync(join(root, 'opening/collection.json'), 'utf8'))).toEqual([
        { channel: 'events', status: 'unavailable', reason: 'session opening failed' },
        { channel: 'history', status: 'unavailable', reason: 'session opening failed' },
        { channel: 'spend', status: 'unavailable', reason: 'session opening failed' },
      ]);
      expect(existsSync(join(root, 'opening/spend.json'))).toBe(false);
      expect(existsSync(join(root, 'opening/events.jsonl'))).toBe(false);
      expect(liveModelSpend().episodesUnmeasured).toBe(1);
      expect(liveModelSpend().episodesWithoutModel).toBe(0);
    } finally {
      resetLiveModelSpend();
    }
  });
});

test('an explicitly missing file is an oracle miss; authorization and server failures still throw', async () => {
  let status = 404;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('fixture failure', { status }) });

  const session = new KinuPublicSession({
    origin: server.url.origin, identity: { kind: 'loopback' }, workspace: 'probe', purpose: 'file-read oracle probe',
    llm: { name: 'workers-ai', model: '@cf/zai-org/glm-5.3', baseURL: server.url.origin, headers: {} },
  }, 'probe');

  try {
    await expect(session.readFile('missing.txt', { allowMissing: true })).resolves.toBe('');
    await expect(session.readFile('missing.txt')).rejects.toThrow('404');
    status = 403;
    await expect(session.readFile('missing.txt', { allowMissing: true })).rejects.toThrow('403');
    status = 503;
    await expect(session.readFile('missing.txt', { allowMissing: true })).rejects.toThrow('503');
  } finally {
    await server.stop(true);
  }
});

/**
 * THE FIVE VERIFIER READS, each over the RPC it wraps.
 *
 * One row per read, because each one is a claim about a DIFFERENT product
 * surface and a shared happy path would prove only that the socket works: the
 * roster's `lifetime`, the task list's statuses, the plan view at the ROOT
 * path, the decision's queued handoff, and a preview request that carries a
 * query string. That last one is the row that would have caught the defect
 * this test was written against — assigning a path with `?` to `pathname`
 * percent-encodes the `?`, so `/tickets?status=claimed` reached a fixture app
 * as `/tickets%3Fstatus=claimed` and answered 404.
 */
/** One RPC method → the reply this fixture answers it with. A named contract
 *  because the probes REWRITE entries mid-test (the plan view's three shapes),
 *  so the map is mutable by design rather than by omission. */
const FixtureRpcMethodSchema = v.picklist([
  'listSubordinates', 'listAgentTasks', 'inspectSubordinate', 'decidePlanReview',
]);

interface FixtureRpcAnswers {
  listSubordinates: JsonValue;
  listAgentTasks: JsonValue;
  inspectSubordinate: JsonValue;
  decidePlanReview: JsonValue;
}

describe('the verifier reads speak the RPCs the web app is bound to', () => {
  const PLAN_ROW = {
    id: 'plan-7', sessionId: 'default', revision: 2, content: '1. one\n2. two\n3. three',
    status: 'pending', annotations: [], feedback: null, handoffAccepted: true,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, decidedAt: null,
  };

  const answers: FixtureRpcAnswers = {
    listSubordinates: [
      { name: 'alpha', status: 'dismissed', lifetime: 'task', createdBy: 'orchestrator',
        currentTask: null, createdAt: 1, dismissedAt: 2, actorReference: null, birth: null,
        deleteRequested: false, taskEventId: null },
    ],
    listAgentTasks: [
      { id: 't1', parentId: null, title: 'write the doc', status: 'done', createdAt: 3, updatedAt: 4, subtasks: [] },
    ],
    inspectSubordinate: { view: 'plans', path: [], page: { status: 'end', items: [PLAN_ROW] } },
    decidePlanReview: { ok: true, plan: { ...PLAN_ROW, status: 'approved' }, queued: true },
  };

  /** Every RPC this fixture was ASKED, so a read that reached a different
   *  method than the one its doc names fails here rather than passing on a
   *  lenient parse. */
  const asked: { method: string; args: readonly unknown[] }[] = [];

  const open = () => {
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch(request, upgrading) {
        if (request.method === 'DELETE') return Response.json({ ok: true });

        if (upgrading.upgrade(request)) return;
        const url = new URL(request.url);

        return Response.json({ path: url.pathname, query: url.search });
      },
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

  test('tasks() is listAgentTasks, with the status a reply is checked against', async () => {
    const { server, session } = open();
    asked.length = 0;

    try {
      await session.connect();

      expect(await session.tasks()).toEqual([
        { id: 't1', title: 'write the doc', status: 'done', createdAt: 3, updatedAt: 4, subtasks: [] },
      ]);

      expect(asked).toEqual([{ method: 'listAgentTasks', args: [] }]);
    } finally { await session.teardown(); await server.stop(true); }
  });

  test('plans() is inspectSubordinate over the ROOT path, and a missing view is an empty list', async () => {
    const { server, session } = open();
    asked.length = 0;

    try {
      await session.connect();
      expect((await session.plans()).map((plan) => plan.id)).toEqual(['plan-7']);
      // The ROOT path and the `plans` view: a request that walked into a
      // subordinate would credit the wrong actor with the root's plan.
      expect(asked).toEqual([{
        method: 'inspectSubordinate', args: [{ path: [], view: 'plans', page: { limit: 50 } }],
      }]);

      answers.inspectSubordinate = { view: 'missing', path: [], reason: 'missing', error: 'no plan_reviews table' };
      expect(await session.plans()).toEqual([]);

      // Any OTHER view is a protocol disagreement, not an empty reading.
      answers.inspectSubordinate = { view: 'children', path: [], page: { status: 'end', items: [] } };
      await expect(session.plans()).rejects.toThrow('children');
    } finally {
      answers.inspectSubordinate = { view: 'plans', path: [], page: { status: 'end', items: [PLAN_ROW] } };
      await session.teardown();
      await server.stop(true);
    }
  });

  test('decidePlan() is decidePlanReview, and reports the queued handoff', async () => {
    const { server, session } = open();
    asked.length = 0;

    try {
      await session.connect();
      const decided = await session.decidePlan('plan-7', 2, 'approve');

      if (!decided.ok) throw new Error('the fixture answered a refusal');
      // `queued` is the fact a caller that must WAIT for the implementation
      // turn needs; an approval whose handoff was accepted starts one.
      expect(decided.queued).toBe(true);
      expect(decided.plan.status).toBe('approved');
      expect(asked).toEqual([{ method: 'decidePlanReview', args: ['plan-7', 2, 'approve'] }]);

      await session.decidePlan('plan-7', 2, 'request_changes', 'needs a rollback step');
      expect(asked.at(-1)?.args).toEqual(['plan-7', 2, 'request_changes', 'needs a rollback step']);
    } finally { await session.teardown(); await server.stop(true); }
  });

  test('fetchPreview() keeps the query string, the exposure path prefix and the method', async () => {
    const { server, session } = open();

    try {
      await session.connect();
      // A bare path.
      expect(JSON.parse((await session.fetchPreview(server.url.origin, '/health')).text))
        .toEqual({ path: '/health', query: '' });

      // A QUERY, which is the contract a slate case exercises.
      expect(JSON.parse((await session.fetchPreview(server.url.origin, '/tickets?status=claimed&agent=ana')).text))
        .toEqual({ path: '/tickets', query: '?status=claimed&agent=ana' });

      // A preview URL that carries its own path prefix — a capability URL
      // does — keeps it in front of the request path.
      expect(JSON.parse((await session.fetchPreview(`${server.url.origin}/p/abc123/`, '/metrics')).text))
        .toEqual({ path: '/p/abc123/metrics', query: '' });

      // And it WRITES: an app's own contract cannot be checked with reads
      // alone.
      const posted = await session.fetchPreview(server.url.origin, '/tickets', {
        method: 'POST', json: { id: 'q-1', priority: 2 },
      });

      expect(posted.status).toBe(200);
      expect(JSON.parse(posted.text)).toEqual({ path: '/tickets', query: '' });
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
