// `makeSql`/`makeSqlExec` stand in for a Durable Object's `ctx.storage.sql`, which returns whatever rows a statement
// produces: a write with RETURNING must answer its rows, not `[]` from a leading-keyword sniff.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DeferredApprovalStore, EventLog, initWorkspaceSchema, type ActorHandle } from '@kinu.run/core';
import { createTestActors } from '@kinu.run/test-utils';
import { makeSql, makeSqlExec, makeWorkspaceSchemaSql } from '../src/runtime';

/** One workspace's schema and main actor, issued through `makeSql`: the directory's INSERT … RETURNING is the first row it must hand back. */
function mainActor(db: Database): ActorHandle {
  const schemaSql = makeWorkspaceSchemaSql(db);
  initWorkspaceSchema(schemaSql);

  return createTestActors(schemaSql.sql, schemaSql.execRaw).main;
}

/** An approved, unspent grant: where a deferred shell approval waits for the agent. */
function approvedGrant(db: Database): DeferredApprovalStore {
  const store = new DeferredApprovalStore(makeSql(db), mainActor(db));
  store.create({
    id: 'act-1',
    command: 'rm -rf ./build',
    executor: 'device',
    reason: 'the build directory is stale',
    requestedAt: 1,
  });
  expect(store.decide('act-1', 'approved', 2)?.status).toBe('approved');

  return store;
}

describe('the local SQL adapter returns the rows a write produces', () => {
  test('an approved shell command is claimed exactly once through the real store', () => {
    const db = new Database(':memory:');
    const store = approvedGrant(db);

    // `spend` is `UPDATE … RETURNING`: the returned row is the claim.
    const claimed = store.spend('act-1');
    expect(claimed?.action).toMatchObject({
      id: 'act-1',
      command: 'rm -rf ./build',
      executor: 'device',
      status: 'spent',
    });
    expect(claimed?.spend).toEqual({ approvalId: 'act-1', spend: 1 });

    expect(store.spend('act-1')).toBeNull();
    expect(store.standing('rm -rf ./build', 'device', Date.now())).toBeNull();

    if (!claimed) throw new Error('the approved grant must be claimable');

    // `settle` is `DELETE … RETURNING`; the row tells the caller this call closed the spend, not a replay.
    expect(store.settle(claimed.spend, 'spent')).toBe(true);
    expect(store.settle(claimed.spend, 'spent')).toBe(false);
    expect(store.get('act-1')).toBeNull();
    db.close();
  });

  test('a stranded event delivery is named by the reclaim that re-pends it', () => {
    const db = new Database(':memory:');
    const log = new EventLog(makeSqlExec(db), mainActor(db));

    const { id } = log.publish({
      descriptor: {
        ingress: 'chat_ws',
        variant: 'chat',
        payload: { text: 'external wake' },
        operator_user_id: 'owner-1',
        session_id: 'local-test',
      },
      now: 1,
    });

    log.markConsumed(id, 'evt-dead', 0, 5);

    // `unbindStale` is `UPDATE … RETURNING id`: the caller counts recovered deliveries from those ids.
    expect(log.unbindStale(0, 10)).toEqual([id]);
    expect(log.pending().map((event) => event.id)).toEqual([id]);
    db.close();
  });
});
