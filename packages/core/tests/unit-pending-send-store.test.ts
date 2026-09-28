/** PendingSendStore: the pending-send ledger both backends sit over. */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initPendingSendTables, PendingSendStore } from '../src/orchestrator/inbox';
import { CLOUD_MAX_INLINE_ATTACHMENT_BYTES } from '../src/cloud-wire';
import { PLATFORM_CATALOG } from '../src/platform-catalog';
import { makeSql, makeExecRaw } from './helpers';

function setup() {
  const db = new Database(':memory:');
  initPendingSendTables(makeExecRaw(db));
  const sql = makeSql(db);
  const store = (actorId: string) => new PendingSendStore(sql, actorId);

  return { db, sql, store };
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

  test('a send carrying two of the largest attachments the composer admits fits the platform row cap', () => {
    const { db, store } = setup();

    const largest = (name: string) => ({
      filename: name, mediaType: 'application/octet-stream',
      url: `data:application/octet-stream;base64,${Buffer.alloc(CLOUD_MAX_INLINE_ATTACHMENT_BYTES, 7).toString('base64')}`,
    });

    const files = [largest('one.bin'), largest('two.bin')];

    store('actor-a').reserve({ id: 's-big', turnId: 'turn-1', mode: 'build', text: 'both attached', files });

    const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pending_steer%'`).all();

    const widest = Math.max(...tables.map(({ name }) => {
      const columns = db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${name}')`).all()
        .map((column) => `COALESCE(length(CAST(${column.name} AS BLOB)), 0)`).join(' + ');

      return db.query<{ bytes: number }, []>(`SELECT MAX(${columns}) AS bytes FROM ${name}`).get()?.bytes ?? 0;
    }));

    expect(widest).toBeLessThan(PLATFORM_CATALOG['do.sqlite.row_bytes'].limit.value);
    expect(store('actor-a').files('s-big')).toEqual(files);
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
