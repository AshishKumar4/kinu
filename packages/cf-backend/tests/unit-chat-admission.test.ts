/**
 * The admission seam through the production `onMessage` over the real loop.
 * Defends: the transport writes no row; the loop's turn start or drain writes it, and a refusal leaves nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { Connection } from 'agents';
import * as v from 'valibot';
import type { SessionMessage } from 'agents/experimental/memory/session';
import type { LanguageModel } from 'ai';
import { AwaitedList, scriptedTurnModel } from '@kinu.run/test-utils';
import { fleetEnvForTest } from './helpers/analytics-plane';
import { makeEnv, orchestratorHarness, reactivateOrchestratorHarness, chatSessionTurns } from './helpers/actor-harness';
import { socketConnection } from './helpers/bindings';

function scriptedAnswer(text: string): LanguageModel {
  return scriptedTurnModel({ doGenerate: () => ({
    content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });
}

interface AdmissionSocket {
  readonly wire: Connection;
  readonly sent: string[];
  readonly frame: (holds: (sent: readonly string[]) => boolean) => Promise<void>;
}

function connection(agent: { broadcast: (message: string, exclude?: string[]) => void }): AdmissionSocket {
  const frames = new AwaitedList<string>();
  const sent = frames.items;

  const wire = socketConnection({
    id: 'admission-conn',
    send: (data: string) => { frames.push(data); },
  });

  // The harness connection set is empty: route the actor's fan-out to this socket, as a connected tab reads it.
  const fanout = agent.broadcast.bind(agent);

  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes('admission-conn')) frames.push(message);
      fanout(message, exclude);
    },
  });

  return { wire, sent, frame: (holds) => frames.until(holds) };
}

/** The request is answered only when the words land, so a step driver waits for `queued` instead. */
function queuedOnWire(steerId: string): (frames: readonly string[]) => boolean {
  const queued = v.object({ type: v.literal('steer_status'), status: v.literal('queued'), steerId: v.literal(steerId) });

  return (frames) => frames.some((raw) => v.is(queued, JSON.parse(raw)));
}

function chatRequest(id: string, text: string): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }] }],
      trigger: 'submit-message',
    }) },
  });
}

function doneFrames(sent: readonly string[]): Array<{ id: string; error?: string; landed?: string }> {
  return sent.flatMap((raw) => {
    const parsed = v.safeParse(v.object({
      type: v.literal('cf_agent_use_chat_response'),
      id: v.string(), done: v.optional(v.boolean()), error: v.optional(v.boolean()),
      landed: v.optional(v.string()), body: v.optional(v.string()),
    }), JSON.parse(raw));

    if (!parsed.success || parsed.output.done !== true) return [];

    return [{ id: parsed.output.id, ...(parsed.output.error === true && { error: parsed.output.body }), ...(parsed.output.landed !== undefined && { landed: parsed.output.landed }) }];
  });
}

/** `turn` for the loop's own seal; anything else is the harness plane's notices. */
function fleetRowKinds(agent: { harnessFleetTurnRows(): object[] }): string[] {
  return agent.harnessFleetTurnRows().flatMap((row) => {
    const parsed = v.safeParse(v.object({ blobs: v.array(v.string()) }), row);

    return parsed.success ? [parsed.output.blobs[0]] : [];
  });
}

async function userRows(agent: { harnessTranscript: { history(): Promise<SessionMessage[]> } }): Promise<string[]> {
  return (await agent.harnessTranscript.history())
    .filter((message) => message.role === 'user')
    .map((message) => message.id);
}

