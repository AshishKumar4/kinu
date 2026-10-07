// Every table a workspace holds declares how a fork takes it, and what a fork carries or resets follows from that
// declaration: a new table cannot cross, or be left behind, by accident.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { wrapDatabase } from '../src/identity/inline-primitives';
import { normalizeObservedTables } from '../src/conformance';
import { FORK_FAMILIES, type ForkFamily } from '../src/identity/fork-policy';
import { FORK_ROW_SECTIONS, FORK_SECTIONS } from '../src/identity/fork-sections';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';
import { sealForkFrame } from '../src/index';
import { createTestWorkspace as fresh, makeSqlExec } from './helpers';
import { seedForkSource, TARGET_ARTIFACTS } from './helpers/fork-conversation';
import { deliver, receiverFor, sourceFrames } from './helpers/fork-stream';

const families: ReadonlyArray<readonly [string, ForkFamily]> = Object.entries(FORK_FAMILIES);

function workspaceTables() {
  const db = new Database(':memory:');

  initWorkspaceSchema({ ...wrapDatabase(db), exec: makeSqlExec(db) });

  return { db, tables: normalizeObservedTables(db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name)) };
}

describe('the fork policy of a workspace\'s state', () => {
  test('names every table a workspace holds exactly once, and no table it does not hold', () => {
    const { tables } = workspaceTables();
    const declared = families.flatMap(([, family]) => family.tables);

    expect(declared.filter((table, at) => declared.indexOf(table) !== at)).toEqual([]);
    expect([...tables].filter((table) => !declared.includes(table)).sort()).toEqual([]);
    expect(declared.filter((table) => !tables.has(table)).sort()).toEqual([]);
  });

  test('a family the fork carries crosses in a row section, and a section carries only such a family', () => {
    const carried = families.filter(([, family]) => family.policy === 'as-of-cut' || family.policy === 'current').map(([name]) => name);
    const crossing = new Set<string>(FORK_ROW_SECTIONS.map((kind) => FORK_SECTIONS[kind].family));

    expect([...crossing].filter((name) => !carried.includes(name))).toEqual([]);
    expect(carried.filter((name) => !crossing.has(name))).toEqual([]);
  });

  test('the write resets every table a carried family lands in, and only a family\'s own tables', () => {
    for (const [name, family] of families) {
      const reset = (family.resets ?? []).map(({ table }) => table);

      expect([name, reset.filter((table) => !family.tables.includes(table))]).toEqual([name, []]);
    }

    // Each carried section's rows land in its family's tables, so those are emptied before a retry stages again.
    for (const kind of FORK_ROW_SECTIONS) expect([kind, FORK_FAMILIES[FORK_SECTIONS[kind].family].resets?.length ?? 0]).not.toEqual([kind, 0]);
  });

  // Run against the store's own foreign keys: a reset ordered parent first is refused by SQLite, not by this test.
  test('a replacement transfer empties a published fork with every foreign key enforced', async () => {
    const src = fresh();
    const chat = await seedForkSource(src, { purpose: 'help with testing', craftedTools: [{ name: 'helper', description: 'utility', code: 'async (x) => x' }] });

    await chat.say({ id: 'm1', role: 'user', text: 'first' });
    await chat.say({ id: 'm2', role: 'assistant', text: 'second' });
    const tgt = fresh();
    const target = { workspaceId: 'FORK-ID', workspaceName: 'my-fork', artifactDirectory: TARGET_ARTIFACTS, now: 4242 };

    await deliver(receiverFor(tgt, target), await sourceFrames(src, 'm2'));
    const actorId = openWorkspaceMainActor(tgt.sql).actorId;

    const rowsIn = (table: string, scope: 'actor' | 'workspace'): number => (scope === 'actor'
      ? tgt.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE actor_id = ?`).get(actorId)?.n
      : tgt.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n) ?? 0;

    const landed = (): string[] => families.flatMap(([, family]) => family.resets ?? [])
      .filter(({ table, scope }) => rowsIn(table, scope) > 0).map(({ table }) => table);

    expect(landed()).toEqual(expect.arrayContaining(['conversation_entries', 'context_memberships', 'session_messages', 'crafted_tools']));
    tgt.db.exec('PRAGMA foreign_keys = ON');
    const replacement = (await sourceFrames(src, 'm1')).find((frame) => frame.kind === 'begin');

    if (replacement === undefined) throw new Error('the source stream has no begin frame');
    await receiverFor(tgt, target).accept(sealForkFrame({ ...replacement, transferId: 'tx-replacement' }));
    expect(landed()).toEqual([]);
  });
});
