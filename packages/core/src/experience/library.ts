// Owner-scoped experience library (no cross-owner path); entries deliberately outlive their source workspace.

import { ftsPhrases } from '@kinu.run/agent-utils/memory';
import {
  EXPERIENCE_KINDS,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
} from './types';
import type { SqlExec } from '../types/primitives';
import { sqlCheckList } from '../utils/sql';
import type { SqlValue } from '../types/primitives';
import * as v from 'valibot';

export function initExperienceLibraryTables(sql: SqlExec): void {
  const ddl = `(
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL CHECK (kind IN (${sqlCheckList(EXPERIENCE_KINDS)})),
      source_workspace TEXT NOT NULL,
      key              TEXT NOT NULL,
      title            TEXT NOT NULL,
      payload_json     TEXT NOT NULL,
      evidence         TEXT NOT NULL,
      search_text      TEXT NOT NULL,
      published_at     INTEGER NOT NULL,
      UNIQUE (source_workspace, kind, key)
    )`;

  sql.exec(`CREATE TABLE IF NOT EXISTS experience_library ${ddl}`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_experience_library_published
              ON experience_library (published_at DESC)`);

  // Same trigger-synced external-content FTS5 idiom as CraftStore.
  sql.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS experience_library_fts USING fts5(
      title, key, evidence, search_text,
      content=experience_library, content_rowid=rowid
    )
  `);
  sql.exec(`
    CREATE TRIGGER IF NOT EXISTS experience_library_ai AFTER INSERT ON experience_library BEGIN
      INSERT INTO experience_library_fts(rowid, title, key, evidence, search_text)
      VALUES (new.rowid, new.title, new.key, new.evidence, new.search_text);
    END
  `);
  sql.exec(`
    CREATE TRIGGER IF NOT EXISTS experience_library_ad AFTER DELETE ON experience_library BEGIN
      INSERT INTO experience_library_fts(experience_library_fts, rowid, title, key, evidence, search_text)
      VALUES ('delete', old.rowid, old.title, old.key, old.evidence, old.search_text);
    END
  `);
  sql.exec(`
    CREATE TRIGGER IF NOT EXISTS experience_library_au AFTER UPDATE ON experience_library BEGIN
      INSERT INTO experience_library_fts(experience_library_fts, rowid, title, key, evidence, search_text)
      VALUES ('delete', old.rowid, old.title, old.key, old.evidence, old.search_text);
      INSERT INTO experience_library_fts(rowid, title, key, evidence, search_text)
      VALUES (new.rowid, new.title, new.key, new.evidence, new.search_text);
    END
  `);
}

export interface ExperienceSearchOptions {
  /** Omitted or blank lists the newest entries. */
  query?: string;
  kind?: ExperienceKind;
  excludeWorkspace?: string;
  limit?: number;
}

export interface ExperienceLibraryStore {
  search(options?: ExperienceSearchOptions): ExperienceEntry[];
}

const DEFAULT_SEARCH_LIMIT = 10;

const LibraryRowSchema = v.object({
  id: v.string(),
  source_workspace: v.string(),
  key: v.string(),
  title: v.string(),
  payload_json: v.string(),
  evidence: v.string(),
  published_at: v.number(),
});

type LibraryRow = v.InferOutput<typeof LibraryRowSchema>;

function toEntry(row: LibraryRow): ExperienceEntry | null {
  const payload = parseExperiencePayload(row.payload_json);

  if (!payload) return null;

  return {
    id: row.id,
    key: row.key,
    title: row.title,
    payload,
    evidence: row.evidence,
    sourceWorkspace: row.source_workspace,
    publishedAt: row.published_at,
  };
}

export function createExperienceLibrary(sql: SqlExec): ExperienceLibraryStore {
  const rows = (query: string, ...bindings: SqlValue[]): LibraryRow[] =>
    sql.exec(query, ...bindings).toArray().map((row) => v.parse(LibraryRowSchema, row));

  return {
    search(options: ExperienceSearchOptions = {}) {
      const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT);
      const match = options.query ? ftsPhrases(options.query).join(' OR ') || null : null;
      // '' matches no kind or workspace, so one statement serves filtered and unfiltered cases.
      const kind = options.kind ?? '';
      const exclude = options.excludeWorkspace ?? '';

      const found = match
        ? rows(
            `SELECT e.* FROM experience_library e
               JOIN experience_library_fts f ON e.rowid = f.rowid
              WHERE experience_library_fts MATCH ?
                AND (? = '' OR e.kind = ?)
                AND e.source_workspace <> ?
              ORDER BY rank LIMIT ?`,
            match, kind, kind, exclude, limit,
          )
        : rows(
            `SELECT * FROM experience_library
              WHERE (? = '' OR kind = ?) AND source_workspace <> ?
              ORDER BY published_at DESC LIMIT ?`,
            kind, kind, exclude, limit,
          );

      return found.map(toEntry).filter((e): e is ExperienceEntry => e !== null);
    },
  };
}