describe('a chat request through the production gate', () => {
  test('an idle send leaves exactly one row, under the id the client rendered', async () => {
    const { agent, tableNames } = orchestratorHarness();
    const { wire, sent, frame } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    agent.harnessSupplyTurnModel(scriptedAnswer('hello back'));

    await gate(wire, chatRequest('req-idle', 'hello'));

    // The gate returns on admission; the request closes at turn-end, so wait for the done frame.
    await frame((frames) => doneFrames(frames).length > 0);

    expect((await userRows(agent))).toEqual(['input-req-idle']);
    expect(doneFrames(sent)).toEqual([{ id: 'req-idle' }]);
    // No submission ledger or input receipt table exists for the loop to write.
    expect(tableNames()).not.toContain('cf_think_submissions');
    expect(tableNames()).not.toContain('actor_turn_inputs');
  });

  test('a mid-turn send that lands leaves exactly one row, stamped where it landed', async () => {
    const { agent } = orchestratorHarness();
    const { wire, sent, frame } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();
    // Prepare opens the turn production-style, so the inbox reads busy and the splice takes the mid-turn arm.
    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'the long job' }] });
    const [liveRow] = (await userRows(agent));

    // The drain at the step boundary commits the row and answers the request, not the admission.
    const request = gate(wire, chatRequest('req-steer', 'check staging'));
    await frame(queuedOnWire('input-req-steer'));
    const stepped = await agent.harnessStepInto(0, [{ role: 'user', content: 'the long job' }]);
    await request;
    const carried = stepped.flatMap((m) => m.role === 'user' && v.is(v.string(), m.content) ? [m.content] : []);
    expect(carried.some((content) => content.includes('check staging'))).toBe(true);
    expect((await userRows(agent))).toEqual([liveRow, 'input-req-steer']);
    const appended = (await agent.harnessTranscript.history()).find((m) => m.id === 'input-req-steer');
    expect(v.is(v.object({ metadata: v.object({ kinuSteer: v.literal(true) }) }), appended)).toBe(true);
    expect(JSON.parse(JSON.stringify(appended))).toMatchObject({ metadata: { kinuSteer: true, kinuSteerAtStep: 0 } });
    expect(doneFrames(sent)).toEqual([{ id: 'req-steer', landed: 'mid-turn' }]);
  });

  test('a replay of the same request while the steer is pending asks for no second turn', async () => {
    const { agent } = orchestratorHarness();
    const { wire, sent, frame } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    // The replay finds the words held and is spent at once, asking for nothing.
    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'the long job' }] });
    const request = gate(wire, chatRequest('req-steer', 'check staging'));
    await frame(queuedOnWire('input-req-steer'));
    await gate(wire, chatRequest('req-steer', 'check staging'));

    expect(doneFrames(sent)).toEqual([{ id: 'req-steer' }]);
    const bodies = agent.harnessEnqueued.map((turn) => turn.text);
    expect(bodies.filter((text) => text.includes('check staging'))).toHaveLength(0);

    await agent.harnessStepInto(0, [{ role: 'user', content: 'the long job' }]);
    await request;
    expect(doneFrames(sent)).toEqual([{ id: 'req-steer' }, { id: 'req-steer', landed: 'mid-turn' }]);
  });

  test('a second connection mid-turn is told what is resuming and reads the fresh transcript', async () => {
    const { agent } = orchestratorHarness();
    const { wire, frame } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    // The request stays open, as one to a running turn is; the second socket is what is measured.
    await chatSessionTurns(agent).prepare({ messages: [{ role: 'user', content: 'the long job' }] });
    const request = gate(wire, chatRequest('req-live', 'the long job'));
    await frame(queuedOnWire('input-req-live'));
    const [liveRow] = (await agent.harnessTranscript.history()).filter((m) => m.role === 'user').map((m) => m.id);

    const second = connection(agent);
    await agent.onConnect(second.wire, { request: new Request('https://agent/connect') });
    const frames = second.sent.map((raw) => v.parse(v.looseObject({ type: v.string(), messages: v.optional(v.array(v.object({ id: v.string() }))) }), JSON.parse(raw)));

    // Resuming first, then the current transcript including the live turn's row.
    expect(frames[0]?.type).toBe('cf_agent_stream_resuming');
    const seed = frames.find((sentFrame) => sentFrame.type === 'cf_agent_chat_messages');
    expect(seed?.messages?.map((m) => m.id)).toContain(liveRow);

    // A resuming socket that closes releases the resume the handshake held.
    await agent.onClose(second.wire, 1000, 'gone', true);
    await agent.harnessStepInto(0, [{ role: 'user', content: 'the long job' }]);
    await request;
  });

  test('a live turn records its fleet row at its own seal', async () => {
    const { agent } = orchestratorHarness(undefined, undefined, fleetEnvForTest(makeEnv()));
    await agent.activateActor();
    agent.harnessOpenFleetWindow();
    agent.harnessSupplyTurnModel(scriptedAnswer('hello back'));

    const gate = agent.harnessChatGate();
    const { wire } = connection(agent);
    await gate(wire, chatRequest('req-fleet', 'hello'));
    await agent.harnessFleetRowWritten();

    // The positive half of the next test, so dropping all rows fails here instead of passing vacuously.
    expect(fleetRowKinds(agent).filter((kind) => kind === 'turn')).toHaveLength(1);
  });

  test('a reconciled interrupted run records no fleet row', async () => {
    const env = fleetEnvForTest(makeEnv());
    const dead = orchestratorHarness(undefined, undefined, env);
    await dead.agent.activateActor();

    // A run_start with no run_end from the dying activation; the reconcile on wake seals it.
    dead.agent.harnessEventRecorder.emit('run-dead-activation', {
      type: 'run_start', agentId: 'harness-actor', caused_by: 'chat',
      userMessage: 'the turn the last process died inside',
    });
    // Backdated a minute so predating the new activation's millisecond cutoff is a fact of the row.
    dead.db.run(
      'UPDATE run_events SET ts = ? WHERE run_id = ?',
      [new Date(Date.now() - 60_000).toISOString(), 'run-dead-activation'],
    );

    // The seal is not a turn the loop ran, so no turn row.
    const { agent } = await reactivateOrchestratorHarness(dead.db, undefined, { env });
    await agent.activateActor();
    agent.harnessOpenFleetWindow();
    await agent.terminalRetryPass();

    expect(agent.harnessEventRecorder.unterminatedRuns()).toEqual([]);
    expect(fleetRowKinds(agent)).not.toContain('turn');
  });

  test('a refused send closes the request with the refusal and leaves nothing', async () => {
    const { agent } = orchestratorHarness();
    const { wire, sent } = connection(agent);
    await agent.activateActor();
    agent.harnessRefuseDriving({ reason: 'unavailable', error: 'another session is driving this workspace' });

    await agent.harnessChatGate()(wire, chatRequest('req-no', 'hello'));

    const [done] = doneFrames(sent);
    expect(done?.id).toBe('req-no');
    expect(done?.error).toMatch(/another session is driving/);
    expect((await userRows(agent))).toEqual([]);
  });
});
