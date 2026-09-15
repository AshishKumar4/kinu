/**
 * The public share index as data: a projection the Shared page's "Public" list
 * reads and every reader verifies against the owner's object. What is pinned
 * here is the store's own contract — upsert by (owner, workspace, share),
 * newest first, forget by key — and that a row never carries visibility.
 */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { forgetPublicShare, indexPublicShare, initControlPlaneSchema, listPublicShares } from '@kinu.run/core/control-plane';
import { sqlExec } from './helpers/user-do';

function store() {
  const sql = sqlExec(new Database(':memory:'));
  initControlPlaneSchema(sql);

  return sql;
}

test('a public share is listed newest first, upserted by key, and forgotten by key', () => {
  const sql = store();
  const lee = { ownerUserId: 'a'.repeat(32), ownerEmail: 'lee@example.test', workspace: 'ops-board' };
  indexPublicShare(sql, { ...lee, shareId: 's1', kind: 'live', title: 'Deploy status', createdAt: 1000 });
  indexPublicShare(sql, { ...lee, shareId: 's2', kind: 'blueprint', title: 'Standup notes', createdAt: 2000 });
  indexPublicShare(sql, { ...lee, ownerEmail: 'lee@renamed.test', shareId: 's1', kind: 'live', title: 'Deploy status board', createdAt: 1000 });

  expect(listPublicShares(sql).map((row) => [row.shareId, row.title, row.ownerEmail])).toEqual([
    ['s2', 'Standup notes', 'lee@example.test'],
    ['s1', 'Deploy status board', 'lee@renamed.test'],
  ]);
  expect(Object.keys(listPublicShares(sql)[0] ?? {}).sort()).toEqual(['createdAt', 'kind', 'ownerEmail', 'ownerUserId', 'shareId', 'title', 'workspace']);

  forgetPublicShare(sql, { ownerUserId: lee.ownerUserId, workspace: 'ops-board', shareId: 's2' });
  forgetPublicShare(sql, { ownerUserId: lee.ownerUserId, workspace: 'other', shareId: 's1' });
  expect(listPublicShares(sql).map((row) => row.shareId)).toEqual(['s1']);
  expect(listPublicShares(sql, 0)).toEqual([]);
});
