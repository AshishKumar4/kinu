// A slate room is made only by its workspace's `create`: one the deploy's walk asks before that holds nothing and
// stays unmade. Made, it is stamped as this build's class `room`, and a room a release left behind is repaired as it
// starts, keeping its rows (core state/schema-repair.ts).
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { opsCaller, SCHEMA_STAMPS } from '@kinu.run/core';
import { SlateRoom } from '../src/slates/room';
import { kvOf, makeCtx } from './helpers/platform-context';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { workerEnv } from './helpers/bindings';

const env = workerEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

/** The harness's context is the platform's `DurableObjectState` over bun:sqlite; its declared type is the SDK's. */
const roomOn = (db: Database) => new SlateRoom(makeCtx(db, 'room'), env);

const tables = (db: Database) => db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'room%' ORDER BY name").all();

test('a room asked before it is made holds nothing, and its census is empty', async () => {
  const db = new Database(':memory:');
  const room = roomOn(db);

  expect(room.exists()).toBe(false);
  expect((await room.opsTables(await opsCaller({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY }))).census).toEqual([]);
  expect(tables(db)).toEqual([]);
  expect(kvOf(db).get('kinu.schema_stamp')).toBeUndefined();
});

test('a made room is stamped as this build\'s, and starts again holding its rows', () => {
  const db = new Database(':memory:');

  roomOn(db).create({ workspace: 'jarvis', slate: 'board', title: 'Board', owner: 'sam@acme.dev', parent: null });
  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.room);
  expect(roomOn(db).exists()).toBe(true);
});

test('a room behind this build is repaired as it starts, keeping its rows', () => {
  const db = new Database(':memory:');

  roomOn(db).create({ workspace: 'jarvis', slate: 'board', title: 'Board', owner: 'sam@acme.dev', parent: null });
  kvOf(db).set('kinu.schema_stamp', 1);
  const again = roomOn(db);

  expect(kvOf(db).get('kinu.schema_stamp')).toBe(SCHEMA_STAMPS.room);
  expect(again.exists()).toBe(true);
});
