/**
 * A store created before a storage reset is refused once at schema init: storage is asked whether each table the
 * canonical conversation store declares carries the columns this build writes, before anything touches them.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { wrapDatabase } from '../src/identity/inline-primitives';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { resetGuardedExec, StoragePredatesResetError } from '../src/state/store-reset';
import type { SqlExec } from '../src/types/primitives';
import { makeSqlExec } from './helpers';

function initSchema(db: Database): void {
  const { sql, execRaw, transactionSync } = wrapDatabase(db);

  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db), transactionSync });
}

/** The whole schema through the guard, counting the tables it asked storage about. */
function initGuarded(db: Database): number {
  const { sql, execRaw, transactionSync } = wrapDatabase(db);
  const exec = makeSqlExec(db);
  let asked = 0;

  const counting: SqlExec = {
    exec: (query, ...bindings) => {
      if (query.startsWith('PRAGMA table_info')) asked += 1;

      return exec.exec(query, ...bindings);
    },
  };

  initWorkspaceSchema({ execRaw: resetGuardedExec(execRaw, counting), sql, exec, transactionSync });

  return asked;
}

/** `session_messages` as 5682c7907 created it (2026-09-21), before its envelope and sealed content columns. */
const PRE_RESET_SESSION_MESSAGES = `CREATE TABLE IF NOT EXISTS session_messages (
    actor_id TEXT NOT NULL REFERENCES workspace_actors(actor_id), message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
    native_content_kind TEXT NOT NULL CHECK(native_content_kind IN ('string','parts')),
    origin TEXT NOT NULL CHECK(origin IN ('input','output','edit','context_transform','render')),
    request_id TEXT, output_slot INTEGER, ingress_id TEXT, sealed_sequence INTEGER,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,message_id), UNIQUE(actor_id,request_id,output_slot),
    FOREIGN KEY(actor_id,request_id) REFERENCES actor_requests(actor_id,request_id),
    FOREIGN KEY(actor_id,message_id,sealed_sequence) REFERENCES message_updates(actor_id,message_id,sequence),
    CHECK(output_slot IS NULL OR output_slot >= 0),
    CHECK((request_id IS NULL) = (output_slot IS NULL)))`;

describe('a store created before a storage reset', () => {
  test('a store this build created is never refused, whichever of its tables the guard reads', () => {
    // The guard reads each table's columns out of its DDL, so a misreading would refuse every sound store.
    const db = new Database(':memory:');
    initSchema(db);

    expect(initGuarded(db)).toBeGreaterThan(50);
  });

  test('is refused once at schema init, naming the table and the columns it lacks, before anything uses them', () => {
    const db = new Database(':memory:');
    db.run(PRE_RESET_SESSION_MESSAGES);

    let refusal: unknown;

    try {
      initSchema(db);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(StoragePredatesResetError);
    expect(refusal).toMatchObject({
      code: 'unsupported',
      table: 'session_messages',
      missing: ['envelope_json', 'sealed_at', 'content_json', 'content_path', 'content_digest'],
    });
    // The index on a column the old table lacks never ran.
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'session_open_messages'`).all()).toEqual([]);
  });
});
