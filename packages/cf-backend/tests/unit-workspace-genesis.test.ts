// The workspace's first turn.
//
// The owner's complaint (2026-08-16): "the initial prompt I give in the 'New
// workspace' dialog is not really an initial prompt but rather the agent's
// mission, which is fine, but then the user needs to reprompt it again to get it
// going… the agent should have the first turn."
//
// So creation delivers ONE signal through the existing seam, and that signal
// becomes a programmatic turn. These tests drive the real path — real
// workspaceGenesisSignal, real SignalDelivery, real BackendHost.enqueueTurn —
// and stub only Think's saveMessages, the platform boundary where a turn starts.
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { WORKSPACE_CREATED_EVENT } from '@kinu/core';
import { orchestratorHarness } from './helpers/actor-harness';

const MISSION = 'Audit the OAuth callback flow and report what an attacker could reach.';
/** What renderSoulMarkdown writes when the dialog carried no mission. */
const PLACEHOLDER_MISSION = 'Help the user with the work they assign.';

/** The provenance stamp `BackendHost.enqueueTurn` puts on a programmatic turn:
 *  the `proteusEvent` the prompt surface and the chat card both read, and the
 *  card id the delivery seam round-trips. */
interface TurnProvenance {
  readonly proteusEvent?: string;
  readonly signalId?: string;
}

const TurnProvenanceSchema: v.GenericSchema<TurnProvenance> = v.object({
  proteusEvent: v.optional(v.string()),
  signalId: v.optional(v.string()),
});

interface RecordedTurn {
  readonly role: string;
  readonly text: string;
  readonly provenance: TurnProvenance;
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
}

/** Take over Think's turn-start boundary and record what a turn would run on. */
function captureTurns(agent: GenesisAgent): RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  Object.defineProperty(agent, 'saveMessages', {
    configurable: true,
    value: async (messages: () => readonly QueuedMessage[]) => {
      for (const message of messages()) {
        turns.push({
          role: message.role,
          text: (message.parts ?? []).map((part) => part.text ?? '').join(''),
          provenance: v.parse(TurnProvenanceSchema, message.metadata ?? {}),
        });
      }
      return { status: 'completed' };
    },
  });
  return turns;
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
    const turns = captureTurns(harness.agent);

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });

    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    // A turn the backend enqueued. The provenance is what stops the chat from
    // rendering it as words the owner typed.
    expect(turn.role).toBe('user');
    expect(turn.provenance.proteusEvent).toBe(WORKSPACE_CREATED_EVENT);
    expect(turn.provenance.signalId).toMatch(/^sig-/);
    expect(turn.text).toContain('first turn');
    harness.db.close();
  });

  test('the mission is not quoted into the turn — it is already the system prompt', async () => {
    const harness = orchestratorHarness();
    seedMission(harness.db, MISSION);
    const turns = captureTurns(harness.agent);

    await harness.agent.beginGenesisTurn();

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
    const turns = captureTurns(harness.agent);

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
      value: async () => { turnStarted = true; await turnRunning; return { status: 'completed' }; },
    });

    expect(await harness.agent.beginGenesisTurn()).toEqual({ started: true });
    expect(turnStarted).toBe(true);

    endTurn();
    harness.db.close();
  });
});
