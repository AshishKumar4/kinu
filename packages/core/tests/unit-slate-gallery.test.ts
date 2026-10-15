// The Gallery's index: listings only a room writes, found by words and category, sorted three ways, starred once per
// person, and gone with their stars when the room takes them down.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { GalleryIndex, initGalleryTables, type GalleryEntry } from '../src/slates/gallery';
import { makeExecRaw, makeSqlExec } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

const NOW = Date.UTC(2026, 9, 15);

function newIndex(): GalleryIndex {
  const db = new Database(':memory:');

  initGalleryTables(makeExecRaw(db));

  return new GalleryIndex(makeSqlExec(db));
}

function entry(slate: string, over: Partial<GalleryEntry> = {}): GalleryEntry {
  return {
    workspace: 'sam', slate, title: `The ${slate}`, line: `A ${slate} for the team`, category: 'work', ownerName: 'Sam',
    url: `/s/sam/${slate}?k=key`, needs: [{ title: 'GitHub', kind: 'github' }], files: ['server.ts'], readsAuthor: false, picture: null, ...over,
  };
}

test('a listing is found by its words and its category, and says what a fork needs', () => {
  const index = newIndex();

  index.list(entry('board'), NOW);
  index.list(entry('budget', { category: 'money', line: 'Monthly spend' }), NOW + 1);

  expect(index.page({ q: 'spend', sort: 'new', category: null, page: 0 }, null, NOW).listings.map((each) => each.slate)).toEqual(['budget']);
  expect(index.page({ q: '', sort: 'new', category: 'work', page: 0 }, null, NOW).listings.map((each) => each.slate)).toEqual(['board']);
  expect(index.page({ q: '100%', sort: 'new', category: null, page: 0 }, null, NOW).listings).toEqual([]);
  expect(index.slate('sam', 'board', null, NOW)?.listing).toMatchObject({ needs: [{ title: 'GitHub', kind: 'github' }], url: '/s/sam/board?k=key', starred: false });
});

test('stars count once per person, sort by all time or by this week, and the week\'s top two are featured', () => {
  const index = newIndex();

  for (const slate of ['old', 'new', 'quiet']) index.list(entry(slate), NOW);
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

test('taking a listing down takes its stars, and a slate that is not listed takes no star or report', () => {
  const index = newIndex();

  index.list(entry('board'), NOW);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  index.unlist('sam', 'board');

  expect(index.slate('sam', 'board', null, NOW)).toBeNull();
  expect(index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW)).toBe(false);
  expect(index.report({ email: 'a@x.dev', workspace: 'sam', slate: 'board', reason: 'spam' }, NOW)).toBe(false);

  index.list(entry('board'), NOW);
  expect(index.slate('sam', 'board', null, NOW)?.listing.stars).toBe(0);
});

test('a deleted account\'s stars go, and the others\' stay', () => {
  const index = newIndex();

  index.list(entry('board'), NOW);
  index.star({ email: 'a@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  index.star({ email: 'b@x.dev', workspace: 'sam', slate: 'board', on: true }, NOW);
  index.forget('a@x.dev');

  expect(index.slate('sam', 'board', 'a@x.dev', NOW)?.listing).toMatchObject({ stars: 1, starred: false });
  expect(index.starred('a@x.dev', NOW)).toEqual([]);
  expect(index.starred('b@x.dev', NOW).map((listing) => listing.slate)).toEqual(['board']);
});

test('a page holds 24 listings and names the next one', () => {
  const index = newIndex();

  for (let n = 0; n < 30; n++) index.list(entry(`s${String(n).padStart(2, '0')}`), NOW + n);
  const first = index.page({ q: '', sort: 'new', category: null, page: 0 }, null, NOW);
  const second = index.page({ q: '', sort: 'new', category: null, page: 1 }, null, NOW);

  expect([first.listings.length, first.next, second.listings.length, second.next]).toEqual([24, 1, 6, null]);
  expect(first.listings[0]?.slate).toBe('s29');
});
