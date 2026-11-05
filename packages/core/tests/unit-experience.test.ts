// The owner's experience library: what is published reads back ranked and filtered, and an unreadable row is skipped.
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeSqlExec } from './helpers';
import { createExperienceLibrary, initExperienceLibraryTables, type ExperienceLibraryStore, type SqlExec } from '../src/index';

function sqlExec(db: Database): SqlExec {
  return makeSqlExec(db);
}

function ownerLibrary(): ExperienceLibraryStore {
  const db = new Database(':memory:');
  const exec = sqlExec(db);
  initExperienceLibraryTables(exec);

  return createExperienceLibrary(exec);
}

describe('library search', () => {
  test('ranks on content and filters by kind', () => {
    const library = ownerLibrary();
    library.publish({
      key: 'l1', title: 'Wrangler deploys need an account id', evidence: 'corroborated',
      payload: { kind: 'lesson', text: 'Set CLOUDFLARE_ACCOUNT_ID before wrangler deploy.' },
    }, 'alpha');
    library.publish({
      key: 'deploy.target', title: 'deploy.target', evidence: 'confident',
      payload: { kind: 'fact', key: 'deploy.target', value: 'kinu.workers.dev', confidence: 1 },
    }, 'alpha');

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
      const db = new Database(':memory:');
      const exec = sqlExec(db);
      initExperienceLibraryTables(exec);
      const library = createExperienceLibrary(exec);
      library.publish({
        key: 'ok', title: 'ok', evidence: 'e',
        payload: { kind: 'fact', key: 'ok', value: 1, confidence: 1 },
      }, 'alpha');
      db.prepare(`INSERT INTO experience_library
        (id, kind, source_workspace, key, title, payload_json, evidence, search_text, published_at)
        VALUES (?, ?, 'alpha', 'bad', 'bad', ?, 'e', 'bad', 1)`)
        .run(unreadable.id, unreadable.kind, unreadable.payload);

      expect(library.search().map((e) => e.key)).toEqual(['ok']);
      expect(library.get(unreadable.id)).toBeNull();
    });
  }
});
