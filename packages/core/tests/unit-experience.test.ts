// The owner's experience library: what was published reads back ranked and filtered, and an unreadable row is skipped.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { createExperienceLibrary, initExperienceLibraryTables, type ExperienceEntry } from '../src/index';

/** The library over rows as a publish wrote them: `search_text` held the title, key, evidence and payload text. */
function ownerLibrary(entries: readonly Omit<ExperienceEntry, 'id' | 'publishedAt'>[]) {
  const db = new Database(':memory:');
  const exec = makeSqlExec(db);
  initExperienceLibraryTables(exec);

  for (const [at, entry] of entries.entries()) {
    db.prepare(`INSERT INTO experience_library
      (id, kind, source_workspace, key, title, payload_json, evidence, search_text, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`exp-${String(at)}`, entry.payload.kind, entry.sourceWorkspace, entry.key, entry.title, JSON.stringify(entry.payload), entry.evidence,
        [entry.title, entry.key, entry.evidence, JSON.stringify(entry.payload)].join('\n'), at + 1);
  }

  return { db, library: createExperienceLibrary(exec) };
}

describe('library search', () => {
  test('ranks on content and filters by kind', () => {
    const { library } = ownerLibrary([
      {
        key: 'l1', title: 'Wrangler deploys need an account id', evidence: 'corroborated', sourceWorkspace: 'alpha',
        payload: { kind: 'lesson', text: 'Set CLOUDFLARE_ACCOUNT_ID before wrangler deploy.' },
      },
      {
        key: 'deploy.target', title: 'deploy.target', evidence: 'confident', sourceWorkspace: 'alpha',
        payload: { kind: 'fact', key: 'deploy.target', value: 'kinu.workers.dev', confidence: 1 },
      },
    ]);

    expect(library.search({ query: 'wrangler' }).map((e) => e.key)).toEqual(['l1']);
    expect(library.search({ kind: 'fact' }).map((e) => e.key)).toEqual(['deploy.target']);
    expect(library.search({ excludeWorkspace: 'alpha' })).toEqual([]);
    // Punctuation in a query is data, never FTS syntax.
    expect(library.search({ query: 'wrangler "OR" NEAR(' }).map((e) => e.key)).toEqual(['l1']);
  });

  const UNREADABLE_ROWS = [
    {
      name: 'a malformed stored payload is skipped rather than half-parsed',
      id: 'exp-bad', kind: 'craft', payload: '{"kind":"craft"}',
    },
    {
      name: 'a non-JSON stored payload is skipped like a shape mismatch',
      id: 'exp-nonjson', kind: 'lesson', payload: 'not-json{{{',
    },
  ];

  for (const unreadable of UNREADABLE_ROWS) {
    test(unreadable.name, () => {
      const { db, library } = ownerLibrary([{
        key: 'ok', title: 'ok', evidence: 'e', sourceWorkspace: 'alpha',
        payload: { kind: 'fact', key: 'ok', value: 1, confidence: 1 },
      }]);

      db.prepare(`INSERT INTO experience_library
        (id, kind, source_workspace, key, title, payload_json, evidence, search_text, published_at)
        VALUES (?, ?, 'alpha', 'bad', 'bad', ?, 'e', 'bad', 1)`)
        .run(unreadable.id, unreadable.kind, unreadable.payload);

      expect(library.search().map((e) => e.key)).toEqual(['ok']);
    });
  }
});
