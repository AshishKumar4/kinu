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
import * as v from 'valibot';

import { BEHAVIOUR_SCORERS, ledgerTotalsFromEvents, TASK_OUTCOME } from '@kinu.run/test-utils';
import {
  PUBLIC_IDENTITY_ENV, decodeFrame, encodeChatRequest, encodeRpcRequest,
  recordPublicTurn, resolvePublicSessionPlan, resolveWebIdentity, scorePublicLedger,
  type PublicTurnRecorder,
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
      requestId: 'rpc-1', method: 'steerTurn', args: ['stop, use the file tool', 'build'],
    }));
    // Same as above: an outbound frame is not one this session consumes.
    expect(frame?.kind).toBe('other');
    const sent = v.parse(RpcRequestFrameSchema, JSON.parse(encodeRpcRequest({
      requestId: 'rpc-1', method: 'setModel', args: ['@cf/x'],
    })));
    expect(sent).toEqual({ type: 'rpc', id: 'rpc-1', method: 'setModel', args: ['@cf/x'] });
  });

  test('a file-producing turn decodes to its tool call, its text and its steps', () => {
    const recorder = replay(chatTurnFrames({
      requestId: FIXTURE_REQUEST_ID, chunks: FILE_TURN_CHUNKS,
    }));
    const turn = recorder.settled();
    if (turn === null) throw new Error('the terminal frame did not settle the turn');
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
    if (turn === null) throw new Error('the terminal frame did not settle the turn');
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
    if (turn === null) throw new Error('the error frame did not settle the turn');
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
    if (turn === null) throw new Error('the replayed terminal frame did not settle the turn');
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

describe('route-shaped run events score through the production instruments', () => {
  test('the ledger reduction reads the deployment\'s own events', () => {
    const totals = ledgerTotalsFromEvents(LEDGER_EVENTS);
    expect(totals.turns).toBe(2);
    expect(totals.toolCalls).toBe(4);
    expect(totals.steps).toBe(2);
    expect(totals.tokensIn).toBe(2_700);
    expect(totals.toolNames).toEqual(['file', 'run', 'file', 'run']);
  });

  test('every instrument scores, and the failing tool call is counted as one', () => {
    const rows = scorePublicLedger(LEDGER_EVENTS);
    const byName = new Map(rows.map((row) => [row.name, row]));
    // Every declared scorer, over one store: this is the assertion that the
    // bridge did not quietly narrow the panel.
    expect(rows.map((row) => row.name).sort()).toEqual(BEHAVIOUR_SCORERS.map((scorer) => scorer.name).sort());
    // `tool_outcomes` is the coarse instrument with a denominator on any task,
    // and the row it must not get wrong is the command that RAN and exited 1 —
    // an ordinary successful tool result whose text begins `Error (exit 1)`.
    const outcomes = byName.get('tool_outcomes');
    expect(outcomes?.eligible).toBe(4);
    expect(outcomes?.passed).toBe(3);
    expect(outcomes?.detail).toContain('work failed');
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
});
