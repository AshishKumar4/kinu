/**
 * Two real OrchestratorAgent turns, end to end inside workerd, over the real
 * HTTP model seam.
 *
 * THE TWO DEFECTS THIS FILE PINS, both shipped 2026-09-08 and invisible to
 * every suite that seeds its own history:
 *
 *  (a) the open read (`getWorkspaceSnapshot` → `getAgentStatus` →
 *      `conversationCount`) once selected a table a hosted workspace root
 *      only gained on the SDK session's first read, so the read was green
 *      only when that DDL had run.
 *  (b) the second turn's model request must carry the user message that
 *      started it. The Node-side fake records the HTTP bodies as the
 *      production SDK sent them, so the assertion reads the defect at the
 *      model boundary, not by proxy.
 *
 * THE SEAM. The drive pins `openai-compat/probe` (fixture credential
 * `openai-compat.default` whose baseURL points at the fake host), so the
 * turn's requests travel the product's own openai-compat wire path —
 * `createAuthedFetch` over the global fetch, intercepted by this worker's
 * Node-side `outboundService` — instead of the direct Workers AI binding.
 * Sleep/title lanes stay on the binding (tier models, not the pin), so
 * FakeAI keeps answering them; the binding log's zero streamed turns proves
 * the cutover. Nothing in production knows the probe exists.
 *
 * THE CLEAN-LOG ASSERTION. The probe joins each turn's terminal settle on the
 * product's own evidence (`memory.facts_deferred` / `memory.facts_compressed`) and returns the captured
 * diagnostics: the test asserts zero failures and zero owed effects. A double
 * that fails the product code it serves is a defect, not a limitation — so a
 * failing lane would fail this test rather than pass behind an echo.
 *
 * No pending-cancel case lives here: the miniflare pool does not deliver
 * subrequest abort into a Node-side outboundService handler (evidence in
 * kinu-logs/two-turn/run16 through run19), so that arm now belongs to a
 * bun-side test over the injected fetch instead.
 */
import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  CallRecordSchema,
  DiagnosticFailureSchema,
  HistorySchema,
  HttpCallSchema,
  PreparedConversationSchema,
  SnapshotSchema,
  type DiagnosticFailure,
  type PendingSteer,
} from './two-turn-shapes';

const SignalProbeSchema = v.union([
  v.object({ signalKind: v.string() }),
  v.object({ threw: v.string() }),
]);

const FailuresSchema = v.array(DiagnosticFailureSchema);

const HttpSchema = v.array(HttpCallSchema);

