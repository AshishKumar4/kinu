import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// docs/MAIL.md §11's search, measured on the SQLite a Durable Object runs: FTS5 with contentless_delete (SQLite 3.43+;
// the version itself is not readable there, since sqlite_version() is refused as unauthorized),
// long queries (a LIKE there is refused past 50 bytes), the search box's words quoted, and a row deleted from the index.
// Measured 2026-10-19 here and, with the same rows and queries plus a 5,320-character one, on a deployed Durable Object
// (scratch Worker kinu-mail-probe, 19:18 UTC): every result matched. Without contentless_delete the delete fails and so
// does this test.
const probe = () => env.SLATE_SHARE_PROBE.get(env.SLATE_SHARE_PROBE.idFromName('mail-search'));

const ROWS = [
  { rowid: 1, subject: 'Self-hosted Kinu: Gmail says my replies fail DMARC', sender: 'Priya Raman priya@raman.dev', body: 'I see only cf-bounce records and no _dmarc record. Café on raman.dev.' },
  { rowid: 2, subject: 'Your Cloudflare invoice for October 2026', sender: 'Cloudflare Billing billing@cloudflare.com', body: 'Workers Paid, Durable Objects requests, R2 storage.' },
  { rowid: 3, subject: 'Which inbound parser keeps Authentication-Results?', sender: 'research research.ashish@kinu.run', body: 'Only the topmost Authentication-Results counts, with authserv-id checked.' },
];

/** The search box's words, each a quoted phrase: the box never speaks FTS5's query language. */
const quoted = (box: string): string => box.split(/\s+/u).filter(Boolean).map((word) => `"${word.replaceAll('"', '""')}"`).join(' ');

const LONG = quoted(`${'only the topmost authentication results counts '.repeat(6)}authserv`);

it('mail search runs on FTS5 in a Durable Object: long queries, quoted words, prefixes, diacritics, and deletes', async () => {
  const queries = [
    'dmarc', quoted('cf-bounce records'), 'authent*', 'subject:invoice', LONG, quoted('research.ashish@kinu.run'), 'cafe',
    // Raw box text in FTS5's own syntax: refused, which is why the box's words are quoted.
    'research.ashish@kinu.run',
  ];

  const measured = await probe().mailSearch(ROWS, queries, [3]);

  expect({ made: measured.made, indexed: measured.indexed }).toEqual({ made: { found: [] }, indexed: { found: [1, 2, 3] } });
  expect(LONG.length).toBeGreaterThan(300);
  expect(measured.before).toEqual([
    { found: [1] }, { found: [1] }, { found: [3] }, { found: [2] }, { found: [3] }, { found: [3] }, { found: [1] },
    { failed: expect.stringContaining('syntax error') },
  ]);
  expect(measured.removed).toEqual({ found: [3] });
  expect(measured.after.slice(0, 7)).toEqual([{ found: [1] }, { found: [1] }, { found: [] }, { found: [2] }, { found: [] }, { found: [] }, { found: [1] }]);
  console.log(JSON.stringify({ longQueryChars: LONG.length, before: measured.before }));
});
