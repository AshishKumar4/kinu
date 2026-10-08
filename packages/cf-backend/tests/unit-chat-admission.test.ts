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
import { sqlOver } from '@kinu.run/test-utils';
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
    const { agent, tableNames } = harness;
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
    expect(tableNames()).not.toContain('cf_think_submissions');
    expect(tableNames()).not.toContain('actor_turn_inputs');
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
    new RunEventRecorder(sqlOver(dead.db), workspaceMainActor(dead.db)).emit('run-dead-activation', {
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

    expect(new RunEventRecorder(sqlOver(dead.db), workspaceMainActor(dead.db)).unterminatedRuns()).toEqual([]);
    expect(fleetRowKinds(agent)).not.toContain('turn');
  });

});
