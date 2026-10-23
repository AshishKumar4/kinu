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
      card: { title: 'Board', line: `The ${workspace} board`, category: 'work', ownerName: 'Sam', picture: null, viewers: 0 },
    });
  }

  const listed = async () => (await index.explorePage(caller, { q: '', kind: 'app', sort: 'new', category: null, page: 0 }, null)).items
    .flatMap((item) => (item.kind === 'app' ? [item.app.workspace] : [])).sort();

  return { index, caller, listed };
}

test('a workspace the index forgets takes its Gallery listings with it', async () => {
  const { index, caller, listed } = await plane();

  expect(await listed()).toEqual(['notes', 'shop']);
  await index.forgetWorkspace(caller, { userId: 'u-1', name: 'shop' });
  expect(await listed()).toEqual(['notes']);
  expect(await index.galleryListed(caller, 'shop', 'board')).toBeNull();
});

// Staging 04603ec96: an eval account held about 4,000 removed workspaces, each forget re-forgot them all at 1.2 s, and
// the forgets the evals queued behind one another reset the object.
test("an account's removed workspaces cost the next forget nothing: each forgets its own, as at the account's first", async () => {
  /** Forty forgets, each of a listed workspace, after `removed` earlier removals: the statements they cost, and what stays listed. */
  const forgets = async (removed: number) => {
    const db = new Database(':memory:');
    const ctx = makeCtx(db, 'site');
    const index = new ControlPlaneDO(ctx, env);
    const caller = await internalCaller(env);
    const earlier = db.prepare('INSERT INTO cp_workspaces (user_id, name, display_name, created_at, last_seen_at, removed_at) VALUES (?, ?, ?, 1, 1, 2)');

    db.transaction(() => {
      for (let i = 0; i < removed; i++) earlier.run('u-eval', `eval-${String(i)}`, 'eval');
    })();

    for (const workspace of [...Array.from({ length: 40 }, (_, i) => `doomed-${String(i)}`), 'kept']) {
      await index.observeWorkspace(caller, { userId: 'u-eval', name: workspace, displayName: workspace, createdAt: 1, at: 1 });
      await index.gallerySync(caller, {
        share: `share-${workspace}`, workspace, slate: 'board', handle: '0123456789', listed: true, url: `https://app.test/shared/live/${workspace}/share-${workspace}`,
        card: { title: 'Board', line: `The ${workspace} board`, category: 'work', ownerName: 'Sam', picture: null, viewers: 0 },
      });
    }

    const sql = ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    let statements = 0;

    sql.exec = (query, ...bindings) => {
      statements += 1;

      return exec(query, ...bindings);
    };

    for (let i = 0; i < 40; i++) await index.forgetWorkspace(caller, { userId: 'u-eval', name: `doomed-${String(i)}` });

    return { statements, gone: await index.galleryListed(caller, 'doomed-7', 'board'), kept: await index.galleryListed(caller, 'kept', 'board') };
  };

  const first = await forgets(0);
  const fleet = await forgets(4_000);

  expect(fleet.statements).toBe(first.statements);
  expect(fleet.gone).toBeNull();
  expect(fleet.kept).not.toBeNull();
});

const A = { email: 'a@x.dev', userId: 'u-a' };

const B = { email: 'b@x.dev', userId: 'u-b' };

/** The operators' feedback list, as `kind email: note @ route`. */
async function feedbackOf(index: ControlPlaneDO): Promise<string[]> {
  return (await index.listFeedback(await adminControlToken(env))).items.map((row) => `${row.kind} ${row.email}: ${row.note} @ ${row.route}`);
}

test('a report of a listing is feedback the operators read: one per person, its latest reason, someone else\'s their own', async () => {
  const { index, caller } = await plane();
  const report = (reason: string) => ({ kind: 'report', workspace: 'shop', slate: 'board', reason }) as const;

  expect(await index.galleryMark(caller, A, report('spam'))).toBe(true);
  expect(await index.galleryMark(caller, A, report('spam, again'))).toBe(true);
  expect(await index.galleryMark(caller, B, report('spam'))).toBe(true);
  expect(await index.galleryMark(caller, A, { kind: 'report', workspace: 'shop', slate: 'missing', reason: 'spam' })).toBe(false);

  expect((await feedbackOf(index)).sort()).toEqual([
    'gallery_report a@x.dev: spam, again @ /gallery/shop/board', 'gallery_report b@x.dev: spam @ /gallery/shop/board',
  ]);
});

// The route is clamped for display at 512 characters, and these two slates' pages share their first 512.
test('two listings whose pages share a long prefix are two reports, not one replacing the other', async () => {
  const { index, caller } = await plane();
  const slates = ['界'.repeat(56) + 'a', '界'.repeat(56) + 'b'];

  for (const slate of slates) {
    await index.gallerySync(caller, {
      share: `share-${slate}`, workspace: 'shop', slate, handle: '0123456789', listed: true, url: `https://app.test/shared/live/shop/${slate}`,
      card: { title: 'Board', line: 'A long board', category: 'work', ownerName: 'Sam', picture: null, viewers: 0 },
    });
  }

  for (const [at, slate] of slates.entries()) {
    expect(await index.galleryMark(caller, A, { kind: 'report', workspace: 'shop', slate, reason: `report ${String(at)}` })).toBe(true);
  }

  const reports = (await index.listFeedback(await adminControlToken(env))).items.filter((row) => row.kind === 'gallery_report');

  expect(reports.map((row) => row.note).sort()).toEqual(['report 0', 'report 1']);
});

test("a deleted account's reports go with it; others' reports and its own feedback stay", async () => {
  const { index, caller } = await plane();

  await index.galleryMark(caller, A, { kind: 'report', workspace: 'shop', slate: 'board', reason: 'spam' });
  await index.galleryMark(caller, B, { kind: 'report', workspace: 'shop', slate: 'board', reason: 'spam' });
  await index.recordFeedback(caller, { id: 'f-1', createdAt: 1, userId: A.userId, email: A.email, note: 'slow', route: '/', workspace: null, bytes: null });
  await index.galleryForget(caller, A);

  expect((await feedbackOf(index)).sort()).toEqual(['feedback a@x.dev: slow @ /', 'gallery_report b@x.dev: spam @ /gallery/shop/board']);
});

test("an account's reconcile that finds a workspace gone forgets its listings, and keeps a live one's", async () => {
  const { index, listed } = await plane();

  await index.replaceUserWorkspaces(await adminControlToken(env), 'u-1', [{ name: 'notes', displayName: 'notes', createdAt: 1, lastVisited: 1 }]);
  expect(await listed()).toEqual(['notes']);
});