describe('two real turns over the HTTP model seam', () => {
  it('an ordinary signal arriving at the final model step is not lost at settlement', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('signal-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('signal'))
      .filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(3);
    const genesis = calls[0]?.users.find((message) => !message.startsWith('<'));
    // The signal ran its own turn (the THIRD call). Which side of the
    // programmatic exchange the spliced A+B pair lands on, and whether each
    // echo has flushed by snapshot time, is timing-dependent — the durable
    // contract is only that both inputs reached the model after the genesis
    // exchange, on this one turn.
    const signalTurn = calls[2]?.conversation.filter((message) => message.role !== 'system' && !message.content.startsWith('<'));

    expect(signalTurn?.[0]).toEqual({ role: 'user', content: genesis });
    expect(signalTurn?.[1]).toEqual({ role: 'assistant', content: `echo:${genesis}` });

    const rest = signalTurn?.slice(2).map((m) => m.content) ?? [];
    expect(rest).toContain('QUEUE-PROGRAMMATIC');
    expect(rest).toContain('QUEUE-A\n\nQUEUE-B');
  });

  it('a genesis offer still yields inside its slot to an already admitted owner message', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('yield-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('yield'))
      .filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.users.filter((text) => !text.startsWith('<'))).toEqual(['QUEUE-OWNER']);
  });

  it('admits two websocket asks after held genesis through the installed Think queue', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('chat'))
      .filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(2);
    const genesis = calls[0]?.users.find((message) => !message.startsWith('<'));
    expect(genesis).toContain('This workspace has just been created.');
    expect(calls[0]?.users).not.toContain('QUEUE-A');
    expect(calls[0]?.users).not.toContain('QUEUE-B');

    // Under the splice rule A and B were accepted mid-turn and merged into ONE
    // user message at the held turn's next step — a single second provider call
    // carries the completed genesis prefix plus the merged text, in order.
    expect(calls[1]?.conversation.filter((message) => message.role !== 'system' && !message.content.startsWith('<'))).toEqual([
      { role: 'user', content: genesis },
      { role: 'assistant', content: `echo:${genesis}` },
      { role: 'user', content: 'QUEUE-A\n\nQUEUE-B' },
    ]);

    // The durable-token proof for a mid-turn send lives in the cold arm — under
    // send a busy socket input reserves pending_steers,
    // and the row drains once the turn settles, so nothing durable remains here.
  });

  it('a peer event that arrives mid-genesis rides the rerun of the sends genesis could not land', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('peer-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('peer'))
      .filter((call) => call.model === 'probe-queue');

    // Two turns. Genesis answered on its one step, so A, B and C could not
    // land in it and rerun as ONE user turn after it. The peer event's drain
    // was sent while that rerun was queued and not yet open, and a message
    // arriving behind a queued user turn rides that turn's first step rather
    // than queueing a turn of its own behind it — so the drain's brief is the
    // rerun's second user message, after the operator's own words.
    expect(calls).toHaveLength(2);
    const genesis = calls[0]?.users.find((message) => !message.startsWith('<'));
    const rerun = calls[1]?.conversation.filter((message) => message.role !== 'system' && !message.content.startsWith('<'));

    expect(rerun).toEqual([
      { role: 'user', content: genesis },
      { role: 'assistant', content: `echo:${genesis}` },
      { role: 'user', content: 'QUEUE-A\n\nQUEUE-B\n\nQUEUE-C' },
      { role: 'user', content: expect.stringContaining('QUEUE-PROGRAMMATIC') },
    ]);
  });
  it('keeps a queued chat on its durable token through a cold reset and replay', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('cold-queue-driver'));

    // Genesis's model call is held; B and C are sent mid-turn and each writes a
    // durable pending_steers reservation under the CLIENT's own message id,
    // bound to the in-flight turn. The replay below must re-bind that token,
    // not mint a duplicate.
    const prepared = v.parse(PreparedConversationSchema, await root.prepareQueuedConversation('cold'));
    const steerFor = (rows: PendingSteer[], id: string) => rows.find((row) => row.id === `input-${id}`);
    expect(steerFor(prepared.steers, 'QUEUE-B')).toBeDefined();
    expect(steerFor(prepared.steers, 'QUEUE-C')).toBeDefined();
    expect(prepared.steers).toHaveLength(2);

    // The reset drops the object AND its socket; the stub reacquired below is
    // a fresh activation over the same storage.
    await abortAllDurableObjects();
    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('cold-queue-driver'));

    // Replaying the exact B and C frames re-issues acceptSend under the same
    // client message id. The durable reservation owns the token, so the ledger
    // still holds exactly the two rows — the replay re-binds, never duplicates.
    const replayed = await coldRoot.replayQueuedConversation(prepared);
    expect(replayed.steers).toHaveLength(2);
    expect(new Set(replayed.steers.map((row) => row.id))).toEqual(
      new Set(['input-QUEUE-B', 'input-QUEUE-C']),
    );

    const done = await coldRoot.completeQueuedConversation(prepared);

    const calls = v.parse(HttpSchema, done.http).filter((call) => call.model === 'probe-queue');

    const realUsers = (call: (typeof calls)[number]) => call.conversation
      .filter((m) => m.role === 'user' && !m.content.startsWith('<') && !m.content.startsWith('Continue your previous response'))
      .map((m) => m.content);

    // The re-opened genesis turn continued after the reset and landed B and
    // C at its first step — the boundary both were waiting for — as one
    // spliced message after the genesis text, in order, on ONE model call
    // (the held call died with the object; the probe reads only the calls
    // the restarted object makes).
    expect(calls).toHaveLength(1);
    expect(realUsers(calls[0]!)).toHaveLength(2);
    expect(realUsers(calls[0]!)[1]).toBe('QUEUE-B\n\nQUEUE-C');

    // Each admitted send landed exactly once under its own id — the
    // reservation survived the reset, the replay re-bound it rather than
    // minting a second, and the drain that landed it retired it: one
    // transcript row per client id, chained under the turn's own opening
    // row, and nothing left reserved.
    expect(done.steers).toHaveLength(0);
    expect(done.transcript.map((row) => row.role)).toEqual(['user', 'user', 'user', 'assistant']);

    for (const id of ['input-QUEUE-B', 'input-QUEUE-C']) {
      expect(done.transcript.filter((row) => row.role === 'user' && row.id === id)).toHaveLength(1);
    }

    // The run the loop continued closed ONCE, by the loop. The wake's
    // reconcile seals runs a dead activation left open; a run the loop has
    // re-opened is open on purpose, and a seal under it recorded a second,
    // contradictory close and a fleet row for a turn still running.
    expect(done.runEnds).toEqual([{ runId: expect.any(String), reason: 'completed' }]);
  });

  it('splices a mid-turn attachment into the next model call as a file part', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('attach-queue-driver'));

    // The held genesis turn takes A then B mid-turn; B carries an image
    // attachment. The spliced steer turn's model call must carry the file as
    // a part — not drop it to the floor.
    const calls = v.parse(HttpSchema, await root.queuedConversation('attach')).filter((call) => call.model === 'probe-queue');

    const spliced = calls.find((call) =>
      call.fileParts.some((parts) => parts.some((part) => part.type === 'image_url' && part.url === 'data:image/png;base64,iVBORw0KGgo=')));

    expect(spliced).toBeDefined();
    expect(spliced!.conversation.some((m) => m.role === 'user' && m.content.includes('QUEUE-B'))).toBe(true);
  });

  it('re-delivers a mid-turn attachment with real file data through a cold reset and replay', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('attach-cold-driver'));

    // Same drive as the text-only cold arm, but B's steer carries an image —
    // the reservation now spans TWO tables (pending_steers + pending_steer_files)
    // and the replay must re-bind both, not leave the file row orphaned. A
    // distinct mode keeps its workspace separate from the warm attach test's.
    const prepared = v.parse(PreparedConversationSchema, await root.prepareQueuedConversation('attach-cold'));
    expect(prepared.steerFiles).toHaveLength(1);

    await abortAllDurableObjects();
    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('attach-cold-driver'));

    const replayed = await coldRoot.replayQueuedConversation(prepared);
    // The replay re-admitted B's reservation: the file row survives re-binding
    // under the same client id, not duplicated and not dropped.
    expect(replayed.steerFiles).toEqual([{
      actorId: expect.any(String),
      steerId: 'input-QUEUE-B',
      filename: 'chart.png',
      mediaType: 'image/png',
      url: 'data:image/png;base64,iVBORw0KGgo=',
    }]);

    const done = await coldRoot.completeQueuedConversation(prepared);
    const calls = v.parse(HttpSchema, done.http).filter((call) => call.model === 'probe-queue');

    // The recovered turn's model call carries B's attachment as a file part —
    // the byte-stable url the reservation stored, not a dropped reference.
    const carried = calls.find((call) =>
      call.fileParts.some((parts) => parts.some((part) => part.type === 'image_url' && part.url === 'data:image/png;base64,iVBORw0KGgo=')));

    expect(carried).toBeDefined();
    expect(carried!.conversation.some((m) => m.role === 'user' && m.content.includes('QUEUE-B'))).toBe(true);
  });

  it('re-delivers a buffered event after eviction when its drain lease is stale', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('evt-redelivery-driver'));

    // A claim the workspace can host turns under, then the state a dead
    // activation leaves: one webhook event already bound to a drain turn whose
    // lease never closed, aged past the stale grace. The reset drops the
    // object; the wake that follows must re-pend it and re-ask the question.
    const { workspace } = await root.claimEventWorkspace();
    await root.seedStaleDrainEventFor(workspace, 'BUFFERED-EVENT');
    await abortAllDurableObjects();

    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('evt-redelivery-driver'));

    // Before the wake: the event is still bound to the dead turn's lease —
    // the activation proved the work exists, it did not answer it yet.
    const seeded = (await coldRoot.agentLogEventsFor(workspace)).find((row) => row.id === 'ev-seeded-BUFFERED-EVENT');
    expect(seeded?.turnId).toBe('evt-seeded-dead');
    expect(seeded?.consumedAt).toBe(0);

    // The wake: unbindStale re-pends the unanswered lease, the drain re-binds
    // it to a NEW synthetic turn, and the model sees the event text again. The
    // wake joins on the marker landing in the wire log, so a return means the
    // drain's model call carried the buffered event.
    await coldRoot.runEventWakeFor(workspace, 'BUFFERED-EVENT');

    const calls = v.parse(HttpSchema, await coldRoot.httpCalls());

    const redelivered = calls.find((call) =>
      call.conversation.some((m) => m.content.includes('BUFFERED-EVENT')));

    expect(redelivered).toBeDefined();

    // The re-pend and re-bind both show: the lease moved OFF the dead turn and
    // onto the drain that just consumed it.
    const rebound = (await coldRoot.agentLogEventsFor(workspace)).find((row) => row.id === 'ev-seeded-BUFFERED-EVENT');
    expect(rebound?.turnId).toMatch(/^evt-/);
    expect(rebound?.turnId).not.toBe('evt-seeded-dead');
  });

  it('drains an external event that reached an idle object, on the wake its arrival armed', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('reactor-wake-driver'));

    // An IDLE object: claimed and pinned to the fake wire, no genesis turn and
    // no trigger, so nothing here is due. Then ONE real external event through
    // the shipped cross-DO receiver, which publishes through `EventLog.publish`
    // and calls the production `onAdmitted` — so both halves of the ingress
    // contract run, the in-memory debounce and the durable arm.
    const { workspace, owner } = await root.claimReactorWakeWorkspace();
    const armed = await root.publishPeerEvent(workspace, owner, 'REACTOR-WAKE');

    // WHICH CHAIN the arrival armed. This actor carries two and only the frame
    // behind the armed callback runs: `_kinuTimerTick` is the timer chain that
    // `nextWakeAt` (with the event log folded in) feeds, `_kinuTerminalRetryTick`
    // the terminal-retry chain. Asserted because it is the premise of the drive
    // below — a row that drove a callback nothing armed would measure a frame
    // the platform was never going to deliver.
    expect(armed.map((row) => row.callback)).toContain('_kinuTimerTick');

    // The eviction takes the 250 ms drain debounce `scheduleDrain` armed beside
    // the durable row. What is left is the durable half alone, which is the
    // half a pending reaction is supposed to have.
    await abortAllDurableObjects();

    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('reactor-wake-driver'));

    // The guard on that eviction: the row is still PENDING. A debounce that
    // beat the abort would drain here and green this row on the wrong
    // evidence, so the state the measurement needs is asserted, never assumed.
    const pending = (await coldRoot.agentLogEventsFor(workspace)).filter((row) => row.variant === 'peer_agent');

    expect(pending).toHaveLength(1);
    expect(pending[0]?.turnId).toBeNull();

    // One lap of the wake, delivered: the product's own frames, chosen from the
    // product's own registry. The armed callback is re-read after the reset, so
    // a chain that only the live isolate held would show up as an empty drive.
    const driven = await coldRoot.driveArmedWakesFor(workspace);

    expect(driven).toContain('_kinuTimerTick');

    // THE PROPERTY: the frame that wake reaches DRAINS. The bind is written by
    // `markConsumed` and nothing else writes an `evt-` turn id, so the row
    // itself says whether the drain happened — no poll and no deadline. A
    // CLOSED lease beside it (`consumed_at` back to null, `markTurnCompleted`)
    // is the drain turn having finished, which is why the two fields are read
    // together: pending is (null, null), leased is (evt-, number), answered is
    // (evt-, null).
    const consumed = (await coldRoot.agentLogEventsFor(workspace)).filter((row) => row.variant === 'peer_agent');

    // Asserted as the whole row, so a failure prints the state the wake left
    // rather than a type error about a null.
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toEqual(expect.objectContaining({
      turnId: expect.stringMatching(/^evt-/),
      consumedAt: null,
    }));

    // And the turn that drain queued RAN: the reactor's own run in the ledger,
    // with the event's text on the model wire. The join is bounded by the row
    // above — it is entered only once the bind proved a drain happened.
    await coldRoot.awaitWireMarker('REACTOR-WAKE');
    expect(await coldRoot.runStartCausesFor(workspace)).toContain('event_drain');
  });

  it('two clients delivering the same message at once are one turn, one provider request, one row', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('twin-driver'));
    const out = await root.twinSends();
    const calls = v.parse(HttpSchema, out.http).filter((call) => call.model === 'probe-queue');

    // Idempotent admission under concurrent delivery: the second socket's
    // frame is the same admitted message, not a second turn.
    expect(calls).toHaveLength(1);
    expect(out.transcript.filter((row) => row.role === 'user' && row.id === 'input-TWIN')).toHaveLength(1);
    expect(out.transcript.filter((row) => row.role === 'assistant')).toHaveLength(1);
    expect(out.steers).toHaveLength(0);
    expect(out.runEnds).toEqual([{ runId: expect.any(String), reason: 'completed' }]);
  });

  it('the eval-only abort ends the activation and the object comes back over the same storage', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('eval-abort-driver'));
    const out = await root.evalAbort();

    // The platform rejects the call the abort was in flight on — the receipt
    // the route answers 202 with — and a fresh stub finds a live object.
    expect(out.receipt).not.toBeNull();
    expect(out.alive).toBe(true);
  });

  it('the agent tab: a hired actor answers getActorSnapshot and listAgentTasks on its own path', async () => {
    // The owner's report on build cba44dcb9: the "+" tab hung on
    // "Disconnected · Untitled agent" and both mount reads timed out at 30 s,
    // because the client addressed a facet hop this transport refuses. The
    // object serves the actor itself under its own segment; these are the two
    // reads the tab makes, answered over exactly that socket.
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('agent-tab-driver'));
    const out = await root.hostedActorTab();

    expect(out.name).not.toBe('');

    // Parsed from the frames' own JSON text: the shape the tab reads is what
    // this names, and a refusal frame would fail the parse by its words.
    const snapshot = v.parse(v.object({
      name: v.string(), role: v.string(), mission: v.string(), pendingSteers: v.array(v.unknown()),
    }), JSON.parse(out.snapshot));

    expect(snapshot).toEqual({ name: out.name, role: 'task', mission: '', pendingSteers: [] });
    expect(v.parse(v.array(v.unknown()), JSON.parse(out.tasks))).toEqual([]);
    expect(out.frames).toBeGreaterThanOrEqual(2);
  });

  it('a fresh workspace\'s first chat reaches the model and the turn closes', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('first-chat-driver'));

    // The first-run regression: a fresh workspace's first `cf_agent_use_chat_request`
    // on the socket — no held genesis, no queue arm — must reach the model.
    // `spend.json` on the live build had zero calls for these cases.
    const out = await root.firstChat();
    const calls = v.parse(HttpSchema, out.http).filter((call) => call.model === 'probe-queue');

    // The admission itself is durable evidence: the loop writes the first
    // chat's opening row under the client's own id, and the model call proves
    // the intake became a turn.
    expect(out.transcript.some((row) => row.role === 'user' && row.id === 'input-FIRST-CHAT')).toBe(true);
    expect(calls.length).toBe(1);
    expect(out.sleepTimeSettled).toBe(1);
  });

  it('the owner\'s first chat after genesis rides the genesis turn', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('first-gen-driver'));

    // The absorb contract: the create queues genesis, the owner's first prompt
    // lands mid-genesis as a steer, and the NEXT step of that same turn carries
    // it to the model — one call, both prompts, no second turn. The regression
    // the bench saw was the prompt going nowhere at all: the run admitted but
    // spend.json showed zero calls. `landed:'mid-turn'` is the done frame's own
    // report that the splice, not a fresh turn, answered the prompt.
    const out = await root.firstChatAfterGenesis();
    const calls = v.parse(HttpSchema, out.http).filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(1);

    // The one call's user rows, in order: the genesis prompt first, then the
    // chat text spliced in as the landed steer.
    const human = calls[0]?.users.filter((text) => !text.startsWith('<')) ?? [];
    expect(human[0]).toContain('This workspace has just been created.');
    expect(human[1]).toBe('FIRST-PROMPT');

    // The prompt's durable trace: the pending steer row is retired, the landed
    // user row is persisted under the chat's own id, and the turn closed.
    expect(out.steers).toHaveLength(0);
    expect(out.transcript.some((row) => row.role === 'user' && row.id === 'input-FIRST-PROMPT')).toBe(true);
    expect(out.inbox.busy).toBe(false);
    expect(out.landed).toBe('mid-turn');
  });

  it('spikes the service-binding RPC, then runs A and B end to end', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('driver'));

    // SPIKE 1 — the auxiliary lanes (sleep judge, title) still travel the
    // direct binding, so the whole drive still depends on AbortSignal
    // surviving the service-binding RPC.
    const signal = v.parse(SignalProbeSchema, await root.signalProbe());

    expect(signal).toEqual({ signalKind: 'AbortSignal' });

    // SPIKE 2 + THE DRIVE — claimOwner boots the hosted workspace plane
    // (nimbus session behind the workspace VFS) the first time it touches the
    // scaffold; a failure here is the session-boot spike answering. Each turn
    // is joined on its own terminal settle inside `exercise` before it
    // returns, so everything asserted below is post-settle state.
    const out = await root.exercise();
    const http = v.parse(HttpSchema, out.http);

    // The cutover proof: no streamed turn reached the binding — the turns
    // traveled HTTP. The sleep-time judge is not counted here: it runs on a
    // cadence a two-turn drive never reaches, and `calls` is the fake's
    // worker-wide record, so its sleep rows belong to the three-turn drives.
    const calls = v.parse(v.array(CallRecordSchema), out.calls);

    expect(calls.filter((c) => c.stream)).toHaveLength(0);

    // Zero unmocked egress at the HTTP seam: every captured request went to
    // the fake host, and the two turn posts carried the typed lines — (b)
    // read at the boundary where the defect lived. The real prompt carries
    // harness-injected user rows after the typed text (the `<dynamic_context>`
    // block), so `toContain` picks the typed line out of each post's list.
    expect(http.every((h) => h.host === 'fake-models.invalid')).toBe(true);

    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe');

    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.stream)).toBe(true);
    expect(posts.at(0)?.users).toContain('A');
    expect(posts.at(1)?.users).toContain('B');

    // The stored credential reached the wire without the probe touching it:
    // every post carried the fixture key as a Bearer token.
    expect(posts.every((p) => p.authHeader === 'Bearer probe-fixture-key')).toBe(true);

    // The stored replies: echo:A then echo:B as the two assistant rows.
    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.slice(-2)).toEqual(['echo:A', 'echo:B']);

    // (a): the open read — the pane COUNT over the SDK-created table. The
    // SDK's column list is not exposed by any RPC, so the schema assertion
    // from the original brief is skipped: reading sqlite_master would take a
    // production method added for a test, which the brief forbade. The model
    // asserts the pin took: the turn ran on the compat fixture, not native.
    const snapshot = v.parse(SnapshotSchema, out.snapshot);

    expect(snapshot.status.model).toBe('openai-compat/probe');
    expect(snapshot.status.messageCount).toBe(history.items.length);

    // The settle verdict: both turns' terminal closes finished with nothing
    // owed and nothing failed. `failures` is every captured `diagnostics`
    // failure across the whole drive; `owedEffects` is every effect key a
    // finished close left behind; `sleepTimeSettled` counts the sleep-time
    // settles, one per turn.
    const failures: DiagnosticFailure[] = v.parse(FailuresSchema, out.failures);

    expect(failures).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(2);
    // THE CATALOG WAS SERVED, NOT REFUSED. Every listing sweep asks models.dev
    // for the provider catalog; refused, each provider takes a slow fallback
    // path and the gate's wall goes from its declared seconds to minutes
    // (measured 2026-09-15: 51 fallbacks, 160–398 s solo). A test that reaches
    // the network measures the network, so the probe's outbound answers the
    // catalog from a fixture and no drive may take the fallback. The hit
    // count is not asserted above zero: the catalog module caches per fetch
    // identity for its TTL, so a drive after another suite's sweep reads the
    // cache and asks the outbound nothing — which is the same proof.
    expect(out.catalogFallbacks).toBe(0);
  });

  it('round-trips a real file tool call through the HTTP seam', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('tools-driver'));

    const out = await root.driveOnce({
      workspace: 'tools-workspace',
      owner: 'tools-owner',
      displayName: 'Tools',
      model: 'openai-compat/probe-tools',
      text: 'T1',
      seedFile: { path: 'probe-fixture.txt', content: 'probe fixture says hello\n' },
    });

    const http = v.parse(HttpSchema, out.http);
    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe-tools');

    // The roundtrip shape, exactly two posts: the first offers the real
    // registry surface — `file` among the definitions the product composed —
    // and the fake answers the tool call the model id pins; the second
    // carries the call and its result. Anything else is a confused turn.
    expect(posts).toHaveLength(2);
    expect(posts.at(0)?.offeredTools).toContain('file');
    expect(posts.at(0)?.toolCalls).toEqual([]);

    const called = posts.at(1);

    expect(called?.toolCalls.map((c) => c.name)).toEqual(['file']);

    // The tool executed for real: the following request carries the `file`
    // read's result, naming the seeded content — the actual tool result in
    // the next model request, not an echoed fixture.
    expect(called?.toolResults.join('')).toContain('probe fixture says hello');

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)?.endsWith('echo:tool-answered')).toBe(true);
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

  // The tool-call-only first step, no narrated text delta — the shape real
  // act-first models answer with. Originally reported as a product bug; the
  // red run proved it a fixture protocol error (the fake's schema rejected
  // the follow-up request's legal `content: null` assistant row; evidence in
  // kinu-logs/two-turn/tool-only/). The corrected wire is pinned here so a
  // regression on either side — the turn or the fixture — fails this case.
  it('runs a tool-call-only first step instead of silently skipping it', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('tools-only-driver'));

    const out = await root.driveOnce({
      workspace: 'tools-only-workspace',
      owner: 'tools-only-owner',
      displayName: 'Tools Only',
      model: 'openai-compat/probe-tools-only',
      text: 'T2',
      seedFile: { path: 'probe-fixture.txt', content: 'probe fixture says hello\n' },
    });

    const http = v.parse(HttpSchema, out.http);
    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe-tools-only');

    // Exactly two posts: the tool-call-only first step, then the request
    // carrying the executed `file` result.
    expect(posts).toHaveLength(2);
    expect(posts.at(0)?.offeredTools).toContain('file');

    const called = posts.find((p) => p.toolCalls.length > 0);

    expect(called).toBeDefined();
    expect(called?.toolCalls.map((c) => c.name)).toEqual(['file']);
    expect(called?.toolResults.join('')).toContain('probe fixture says hello');

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)?.endsWith('echo:tool-answered')).toBe(true);
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

  it('settles the turn after a provider error', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('error-driver'));

    const out = await root.driveOnce({
      workspace: 'error-workspace',
      owner: 'error-owner',
      displayName: 'Error',
      model: 'openai-compat/probe-error',
      text: 'E1',
    });

    const http = v.parse(HttpSchema, out.http);
    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe-error');

    // The observed contract: the SDK does not retry the refused request, so
    // the turn fails — but it fails CLEANLY. The provider error is recorded
    // (never swallowed), the close settles with nothing owed, and sleep still
    // ran its completion. A failure the log never names would fail the first
    // assertion; a stranded close would fail the owed one.
    expect(posts.length).toBeGreaterThanOrEqual(1);

    // The hard failure and then the recovery: the refused request is
    // retried and the turn settles on the answer instead of stranding an
    // owed close behind it.
    expect(posts.length).toBeGreaterThanOrEqual(2);

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)).toBe('echo:E1');
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

  // The consumer's contract is to stop at [DONE]: the turn completes on the
  // answer whether or not the producer closes behind it. Over both seams this
  // wedges instead (the turn never returns, facts never fire) — a real defect
  // in who owns stream end, kept red here with its evidence in the run logs.
  it('completes a turn on a producer-open stream', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('early-done-driver'));

    const out = await root.driveOnce({
      workspace: 'early-done-workspace',
      owner: 'early-done-owner',
      displayName: 'Early Done',
      model: 'openai-compat/probe-early-done',
      text: 'E1',
    });

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    // Red while the wedge holds: the turn never returns, so this asserts
    // the completed answer it should have ended on.
    expect(assistant.at(-1)).toBe('echo:early');
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

});
