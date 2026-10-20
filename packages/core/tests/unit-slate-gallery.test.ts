// The Gallery's index: listings only a workspace's share sync writes, found by words and category, sorted three ways,
// starred once per person, and gone with their stars when their share goes off. The listings are a cache the shares
// refill: a row lost to a repair comes back at the share's next sync, its stars waiting for it.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { GalleryIndex, initGalleryTables, KINU_LISTINGS, type KinuListing } from '../src/slates/gallery';
import type { GalleryCard, GalleryListingSync } from '../src/slates/share-modes';
import { makeExecRaw, makeSqlExec } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

const NOW = Date.UTC(2026, 9, 15);

const ASSISTANT: KinuListing = {
  id: 'personal-assistant', title: 'Personal assistant', line: 'Reads your mail and GitHub, and briefs you each day.', category: 'work', picture: 'assistant',
  needs: [{ connection: 'github', secret: null, access: 'read', why: 'Your reviews and mentions.' }],
};

const RELEASE: KinuListing = { id: 'release-manager', title: 'Release manager', line: 'Cuts the release and deploys staging.', category: 'developer', picture: null, needs: [] };

function newIndex() {
  const db = new Database(':memory:');

  initGalleryTables(makeExecRaw(db));

  return { db, index: new GalleryIndex(makeSqlExec(db)) };
}

/** `slate`'s share listed, as its workspace says it. */
function listed(slate: string, card: Partial<GalleryCard> = {}, share = `share-${slate}`): GalleryListingSync {
  return {
    share, workspace: 'sam', slate, handle: `handle-${slate}`, listed: true, url: `https://${slate}.slates.test/`,
    card: { title: `The ${slate}`, line: `A ${slate} for the team`, category: 'work', ownerName: 'Sam', picture: null, viewers: 0, ...card },
  };
}

function unlisted(slate: string, share = `share-${slate}`): GalleryListingSync {
  return { share, workspace: 'sam', slate, handle: `handle-${slate}`, listed: false };
}

test('a listing is found by its words and its category, and opens its share', () => {
  const { index } = newIndex();

  index.sync(listed('board'), NOW);
  index.sync(listed('budget', { category: 'money', line: 'Monthly spend' }), NOW + 1);

  expect(index.page({ q: 'spend', sort: 'new', category: null, page: 0 }, null, NOW).listings.map((each) => each.slate)).toEqual(['budget']);
  expect(index.page({ q: '', sort: 'new', category: 'work', page: 0 }, null, NOW).listings.map((each) => each.slate)).toEqual(['board']);
  expect(index.page({ q: '100%', sort: 'new', category: null, page: 0 }, null, NOW).listings).toEqual([]);
  expect(index.slate('sam', 'board', null, NOW)?.listing).toMatchObject({ share: 'share-board', url: 'https://board.slates.test/', starred: false });
});

test('stars count once per person, sort by all time or by this week, and the week\'s top two are featured', () => {
  const { index } = newIndex();

  for (const slate of ['old', 'new', 'quiet']) index.sync(listed(slate), NOW);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'old', on: true }, NOW - 30 * DAY);
  index.star({ email: 'b@x.dev', workspace: 'sam', slate: 'old', on: true }, NOW - 30 * DAY);
  index.star({ email: 'c@x.dev', workspace: 'sam', slate: 'new', on: true }, NOW - DAY);
  index.star({ email: 'c@x.dev', workspace: 'sam', slate: 'new', on: true }, NOW - DAY);

  const stars = index.page({ q: '', sort: 'stars', category: null, page: 0 }, 'c@x.dev', NOW).listings;
  const trending = index.page({ q: '', sort: 'trending', category: null, page: 0 }, null, NOW).listings;

  expect(stars.map((each) => [each.slate, each.stars, each.starred])).toEqual([['old', 2, false], ['new', 1, true], ['quiet', 0, false]]);
  expect(trending[0]).toMatchObject({ slate: 'new', featured: true });
  expect(trending.find((each) => each.slate === 'old')?.featured).toBe(false);
  expect(index.starred('c@x.dev', NOW).map((each) => each.slate)).toEqual(['new']);
});

test('unlisting a share takes its listing down with its stars, and an unlisted slate takes no star or report', () => {
  const { index } = newIndex();

  index.sync(listed('board'), NOW);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  index.sync(unlisted('board'), NOW);

  expect(index.slate('sam', 'board', null, NOW)).toBeNull();
  expect(index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW)).toBe(false);
  expect(index.report({ email: 'a@x.dev', workspace: 'sam', slate: 'board', reason: 'spam' }, NOW)).toBe(false);

  index.sync(listed('board'), NOW);
  expect(index.slate('sam', 'board', null, NOW)?.listing.stars).toBe(0);
});

test('an old share\'s late unlisting leaves the slate listed under its new share', () => {
  const { index } = newIndex();

  index.sync(listed('board', {}, 'share-old'), NOW);
  index.sync(listed('board', { line: 'Shared again' }, 'share-new'), NOW + 1);
  index.sync(unlisted('board', 'share-old'), NOW + 2);

  expect(index.slate('sam', 'board', null, NOW)?.listing).toMatchObject({ share: 'share-new', line: 'Shared again', listedAt: NOW });
});

test('a listing is a cache its share refills: a lost row comes back at the next sync, its stars waiting for it', () => {
  const { db, index } = newIndex();

  index.sync(listed('board'), NOW);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  db.exec("DELETE FROM gallery_listings WHERE item = 'board'");

  expect(index.slate('sam', 'board', null, NOW)).toBeNull();

  index.sync(listed('board'), NOW + DAY);
  expect(index.slate('sam', 'board', 'a@x.dev', NOW + DAY)?.listing).toMatchObject({ stars: 1, starred: true, listedAt: NOW + DAY });
});

