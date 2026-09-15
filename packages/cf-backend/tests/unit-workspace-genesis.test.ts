// The workspace's first turn.
//
// The owner's complaint (2026-08-16): "the initial prompt I give in the 'New
// workspace' dialog is not really an initial prompt but rather the agent's
// mission, which is fine, but then the user needs to reprompt it again to get it
// going… the agent should have the first turn."
//
// So creation delivers ONE signal through the existing seam, and that signal
// becomes a programmatic turn. These tests drive the real path — real
// workspaceGenesisSignal, real Inbox, real BackendHost.enqueueTurn —
// and stub only Think's saveMessages, the platform boundary where a turn starts.
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { WORKSPACE_CREATED_EVENT, renderSoulMarkdown, summarizeSoul } from '@kinu.run/core';
import { Session } from 'agents/experimental/memory/session';
import type { UIMessage } from 'ai';
import { orchestratorHarness, thinkTurns, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const MISSION = 'Audit the OAuth callback flow and report what an attacker could reach.';

/** What the dialog leaves behind when it carried no mission: the renderer's own default, read back through the summarizer that derives a mission from soul markdown. The fixture tracks the default across rewordings. */
const PLACEHOLDER_MISSION = summarizeSoul(renderSoulMarkdown({ name: 'probe' }));

/** The provenance stamp `BackendHost.enqueueTurn` puts on a programmatic turn:
 *  the `kinuEvent` the prompt surface and the chat card both read, and the
 *  card id the delivery seam round-trips. */
interface TurnProvenance {
  readonly kinuEvent?: string;
  readonly signalId?: string;
}

const TurnProvenanceSchema: v.GenericSchema<TurnProvenance> = v.object({
  kinuEvent: v.optional(v.string()),
  signalId: v.optional(v.string()),
});

interface RecordedTurn {
  readonly role: string;
  readonly text: string;
  readonly provenance: TurnProvenance;
  /** The transcript the turn's model request would have been built over —
   *  what `saveMessages`' callback receives as `current` once the slot opens. */
  readonly request: string;
}

/** One `UIMessage` as `enqueueTurn` builds it, narrowed to what a turn's input
 *  actually is. `metadata` is `unknown` because it crosses the platform seam and
 *  is parsed here, at that boundary. */
interface QueuedMessage {
  readonly role: string;
  readonly parts?: readonly { readonly text?: string }[];
  readonly metadata?: unknown;
}

/** The one RPC this file drives on a real orchestrator.
 *
 *  Named rather than `object` so the double cannot drift from the agent it
 *  stands in for: `beginGenesisTurn`'s signature is checked against the real
 *  class on every call below.
 *
 *  `saveMessages` is deliberately NOT here. It is REPLACED, never called, so it
 *  is not part of the contract this parameter needs — and restating Think's
 *  signature narrower than Think declares it (callback-only, `readonly` parts)
 *  is exactly what made a real `OrchestratorAgent` unassignable. The narrowing
 *  belongs on the value installed below, where it describes what `enqueueTurn`
 *  actually passes; if Think ever stops using the callback form, `messages()`
 *  throws and these tests fail loudly rather than silently stop observing. */
interface GenesisAgent {
  beginGenesisTurn(): Promise<{ started: boolean }>;
  /** The session Think boots over this workspace's transcript store. Optional
   *  here because an un-booted harness agent has none and reads as an empty
   *  history — the state a workspace is in before its first row is written. */
  session?: { getHistory(): Promise<readonly QueuedMessage[]> };
}

/** What the stubbed boundary exposes: the turns it recorded plus the two
 *  public moments of its lifecycle as deferreds — deterministic without any
 *  reach into the agent's private task bookkeeping. */
interface CapturedTurns {
  readonly turns: RecordedTurn[];
  /** The slot opened: the admission gate ran and the rows it would append are
   *  observed — recorded for a turn that ran, and resolved on the early
   *  `aborted` return so a withdrawn turn is observable too. */
  readonly opened: Promise<void>;
  /** The boundary answered: after `hold` for a running turn, at the aborted
   *  return for a withdrawn one. */
  readonly completed: Promise<void>;
}

/**
 * Take over Think's turn-start boundary and record what a turn would run on.
 *
 * The transcript a slot-time read sees is the DURABLE rows — `getHistory`
 * over the pane store — not the hydrated cache the bun harness never wires
 * (the vendor's `internal_onMessagesChanged` subscription lives in
 * `startThink`, which the harness's actor-only boot does not run). The
 * vendored runner's slot is emulated, not just the callback: the same two
 * `shouldApplyMessages` checks `_runProgrammaticMessagesTurn` runs — on entry
 * and again after the messages resolve — answer `aborted` with nothing
 * appended and no model call, which is how a `yieldsToUserMessage` turn
 * withdraws. `hold` keeps the recorded slot open for the turn's duration, the
 * window a late message lands in.
 */
function captureTurns(agent: GenesisAgent, hold?: Promise<void>): CapturedTurns {
  const turns: RecordedTurn[] = [];
  const { promise: opened, resolve: openedResolve } = Promise.withResolvers<void>();
  const { promise: completed, resolve: completedResolve } = Promise.withResolvers<void>();

  Object.defineProperty(agent, 'saveMessages', {
    configurable: true,
    value: async (
      messages: (current: readonly QueuedMessage[]) => readonly QueuedMessage[],
      options?: { shouldApplyMessages?: () => boolean },
    ) => {
      // The vendored runner's slot is emulated: `shouldApplyMessages` runs on
      // entry and again after the messages resolve. `opened` resolves only
      // after that check has executed — on the aborted path the gate has
      // already observed the durable rows it read (and written the activity
      // row) by the time it returns false, so ordering is meaningful.
      if (options?.shouldApplyMessages && !(await options.shouldApplyMessages())) {
        openedResolve();
        completedResolve();

        return { status: 'aborted' };
      }

      const current = await agent.session?.getHistory() ?? [];

      const request = current
        .flatMap((m) => (m.parts ?? []).map((part) => part.text ?? ''))
        .join('\n');

      const appended = messages(current);

      if (options?.shouldApplyMessages && !(await options.shouldApplyMessages())) {
        openedResolve();
        completedResolve();

        return { status: 'aborted' };
      }

      for (const message of appended) {
        turns.push({
          role: message.role,
          text: (message.parts ?? []).map((part) => part.text ?? '').join(''),
          provenance: v.parse(TurnProvenanceSchema, message.metadata ?? {}),
          request,
        });
      }

      openedResolve();

      if (hold) await hold;
      completedResolve();

      return { status: 'completed' };
    },
  });

  return { turns, opened, completed };
}

/** What Think's `startThink` does before the actor's `onStart`: create the
 *  session over the DO's storage, which is also the DDL run that creates the
 *  pane store the admission check reads. */
async function bootThinkSession(agent: HarnessOrchestratorAgent): Promise<void> {
  agent.session = Session.create(agent);
  await agent.session.getLatestLeaf();
}

/** A first message from the operator, durable the way the chat request leaves
 *  it: persisted BEFORE its own turn queues, which is exactly the admission
 *  order the offered turn's slot reads. */
async function admitOperatorMessage(agent: HarnessOrchestratorAgent, text: string): Promise<void> {
  await agent.addMessages([
    { id: `user-${crypto.randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] } satisfies UIMessage,
  ]);
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
    const { turns, completed } = captureTurns(harness.agent);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    // The delivery fiber is detached: the boundary's own answer is the
    // completion to await, not the agent's private task list.
    await completed;

    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    // A turn the backend enqueued. The provenance is what stops the chat from
    // rendering it as words the owner typed.
    expect(turn.role).toBe('user');
    expect(turn.provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(turn.provenance.signalId).toMatch(/^sig-/);
    expect(turn.text).toContain('first turn');
    harness.db.close();
  });

  test('the mission is not quoted into the turn — it is already the system prompt', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const { turns, completed } = captureTurns(harness.agent);

    await harness.agent.beginGenesisTurn();
    await completed;

    // SOUL.md is the opening bytes of the system prompt (prompt.ts
    // readSoulForPrompt ← soulOverride ← getSoulText). Repeating the mission in
    // the turn would both duplicate it and stage a standing identity as
    // something the owner said in the chat.
    expect(turns[0]!.text).not.toContain('OAuth');
    expect(turns[0]!.text).not.toContain(MISSION);
    harness.db.close();
  });

  test('a workspace created without a mission gets no turn to take', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, PLACEHOLDER_MISSION);
    const { turns } = captureTurns(harness.agent);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: false });

    expect(turns).toEqual([]);
    harness.db.close();
  });

  test('creation does not wait for the turn it started', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    let turnStarted = false;
    let endTurn = () => {};

    const turnRunning = new Promise<void>((resolve) => { endTurn = resolve; });
    Object.defineProperty(harness.agent, 'saveMessages', {
      configurable: true,
      // Think's saveMessages resolves when the TURN ENDS, which is minutes. If
      // beginGenesisTurn awaited it, POST /workspaces would hold the New
      // workspace dialog open for the whole turn — so this resolves only when
      // the test says so, and beginGenesisTurn must still answer.
      value: async () => {
        turnStarted = true;
        await turnRunning;

        return { status: 'completed' };
      },
    });

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    expect(turnStarted).toBe(true);

    endTurn();
    harness.db.close();
  });

  test('a message admitted before the genesis slot opens IS the first turn', async () => {
    // The first-run defect (deployed 4f4c0af36): the workspace's own turn and
    // the person's first message reached the model in ONE request, and the
    // reply answered the genesis text instead of the person. A genesis turn is
    // a move OFFERED — somebody already speaking withdraws it, inside the slot
    // and never before it.
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    await bootThinkSession(harness.agent);
    const { turns, completed } = captureTurns(harness.agent);

    // The card's withdrawal is the PUBLIC terminal event of a yielded offer —
    // the same `signal_card` broadcast the chat consumes, and it is emitted
    // after the ledger row, so awaiting it settles the whole yield before the
    // database closes.
    const { promise: cardWithdrawn, resolve: cardGone } = Promise.withResolvers<void>();
    Reflect.set(harness.agent, 'broadcast', (payload: string) => {
      const parsed = v.safeParse(
        v.object({ type: v.literal('signal_card'), state: v.string() }),
        JSON.parse(payload),
      );

      if (parsed.success && parsed.output.state === 'undelivered') cardGone();
    });

    // Durable before the offer was even taken — the order the ws-chat path
    // leaves admission in (persist first, queue second).
    await admitOperatorMessage(harness.agent, 'Summarize the incident timeline first.');
    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });

    // The offer was withdrawn inside its slot: nothing appended, no model call.
    await completed;
    await cardWithdrawn;
    expect(turns).toEqual([]);
    expect(activityEvents(harness.db)).toContain('genesis.yielded_to_message');

    // The admitted message's own queued turn is the first turn, and its model
    // request carries the message and no genesis text.
    await thinkTurns(harness.agent).runQueuedMessage();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('Summarize the incident timeline first.');
    expect(turns[0]!.request).toContain('Summarize the incident timeline first.');
    expect(turns[0]!.request).not.toContain('first turn');
    harness.db.close();
  });

  test('a workspace with nobody speaking runs the offer as its first turn', async () => {
    // The yield is conditional, not the new shape of genesis: no admitted
    // operator row, and the workspace takes its own first turn exactly as
    // before — `snapshot-after-turn` and the genesis card depend on it.
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    await bootThinkSession(harness.agent);
    const { turns, completed } = captureTurns(harness.agent);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    await completed;

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain('first turn');
    expect(turns[0]!.provenance.kinuEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(activityEvents(harness.db)).not.toContain('genesis.yielded_to_message');
    harness.db.close();
  });

  test('a message admitted after the genesis slot opened is the next turn', async () => {
    // The check lives inside the slot. A message that lands while the genesis
    // turn is RUNNING waits for its own turn, exactly as it always has.
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    await bootThinkSession(harness.agent);

    const { promise: genesisRunning, resolve: releaseGenesis } = Promise.withResolvers<void>();
    const { turns, opened, completed } = captureTurns(harness.agent, genesisRunning);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });

    // `opened` resolves once the admission check has run and the turn's rows
    // are recorded — proof the offer took its slot, so "admitted after the
    // start" is true rather than a guess at microtask depth.
    await opened;

    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain('first turn');

    await admitOperatorMessage(harness.agent, 'Late but admitted.');
    releaseGenesis();
    await completed;

    expect(activityEvents(harness.db)).not.toContain('genesis.yielded_to_message');

    // Its own turn runs next, as the ordinary second turn.
    await thinkTurns(harness.agent).runQueuedMessage();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.text).toBe('Late but admitted.');
    harness.db.close();
  });
});
