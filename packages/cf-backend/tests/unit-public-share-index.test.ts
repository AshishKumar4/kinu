/** Store contract: upsert by (owner, workspace, share), forget by key; rows never carry visibility. */
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { forgetPublicShare, indexPublicShare, initControlPlaneSchema } from '@kinu.run/core/control-plane';
import { sqlExec } from './helpers/user-do';

function store() {
  const sql = sqlExec(new Database(':memory:'));
  initControlPlaneSchema(sql);

  return sql;
}

function rows(sql: ReturnType<typeof store>): unknown[][] {
  return sql.exec('SELECT share_id, title, owner_email FROM cp_public_shares ORDER BY share_id').toArray()
    .map((row) => [row['share_id'], row['title'], row['owner_email']]);
}

test('a public share is upserted by key and forgotten by key', () => {
  const sql = store();
  const lee = { ownerUserId: 'a'.repeat(32), ownerEmail: 'lee@example.test', workspace: 'ops-board' };
  indexPublicShare(sql, { ...lee, shareId: 's1', kind: 'live', title: 'Deploy status', createdAt: 1000 });
  indexPublicShare(sql, { ...lee, shareId: 's2', kind: 'blueprint', title: 'Standup notes', createdAt: 2000 });
  indexPublicShare(sql, { ...lee, ownerEmail: 'lee@renamed.test', shareId: 's1', kind: 'live', title: 'Deploy status board', createdAt: 1000 });

  expect(rows(sql)).toEqual([
    ['s1', 'Deploy status board', 'lee@renamed.test'],
    ['s2', 'Standup notes', 'lee@example.test'],
  ]);
  expect(sql.exec('SELECT name FROM pragma_table_info(?) ORDER BY name', 'cp_public_shares').toArray().map((column) => column['name']))
    .toEqual(['created_at', 'kind', 'owner_email', 'owner_user_id', 'share_id', 'title', 'workspace']);

  forgetPublicShare(sql, { ownerUserId: lee.ownerUserId, workspace: 'ops-board', shareId: 's2' });
  forgetPublicShare(sql, { ownerUserId: lee.ownerUserId, workspace: 'other', shareId: 's1' });
  expect(rows(sql).map(([shareId]) => shareId)).toEqual(['s1']);
});
