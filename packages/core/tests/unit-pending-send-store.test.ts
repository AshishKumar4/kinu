/**
 * PendingSendStore — the ONE pending-send ledger both backends sit over.
 *
 * What is pinned here is the contract a backend composes, not the SQL: a
 * reservation exists before the client hears the send was taken, a retirement
 * spends the row and its attachments together, and `sweepDead`'s NULL
 * semantics keep a backend that writes idle-queued rows from sweeping its own
 * queue as orphans. Each assertion names the observable a restart or a
 * reconnect would read.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initPendingSendTables, PendingSendStore } from '../src/orchestrator/inbox';
import { makeSql, makeExecRaw } from './helpers';

function setup() {
  const db = new Database(':memory:');
  initPendingSendTables(makeExecRaw(db));
  const sql = makeSql(db);
  const store = (actorId: string) => new PendingSendStore(sql, actorId);

  return { sql, store };
}

const FILE = { filename: 'a.png', mediaType: 'image/png', url: 'data:image/png;base64,x' };

const FILE_B = { filename: 'b.png', mediaType: 'image/png', url: 'data:image/png;base64,y' };

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

  test('retire spends the row AND its attachments, and no other actor\'s', () => {
    const { store } = setup();
    const sends = store('actor-a');
    const other = store('actor-b');
    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'build', text: 'mine', files: [FILE] });
    other.reserve({ id: 's-1', turnId: 'turn-9', mode: 'plan', text: 'theirs', files: [FILE_B] });

    sends.retire(['s-1']);

    expect(sends.restore()).toEqual([]);
    expect(sends.files('s-1')).toEqual([]);
    // The other actor's same-named steer is untouched: the id is an actor's
    // to spend, never a workspace's.
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
  test('forTurn names only rows bound to that turn', () => {
    const { store } = setup();
    const sends = store('actor-a');
    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'build', text: 'this turn' });
    sends.reserve({ id: 's-2', turnId: 'turn-2', mode: 'build', text: 'another turn' });
    sends.reserve({ id: 's-3', turnId: null, mode: 'build', text: 'idle-queued' });

    expect(sends.forTurn('turn-1').map((row) => row.id)).toEqual(['s-1']);
  });

  test('sweepDead excludes the live turn AND keeps idle-queued rows out of the orphan set', () => {
    const { store } = setup();
    const sends = store('actor-a');
    sends.reserve({ id: 's-live', turnId: 'turn-live', mode: 'build', text: 'in flight' });
    sends.reserve({ id: 's-dead', turnId: 'turn-dead', mode: 'build', text: 'turn is gone' });
    sends.reserve({ id: 's-idle', turnId: null, mode: 'build', text: 'queued, nobody owns it' });

    // NULL turn_id <> 'turn-live' is NULL, not TRUE: the idle-queued row must
    // not be swept as an orphan — it is the queue's record, not a dead turn's.
    expect(sends.sweepDead('turn-live').map((row) => row.id)).toEqual(['s-dead']);
  });

  test('ensureReserved binds a fresh id to the admitting turn and keeps an existing row untouched', () => {
    const { store } = setup();
    const sends = store('actor-a');
    sends.reserve({ id: 's-1', turnId: 'turn-1', mode: 'plan', text: 'original words', files: [FILE] });

    // A leftover rerun's id already carries its row: re-admission binds nothing.
    sends.ensureReserved({ id: 's-1', turnId: 'turn-rerun', mode: 'build', text: 'merged words' });
    expect(sends.restore()).toEqual([
      { id: 's-1', turnId: 'turn-1', mode: 'plan', text: 'original words' },
    ]);
    expect(sends.files('s-1')).toEqual([FILE]);

    // An id with no row gets one bound to the admitting turn — the send the
    // session acknowledged before the queue could admit it.
    sends.ensureReserved({ id: 's-2', turnId: 'turn-rerun', mode: 'build', text: 'merged words' });
    expect(sends.restore().map((row) => row.id)).toEqual(['s-1', 's-2']);
    expect(sends.forTurn('turn-rerun').map((row) => row.id)).toEqual(['s-2']);
  });
});
