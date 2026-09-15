/**
 * The admission seam, through the real chat transport over the real loop.
 *
 * Main's ruling for this seam: the transport writes no row. The loop decides
 * where a message lands before anything of it is durable — a message that
 * opens a turn IS that turn's opening row, written by the loop when the turn
 * starts; a message spliced into a running turn is written by the drain that
 * lands it, with the stamps that say which step it took; a message the loop
 * refuses leaves nothing behind. A test that only calls `loop.send` cannot
 * tell the seam from the loop; every case here enters through the gate — the
 * production `onMessage` with the hook's own frame — and reads the durable
 * rows back.
 */
import { describe, expect, test } from 'bun:test';
import type { Connection } from 'agents';
import * as v from 'valibot';
import type { SessionMessage } from 'agents/experimental/memory/session';
import type { LanguageModel } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { fleetEnvForTest } from './helpers/analytics-plane';
import { makeEnv, orchestratorHarness, thinkTurns } from './helpers/actor-harness';

/** A turn the suite runs end to end answers one scripted line: no provider,
 *  no harness UserDO credential, so the admission is what the test measures
 *  rather than the platform behind it. */
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
}

function connection(agent: { broadcast: (message: string, exclude?: string[]) => void }): AdmissionSocket {
  const sent: string[] = [];
  const partial: Partial<Connection> = {};
  Object.assign(partial, {
    id: 'admission-conn', tags: [],
    send: (data: string) => { sent.push(data); },
    close: () => {},
  });
  // SAFETY: every member the frame gate touches is constructed above — the
  // platform contract for a hibernated connection carries its tags and its
  // wire and nothing else, so the checked members above exhaust what the code
  // under test can reach.
  const wire = partial as Connection;
  // The actor broadcasts over its connection set, which is empty in this
  // harness; route its fan-out to this socket too, so the test reads the
  // frames a connected tab would. The sender's own hook already holds the
  // chat-request it sent, so nothing here double-delivers.
  const fanout = agent.broadcast.bind(agent);

  // The mocked Agent base declares broadcast over the same (message,
  // exclude) pair the override below keeps, so rebinding it to fan out to
  // this socket preserves the checked signature while the test observes it.
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (message: string, exclude?: string[]) => {
      if (exclude === undefined || !exclude.includes('admission-conn')) sent.push(message);
      fanout(message, exclude);
    },
  });

  return { wire, sent };
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

function userRows(agent: { harnessTranscript: { history(): SessionMessage[] } }): string[] {
  return agent.harnessTranscript.history()
    .filter((message) => message.role === 'user')
    .map((message) => message.id);
}

