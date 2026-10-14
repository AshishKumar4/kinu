/**
 * The admission seam through the production `onMessage` over the real loop.
 * Defends: the transport writes no row; the loop's turn start or drain writes it, and a refusal leaves nothing.
 */
import { describe, expect, test } from 'bun:test';
import type { Connection } from 'agents';
import * as v from 'valibot';
import type { LanguageModel } from 'ai';
import { AwaitedList, scriptedTurnModel } from '@kinu.run/test-utils';
import { fleetEnvForTest } from './helpers/analytics-plane';
import {
  makeEnv, orchestratorHarness, reactivateOrchestratorHarness, storedChat, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { RunEventRecorder } from '@kinu.run/core';
import { socketConnection } from './helpers/bindings';
import { wrapDatabase } from '@kinu.run/core/identity';

function scriptedAnswerResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  };
}

function scriptedAnswer(text: string): LanguageModel {
  return scriptedTurnModel({ doGenerate: () => scriptedAnswerResult(text) });
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

async function userRows(harness: ActorHarness<HarnessOrchestratorAgent>): Promise<string[]> {
  return (await storedChat(harness))
    .filter((message) => message.role === 'user')
    .map((message) => message.id);
}

describe('a chat request through the production gate', () => {
  test('an idle send leaves exactly one row, under the id the client rendered', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    const { wire, sent, frame } = connection(agent);
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    agent.harnessSupplyTurnModel(scriptedAnswer('hello back'));

    await gate(wire, chatRequest('req-idle', 'hello'));

    // The gate returns on admission; the request closes at turn-end, so wait for the done frame.
    await frame((frames) => doneFrames(frames).length > 0);

    expect((await userRows(harness))).toEqual(['input-req-idle']);
    expect(doneFrames(sent)).toEqual([{ id: 'req-idle' }]);
    // No submission ledger or input receipt table exists for the loop to write.
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
    new RunEventRecorder(wrapDatabase(dead.db).sql, workspaceMainActor(dead.db)).emit('run-dead-activation', {
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

    expect(new RunEventRecorder(wrapDatabase(dead.db).sql, workspaceMainActor(dead.db)).unterminatedRuns()).toEqual([]);
    expect(fleetRowKinds(agent)).not.toContain('turn');
  });

  // Staging, 2026-10-14 (titled-chat): the owner stopped a new chat's opening turn 113 ms after sending it and said
  // "Continue". The Stop reached the agent before the opening's words did, so the opening ran anyway, and Continue
  // steered it or was handed back ("was handed back before a turn took it"), never answered.
  test('a Stop right after a send stops that turn, and the next send is answered as a turn of its own', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    const { wire, sent, frame } = connection(agent);
    const asked: string[] = [];

    await agent.activateActor();
    const gate = agent.harnessChatGate();

    agent.harnessSupplyTurnModel(scriptedTurnModel({
      doGenerate: (options) => {
        const prompt = JSON.stringify(options.prompt);

        if (prompt.includes('Continue')) {
          asked.push('continue');

          return scriptedAnswerResult('CONTINUED');
        }

        asked.push('opening');

        // The opening turn waits until it is stopped.
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => { reject(options.abortSignal?.reason); });
        });
      },
    }));

    // As one tab sends them, in this order on one socket, each frame handed in as it arrives.
    const handled = [
      gate(wire, chatRequest('req-opening', 'Log every lamp tonight.')),
      gate(wire, JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'req-opening' })),
      gate(wire, chatRequest('req-continue', 'Continue')),
    ];

    await frame((frames) => doneFrames(frames).some((done) => done.id === 'req-continue'));
    await Promise.all(handled);

    expect(doneFrames(sent).find((done) => done.id === 'req-continue')).toEqual({ id: 'req-continue' });
    expect(asked).toEqual(['continue']);
    expect((await storedChat(harness)).filter((message) => message.role === 'assistant').map((message) => JSON.stringify(message.parts)).join(' ')).toContain('CONTINUED');
  });
});
