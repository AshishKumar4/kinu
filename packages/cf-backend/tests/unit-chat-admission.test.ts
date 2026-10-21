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
  driveUntil, gatewayWorkspace, GATEWAY_CATALOG, makeEnv, orchestratorHarness, ownDatabase, reactivateOrchestratorHarness, storedChat,
  workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import type { Database } from 'bun:sqlite';
import { chatCompletion, GATEWAY_MODEL, requestOf, stubAiBinding } from './helpers/platform-gateway';
import { actorConnectionTag, RunEventRecorder, WORKSPACE_TITLE_SYSTEM_PROMPT, type SendMetadata } from '@kinu.run/core';
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

function connection(agent: { broadcast: (message: string, exclude?: string[]) => void }, tags: string[] = []): AdmissionSocket {
  const frames = new AwaitedList<string>();
  const sent = frames.items;

  const wire = socketConnection({
    id: 'admission-conn',
    tags,
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

function chatRequest(id: string, text: string, metadata?: SendMetadata): string {
  return JSON.stringify({
    type: 'cf_agent_use_chat_request', id,
    init: { method: 'POST', body: JSON.stringify({
      messages: [{ id: `input-${id}`, role: 'user', parts: [{ type: 'text', text }], ...(metadata !== undefined && { metadata }) }],
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

/** Whether an agent's own store holds `id`'s words: a send records them before it steers or queues them. */
function sentWords(database: Database, id: string): boolean {
  return database.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM pending_steers WHERE id = ?').get(id)?.n === 1;
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

  test("a send's tier and one-shot mark reach the turn it opens; the next send runs as the workspace sets", async () => {
    const deep = 'ai-gateway/workers-ai/@cf/harness/deep';
    const served: Array<{ readonly model: string; readonly asked: string }> = [];

    const harness = gatewayWorkspace(stubAiBinding((run) => {
      const { messages, tools } = requestOf(run);

      // A turn's own requests offer its tools; a title or a review offers none.
      const asked = messages.filter((message) => message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context')).at(-1);

      if (tools.length > 0) served.push({ model: v.parse(v.object({ model: v.string() }), run.query).model, asked: JSON.stringify(asked) });

      return chatCompletion(run, 'Noted.');
    }));

    /** A gateway spec's model as Workers AI names it on the wire. */
    const workersAiId = (spec: string): string => spec.slice(spec.indexOf('@'));

    /** The model the turn asked `text` ran on. */
    const servedFor = (text: string): string | undefined => served.find((request) => request.asked.includes(text))?.model;

    const { agent } = harness;
    const { wire, frame } = connection(agent);

    agent.harnessInstallCatalog({
      ...GATEWAY_CATALOG, tiers: { ...GATEWAY_CATALOG.tiers, default: { model: GATEWAY_MODEL }, deep: { model: deep } },
      availableModels: [GATEWAY_MODEL, deep],
    });
    await agent.activateActor();
    const gate = agent.harnessChatGate();

    // As `kinu run` sends against the cloud: one task on the deep tier, run as an independent task.
    await gate(wire, chatRequest('req-oneshot', 'Count the files.', { kinuTier: 'deep', kinuTurn: { oneShot: true } }));
    await frame((frames) => doneFrames(frames).some((done) => done.id === 'req-oneshot'));
    await gate(wire, chatRequest('req-next', 'And the folders?'));
    await frame((frames) => doneFrames(frames).some((done) => done.id === 'req-next'));

    const turns = (await storedChat(harness)).filter((message) => message.role === 'user').map((message) => message.metadata);

    expect({
      first: servedFor('Count the files.'),
      next: servedFor('And the folders?'),
      turns,
    }).toEqual({
      first: workersAiId(deep), next: workersAiId(GATEWAY_MODEL),
      turns: [expect.objectContaining({ oneShot: true, profile_tier: 'deep' }), expect.not.objectContaining({ oneShot: true })],
    });
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

  // The tab offers Send as soon as Stop is pressed (titled-chat, 1008-e): Continue reaches the agent while the turn the
  // Stop cut is still ending. It is owed to no turn being stopped, but runs as one of its own, after the brief.
  test('Continue sent while a stopped turn is still ending runs as a turn of its own, after the brief', async () => {
    const harness = orchestratorHarness();
    const { agent } = harness;
    const { wire, sent, frame } = connection(agent);
    const asked: string[] = [];
    const opened = Promise.withResolvers<void>();
    const unwound = Promise.withResolvers<void>();

    await agent.activateActor();
    const gate = agent.harnessChatGate();

    agent.harnessSupplyTurnModel(scriptedTurnModel({
      doGenerate: (options) => {
        const prompt = JSON.stringify(options.prompt);

        if (prompt.includes('Continue')) {
          asked.push(prompt.includes('Log every lamp tonight.') ? 'continue after the brief' : 'continue alone');

          return scriptedAnswerResult('CONTINUED');
        }

        asked.push('brief');
        opened.resolve();

        // The brief's turn holds at its model until it is stopped, and its call ends only once Continue reached the
        // agent: the stopped call is still out when the next words come, as over staging's network. Since ai 7.0.148 a
        // stopped stream ends at the abort, not when its call settles, so the turn may be settling by then rather than
        // streaming, and Continue is queued rather than steered; either way it runs as a turn of its own.
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => { unwound.promise.then(() => { reject(options.abortSignal?.reason); }, reject); });
        });
      },
    }));

    const opening = gate(wire, chatRequest('req-opening', 'Log every lamp tonight.'));

    await opened.promise;

    // As the tab sends them on Stop and at Send's return: one socket, in this order, none awaited.
    const handled = [
      gate(wire, JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'req-opening' })),
      gate(wire, JSON.stringify({ type: 'rpc', id: 'stop', method: 'cancelCurrentWork', args: [] })),
      gate(wire, chatRequest('req-continue', 'Continue')),
    ];

    await driveUntil(harness, "Continue's words never reached the agent", () => sentWords(ownDatabase(harness, workspaceMainActor(harness.db).actorId), 'input-req-continue') || asked.includes('continue after the brief'));
    unwound.resolve();

    await frame((frames) => doneFrames(frames).some((done) => done.id === 'req-continue'));
    await Promise.all([opening, ...handled]);

    expect(doneFrames(sent).find((done) => done.id === 'req-continue')).toEqual({ id: 'req-continue' });
    expect(asked).toEqual(['brief', 'continue after the brief']);
    expect((await storedChat(harness)).filter((message) => message.role === 'assistant').map((message) => JSON.stringify(message.parts)).join(' ')).toContain('CONTINUED');
  });

  // The same, in a new chat: an agent of its own, whose room calls into its isolate, as staging's titled-chat did.
  test("an agent's Continue sent while its stopped turn is still ending runs as a turn of its own, after the brief", async () => {
    const BRIEF = 'Log every lamp tonight.';
    const asked: string[] = [];
    const opened = Promise.withResolvers<void>();
    const unwound = Promise.withResolvers<void>();

    const gateway = stubAiBinding((run) => {
      const said = JSON.stringify(requestOf(run).messages);

      if (said.includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, JSON.stringify({ title: 'Lamp log' }));

      if (said.includes('Continue')) {
        asked.push(said.includes(BRIEF) ? 'continue after the brief' : 'continue alone');

        return chatCompletion(run, 'CONTINUED');
      }

      asked.push('brief');
      opened.resolve();

      // The brief's turn holds at its model until it is stopped, and its call ends only once Continue reached the agent,
      // as a steer of the stopped turn or as its own turn (the first test says why either).
      return new Promise<Response>((_resolve, reject) => {
        run.signal?.addEventListener('abort', () => { unwound.promise.then(() => { reject(run.signal?.reason); }, reject); });
      });
    });

    const workspace = gatewayWorkspace(gateway);

    await workspace.agent.setSoul('# Purpose\n\nKeep the lamp log.');
    const { subagent } = await workspace.agent.createSubagentAgent();
    const actorId = v.parse(v.string(), subagent.actorId);
    const { wire, sent, frame } = connection(workspace.agent, [actorConnectionTag(actorId)]);
    const gate = workspace.agent.harnessChatGate();
    const opening = gate(wire, chatRequest('req-opening', BRIEF));

    await opened.promise;

    // As the tab sends them on Stop and at Send's return: one socket, in this order, none awaited.
    const handled = [
      gate(wire, JSON.stringify({ type: 'cf_agent_chat_request_cancel', id: 'req-opening' })),
      gate(wire, JSON.stringify({ type: 'rpc', id: 'stop', method: 'cancelCurrentWork', args: [] })),
      gate(wire, chatRequest('req-continue', 'Continue')),
    ];

    await driveUntil(workspace, "Continue's words never reached the agent", () => sentWords(ownDatabase(workspace, actorId), 'input-req-continue') || asked.includes('continue after the brief'));
    unwound.resolve();
    await frame((frames) => doneFrames(frames).some((done) => done.id === 'req-continue'));
    await Promise.all([opening, ...handled]);

    expect(doneFrames(sent).find((done) => done.id === 'req-continue')).toEqual({ id: 'req-continue' });
    expect(asked).toEqual(['brief', 'continue after the brief']);
  });
});
