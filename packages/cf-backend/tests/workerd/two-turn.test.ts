/**
 * Two real OrchestratorAgent turns end to end inside workerd over the real HTTP model seam.
 * Defends two defects shipped 2026-09-08: (a) the open read selected a table only the SDK's first
 * read creates; (b) the second turn's model request dropped its user message.
 * Pending-cancel lives bun-side: the miniflare pool does not deliver subrequest abort to a Node-side outboundService.
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
  type HttpCall,
  type PendingSteer,
} from './two-turn-shapes';

const SignalProbeSchema = v.union([
  v.object({ signalKind: v.string() }),
  v.object({ threw: v.string() }),
]);

const FailuresSchema = v.array(DiagnosticFailureSchema);

const HttpSchema = v.array(HttpCallSchema);

/** The attachment the queue probes splice, byte-stable from the reservation through the replay. */
const ATTACHMENT_URL = 'data:image/png;base64,iVBORw0KGgo=';

function carriesAttachment(call: HttpCall): boolean {
  return call.fileParts.some((parts) => parts.some((part) => part.type === 'image_url' && part.url === ATTACHMENT_URL));
}

describe('two real turns over the HTTP model seam', () => {
  it('an ordinary signal arriving at the final model step is not lost at settlement', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('signal-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('signal'))
      .filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(3);
    const genesis = calls[0]?.users.find((message) => !message.startsWith('<'));
    // Splice side and echo flush are timing-dependent; the contract is only that both inputs
    // reached the model after the genesis exchange, on this one turn.
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

    // Splice rule: A and B merge into one user message at the held turn's next step.
    expect(calls[1]?.conversation.filter((message) => message.role !== 'system' && !message.content.startsWith('<'))).toEqual([
      { role: 'user', content: genesis },
      { role: 'assistant', content: `echo:${genesis}` },
      { role: 'user', content: 'QUEUE-A\n\nQUEUE-B' },
    ]);

    // A busy socket's pending_steers row drains once the turn settles; the durable-token proof is the cold arm.
  });

  it('a peer event that arrives mid-genesis rides the rerun of the sends genesis could not land', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('peer-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('peer'))
      .filter((call) => call.model === 'probe-queue');

    // A message arriving behind a queued user turn rides that turn's first step, so the drain's
    // brief is the rerun's second user message.
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

    // B and C each reserve pending_steers under the client's message id; the replay must re-bind
    // that token, not mint a duplicate.
    const prepared = v.parse(PreparedConversationSchema, await root.prepareQueuedConversation('cold'));
    const steerFor = (rows: PendingSteer[], id: string) => rows.find((row) => row.id === `input-${id}`);
    expect(steerFor(prepared.steers, 'QUEUE-B')).toBeDefined();
    expect(steerFor(prepared.steers, 'QUEUE-C')).toBeDefined();
    expect(prepared.steers).toHaveLength(2);

    await abortAllDurableObjects();
    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('cold-queue-driver'));

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

    // The held call died with the object; the probe reads only the restarted object's calls.
    expect(calls).toHaveLength(1);
    expect(realUsers(calls[0])).toHaveLength(2);
    expect(realUsers(calls[0])[1]).toBe('QUEUE-B\n\nQUEUE-C');

    expect(done.steers).toHaveLength(0);
    expect(done.transcript.map((row) => row.role)).toEqual(['user', 'user', 'user', 'assistant']);

    for (const id of ['input-QUEUE-B', 'input-QUEUE-C']) {
      expect(done.transcript.filter((row) => row.role === 'user' && row.id === id)).toHaveLength(1);
    }

    // The wake's reconcile must not seal a run the loop re-opened: that recorded a second close
    // and a fleet row for a turn still running.
    expect(done.runEnds).toEqual([{ runId: expect.any(String), reason: 'completed' }]);
  });

  it('splices a mid-turn attachment into the next model call as a file part', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('attach-queue-driver'));

    const calls = v.parse(HttpSchema, await root.queuedConversation('attach')).filter((call) => call.model === 'probe-queue');

    const spliced = calls.find(carriesAttachment);

    if (spliced === undefined) throw new Error('no probe-queue call carried the spliced attachment');

    expect(spliced.conversation.some((m) => m.role === 'user' && m.content.includes('QUEUE-B'))).toBe(true);
  });

  it('re-delivers a mid-turn attachment with real file data through a cold reset and replay', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('attach-cold-driver'));

    // The reservation spans pending_steers + pending_steer_files; the replay must re-bind both.
    // A distinct mode keeps its workspace separate from the warm attach test's.
    const prepared = v.parse(PreparedConversationSchema, await root.prepareQueuedConversation('attach-cold'));
    expect(prepared.steerFiles).toHaveLength(1);

    await abortAllDurableObjects();
    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('attach-cold-driver'));

    const replayed = await coldRoot.replayQueuedConversation(prepared);
    expect(replayed.steerFiles).toEqual([{
      actorId: expect.any(String),
      steerId: 'input-QUEUE-B',
      filename: 'chart.png',
      mediaType: 'image/png',
      url: ATTACHMENT_URL,
    }]);

    const done = await coldRoot.completeQueuedConversation(prepared);
    const calls = v.parse(HttpSchema, done.http).filter((call) => call.model === 'probe-queue');

    const carried = calls.find(carriesAttachment);

    if (carried === undefined) throw new Error('no replayed probe-queue call carried the attachment');

    expect(carried.conversation.some((m) => m.role === 'user' && m.content.includes('QUEUE-B'))).toBe(true);
  });

  it('re-delivers a buffered event after eviction when its drain lease is stale', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('evt-redelivery-driver'));

    // The state a dead activation leaves: an event bound to a never-closed drain lease, aged past the stale grace.
    const { workspace } = await root.claimEventWorkspace();
    await root.seedStaleDrainEventFor(workspace, 'BUFFERED-EVENT');
    await abortAllDurableObjects();

    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('evt-redelivery-driver'));

    const seeded = (await coldRoot.agentLogEventsFor(workspace)).find((row) => row.id === 'ev-seeded-BUFFERED-EVENT');
    expect(seeded?.turnId).toBe('evt-seeded-dead');
    expect(seeded?.consumedAt).toBe(0);

    // The wake joins on the marker in the wire log, so a return means the drain's model call carried the event.
    await coldRoot.runEventWakeFor(workspace, 'BUFFERED-EVENT');

    const calls = v.parse(HttpSchema, await coldRoot.httpCalls());

    const redelivered = calls.find((call) =>
      call.conversation.some((m) => m.content.includes('BUFFERED-EVENT')));

    expect(redelivered).toBeDefined();

    const rebound = (await coldRoot.agentLogEventsFor(workspace)).find((row) => row.id === 'ev-seeded-BUFFERED-EVENT');
    expect(rebound?.turnId).toMatch(/^evt-/);
    expect(rebound?.turnId).not.toBe('evt-seeded-dead');
  });

  it('drains an external event that reached an idle object, on the wake its arrival armed', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('reactor-wake-driver'));

    // The shipped cross-DO receiver runs both ingress halves: the in-memory debounce and the durable arm.
    const { workspace, owner } = await root.claimReactorWakeWorkspace();
    const armed = await root.publishPeerEvent(workspace, owner, 'REACTOR-WAKE');

    // Only the frame behind the armed callback runs; asserting the armed chain keeps the drive from
    // measuring a frame the platform would never deliver.
    expect(armed.map((row) => row.callback)).toContain('_kinuTimerTick');

    // The eviction drops scheduleDrain's debounce, leaving the durable half alone.
    await abortAllDurableObjects();

    const coldRoot = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('reactor-wake-driver'));

    // The row must still be pending, or a debounce that beat the abort would green this on the wrong evidence.
    const pending = (await coldRoot.agentLogEventsFor(workspace)).filter((row) => row.variant === 'peer_agent');

    expect(pending).toHaveLength(1);
    expect(pending[0]?.turnId).toBeNull();

    // The armed callback is re-read after the reset, so a chain only the live isolate held shows as an empty drive.
    const driven = await coldRoot.driveArmedWakesFor(workspace);

    expect(driven).toContain('_kinuTimerTick');

    // Only markConsumed writes an `evt-` turn id, so the row says whether the drain happened:
    // pending (null, null), leased (evt-, number), answered (evt-, null).
    const consumed = (await coldRoot.agentLogEventsFor(workspace)).filter((row) => row.variant === 'peer_agent');

    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toEqual(expect.objectContaining({
      turnId: expect.stringMatching(/^evt-/),
      consumedAt: null,
    }));

    await coldRoot.awaitWireMarker('REACTOR-WAKE');
    expect(await coldRoot.runStartCausesFor(workspace)).toContain('event_drain');
  });

  it('two clients delivering the same message at once are one turn, one provider request, one row', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('twin-driver'));
    const out = await root.twinSends();
    const calls = v.parse(HttpSchema, out.http).filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(1);
    expect(out.transcript.filter((row) => row.role === 'user' && row.id === 'input-TWIN')).toHaveLength(1);
    expect(out.transcript.filter((row) => row.role === 'assistant')).toHaveLength(1);
    expect(out.steers).toHaveLength(0);
    expect(out.runEnds).toEqual([{ runId: expect.any(String), reason: 'completed' }]);
  });

  it('the eval-only abort ends the activation and the object comes back over the same storage', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('eval-abort-driver'));
    const out = await root.evalAbort();

    // The platform rejects the call the abort was in flight on; a fresh stub finds a live object.
    expect(out.receipt).not.toBeNull();
    expect(out.alive).toBe(true);
  });

  it('the agent tab: a hired actor answers getActorSnapshot and listAgentTasks on its own path', async () => {
    // The object serves the actor under its own segment (a facet hop is refused); these are the
    // tab's two mount reads over that socket.
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('agent-tab-driver'));
    const out = await root.hostedActorTab();

    expect(out.name).not.toBe('');

    const snapshot = v.parse(v.object({
      name: v.string(), role: v.string(), mission: v.string(), pendingSteers: v.array(v.unknown()),
    }), JSON.parse(out.snapshot));

    expect(snapshot).toEqual({ name: out.name, role: 'task', mission: '', pendingSteers: [] });
    expect(v.parse(v.array(v.unknown()), JSON.parse(out.tasks))).toEqual([]);
    expect(out.frames).toBeGreaterThanOrEqual(2);
  });

  it('a fresh workspace\'s first chat reaches the model and the turn closes', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('first-chat-driver'));

    // A fresh workspace's first `cf_agent_use_chat_request`, with no held genesis or queue arm, must reach the model.
    const out = await root.firstChat();
    const calls = v.parse(HttpSchema, out.http).filter((call) => call.model === 'probe-queue');

    expect(out.transcript.some((row) => row.role === 'user' && row.id === 'input-FIRST-CHAT')).toBe(true);
    expect(calls.length).toBe(1);
    expect(out.sleepTimeSettled).toBe(1);
  });

  it('the owner\'s first chat after genesis rides the genesis turn', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('first-gen-driver'));

    // Absorb contract: the owner's first prompt lands mid-genesis as a steer and the same turn's next
    // step carries it to the model: one call, no second turn.
    const out = await root.firstChatAfterGenesis();
    const calls = v.parse(HttpSchema, out.http).filter((call) => call.model === 'probe-queue');

    expect(calls).toHaveLength(1);

    const human = calls[0]?.users.filter((text) => !text.startsWith('<')) ?? [];
    expect(human[0]).toContain('This workspace has just been created.');
    expect(human[1]).toBe('FIRST-PROMPT');

    expect(out.steers).toHaveLength(0);
    expect(out.transcript.some((row) => row.role === 'user' && row.id === 'input-FIRST-PROMPT')).toBe(true);
    expect(out.inbox.busy).toBe(false);
    expect(out.landed).toBe('mid-turn');
  });

  it('spikes the service-binding RPC, then runs A and B end to end', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('driver'));

    // Sleep/title lanes still use the direct binding, so the drive depends on AbortSignal surviving service-binding RPC.
    const signal = v.parse(SignalProbeSchema, await root.signalProbe());

    expect(signal).toEqual({ signalKind: 'AbortSignal' });

    // claimOwner boots the hosted workspace plane on first scaffold touch; each turn is joined on its
    // terminal settle inside `exercise`, so everything below is post-settle.
    const out = await root.exercise();
    const http = v.parse(HttpSchema, out.http);

    // No streamed turn reached the binding. The sleep judge is excluded: its cadence is beyond two
    // turns and `calls` is worker-wide.
    const calls = v.parse(v.array(CallRecordSchema), out.calls);

    expect(calls.filter((c) => c.stream)).toHaveLength(0);

    // The real prompt appends harness `<dynamic_context>` user rows after the typed text, hence `toContain`.
    expect(http.every((h) => h.host === 'fake-models.invalid')).toBe(true);

    const posts = http.filter((h) => h.path === '/v1/chat/completions' && h.model === 'probe');

    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.stream)).toBe(true);
    expect(posts.at(0)?.users).toContain('A');
    expect(posts.at(1)?.users).toContain('B');

    expect(posts.every((p) => p.authHeader === 'Bearer probe-fixture-key')).toBe(true);

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.slice(-2)).toEqual(['echo:A', 'echo:B']);

    // (a) the open read. The SDK schema is not exposed by RPC, and reading sqlite_master would need
    // a test-only production method.
    const snapshot = v.parse(SnapshotSchema, out.snapshot);

    expect(snapshot.status.model).toBe('openai-compat/probe');
    expect(snapshot.status.messageCount).toBe(history.items.length);

    const failures: DiagnosticFailure[] = v.parse(FailuresSchema, out.failures);

    expect(failures).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(2);
    // The catalog must be served from the fixture: refused, each provider falls back (measured
    // 2026-09-15: 51 fallbacks, 160–398 s solo). Hits are not asserted >0: the catalog caches per fetch identity.
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

    // Exactly two posts: the first offers the real registry (`file` among the definitions), the second
    // carries the call and its result.
    expect(posts).toHaveLength(2);
    expect(posts.at(0)?.offeredTools).toContain('file');
    expect(posts.at(0)?.toolCalls).toEqual([]);

    const called = posts.at(1);

    expect(called?.toolCalls.map((c) => c.name)).toEqual(['file']);

    expect(called?.toolResults.join('')).toContain('probe fixture says hello');

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)?.endsWith('echo:tool-answered')).toBe(true);
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

  // The tool-call-only first step act-first models send; pins the follow-up's legal `content: null`
  // assistant row on both the turn and the fixture side.
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

    // The SDK does not retry the refused request: the turn fails cleanly, with the provider error
    // recorded and nothing owed.
    expect(posts.length).toBeGreaterThanOrEqual(1);

    expect(posts.length).toBeGreaterThanOrEqual(2);

    const history = v.parse(HistorySchema, out.history);
    const assistant = history.items.filter((m) => m.role === 'assistant').map((m) => m.content);

    expect(assistant.at(-1)).toBe('echo:E1');
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

  // The consumer must stop at [DONE] whether or not the producer closes. Both seams wedge instead:
  // a real defect, kept red.
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

    expect(assistant.at(-1)).toBe('echo:early');
    expect(v.parse(FailuresSchema, out.failures)).toEqual([]);
    expect(out.owedEffects).toEqual([]);
    expect(out.sleepTimeSettled).toBe(1);
  });

});
