import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// The Gallery's search on the SQLite a Durable Object runs in production: a LIKE or GLOB pattern there is at most 50
// bytes, so a search worded longer than that was refused as a whole, not answered (staging rc20, 2026-10-19).
it("the Gallery finds a listing by its whole line, however long, and matches its words in any letter case", async () => {
  const probe = env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName('gallery-search'));
  const line = 'First-run listing 3cd22212-223b-4e5d-9502-93015c6c29d3';

  expect(await probe.gallerySearch(line, line)).toEqual({ found: [line] });
  expect(await probe.gallerySearch(line, 'FIRST-RUN LISTING')).toEqual({ found: [line] });
  // What the words do not hold, nothing; a wildcard is its own character, never a pattern.
  expect(await probe.gallerySearch(line, `${line} and more`)).toEqual({ found: [] });
  expect(await probe.gallerySearch(line, 'First%listing')).toEqual({ found: [] });
});