describe('a chat request through the production gate', () => {
  test('an idle send leaves exactly one row, under the id the client rendered', async () => {
    const { agent } = orchestratorHarness();
    const { wire, sent } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    agent.harnessSupplyTurnModel(scriptedAnswer('hello back'));
    agent.harnessNameWorkspace('Titled');
    // The auto-title effect's suggest call would reach the harness's
    // recording UserDO and refuse; the suite pins admission, not the title.

    await gate(wire, chatRequest('req-idle', 'hello'));

    // The gate returns when the loop ADMITTED the send; the turn runs on the
    // pump behind it, and the request closes at the turn's own turn-end — so
    // the test waits for the client's own evidence, not a guessed tick.
    for (let round = 0; round < 200 && doneFrames(sent).length === 0; round++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    expect(userRows(agent)).toEqual(['input-req-idle']);
    expect(doneFrames(sent)).toEqual([{ id: 'req-idle' }]);
  });

  test('a mid-turn send that lands leaves exactly one row, stamped where it landed', async () => {
    const { agent } = orchestratorHarness();
    const { wire, sent } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();
    // Production opens a turn through prepare; driving the same entry point
    // gives the step the prepared snapshot it refuses without, and the inbox
    // reads busy off this open turn — so the splice below takes the mid-turn
    // arm exactly as a message typed while the agent works does. Nothing of
    // the live turn itself runs here: its text is the step's input below.
    await thinkTurns(agent).prepare({ messages: [{ role: 'user', content: 'the long job' }] });
    const [liveRow] = userRows(agent);

    // Admit the splice first, then drive the step it lands in: the drain
    // at the step boundary commits the row the assertions read back.
    await gate(wire, chatRequest('req-steer', 'check staging'));
    const stepped = await agent.harnessStepInto(0, [{ role: 'user', content: 'the long job' }]);
    const carried = stepped.flatMap((m) => m.role === 'user' && v.is(v.string(), m.content) ? [m.content] : []);
    expect(carried.some((content) => content.includes('check staging'))).toBe(true);
    expect(userRows(agent)).toEqual([liveRow, 'input-req-steer']);
    const appended = agent.harnessTranscript.history().find((m) => m.id === 'input-req-steer');
    expect(v.is(v.object({ metadata: v.object({ kinuSteer: v.literal(true) }) }), appended)).toBe(true);
    expect(JSON.parse(JSON.stringify(appended))).toMatchObject({ metadata: { kinuSteer: true, kinuSteerAtStep: 0 } });
    expect(doneFrames(sent)).toEqual([{ id: 'req-steer', landed: 'mid-turn' }]);
  });

  test('a replay of the same request while the steer is pending asks for no second turn', async () => {
    const { agent } = orchestratorHarness();
    const { wire, sent } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    // A turn the session opened but the loop never ran — the inbox reads
    // busy off it, so both sends take the mid-turn arm. The loop's own terms
    // for a message typed while the agent works, without spending a turn.
    await thinkTurns(agent).prepare({ messages: [{ role: 'user', content: 'the long job' }] });
    await gate(wire, chatRequest('req-steer', 'check staging'));
    await gate(wire, chatRequest('req-steer', 'check staging'));

    expect(doneFrames(sent)).toEqual([
      { id: 'req-steer', landed: 'mid-turn' },
      { id: 'req-steer' },
    ]);
    const bodies = agent.harnessEnqueued.map((turn) => turn.text);
    expect(bodies.filter((text) => text.includes('check staging'))).toHaveLength(0);
  });

  test('a second connection mid-turn is told what is resuming and reads the fresh transcript', async () => {
    const { agent } = orchestratorHarness();
    const { wire } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    // Production opens a turn through prepare; driving the same entry point
    // gives the step the prepared snapshot it refuses without, and the inbox
    // reads busy off this open turn. The LIVE text is the step's input; the
    // gold is what the SECOND socket sees while the turn is still running.
    await thinkTurns(agent).prepare({ messages: [{ role: 'user', content: 'the long job' }] });
    await gate(wire, chatRequest('req-live', 'the long job'));
    const [liveRow] = agent.harnessTranscript.history().filter((m) => m.role === 'user').map((m) => m.id);

    const second = connection(agent);
    await agent.onConnect(second.wire, { request: new Request('https://agent/connect') });
    const frames = second.sent.map((raw) => v.parse(v.looseObject({ type: v.string(), messages: v.optional(v.array(v.object({ id: v.string() }))) }), JSON.parse(raw)));

    // Resuming first — the tab replays the stream it is still owed — then
    // the transcript as it is NOW, the live turn's opening row included.
    expect(frames[0]?.type).toBe('cf_agent_stream_resuming');
    const seed = frames.find((frame) => frame.type === 'cf_agent_chat_messages');
    expect(seed?.messages?.map((m) => m.id)).toContain(liveRow);

    // And the close half of the same wiring: a resuming socket that goes
    // away releases the resume the handshake held for it.
    await agent.onClose(second.wire, 1000, 'gone', true);

    // And the close half of the same wiring: a resuming socket that goes
    // away releases the resume the handshake held for it.
    await agent.onClose(second.wire, 1000, 'gone', true);
  });

  test('a live turn records its fleet row at its own seal', async () => {
    const { agent } = orchestratorHarness(undefined, undefined, fleetEnvForTest(makeEnv()));
    await agent.activateActor();
    agent.harnessObserveFleetPlane();
    agent.harnessSupplyTurnModel(scriptedAnswer('hello back'));
    agent.harnessNameWorkspace('Titled');

    const gate = agent.harnessChatGate();
    const { wire } = connection(agent);
    await gate(wire, chatRequest('req-fleet', 'hello'));

    for (let round = 0; round < 200 && agent.harnessFleetTurnRows().length === 0; round++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }



    // The turn's own row, and only one of it — the positive half of the
    // gate below, so a future change that drops ALL rows reds here rather
    // than passing vacuously beside it. The sink's own install notice is the
    // harness's, not the turn's.
    const kinds = agent.harnessFleetTurnRows().flatMap((row) => {
      const parsed = v.safeParse(v.object({ blobs: v.array(v.string()) }), row);

      return parsed.success ? [parsed.output.blobs[0]] : [];
    });

    expect(kinds.filter((kind) => kind === 'turn')).toHaveLength(1);
  });



  test('a reconciled interrupted run records no fleet row', async () => {
    const { agent } = orchestratorHarness(undefined, undefined, fleetEnvForTest(makeEnv()));
    await agent.activateActor();

    // Exactly what a dead activation leaves: a run the loop opened and never
    // closed — openTurnRun's run_start with no run_end.
    agent.harnessOpenDanglingRun('run-dead-activation');
    agent.harnessObserveFleetPlane();

    // The wake reconcile seals what the dead activation left, and the seal is
    // not a turn the loop ran: no turn row for it. The sink's own install
    // notice is the harness's, not a turn's.
    await agent.harnessReconcileInterruptedRuns();

    const kinds = agent.harnessFleetTurnRows().flatMap((row) => {
      const parsed = v.safeParse(v.object({ blobs: v.array(v.string()) }), row);

      return parsed.success ? [parsed.output.blobs[0]] : [];
    });

    expect(kinds).not.toContain('turn');
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
    expect(userRows(agent)).toEqual([]);
  });
});
