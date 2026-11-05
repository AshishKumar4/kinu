// rc29 → this build, at an object's first open (core state/schema-repair.ts). The databases are rc29's own: made by its
// init and stores at 62b6c90c6 (tests/fixtures/rc29). This release reshaped actor_requests and mail_messages, so a
// repair drops what refers to them; what is derived from those, by the mark beside its DDL, goes too (the
// consolidation's review, 2026-10-21): no entry is left without its messages, no index over rowids that are gone.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { durableStamps, initMailboxTables, MailStore, repairSchema, SCHEMA_STAMPS, SCHEMA_TABLES, WORKSPACE_ROOT, type ParsedMail } from '@kinu.run/core';
import { openAgentDatabase, repairAgentDatabase } from '../src/agent-facet/agent-database';
import { kvOf, makeCtx } from './helpers/platform-context';

function unreachable(): never {
  throw new Error('the repair test reached the workspace');
}

const WORKSPACE = {
  agent: unreachable, home: WORKSPACE_ROOT, state: unreachable, enqueueTurn: unreachable, admitDelivery: unreachable, broadcast: unreachable,
  turnInFlight: () => false, memory: unreachable, program: unreachable, sayToParent: unreachable, receipts: unreachable, logActivity: unreachable,
};

/** The fixture's database, stamped as rc29 stamped it (its first line names the stamp). */
function rc29(fixture: string): Database {
  const text = readFileSync(join(import.meta.dir, 'fixtures/rc29', fixture), 'utf8');
  const stamp = Number(/Stamp (\d+)\./u.exec(text.split('\n')[0] ?? '')?.[1]);
  const db = new Database(':memory:');

  db.exec(text);
  kvOf(db).set('kinu.schema_stamp', stamp);

  return db;
}

const Count = v.object({ n: v.number() });

const count = (db: Database, query: string): number => v.parse(Count, db.query(query).get()).n;

test('an rc29 agent database opens with no entry left without its messages, no index over them, and no head without its run', () => {
  const db = rc29('agent.sql');
  const before = { entries: count(db, 'SELECT COUNT(*) AS n FROM conversation_entries'), indexed: count(db, 'SELECT COUNT(*) AS n FROM conversation_fts') };
  const { storage } = makeCtx(db, 'rc29-agent');
  const repair = repairAgentDatabase(storage, 'rc29-agent');

  expect({ refused: repair?.refused ?? null, before }).toEqual({ refused: null, before: { entries: 2, indexed: 2 } });
  expect({
    entriesWithoutParts: count(db, 'SELECT COUNT(*) AS n FROM conversation_entries e WHERE NOT EXISTS (SELECT 1 FROM conversation_entry_parts p WHERE p.actor_id = e.actor_id AND p.entry_id = e.id)'),
    index: count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'conversation_fts'"),
    headsWithoutRuns: count(db, 'SELECT COUNT(*) AS n FROM head_journal j WHERE NOT EXISTS (SELECT 1 FROM head_runs r WHERE r.actor_id = j.actor_id AND r.root_id = j.root_id)'),
    stepsWithoutHeads: count(db, 'SELECT COUNT(*) AS n FROM head_steps s WHERE NOT EXISTS (SELECT 1 FROM head_journal j WHERE j.actor_id = s.actor_id AND j.id = s.head_id)'),
    stamp: kvOf(db).get('kinu.schema_stamp'),
  }).toEqual({ entriesWithoutParts: 0, index: 0, headsWithoutRuns: 0, stepsWithoutHeads: 0, stamp: SCHEMA_STAMPS.agent });
  expect(repair?.dropped).toEqual(expect.arrayContaining([
    'actor_requests', 'session_messages', 'conversation_entry_parts', 'conversation_entries', 'conversation_fts', 'actor_contexts', 'context_revisions', 'head_runs', 'head_journal', 'head_steps',
  ]));
  openAgentDatabase(storage, repair, WORKSPACE);
});

test('an rc29 mailbox opens with its search over no message that is gone, and its retired table retired once', async () => {
  const db = rc29('mailbox.sql');
  const { storage } = makeCtx(db, 'rc29-mailbox');
  const init = (): void => { initMailboxTables(storage.sql); };

  const repair = repairSchema(storage.sql, { schema: 'mailbox', tables: SCHEMA_TABLES.mailbox, stamps: durableStamps(storage.kv), transactionSync: (write) => storage.transactionSync(write), init }, 'rc29-mailbox');

  expect(repair?.refused ?? null).toBeNull();

  // A message delivered now takes rowid 1, the rc29 message's: the search finds it by its own words alone.
  const parsed: ParsedMail = {
    from: { address: 'lee@northwind.io', name: 'Lee' }, to: [{ address: 'ashish@kinu.run', name: null }], cc: [], subject: 'Lunch on Friday',
    messageId: '<m2@northwind.io>', inReplyTo: null, references: [], text: 'Friday at noon works.', ownWords: 'Friday at noon works.', html: null, attachments: [],
  };

  const store = new MailStore({
    sql: storage.sql, domain: 'kinu.run', now: () => 1_761_000_000_000, id: () => crypto.randomUUID(), parse: async () => parsed,
    blobs: { put: () => Promise.resolve(), text: () => Promise.resolve(null), delete: () => Promise.resolve() },
    digest: (bytes) => Promise.resolve(createHash('sha256').update(bytes).digest('hex')),
  });

  store.open({ userId: 'u-1', email: 'me@example.com', username: 'ashish', assistant: null });
  await store.deliver({ raw: new TextEncoder().encode('From: lee@northwind.io\r\n\r\nFriday'), envelopeFrom: 'lee@northwind.io', recipient: { username: 'ashish', path: '', tag: null } });
  const found = (word: string) => count(db, `SELECT COUNT(*) AS n FROM mail_messages WHERE rowid IN (SELECT rowid FROM mail_fts WHERE mail_fts MATCH '${word}')`);

  expect({ rowid: count(db, 'SELECT MIN(rowid) AS n FROM mail_messages'), old: found('oldsecretword'), own: found('noon') }).toEqual({ rowid: 1, old: 0, own: 1 });
  expect({ retired: repair?.retired, untriaged: repair?.tables.filter(({ table }) => table === 'mail_untriaged') })
    .toEqual({ retired: ['mail_untriaged'], untriaged: [{ table: 'mail_untriaged', before: 1, after: null }] });
  expect(repair?.dropped).toEqual(expect.arrayContaining(['mail_messages', 'mail_fts']));
});
