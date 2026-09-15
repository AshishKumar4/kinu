// The workspace's first turn.
//
// The owner's complaint (2026-08-16): "the initial prompt I give in the 'New
// workspace' dialog is not really an initial prompt but rather the agent's
// mission, which is fine, but then the user needs to reprompt it again to get it
// going… the agent should have the first turn."
//
// So creation delivers ONE signal through the existing seam, and that signal
// becomes a programmatic turn. These tests drive the real path — real
// workspaceGenesisSignal, real Inbox, real BackendHost.enqueueTurn, the real
// loop's admission and its slot-time yield — and park the turn at its model
// call, the one boundary a suite scripts.
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { SIGNAL_ID_METADATA_KEY, WORKSPACE_CREATED_EVENT, renderSoulMarkdown, summarizeSoul } from '@kinu.run/core';
import type { ModelMessage } from 'ai';
import { orchestratorHarness, thinkTurns, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const MISSION = 'Audit the OAuth callback flow and report what an attacker could reach.';

const PLACEHOLDER_MISSION = summarizeSoul(renderSoulMarkdown({ name: 'probe' }));

const TurnProvenanceSchema = v.looseObject({
  kinuEvent: v.optional(v.string()),
  [SIGNAL_ID_METADATA_KEY]: v.optional(v.string()),
});

/** The turns the loop ran, as their durable user rows read: the text the turn
 *  was opened for and the provenance its metadata carries. */
function turnsRun(agent: HarnessOrchestratorAgent): Array<{ text: string; provenance: v.InferOutput<typeof TurnProvenanceSchema> }> {
  return agent.harnessTranscript.history()
    .filter((message) => message.role === 'user')
    .map((message) => ({
      text: message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''),
      provenance: v.parse(TurnProvenanceSchema, v.parse(v.looseObject({ metadata: v.optional(v.unknown()) }), message).metadata ?? {}),
    }));
}

/** The user lines of a parked request — what the model was handed — as text. */
function requestText(prompt: readonly ModelMessage[]): string {
  return prompt
    .filter((message) => message.role === 'user')
    .map((message) => v.is(v.string(), message.content) ? message.content : message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''))
    .join('\n');
}

/** The activity ledger's rows for this actor — the durable half of the
 *  `genesis.yielded_to_message` record, beside the diagnostics event. */
function activityEvents(db: Database): string[] {
  return db.prepare<{ event: string }, []>(
    'SELECT event FROM activity_log ORDER BY created_at, rowid',
  ).all().map((row) => row.event);
}

/** Seed the identity row creation writes, carrying the mission `setSoul` would
 *  have refreshed onto it. `workspace_identity` has no primary key and `onStart`
 *  seeds a row of its own after its first await, so this replaces rather than
 *  updates: exactly one row, whichever order the two land in. */
function seedMission(db: Database, mission: string): void {
  db.prepare('DELETE FROM workspace_identity').run();
  db.prepare(
    `INSERT INTO workspace_identity (id, name, owner_user_id, mission)
     VALUES ('harness-actor', 'harness-actor', 'harness-owner', ?)`,
  ).run(mission);
}

describe('the workspace takes its own first turn', () => {
  test('a mission becomes a queued agent turn with no user input', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = thinkTurns(harness.agent);
    const next = turns.park();

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    const request = await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    const ran = turnsRun(harness.agent);
    expect(ran).toHaveLength(1);
    const turn = ran[0]!;
    expect(turn.provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(turn.provenance[SIGNAL_ID_METADATA_KEY]).toMatch(/^sig-/);
    expect(turn.text).toContain('first turn');
    expect(requestText(request.prompt)).toContain('first turn');
    harness.db.close();
  });

  test('the mission is not quoted into the turn — it is already the system prompt', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = thinkTurns(harness.agent);
    const next = turns.park();

    await harness.agent.beginGenesisTurn();
    const request = await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    expect(turnsRun(harness.agent)[0]!.text).not.toContain('OAuth');
    expect(turnsRun(harness.agent)[0]!.text).not.toContain(MISSION);
    expect(requestText(request.prompt)).not.toContain(MISSION);
    harness.db.close();
  });

  test('a workspace created without a mission gets no turn to take', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, PLACEHOLDER_MISSION);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: false });
    expect(turnsRun(harness.agent)).toEqual([]);
    harness.db.close();
  });

  test('creation does not wait for the turn it started', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = thinkTurns(harness.agent);
    const next = turns.park();

    // Answered while the turn it started is still parked at its model call.
    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    expect(harness.agent.harnessChatLoop.turnInFlight()).toBe(true);
    await next;
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

    // The operator's message reaches the loop before the offer does, as a
    // send the transport hands the idle loop: it IS the first turn, opened
    // and parked at its model call, its row durable before the offer arrives.
    const turns = thinkTurns(harness.agent);
    const request = await turns.prepare({ messages: [{ role: 'user', content: 'Summarize the incident timeline first.' }] });
    expect(requestText(request.prompt)).toContain('Summarize the incident timeline first.');
    expect(requestText(request.prompt)).not.toContain('first turn');

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await turns.settle({ messageId: 'a-first', text: 'ok' });
    await harness.agent.harnessChatLoop.pumpPromise;
    await cardWithdrawn;

    // The offer yielded at its slot: nothing of it ran, and the ledger says
    // why. The operator's message is the one turn that ran.
    expect(turnsRun(harness.agent).map((turn) => turn.provenance.kinuEvent)).toEqual([undefined]);
    expect(turnsRun(harness.agent).map((turn) => turn.text)).toEqual(['Summarize the incident timeline first.']);
    expect(activityEvents(harness.db)).toContain('genesis.yielded_to_message');
    harness.db.close();
  });

  test('a workspace with nobody speaking runs the offer as its first turn', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = thinkTurns(harness.agent);
    const next = turns.park();

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await next;
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });

    const ran = turnsRun(harness.agent);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.text).toContain('first turn');
    expect(ran[0]!.provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(activityEvents(harness.db)).not.toContain('genesis.yielded_to_message');
    harness.db.close();
  });

  test('a message admitted after the genesis slot opened is the next turn', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = thinkTurns(harness.agent);
    const genesis = turns.park();

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    expect(requestText((await genesis).prompt)).toContain('first turn');

    // Late, while the offer's turn holds the slot: a steer the model never
    // sees, which the settle reruns as the operator's own next turn — on the
    // same scripted model, answered as the offer was.
    const late = harness.agent.harnessChatLoop.send('Late but admitted.');
    await turns.settle({ messageId: 'a-genesis', text: 'ok' });
    expect(await late).toBe('mid-turn');

    expect(activityEvents(harness.db)).not.toContain('genesis.yielded_to_message');
    const ran = turnsRun(harness.agent);
    expect(ran).toHaveLength(2);
    expect(ran[0]!.provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(ran[1]!.text).toBe('Late but admitted.');
    expect(harness.agent.harnessTranscript.history().filter((message) => message.role === 'assistant')).toHaveLength(2);
    harness.db.close();
  });
});
