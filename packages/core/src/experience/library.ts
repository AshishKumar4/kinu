/**
 * The owner's experience library — one shared knowledge base per user, living
 * beside the owner's other user-level state.
 *
 * Portable by construction (the `ReleaseSqlStore` pattern): core owns the
 * schema and the queries, the backend supplies an exec seam and the capability
 * gate around it. The library is deliberately OWNER-SCOPED — there is no
 * cross-owner path here and no grant concept to get wrong; reach into it is
 * attenuated at the same boundary every other user-level surface is.
 *
 * Entries outlive their source workspace on purpose. Publishing is an explicit
 * act that moves knowledge from a workspace into the OWNER's library; deleting
 * the workspace afterwards does not un-publish it, the same way deleting a
 * repository does not un-publish a release.
 */

import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import {
  EXPERIENCE_KINDS,
  experienceSearchText,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type PublishableCandidate,
} from './types';
import type { SqlExec } from '../types/primitives';
import { sqlCheckList } from '../identity/schema';
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
  const storedDdl = (name: string): string | null => {
    const row = sql.exec(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
    ).toArray()[0];
    return row ? v.parse(v.object({ sql: v.string() }), row).sql : null;
  };

  // Widening the kind CHECK: SQLite cannot ALTER one, so a library created
  // before a kind was added has to be rebuilt in place (the same discipline
  // turn_outcomes needed — see evolution/outcomes.ts). The probe is the kind
  // LIST itself, so adding a member is the only edit ever needed here, and the
  // `_legacy` table is the resume point for a crash mid-sequence: rows stranded
  // there must be copied before a bare CREATE IF NOT EXISTS starts an empty one.
  const live = storedDdl('experience_library');
  const narrow = live !== null && EXPERIENCE_KINDS.some((kind) => !live.includes(`'${kind}'`));
  const stranded = storedDdl('experience_library_legacy') !== null;
  if (narrow) {
    // Triggers are renamed WITH their table and keep their names, so a later
    // CREATE TRIGGER IF NOT EXISTS would no-op and leave the new table
    // unindexed. The FTS table names its content table in its own CREATE, which
    // a rename does not rewrite — it holds no content of its own, so dropping
    // and rebuilding the index below is the whole cost.
    for (const suffix of ['ai', 'ad', 'au']) {
      sql.exec(`DROP TRIGGER IF EXISTS experience_library_${suffix}`);
    }
    sql.exec(`DROP TABLE IF EXISTS experience_library_fts`);
    sql.exec(`ALTER TABLE experience_library RENAME TO experience_library_legacy`);
  }

  sql.exec(`CREATE TABLE IF NOT EXISTS experience_library ${ddl}`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_experience_library_published
              ON experience_library (published_at DESC)`);

  // External-content FTS5 over the row's own columns, kept in sync by
  // triggers — the same shape CraftStore uses, so there is one FTS idiom in
  // the codebase rather than two.
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

  if (narrow || stranded) {
    sql.exec(`INSERT OR IGNORE INTO experience_library SELECT * FROM experience_library_legacy`);
    sql.exec(`DROP TABLE experience_library_legacy`);
    // The copy above fired the insert trigger, and a surviving index may still
    // hold the old table's rows; 'rebuild' replaces the whole index from the
    // content table, so neither duplicates nor stale rows can remain.
    sql.exec(`INSERT INTO experience_library_fts(experience_library_fts) VALUES('rebuild')`);
  }
}

export interface ExperienceSearchOptions {
  /** Free-text query. Omitted (or blank) lists the newest entries instead. */
  query?: string;
  kind?: ExperienceKind;
  /** The calling workspace's own entries — excluded, because importing what
   *  you already have is noise, not transfer. */
  excludeWorkspace?: string;
  limit?: number;
}

export interface ExperienceLibraryStore {
  /** Publish (or replace, by (workspace, kind, key)) one entry. */
  publish(candidate: PublishableCandidate, sourceWorkspace: string): ExperienceEntry;
  search(options?: ExperienceSearchOptions): ExperienceEntry[];
  get(id: string): ExperienceEntry | null;
}

const DEFAULT_SEARCH_LIMIT = 10;


const LibraryRowSchema = v.object({
  id: v.string(),
  kind: v.picklist(EXPERIENCE_KINDS),
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
  if (!payload || payload.kind !== row.kind) return null;
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    title: row.title,
    payload,
    evidence: row.evidence,
    sourceWorkspace: row.source_workspace,
    publishedAt: row.published_at,
  };
}

/** FTS5 MATCH input from free text: quote every term so punctuation in a user
 *  query can never be read as query syntax, and OR them so a multi-word query
 *  ranks rather than requires. */
function ftsQuery(query: string): string | null {
  const terms = query.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export function createExperienceLibrary(sql: SqlExec): ExperienceLibraryStore {
  const rows = (query: string, ...bindings: SqlValue[]): LibraryRow[] =>
    sql.exec(query, ...bindings).toArray().map((row) => v.parse(LibraryRowSchema, row));

  return {
    publish(candidate, sourceWorkspace) {
      const id = `exp-${nanoid()}`;
      const publishedAt = nowMs();
      // ON CONFLICT keeps the ORIGINAL id when a workspace re-publishes the
      // same key, so an importer's provenance reference stays valid across
      // refreshes of the same knowledge.
      sql.exec(
        `INSERT INTO experience_library
           (id, kind, source_workspace, key, title, payload_json, evidence, search_text, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_workspace, kind, key) DO UPDATE SET
           title        = excluded.title,
           payload_json = excluded.payload_json,
           evidence     = excluded.evidence,
           search_text  = excluded.search_text,
           published_at = excluded.published_at`,
        id, candidate.kind, sourceWorkspace, candidate.key, candidate.title,
        JSON.stringify(candidate.payload), candidate.evidence,
        experienceSearchText(candidate), publishedAt,
      );
      const stored = rows(
        `SELECT * FROM experience_library
          WHERE source_workspace = ? AND kind = ? AND key = ? LIMIT 1`,
        sourceWorkspace, candidate.kind, candidate.key,
      )[0];
      const entry = stored ? toEntry(stored) : null;
      if (!entry) throw new Error('experience entry did not survive publication');
      return entry;
    },

    search(options: ExperienceSearchOptions = {}) {
      // The caller's limit is honoured — a reader that asks for 50 rows gets
      // 50 rows, not a silent 25.
      const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT);
      const match = options.query ? ftsQuery(options.query) : null;
      // '' matches nothing for kind (the CHECK constraint forbids it) and
      // nothing for a workspace name, so one statement per shape serves both
      // the filtered and unfiltered cases without string-built SQL.
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

    get(id) {
      const row = rows(`SELECT * FROM experience_library WHERE id = ? LIMIT 1`, id)[0];
      return row ? toEntry(row) : null;
    },
  };
}
