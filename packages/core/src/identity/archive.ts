/**
 * Workspace archive — the ONE portable serialization of a workspace's durable
 * state, produced by both backends and consumed by both.
 *
 * Why a logical dump rather than the database file: a cloud workspace lives in
 * a Durable Object's SQLite, and a Worker has no way to hand out that file. A
 * backup format that only the local backend can write is not a backup format,
 * so the archive is schema + rows, read through a seam both `ctx.storage.sql`
 * and bun:sqlite satisfy. One writer, one reader, one file shape: an archive
 * exported from the cloud and an archive exported locally are the same bytes
 * for the same content, and `restoreWorkspaceArchive` takes either.
 *
 * The shape is JSON Lines so it streams in both directions — the cloud export
 * is paged (a DO answers one bounded page per RPC, never materializing a
 * workspace-sized string) and the restore consumes line by line. A trailing
 * `end` record is what makes a truncated download detectable rather than a
 * silently short restore.
 *
 * What is deliberately NOT in an archive: `workspace_capability`. That table
 * holds the secret the owner's UserDO minted to prove which workspace is
 * calling it — identity, not data (see ActorAgent.workspaceCapabilityToken:
 * "must not be reachable through any config or snapshot surface"). A restored
 * workspace is re-issued one by its owner; an archive never carries one.
 *
 * Consistency: pages are read one at a time, so a workspace actively taking a
 * turn during an export can land rows written between pages. It is a backup of
 * a live database, not a point-in-time snapshot — the honest guarantee, stated
 * because the alternative (a cross-RPC transaction) does not exist on a DO.
 */

import { base64ToBytes, bytesToBase64 } from '../utils/base64.js';
import type { AgentDatabase } from './inline-primitives.js';
import type { SqlExec } from '../types/primitives.js';

/** `SqlExec` over a local workspace database (the same `AgentDatabase` seam
 *  `wrapDatabase` takes), so the CLI's export and import speak to bun:sqlite
 *  exactly as the Durable Object speaks to its own storage. Statements run
 *  eagerly — DDL and INSERTs have no rows to pull. */
export function archiveSqlFromDatabase(db: AgentDatabase): SqlExec {
  return {
    exec(query, ...bindings) {
      // Canonical BLOBs are ArrayBuffers (DO storage's native type); bun:sqlite
      // binds TypedArrays only — the same coercion `wrapDatabase` makes.
      const bound = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      const rows = db.prepare(query).all(...bound) as Array<Record<string, unknown>>;
      return { toArray: () => rows };
    },
  };
}

/** Bumped only when a reader would misread an older archive. */
export const WORKSPACE_ARCHIVE_VERSION = 1;

/** File extension the CLI and the browser download use, so an archive is
 *  recognizable as one wherever it is stored. */
export const WORKSPACE_ARCHIVE_EXTENSION = '.proteus.jsonl';

/**
 * Tables an archive never carries. Everything else in the workspace's SQLite
 * is data the owner is entitled to a copy of.
 */
const EXCLUDED_TABLES = new Set(['workspace_capability']);

/** Durable-Object-internal tables (the KV shim and its metadata) and SQLite's
 *  own bookkeeping — neither is ours to restore. */
function isInternalTable(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_');
}

export interface ArchiveCursor {
  /** Table whose rows the next page resumes in. */
  table: string;
  /** Where in that table to resume: the last rowid already emitted, or — for a
   *  WITHOUT ROWID table, which has none — the number of rows already emitted.
   *  Keyset, not offset, because a table with a hundred thousand rows would
   *  otherwise cost a full scan per page. `null` starts the table: a rowid can
   *  legally be 0 or negative when the table declares its own INTEGER PRIMARY
   *  KEY, so no numeric sentinel can mean "before the first row". */
  after: number | null;
  /** Rows emitted by every page so far — the count the end record declares,
   *  and therefore what makes a short restore detectable. */
  rows: number;
}

export interface ArchivePage {
  /** JSON Lines, without trailing newlines. */
  lines: string[];
  /** Where to resume; null when the archive is complete. */
  next: ArchiveCursor | null;
}

export interface ArchiveExportOptions {
  workspace: string;
  /** Which backend produced it — provenance only; restore accepts either. */
  source: 'cloud' | 'local';
  /** Null starts a fresh archive (header + schema). */
  cursor?: ArchiveCursor | null;
  /** Soft budget for one page's encoded bytes. A row larger than the budget
   *  is still emitted whole — pages are bounded, rows are never split. */
  maxBytes?: number;
  now?: number;
}

interface ArchiveHeader {
  t: 'header';
  proteus_workspace_archive: number;
  workspace: string;
  source: 'cloud' | 'local';
  exported_at: number;
}

type SchemaKind = 'table' | 'index' | 'trigger' | 'view';

interface SchemaRecord {
  t: 'schema';
  kind: SchemaKind;
  name: string;
  sql: string;
  /** `CREATE VIRTUAL TABLE` — restored after the rows it indexes. */
  virtual?: true;
  /** External-content FTS5: rebuilt from its content table instead of dumped. */
  derived?: true;
}

