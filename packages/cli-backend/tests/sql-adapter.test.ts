// The local SQL adapters (`makeSql`, `makeSqlExec` in src/runtime.ts) stand in
// for a Durable Object's `ctx.storage.sql`, which returns whatever rows a
// statement produces. Both used to decide that by sniffing the leading keyword
// and ran anything outside SELECT/WITH/PRAGMA through `stmt.run()`, answering
// `[]` — so every core statement that RETURNS rows from a write performed the
// write and reported nothing, on this backend only.
//
// Driven through the real stores rather than against the adapter alone: the
// symptom was never a wrong row shape, it was a caller reading "nothing
// matched" out of a write that had just succeeded.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DeferredApprovalStore, EventLog, initWorkspaceSchema } from '@kinu.run/core';
import { makeSql, makeSqlExec, makeWorkspaceSchemaSql } from '../src/runtime';

/** A grant the owner has approved and nobody has spent — the state a deferred
 *  shell approval sits in until the agent comes back for it. */
function approvedGrant(db: Database): DeferredApprovalStore {
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const store = new DeferredApprovalStore(makeSql(db));
  store.create({
    id: 'act-1',
    command: 'rm -rf ./build',
    executor: 'laptop',
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

    // `spend` is `UPDATE … RETURNING`: the returned row IS the claim. Reading
    // `[]` here took the grant out of reach and told the caller it got nothing
    // — the approved command could then never run, and the owner's answer was
    // gone.
    const claimed = store.spend('act-1');
    expect(claimed?.action).toMatchObject({
      id: 'act-1',
      command: 'rm -rf ./build',
      executor: 'laptop',
      status: 'spent',
    });
    expect(claimed?.spend).toEqual({ approvalId: 'act-1', spend: 1 });

    // And exactly once: the grant is out, so a second claim has nothing to take.
    expect(store.spend('act-1')).toBeNull();
    expect(store.standing('rm -rf ./build', 'laptop')).toBeNull();
    if (!claimed) throw new Error('the approved grant must be claimable');

    // `settle` is the other keyword this adapter used to swallow:
    // `DELETE … RETURNING`, whose row is how the caller knows THIS call is
    // what closed the spend rather than a replay of one already closed.
    expect(store.settle(claimed.spend, 'spent')).toBe(true);
    expect(store.settle(claimed.spend, 'spent')).toBe(false);
    expect(store.get('act-1')).toBeNull();
    db.close();
  });

  test('a stranded event delivery is named by the reclaim that re-pends it', () => {
    const db = new Database(':memory:');
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const log = new EventLog(makeSqlExec(db));
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

    // `unbindStale` is `UPDATE … RETURNING id`. The re-pending always worked;
    // the ids never came back, so the caller could not report — or count — the
    // deliveries it had just recovered.
    expect(log.unbindStale(0, 10)).toEqual([id]);
    expect(log.pending().map((event) => event.id)).toEqual([id]);
    db.close();
  });
});
