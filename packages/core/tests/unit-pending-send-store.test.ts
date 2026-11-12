/** PendingSendStore: the pending-send ledger both backends sit over. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initPendingSendTables, PendingSendStore } from '../src/orchestrator/inbox';
import { makeSql, makeExecRaw } from './helpers';

function setup() {
  const db = new Database(':memory:');
  initPendingSendTables(makeExecRaw(db));
  const sql = makeSql(db);
  const store = (actorId: string) => new PendingSendStore(sql, actorId);

  return { db, sql, store };
}

const FILE = { filename: 'a.png', mediaType: 'image/png', path: '/uploads/a.png' };

const FILE_B = { filename: 'b.png', mediaType: 'image/png', path: '/uploads/b.png' };

describe('PendingSendStore — the reservation', () => {
  test('reserve writes the steer and its attachments; restore reads them in acceptance order', () => {
    const { store } = setup();
    const sends = store('actor-a');
    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'build', text: 'first', files: [FILE, FILE_B] });
    sends.reserve({ id: 's-2', turnId: null, mode: 'plan', text: 'second' });

    expect(sends.restore()).toEqual([
      { id: 's-1', turnId: 'turn-1', mode: 'build', text: 'first' },
      { id: 's-2', turnId: null, mode: 'plan', text: 'second' },
    ]);
    expect(sends.files('s-1')).toEqual([FILE, FILE_B]);
    expect(sends.files('s-2')).toEqual([]);
  });

  test('a file keeps the digest it was pinned as; an upload whose own name holds the marker is read as named', () => {
    const { store } = setup();
    const sends = store('actor-a');
    const pinned = { ...FILE, digest: 'ab'.repeat(32) };
    const named = { filename: 'report#sha256=draft.txt', mediaType: 'text/plain', path: '/uploads/report#sha256=draft.txt' };

    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'build', text: 'files', files: [pinned, named] });

    expect(sends.files('s-1')).toEqual([pinned, named]);
  });

  test('retire spends the row AND its attachments, and no other actor\'s', () => {
    const { store } = setup();
    const sends = store('actor-a');
    const other = store('actor-b');
    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'build', text: 'mine', files: [FILE] });
    other.reserve({ id: 's-1', turnId: 'turn-9', mode: 'plan', text: 'theirs', files: [FILE_B] });

    sends.retire(['s-1']);

    expect(sends.restore()).toEqual([]);
    expect(sends.files('s-1')).toEqual([]);
    // The id is an actor's to spend.
    expect(other.restore()).toEqual([
      { id: 's-1', turnId: 'turn-9', mode: 'plan', text: 'theirs' },
    ]);
    expect(other.files('s-1')).toEqual([FILE_B]);
  });

  test('a second store over one database sees what the first wrote — the row IS the acknowledgement', () => {
    const { store } = setup();
    store('actor-a').reserve({ id: 's-1', turnId: 'turn-1', mode: 'build', text: 'typed once' });

    expect(store('actor-a').restore().map((row) => row.id)).toEqual(['s-1']);
  });
});

describe('PendingSendStore — the reads a restart composes', () => {
  test('ensureReserved binds a fresh id to the admitting turn and keeps an existing row untouched', () => {
    const { store } = setup();
    const sends = store('actor-a');
    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'plan', text: 'original words', files: [FILE] });

    sends.ensureReserved({ id: 's-1', turnId: 'turn-rerun', mode: 'build', text: 'merged words' });
    expect(sends.restore()).toEqual([
      { id: 's-1', turnId: 'turn-1', mode: 'plan', text: 'original words' },
    ]);
    expect(sends.files('s-1')).toEqual([FILE]);

    sends.ensureReserved({ id: 's-2', turnId: 'turn-rerun', mode: 'build', text: 'merged words' });
    expect(sends.restore().map((row) => [row.id, row.turnId])).toEqual([['s-1', 'turn-1'], ['s-2', 'turn-rerun']]);
  });
});
