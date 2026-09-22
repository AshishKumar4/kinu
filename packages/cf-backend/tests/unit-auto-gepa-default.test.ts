// Pre-flip explicit disables deleted the config row, so an absent row is ambiguous: the first default-driven tick
// must pin the default explicitly and note the activation in the evolution stream, never silently re-enable.
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS } from '@kinu.run/core';
import { orchestratorHarness } from './helpers/actor-harness';

const storedCadence = (db: Database): string | null =>
  db.prepare<{ value: string }, [string]>('SELECT value FROM actor_config WHERE key = ?')
    .get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns)?.value ?? null;

const evolutionNotes = (db: Database) =>
  db.prepare<{ type: string; message: string }, []>(
    'SELECT type, message FROM evolution_events ORDER BY created_at, id',
  ).all();

describe('auto-GEPA default activation', () => {
  test('the tick pins an absent cadence row and records the override note', async () => {
    const { agent, db } = orchestratorHarness();

    // Nothing stored, yet the cadence already reads as enabled: the ambiguity the pin removes.
    expect(storedCadence(db)).toBeNull();
    expect(agent.observeAutoGepaCadence()).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS);
    expect(evolutionNotes(db)).toEqual([]);

    await agent.tickAutoGepa();

    // Pinned at the value already in force: documents the state, does not change the cadence.
    expect(storedCadence(db)).toBe(String(DEFAULT_AUTO_GEPA_EVERY_N_TURNS));
    expect(agent.observeAutoGepaCadence()).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS);

    const notes = evolutionNotes(db);
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('reflection');
    // Must name the override and the way back out to be actionable.
    expect(notes[0].message).toContain(`every ${DEFAULT_AUTO_GEPA_EVERY_N_TURNS} turns`);
    expect(notes[0].message).toContain('superseded by this default');
    expect(notes[0].message).toContain('setAutoGepa(0)');
  });

  test('the note is written once, not once per turn', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.tickAutoGepa();
    await agent.tickAutoGepa();
    await agent.tickAutoGepa();
    // Present now, so not reprinted every turn.
    expect(evolutionNotes(db)).toHaveLength(1);
    expect(storedCadence(db)).toBe(String(DEFAULT_AUTO_GEPA_EVERY_N_TURNS));
  });

  // A stored 0 is a decision, not an absence: the default must not reach it.
  const chosen = [
    { name: 'a deliberate disable survives the tick and is not documented as an override', cadence: 0 },
    { name: 'a cadence the owner chose is left alone', cadence: 7 },
  ];

  for (const { name, cadence } of chosen) {
    test(name, async () => {
      const { agent, db } = orchestratorHarness();
      agent.setAutoGepaCadence(cadence);

      await agent.tickAutoGepa();

      expect(storedCadence(db)).toBe(String(cadence));
      expect(agent.observeAutoGepaCadence()).toBe(cadence);
      expect(evolutionNotes(db)).toEqual([]);
    });
  }
});
