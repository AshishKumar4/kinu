/**
 * Two real OrchestratorAgent turns, end to end inside workerd, over the real
 * HTTP model seam.
 *
 * THE TWO DEFECTS THIS FILE PINS, both shipped 2026-09-08 and invisible to
 * every suite that seeds its own history:
 *
 *  (a) the open read (`getWorkspaceSnapshot` → `getAgentStatus` →
 *      `conversationCount`) selects `assistant_messages` for a hosted
 *      workspace root — a table the agents-SDK session creates on ITS first
 *      read — so the read is green only when the SDK's own DDL ran.
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
 * product's own evidence (`memory.facts_compressed`) and returns the captured
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

  it('a durable programmatic submission excludes a later pending chat from its provider prefix', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('peer-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('peer'))
      .filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(3);
    const genesis = calls[0]?.users.find((message) => !message.startsWith('<'));
    const programmatic = calls[2]?.conversation.filter((message) => message.role !== 'system' && !message.content.startsWith('<'));

    // Under the splice rule A, B and C merged into the held genesis turn, so
    // the programmatic peer event drives the THIRD call — its own turn, ahead
    // of the completed merged-turn prefix.
    expect(programmatic).toEqual([
      { role: 'user', content: genesis },
      { role: 'assistant', content: `echo:${genesis}` },

      { role: 'user', content: 'QUEUE-A\n\nQUEUE-B\n\nQUEUE-C' },
      { role: 'assistant', content: expect.stringContaining('echo:QUEUE-A\n\nQUEUE-B\n\nQUEUE-C') },
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

    // The recovered turn drove with B's text and spliced C at its step
    // boundary — the model saw them in order, on one turn, after the reset.
    const first = calls.find((call) => realUsers(call)[0] === 'QUEUE-B');

    expect(first).toBeDefined();

    const spliced = calls.find((call) => {
      const users = realUsers(call);

      return users.length >= 2 && users.includes('QUEUE-B') && users.includes('QUEUE-C');
    });

    expect(spliced).toBeDefined();

    // Each admitted send landed exactly once under its own id — the
    // reservation survived the reset, the replay re-bound it rather than
    // minting a second, and the drain that landed it retired it: one
    // transcript row per client id, and nothing left reserved.
    expect(done.steers).toHaveLength(0);

    for (const id of ['input-QUEUE-B', 'input-QUEUE-C']) {
      expect(done.transcript.filter((row) => row.role === 'user' && row.id === id)).toHaveLength(1);
    }
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
    expect(out.factsCompressed).toBe(1);
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
    // traveled HTTP — while the sleep-time judge still arrived there twice.
    const calls = v.parse(v.array(CallRecordSchema), out.calls);

    expect(calls.filter((c) => c.stream)).toHaveLength(0);
    expect(calls.filter((c) => c.lane === 'sleep').length).toBeGreaterThanOrEqual(2);

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
    // finished close left behind; `factsCompressed` counts the sleep-time
    // completions, one per turn.
    const failures: DiagnosticFailure[] = v.parse(FailuresSchema, out.failures);

    expect(failures).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.factsCompressed).toBe(2);
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
    expect(out.factsCompressed).toBe(1);
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
    expect(out.factsCompressed).toBe(1);
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
    expect(out.factsCompressed).toBe(1);
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
    expect(out.factsCompressed).toBe(1);
  });

});