interface RowRecord {
  t: 'row';
  table: string;
  values: Record<string, unknown>;
}

interface EndRecord {
  t: 'end';
  rows: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
/** Rows fetched before anything is known about how big this table's rows are.
 *  Small on purpose: one `SELECT` of a VFS chunk table pulls whole file bodies
 *  into memory, and a worker isolate has far less headroom than a page has
 *  budget. */
const FIRST_BATCH = 8;
const MAX_BATCH = 200;
/** Column the row query adds to carry the keyset position; stripped before a
 *  row is emitted. */
const ROWID_ALIAS = '__proteus_rowid';

interface SchemaObject {
  kind: SchemaKind;
  name: string;
  sql: string;
  virtual: boolean;
  derived: boolean;
  /** Rows live in the archive (false for an external-content FTS index). */
  dumpRows: boolean;
  withoutRowid: boolean;
}

/**
 * The schema this archive covers, in restore order: base tables, then the
 * virtual tables / indexes / triggers / views that sit on top of them.
 * Recomputed per page — `sqlite_master` is small, and re-reading it is what
 * keeps a resumed page honest about a schema that changed underneath it.
 */
function readSchema(sql: SqlExec): SchemaObject[] {
  const rows = sql.exec(
    `SELECT name, type, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view')`,
  ).toArray() as Array<{ name: string; type: SchemaKind; sql: string }>;

  const virtualNames = rows
    .filter((r) => r.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql))
    .map((r) => r.name);
  // FTS5 keeps its inverted index in `<name>_data` / `_idx` / `_docsize` /
  // `_config` tables. They are rebuilt from the virtual table, never dumped.
  const isShadow = (name: string) => virtualNames.some((v) => name.startsWith(`${v}_`));

