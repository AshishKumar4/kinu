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
  BEHAVIOUR_SCORERS, EPISODE_TRANSCRIPT_FILES, ledgerTotalsFromEvents, projectRunEventProvenance,
  retainEpisodeTranscript, scratchDir, TASK_OUTCOME, withEpisodeEvidence, liveModelSpend, resetLiveModelSpend,
} from '@kinu.run/test-utils';
import { RunEventSchema, type RunEvent, type WorkspaceSpend, type JsonValue } from '../../packages/core/src/index';
import {
  PUBLIC_IDENTITY_ENV, decodeFrame, encodeChatRequest, encodeRpcRequest,
  recordPublicTurn, resolvePublicSessionPlan, resolveWebIdentity, scorePublicLedger,
  type PublicTurnRecorder,
  KinuPublicSession,
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
    fetch(request, server) {
      if (request.method === 'DELETE') return Response.json({ ok: true });
      if (server.upgrade(request)) return;
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
    expect(await session.execute('laptop', 'work')).toEqual(response);
    response = { stdout: '{"reason":"denied","error":"historical incident"}', stderr: '', exitCode: 0 };
    expect(await session.execute('laptop', 'read')).toEqual(response);
  } finally { await session.teardown(); await server.stop(true); }
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
    // The failing `run` keeps its CLASS and its name; the clean one keeps no class.
    const calls = provenance.events.filter((event) => event.type === 'tool_call_end');
    expect(calls.map((event) => event.name)).toEqual(['file', 'run', 'file', 'run']);
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
      turns: 2, toolCalls: 4, toolNames: ['file', 'run', 'file', 'run'],
      tokensIn: 2700, tokensOut: 520, reasoningOut: 0, steps: 2, failures: ['run: exit_1'],
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
      total: { calls: 8, callsWithoutUsage: 0, unpricedCalls: 8, usage: { input: 234433, output: 29531 } },
      producers: [], missions: [], offTurnShare: null,
      coverage: { calls: 8, measured: 8, reported: 1, silent: [], partial: [] },
    };
    const reader = {
      async runEvents() { return LEDGER_EVENTS; },
      async history() { return [{ role: 'assistant', text: 'partial answer' }]; },
      async spend() { return spend; },
    };
    try {
      await expect(withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'failure', modelCalls: 'expected' }, async () => {
        throw new Error('failed after model work');
      })).rejects.toThrow('failed after model work');
      expect(liveModelSpend().calls).toBe(8);
      expect(JSON.parse(readFileSync(join(root, 'failure/spend.json'), 'utf8'))).toEqual(spend);
      const events = readFileSync(join(root, 'failure/events.jsonl'), 'utf8').split('\n').map((line) => v.parse(RunEventSchema, JSON.parse(line)));
      expect(ledgerTotalsFromEvents(events).turns).toBe(2);
      expect(readFileSync(join(root, 'failure/failure.json'), 'utf8')).toContain('failed after model work');

      resetLiveModelSpend();
      await expect(withEpisodeEvidence(async () => reader, { transcripts: root, taskId: 'assertion', modelCalls: 'expected' }, async (_reader, collect) => {
        await collect();
        throw new Error('subgoal missed');
      })).rejects.toThrow('subgoal missed');
      expect(liveModelSpend().calls).toBe(8);

      resetLiveModelSpend();
      await expect(withEpisodeEvidence(async () => ({ ...reader, async spend() { throw new Error('spend endpoint unavailable'); } }),
        { transcripts: root, taskId: 'outage', modelCalls: 'expected' }, async () => 'finished')).rejects.toThrow('spend endpoint unavailable');
      expect(liveModelSpend().episodesUnmeasured).toBe(1);
      expect(readFileSync(join(root, 'outage/history.json'), 'utf8')).toContain('partial answer');
      expect(JSON.parse(readFileSync(join(root, 'outage/collection.json'), 'utf8'))).toContainEqual({
        channel: 'spend', status: 'failed', reason: 'spend endpoint unavailable',
      });
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
        { transcripts: root, taskId: 'opening', modelCalls: 'expected' },
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
