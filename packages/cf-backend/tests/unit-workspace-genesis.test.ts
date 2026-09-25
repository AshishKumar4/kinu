// Defends the owner's complaint (2026-08-16): the creation prompt was only a mission and the agent
// never took the first turn. Creation delivers one signal that becomes a programmatic turn.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  RunEventRecorder, SIGNAL_ID_METADATA_KEY, TERMINAL_EFFECT_RETRY_CEILING_MS, WORKSPACE_CREATED_EVENT, renderSoulMarkdown, summarizeSoul,
} from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { MockLanguageModelV3 } from 'ai/test';
import { createTestUserDO, testOwner } from './helpers/user-do';
import type { ModelMessage } from 'ai';
import {
  orchestratorHarness, chatSessionTurns, seedMission, storedChat, workspaceMainActor, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';
import { joinHarnessFibers } from './helpers/agents-sdk';

const MISSION = 'Audit the OAuth callback flow and report what an attacker could reach.';

const PLACEHOLDER_MISSION = summarizeSoul(renderSoulMarkdown({ name: 'probe' }));

const TurnProvenanceSchema = v.looseObject({
  kinuEvent: v.optional(v.string()),
  [SIGNAL_ID_METADATA_KEY]: v.optional(v.string()),
});

/** The loop's turns as durable user rows: opening text and metadata provenance. */
async function turnsRun(
  harness: ActorHarness<HarnessOrchestratorAgent>,
): Promise<Array<{ text: string; provenance: v.InferOutput<typeof TurnProvenanceSchema> }>> {
  return (await storedChat(harness))
    .filter((message) => message.role === 'user')
    .map((message) => ({
      text: message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
      provenance: v.parse(TurnProvenanceSchema, v.parse(v.looseObject({ metadata: v.optional(v.unknown()) }), message).metadata ?? {}),
    }));
}

function requestText(prompt: readonly ModelMessage[]): string {
  return prompt
    .filter((message) => message.role === 'user')
    .map((message) => v.is(v.string(), message.content) ? message.content : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''))
    .join('\n');
}

/** Activity rows for this actor: the durable half of `genesis.yielded_to_message`. */
function activityEvents(db: Database): string[] {
  return db.prepare<{ event: string }, []>(
    'SELECT event FROM activity_log ORDER BY created_at, rowid',
  ).all().map((row) => row.event);
}

describe('the workspace takes its own first turn', () => {
  test('a mission becomes a queued agent turn with no user input', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    const request = await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    const ran = (await turnsRun(harness));
    expect(ran).toHaveLength(1);
    const turn = ran[0];
    expect(turn.provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(turn.provenance[SIGNAL_ID_METADATA_KEY]).toMatch(/^sig-/);
    expect(turn.text).toContain('first turn');
    expect(requestText(request.prompt)).toContain('first turn');
    harness.db.close();
  });

  test('the mission is not quoted into the turn — it is already the system prompt', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();

    await harness.agent.beginGenesisTurn();
    const request = await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    expect((await turnsRun(harness))[0].text).not.toContain('OAuth');
    expect((await turnsRun(harness))[0].text).not.toContain(MISSION);
    expect(requestText(request.prompt)).not.toContain(MISSION);
    harness.db.close();
  });

  test('a workspace created without a mission gets no turn to take', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, PLACEHOLDER_MISSION);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: false });
    expect((await turnsRun(harness))).toEqual([]);
    harness.db.close();
  });

  test('creation does not wait for the turn it started', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();

    // Answered while the turn it started is still parked at its model call.
    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await next;
    expect(new RunEventRecorder(sqlOver(harness.db), workspaceMainActor(harness.db)).unterminatedRuns()).toHaveLength(1);
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });
    harness.db.close();
  });

  test('a message admitted before the genesis slot opens IS the first turn', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const { promise: cardWithdrawn, resolve: cardGone } = Promise.withResolvers<void>();

    Reflect.set(harness.agent, 'broadcast', (payload: string) => {
      const parsed = v.safeParse(
        v.object({ type: v.literal('signal_card'), state: v.string() }),
        JSON.parse(payload),
      );

      if (parsed.success && parsed.output.state === 'undelivered') cardGone();
    });

    // The operator's message is the first turn, durable before the offer arrives.
    const turns = chatSessionTurns(harness.agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'Summarize the incident timeline first.' }] });
    expect(requestText(request.prompt)).toContain('Summarize the incident timeline first.');
    expect(requestText(request.prompt)).not.toContain('first turn');

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await turns.settle({ messageId: 'a-first', text: 'ok' });
    await cardWithdrawn;

    // The offer yielded at its slot and the ledger records why.
    expect((await turnsRun(harness)).map((turn) => turn.provenance.kinuEvent)).toEqual([undefined]);
    expect((await turnsRun(harness)).map((turn) => turn.text)).toEqual(['Summarize the incident timeline first.']);
    expect(activityEvents(harness.db)).toContain('genesis.yielded_to_message');
    harness.db.close();
  });

  test('a workspace with nobody speaking runs the offer as its first turn', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    const ran = (await turnsRun(harness));
    expect(ran).toHaveLength(1);
    expect(ran[0].text).toContain('first turn');
    expect(ran[0].provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(activityEvents(harness.db)).not.toContain('genesis.yielded_to_message');
    harness.db.close();
  });

  test('a message admitted after the genesis slot opened is the next turn', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = chatSessionTurns(harness.agent);
    const genesis = turns.park();

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    expect(requestText((await genesis).prompt)).toContain('first turn');

    // A late message while the offer holds the slot reruns as the operator's own next turn.
    await harness.agent.send('Late but admitted.', 'm-late');
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    expect(activityEvents(harness.db)).not.toContain('genesis.yielded_to_message');
    const ran = (await turnsRun(harness));
    expect(ran).toHaveLength(2);
    expect(ran[0].provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(ran[1].text).toBe('Late but admitted.');
    expect((await storedChat(harness)).filter((message) => message.role === 'assistant')).toHaveLength(2);
    harness.db.close();
  });
});