  const objects: SchemaObject[] = [];
  for (const row of rows) {
    if (isInternalTable(row.name) || EXCLUDED_TABLES.has(row.name)) continue;
    if (row.type === 'table' && isShadow(row.name)) continue;
    const virtual = row.type === 'table' && virtualNames.includes(row.name);
    // `content=<table>` means every indexed value already lives in that table:
    // dumping the index too would duplicate the content and fight the triggers
    // that maintain it. Re-derive it after the rows land instead.
    const derived = virtual && /\bcontent\s*=\s*[^'"\s)]/i.test(row.sql);
    objects.push({
      kind: row.type,
      name: row.name,
      sql: row.sql,
      virtual,
      derived,
      dumpRows: row.type === 'table' && !derived,
      withoutRowid: /WITHOUT\s+ROWID/i.test(row.sql),
    });
  }
  // Base tables first so a streaming restore can create them as they arrive.
  const rank = (o: SchemaObject) => (o.kind === 'table' && !o.virtual ? 0 : 1);
  return objects.sort((a, b) => rank(a) - rank(b));
}

function encodeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { $b64: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return { $b64: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { $b64?: unknown }).$b64 === 'string') {
    return base64ToBytes((value as { $b64: string }).$b64);
  }
  return value;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One page of `workspace`'s archive. Call with `cursor: null` for the first
 * page and with the previous page's `next` thereafter, until `next` is null.
 */
export function readWorkspaceArchivePage(
  sql: SqlExec,
  opts: ArchiveExportOptions,
): ArchivePage {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const schema = readSchema(sql);
  const dumpable = schema.filter((o) => o.dumpRows);
  const lines: string[] = [];
  let bytes = 0;
  const emit = (record: ArchiveHeader | SchemaRecord | RowRecord | EndRecord): void => {
    const line = JSON.stringify(record);
    lines.push(line);
    bytes += line.length + 1;
  };

  let index = 0;
  let after: number | null = null;
  let rows = opts.cursor?.rows ?? 0;
  if (opts.cursor) {
    index = dumpable.findIndex((o) => o.name === opts.cursor!.table);
    if (index < 0) {
      throw new Error(`Cannot resume this export: table "${opts.cursor.table}" no longer exists.`);
    }
    after = opts.cursor.after;
  } else {
    const header: ArchiveHeader = {
      t: 'header',
      proteus_workspace_archive: WORKSPACE_ARCHIVE_VERSION,
      workspace: opts.workspace,
      source: opts.source,
      exported_at: opts.now ?? Date.now(),
    };
    emit(header);
    for (const object of schema) {
      emit({
        t: 'schema',
        kind: object.kind,
        name: object.name,
        sql: object.sql,
        ...(object.virtual ? { virtual: true as const } : {}),
        ...(object.derived ? { derived: true as const } : {}),
      });
    }
  }

  // How many rows to ask for next, measured from what THIS table's rows have
  // cost so far: enough to fill the budget, never enough to blow the isolate
  // on a table of megabyte blobs. Per table, because a page that has just
  // streamed a thousand one-line events knows nothing about the sizes in the
  // file-chunk table it is about to open.
  let emitted = 0;
  let emittedBytes = 0;
  const nextBatch = (): number => {
    if (emitted === 0) return FIRST_BATCH;
    return Math.min(MAX_BATCH, Math.max(1, Math.ceil(maxBytes / (emittedBytes / emitted))));
  };

  while (index < dumpable.length) {
    const table = dumpable[index]!;
    const size = nextBatch();
    const rowidSelect = `SELECT rowid AS ${quoteIdent(ROWID_ALIAS)}, * FROM ${quoteIdent(table.name)}`;
    const batch = table.withoutRowid
      ? sql.exec(`SELECT * FROM ${quoteIdent(table.name)} LIMIT ? OFFSET ?`, size, after ?? 0).toArray()
      : after === null
        ? sql.exec(`${rowidSelect} ORDER BY rowid LIMIT ?`, size).toArray()
        : sql.exec(`${rowidSelect} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, size).toArray();

    for (const row of batch) {
      const values: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(row)) {
        if (column !== ROWID_ALIAS) values[column] = encodeValue(value);
      }
      const before = bytes;
      emit({ t: 'row', table: table.name, values });
      rows++;
      emitted++;
      emittedBytes += bytes - before;
      after = table.withoutRowid ? (after ?? 0) + 1 : Number(row[ROWID_ALIAS]);
      // Checked per row, not per batch: one oversized row must end the page
      // rather than ride along with a batch's worth of others.
      if (bytes >= maxBytes) return { lines, next: { table: table.name, after, rows } };
    }

    if (batch.length < size) {
      index++;
      after = null;
      emitted = 0;
      emittedBytes = 0;
    }
  }

  emit({ t: 'end', rows });
  return { lines, next: null };
}

/** Whole archive in one call — for a caller with the database in hand and no
 *  transport in the middle (the local export, and tests). */
export function writeWorkspaceArchive(sql: SqlExec, opts: ArchiveExportOptions): string[] {
  const lines: string[] = [];
  let cursor: ArchiveCursor | null = null;
  do {
    const page = readWorkspaceArchivePage(sql, { ...opts, cursor });
    lines.push(...page.lines);
    cursor = page.next;
  } while (cursor);
  return lines;
}

export interface ArchiveRestoreResult {
  workspace: string;
  source: string;
  exportedAt: number;
  tables: number;
  rows: number;
}

/**
 * Rebuild a workspace's SQLite state from an archive, into an EMPTY database.
 * Streams: base tables are created as their records arrive, rows are inserted
 * as they arrive, and the objects that depend on the rows (FTS indexes, other
 * indexes, triggers, views) are applied at the end — so a large archive never
 * has to be held in memory, and an FTS index is rebuilt against complete
 * content rather than maintained row by row.
 */
export function restoreWorkspaceArchive(sql: SqlExec, lines: Iterable<string>): ArchiveRestoreResult {
  let header: ArchiveHeader | null = null;
  let end: EndRecord | null = null;
  const deferred: SchemaRecord[] = [];
  let tables = 0;
  let rows = 0;
  let insert: { table: string; columns: string[]; statement: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: ArchiveHeader | SchemaRecord | RowRecord | EndRecord;
    try {
      record = JSON.parse(trimmed) as typeof record;
    } catch {
      throw new Error('This file is not a Proteus workspace archive (unparsable line).');
    }
    if (!header) {
      if (record.t !== 'header' || record.proteus_workspace_archive !== WORKSPACE_ARCHIVE_VERSION) {
        throw new Error(
          `This file is not a Proteus workspace archive v${WORKSPACE_ARCHIVE_VERSION}.`,
        );
      }
      header = record;
      continue;
    }
    if (end) throw new Error('This archive has records after its end marker.');

    switch (record.t) {
      case 'header':
        throw new Error('This archive has more than one header.');
      case 'schema':
        if (record.kind === 'table' && !record.virtual) {
          sql.exec(record.sql);
          tables++;
        } else {
          deferred.push(record);
        }
        break;
      case 'row': {
        const columns = Object.keys(record.values);
        if (!insert || insert.table !== record.table || insert.columns.length !== columns.length) {
          insert = {
            table: record.table,
            columns,
            statement: `INSERT INTO ${quoteIdent(record.table)} (${columns.map(quoteIdent).join(', ')})`
              + ` VALUES (${columns.map(() => '?').join(', ')})`,
          };
        }
        sql.exec(insert.statement, ...columns.map((c) => decodeValue(record.values[c])));
        rows++;
        break;
      }
      case 'end':
        end = record;
        break;
    }
  }

  if (!header) throw new Error('This file is not a Proteus workspace archive (no header).');
  if (!end) throw new Error('This archive is incomplete — the export did not finish.');
  if (end.rows !== rows) {
    throw new Error(`This archive is damaged: it declares ${end.rows} rows but carries ${rows}.`);
  }

  for (const record of deferred) sql.exec(record.sql);
  // External-content FTS indexes carry no rows of their own; they are derived
  // from the content tables, which are now populated.
  for (const record of deferred) {
    if (record.derived) {
      sql.exec(`INSERT INTO ${quoteIdent(record.name)} (${quoteIdent(record.name)}) VALUES ('rebuild')`);
    }
  }

  return {
    workspace: header.workspace,
    source: header.source,
    exportedAt: header.exported_at,
    tables,
    rows,
  };
}