test('a deleted account\'s stars, reports and installs go, and the others\' stay', () => {
  const { db, index } = newIndex();

  index.sync(listed('board'), NOW);
  index.syncKinu([ASSISTANT], NOW);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  index.star({ email: 'b@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  index.report({ email: 'a@x.dev', workspace: 'sam', slate: 'board', reason: 'spam' }, NOW);
  index.installed({ kind: 'workspace', workspace: KINU_LISTINGS, item: 'personal-assistant', userId: 'user-a' }, NOW);
  index.installed({ kind: 'workspace', workspace: KINU_LISTINGS, item: 'personal-assistant', userId: 'user-b' }, NOW);
  index.forget({ email: 'a@x.dev', userId: 'user-a' });

  expect(index.workspaceCard(KINU_LISTINGS, 'personal-assistant', null, NOW)?.installs).toBe(1);

  expect(index.slate('sam', 'board', 'a@x.dev', NOW)?.listing).toMatchObject({ stars: 1, starred: false });
  expect(index.starred('a@x.dev', NOW)).toEqual([]);
  expect(index.starred('b@x.dev', NOW).map((listing) => listing.slate)).toEqual(['board']);
  expect(db.query('SELECT COUNT(*) AS n FROM gallery_reports').get()).toEqual({ n: 0 });
});

test('a person reports a listing once: reporting it again replaces their reason, and someone else\'s is their own', () => {
  const { db, index } = newIndex();

  index.sync(listed('board'), NOW);
  expect(index.report({ email: 'a@x.dev', workspace: 'sam', slate: 'board', reason: 'spam' }, NOW)).toBe(true);
  expect(index.report({ email: 'a@x.dev', workspace: 'sam', slate: 'board', reason: 'spam, again' }, NOW)).toBe(true);
  expect(index.report({ email: 'b@x.dev', workspace: 'sam', slate: 'board', reason: 'spam' }, NOW)).toBe(true);
  expect(db.query('SELECT email, reason FROM gallery_reports ORDER BY email').all())
    .toEqual([{ email: 'a@x.dev', reason: 'spam, again' }, { email: 'b@x.dev', reason: 'spam' }]);
});

test('a page holds 24 listings and names the next one', () => {
  const { index } = newIndex();

  for (let n = 0; n < 30; n++) index.sync(listed(`s${String(n).padStart(2, '0')}`), NOW + n);
  const first = index.page({ q: '', sort: 'new', category: null, page: 0 }, null, NOW);
  const second = index.page({ q: '', sort: 'new', category: null, page: 1 }, null, NOW);

  expect([first.listings.length, first.next, second.listings.length, second.next]).toEqual([24, 1, 6, null]);
  expect(first.listings[0]?.slate).toBe('s29');
});

// Explore: Kinu's own workspace blueprints, written from code each start, listed first beside people's apps; each
// counted once per installer; and one a build stops keeping taken down, while apps stay as their shares left them.
test("Kinu's blueprints list first beside apps, count each installer once, and leave with the build that dropped them", () => {
  const { index } = newIndex();

  index.sync(listed('board'), NOW);
  index.syncKinu([ASSISTANT, RELEASE], NOW - DAY);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);

  const feed = index.explore({ q: '', kind: null, sort: 'trending', category: null, page: 0 }, null, NOW);

  expect(feed.items.map((item) => (item.kind === 'app' ? `app:${item.app.slate}` : `workspace:${item.workspace.id}`)))
    .toEqual(['workspace:personal-assistant', 'workspace:release-manager', 'app:board']);
  expect(feed.items[0]).toEqual({
    kind: 'workspace',
    workspace: {
      id: 'personal-assistant', title: 'Personal assistant', line: ASSISTANT.line, category: 'work', maker: { name: 'Kinu', kinu: true },
      picture: 'assistant', installs: 0, stars: 0, starred: false, needs: ASSISTANT.needs, listedAt: NOW - DAY, featured: false,
    },
  });

  expect(index.installed({ kind: 'workspace', workspace: KINU_LISTINGS, item: 'personal-assistant', userId: 'user-a' }, NOW)).toBe(true);
  expect(index.installed({ kind: 'workspace', workspace: KINU_LISTINGS, item: 'personal-assistant', userId: 'user-a' }, NOW)).toBe(true);
  expect(index.installed({ kind: 'workspace', workspace: KINU_LISTINGS, item: 'pricing-watch', userId: 'user-a' }, NOW)).toBe(false);
  expect(index.workspaceCard(KINU_LISTINGS, 'personal-assistant', null, NOW)?.installs).toBe(1);

  // Only one kind, by words; the Gallery's own page is apps alone.
  expect(index.explore({ q: 'release', kind: 'workspace', sort: 'new', category: null, page: 0 }, null, NOW).items.map((item) => item.kind)).toEqual(['workspace']);
  expect(index.page({ q: '', sort: 'new', category: null, page: 0 }, null, NOW).listings.map((each) => each.slate)).toEqual(['board']);

  // The next build keeps one: the other leaves, its listing time and installs kept on the one that stays.
  index.syncKinu([{ ...ASSISTANT, line: 'Your mail, GitHub and Google, briefed daily.' }], NOW);
  expect(index.explore({ q: '', kind: 'workspace', sort: 'new', category: null, page: 0 }, null, NOW).items)
    .toEqual([{ kind: 'workspace', workspace: expect.objectContaining({ id: 'personal-assistant', line: 'Your mail, GitHub and Google, briefed daily.', listedAt: NOW - DAY, installs: 1 }) }]);
});