/** #18: only the genesis turn's `auto_title` row may replace the 'auto' stand-in, across ledger retries. */
describe('the genesis turn names the workspace over its stand-in', () => {
  afterEach(() => { setSystemTime(); });

  const STAND_IN = 'Audit the OAuth callback flow';

  const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };

  async function createdWorkspace(nameOrigin: 'auto' | 'user') {
    const user = createTestUserDO();
    const owner = await testOwner();
    const workspace = 'quiet-maple-a1b2c3d4';
    await user.userDO.registerWorkspace(owner, workspace, STAND_IN, { purpose: MISSION, nameOrigin });
    await user.userDO.ensureWorkspaceCapability(workspace, null);
    const capability = user.installed.get(workspace);

    if (capability === undefined) throw new Error('the workspace has no capability');
    const harness = orchestratorHarness(undefined, { userDO: user.userDO, workspace, ownerUserId: '0123456789abcdef0123456789abcdef' });
    await harness.agent.installWorkspaceCapability(capability);
    await harness.agent.setSoul(renderSoulMarkdown({ name: STAND_IN, mission: MISSION }));
    const namingCalls: string[] = [];

    harness.agent.sideModelFactory = () => new MockLanguageModelV3({
      doGenerate: async () => {
        namingCalls.push('naming');

        if (namingCalls.length === 1) throw new Error('the naming model is unavailable');

        return {
          content: [{ type: 'text', text: '{"title":"OAuth Callback Audit"}' }],
          finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [],
        };
      },
    });

    return { user, owner, workspace, harness, namingCalls };
  }

  test('a failed naming call is retried by the ledger, and a later turn asks no model', async () => {
    const { user, owner, workspace, harness, namingCalls } = await createdWorkspace('auto');
    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();
    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });
    await joinHarnessFibers();

    expect(namingCalls).toHaveLength(1);
    expect(await user.userDO.getWorkspaceTitle(owner, workspace)).toEqual({ displayName: STAND_IN, nameOrigin: 'auto' });

    // The retry is due once its backoff has passed on the platform clock; the alarm's pass replays it.
    setSystemTime(new Date(Date.now() + TERMINAL_EFFECT_RETRY_CEILING_MS));
    await harness.agent.terminalRetryPass();
    expect(await user.userDO.getWorkspaceTitle(owner, workspace)).toEqual({ displayName: 'OAuth Callback Audit', nameOrigin: 'auto' });

    await turns.run('What did you find?');
    await joinHarnessFibers();
    expect(namingCalls).toHaveLength(2);
    expect(await user.userDO.getWorkspaceTitle(owner, workspace)).toEqual({ displayName: 'OAuth Callback Audit', nameOrigin: 'auto' });
    harness.db.close();
    user.close();
  });

  test('a title the owner chose is never replaced by the genesis naming', async () => {
    const { user, owner, workspace, harness, namingCalls } = await createdWorkspace('user');
    const turns = chatSessionTurns(harness.agent);
    const next = turns.park();
    await harness.agent.beginGenesisTurn();
    await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });
    await joinHarnessFibers();

    expect(namingCalls).toEqual([]);
    expect(await user.userDO.getWorkspaceTitle(owner, workspace)).toEqual({ displayName: STAND_IN, nameOrigin: 'user' });
    harness.db.close();
    user.close();
  });
});
