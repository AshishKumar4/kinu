// Pre-flip explicit disables deleted the config row, so an absent row is ambiguous: the first default-driven tick
// must pin the default explicitly and note the activation in the evolution stream, never silently re-enable.
// The tick is the auto-GEPA effect of a settled turn's terminal sequence.
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS } from '@kinu.run/core';
import {
  chatSessionTurns, improvementLanesRan, orchestratorHarness, until, workspaceMainActor,
  type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';

const storedCadence = (db: Database): string | null =>
  db.prepare<{ value: string }, [string]>('SELECT value FROM actor_config WHERE key = ?')
    .get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns)?.value ?? null;

/** The cadence in force, as the object's config reads it. */
const cadenceInForce = (db: Database): number => workspaceMainActor(db).config.getAutoGepaEveryNTurns();

const evolutionNotes = (db: Database) =>
  db.prepare<{ type: string; message: string }, []>(
    'SELECT type, message FROM evolution_events ORDER BY created_at, id',
  ).all();

/** One settled turn, waited on until its terminal sequence (the auto-GEPA tick included) closed. */
async function settledTurn(harness: ActorHarness<HarnessOrchestratorAgent>, messageId: string): Promise<void> {
  const settled = await chatSessionTurns(harness.agent).settle({ messageId, text: 'done' });
  await until(() => improvementLanesRan(harness.db, settled.messageId), `the sequence of ${messageId} closed`);
}

describe('auto-GEPA default activation', () => {
  test('the tick pins an absent cadence row and records the override note', async () => {
    const harness = orchestratorHarness();
    const { db } = harness;

    // Nothing stored, yet the cadence already reads as enabled: the ambiguity the pin removes.
    expect(storedCadence(db)).toBeNull();
    expect(cadenceInForce(db)).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS);
    expect(evolutionNotes(db)).toEqual([]);

    await settledTurn(harness, 'a-first');

    // Pinned at the value already in force: documents the state, does not change the cadence.
    expect(storedCadence(db)).toBe(String(DEFAULT_AUTO_GEPA_EVERY_N_TURNS));
    expect(cadenceInForce(db)).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS);

    const notes = evolutionNotes(db);
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('reflection');
    // Must name the override to be actionable.
    expect(notes[0].message).toContain(`every ${DEFAULT_AUTO_GEPA_EVERY_N_TURNS} turns`);
    expect(notes[0].message).toContain('superseded by this default');
  });

  test('the note is written once, not once per turn', async () => {
    const harness = orchestratorHarness();
    await settledTurn(harness, 'a-1');
    await settledTurn(harness, 'a-2');
    await settledTurn(harness, 'a-3');
    // Present now, so not reprinted every turn.
    expect(evolutionNotes(harness.db)).toHaveLength(1);
    expect(storedCadence(harness.db)).toBe(String(DEFAULT_AUTO_GEPA_EVERY_N_TURNS));
  });

  // A stored 0 is a decision, not an absence: the default must not reach it.
  const chosen = [
    { name: 'a deliberate disable survives the tick and is not documented as an override', cadence: 0 },
    { name: 'a cadence the owner chose is left alone', cadence: 7 },
  ];

  for (const { name, cadence } of chosen) {
    test(name, async () => {
      const harness = orchestratorHarness();
      workspaceMainActor(harness.db).config.setAutoGepaEveryNTurns(cadence);

      await settledTurn(harness, 'a-chosen');

      expect(storedCadence(harness.db)).toBe(String(cadence));
      expect(cadenceInForce(harness.db)).toBe(cadence);
      expect(evolutionNotes(harness.db)).toEqual([]);
    });
  }
});
