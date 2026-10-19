import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// Text matched on the SQLite a Durable Object runs in production: a LIKE or GLOB pattern there is at most 50 bytes, so
// a search worded longer than that was refused as a whole, not answered (staging rc20, 2026-10-19: 48 bytes answered,
// 49 refused). Each search here is matched as `textContains` matches it (core state/text-match.ts).
const probe = () => env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName('text-search'));

// Past the 48 bytes a LIKE pattern's two wildcards left room for.
const LONG = 'First-run listing 3cd22212-223b-4e5d-9502-93015c6c29d3';

it("the Gallery finds a listing by its whole line, however long, and matches its words in any letter case", async () => {
  expect(await probe().gallerySearch(LONG, LONG)).toEqual({ found: [LONG] });
  expect(await probe().gallerySearch(LONG, 'FIRST-RUN LISTING')).toEqual({ found: [LONG] });
  // What the words do not hold, nothing; a wildcard is its own character, never a pattern.
  expect(await probe().gallerySearch(LONG, `${LONG} and more`)).toEqual({ found: [] });
  expect(await probe().gallerySearch(LONG, 'First%listing')).toEqual({ found: [] });
});

it("an account's roster finds a workspace by its whole title, however long", async () => {
  const title = 'Quarterly planning for the platform team in Q4';

  for (const q of [title.slice(0, 49), `${title} again`.slice(0, 49), title]) {
    expect({ q, ...await probe().rosterSearch(title, q) }).toEqual({ q, found: title.toLowerCase().includes(q.toLowerCase()) ? [title] : [] });
  }

  expect(await probe().rosterSearch(title, 'QUARTERLY PLANNING')).toEqual({ found: [title] });
});

it("an agent program's state lists its keys under a prefix however long, and no other", async () => {
  const key = `${'reports/2026/q4/platform-team/'.repeat(2)}summary`;

  expect(await probe().programStateList(key, key.slice(0, 60))).toEqual({ found: [key] });
  expect(await probe().programStateList(key, `${key.slice(0, 59)}X`)).toEqual({ found: [] });
});
