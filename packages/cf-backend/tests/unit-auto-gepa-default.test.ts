// Auto-GEPA autonomous-default honesty: pre-flip explicit disables DELETED
// the config row, so an absent row is indistinguishable from never-configured
// and the default supersedes both. The first default-driven tick must pin the
// default explicitly and document the activation in the evolution stream —
// never silently re-enable.
//
// Driven on a real OrchestratorAgent (tests/helpers/actor-harness.ts): the tick
// is the one a completed turn makes, and every assertion below reads the rows
// it actually left in the agent's own storage.
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { AGENT_CONFIG_KEYS, DEFAULT_AUTO_GEPA_EVERY_N_TURNS } from '@kinu.run/core';
import { orchestratorHarness } from './helpers/actor-harness';

const storedCadence = (db: Database): string | null =>
  db.prepare<{ value: string }, [string]>('SELECT value FROM agent_config WHERE key = ?')
    .get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns)?.value ?? null;

const evolutionNotes = (db: Database) =>
  db.prepare<{ type: string; message: string }, []>(
    'SELECT type, message FROM evolution_events ORDER BY created_at, id',
  ).all();

describe('auto-GEPA default activation', () => {
  test('the tick pins an absent cadence row and records the override note', async () => {
    const { agent, db } = orchestratorHarness();

    // The ambiguity the pin exists to remove: nothing is stored, yet the
    // cadence already reads as enabled.
    expect(storedCadence(db)).toBeNull();
    expect(agent.observeAutoGepaCadence()).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS);
    expect(evolutionNotes(db)).toEqual([]);

    await agent.tickAutoGepa();

    // Pinned explicitly, at the value that was already in force — the tick
    // documents the state, it does not change the cadence.
    expect(storedCadence(db)).toBe(String(DEFAULT_AUTO_GEPA_EVERY_N_TURNS));
    expect(agent.observeAutoGepaCadence()).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS);

    const notes = evolutionNotes(db);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('reflection');
    // The note has to name the override and the way back out, or it documents
    // nothing a reader of the evolution stream could act on.
    expect(notes[0]!.message).toContain(`every ${DEFAULT_AUTO_GEPA_EVERY_N_TURNS} turns`);
    expect(notes[0]!.message).toContain('superseded by this default');
    expect(notes[0]!.message).toContain('setAutoGepa(0)');
  });

  test('the note is written once, not once per turn', async () => {
    const { agent, db } = orchestratorHarness();
    await agent.tickAutoGepa();
    await agent.tickAutoGepa();
    await agent.tickAutoGepa();
    // The row is now present, so the activation is no longer news. An
    // evolution stream that reprinted it every turn would bury everything else.
    expect(evolutionNotes(db)).toHaveLength(1);
    expect(storedCadence(db)).toBe(String(DEFAULT_AUTO_GEPA_EVERY_N_TURNS));
  });

  test('a deliberate disable survives the tick and is not documented as an override', async () => {
    const { agent, db } = orchestratorHarness();
    agent.setAutoGepaCadence(0);

    await agent.tickAutoGepa();

    // A stored 0 is a decision, not an absence: the default must not reach it.
    expect(storedCadence(db)).toBe('0');
    expect(agent.observeAutoGepaCadence()).toBe(0);
    expect(evolutionNotes(db)).toEqual([]);
  });

  test('a cadence the owner chose is left alone', async () => {
    const { agent, db } = orchestratorHarness();
    agent.setAutoGepaCadence(7);

    await agent.tickAutoGepa();

    expect(storedCadence(db)).toBe('7');
    expect(agent.observeAutoGepaCadence()).toBe(7);
    expect(evolutionNotes(db)).toEqual([]);
  });
});
