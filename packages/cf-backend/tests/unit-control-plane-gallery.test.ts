// A removed workspace sends the Gallery no more syncs, so the control plane forgets its listings where it learns the
// workspace is gone: when it is forgotten, and when an account's reconcile finds it absent. A live one keeps its own.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { adminControlToken, internalCaller } from '@kinu.run/core/control-plane';
import { ControlPlaneDO } from '../src/control-plane/control-plane-do';
import { workerEnv } from './helpers/bindings';
import { makeCtx } from './helpers/platform-context';

const env = workerEnv({ CREDENTIAL_ENCRYPTION_KEY: 'c'.repeat(64) });

async function plane() {
  const index = new ControlPlaneDO(makeCtx(new Database(':memory:'), 'site'), env);
  const caller = await internalCaller(env);

  for (const workspace of ['shop', 'notes']) {
    await index.observeWorkspace(caller, { userId: 'u-1', name: workspace, displayName: workspace, createdAt: 1, at: 1 });
    await index.gallerySync(caller, {
      share: `share-${workspace}`, workspace, slate: 'board', handle: '0123456789', listed: true, url: `https://app.test/shared/live/${workspace}/share-${workspace}`,
      card: { title: 'Board', line: `The ${workspace} board`, category: 'work', ownerName: 'Sam', picture: null },
    });
  }

  const listed = async () => (await index.galleryPage(caller, { q: '', sort: 'new', category: null, page: 0 }, null)).listings.map((each) => each.workspace).sort();

  return { index, caller, listed };
}

test('a workspace the index forgets takes its Gallery listings with it', async () => {
  const { index, caller, listed } = await plane();

  expect(await listed()).toEqual(['notes', 'shop']);
  await index.forgetWorkspace(caller, { userId: 'u-1', name: 'shop' });
  expect(await listed()).toEqual(['notes']);
  expect(await index.galleryListed(caller, 'shop', 'board')).toBeNull();
});

test("an account's reconcile that finds a workspace gone forgets its listings, and keeps a live one's", async () => {
  const { index, listed } = await plane();

  await index.replaceUserWorkspaces(await adminControlToken(env), 'u-1', [{ name: 'notes', displayName: 'notes', createdAt: 1, lastVisited: 1 }]);
  expect(await listed()).toEqual(['notes']);
});
