/**
 * Workspace archive — the ONE portable serialization of a workspace's durable
 * state, produced by both backends and consumed by both. Database rows and
 * workspace files are records in this one stream; files do not become a
 * second backup endpoint merely because a hosted workspace keeps them in its
 * authoritative Nimbus session rather than the actor's SQLite.
 *
 * Why a logical dump rather than the database file: a cloud workspace lives in
 * a Durable Object's SQLite, and a Worker has no way to hand out that file. A
 * backup format that only the local backend can write is not a backup format,
 * so the database half is schema + rows, read through a seam both
 * `ctx.storage.sql` and bun:sqlite satisfy. Workspace files join that same
 * logical record stream when their authoritative store is external. One
 * writer, one reader, one file shape; `restoreWorkspaceArchive` takes either
 * backend's output.
 *
 * The shape is JSON Lines so it streams in both directions — the cloud export
 * is paged (a DO answers one bounded page per RPC, never materializing a
 * workspace-sized string) and the restore consumes line by line. A trailing
 * `end` record declares both row and file counts, which makes a truncated
 * download detectable rather than a silently short restore.
 *
 * What is deliberately NOT in an archive: `workspace_capability`, which holds
 * the secret the owner's UserDO minted to prove which workspace is calling it
 * — identity, not data (see ActorAgent.workspaceCapabilityToken: "must not be
 * reachable through any config or snapshot surface"). A restored workspace is
 * re-issued one by its owner; an archive never carries one. And
 * `webhook_secrets`, a live ingress credential rather than workspace state —
 * see EXCLUDED_TABLES below.
 *
 * Consistency: pages are read one at a time, so a workspace actively taking a
 * turn during an export can land rows or files written between pages. It is a
 * backup of live storage, not a point-in-time snapshot — the honest guarantee,
 * stated because a transaction cannot span actor SQLite and a Nimbus session.
 */

import * as v from 'valibot';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import type { AgentDatabase } from './inline-primitives';
import type { SqlExec } from '../types/primitives';
import type { JsonPrimitive } from '../utils/json';

type ArchiveDatabaseValue = JsonPrimitive | ArrayBuffer;
type NativeArchiveDatabaseValue = ArchiveDatabaseValue | Uint8Array;
interface NativeArchiveDatabaseRow {
  [column: string]: NativeArchiveDatabaseValue;
}

const ArchiveDatabaseValueSchema: v.GenericSchema<ArchiveDatabaseValue> = v.union([
  v.string(), v.number(), v.boolean(), v.null(), v.instance(ArrayBuffer),
]);
const ArchiveDatabaseRowSchema = v.record(v.string(), ArchiveDatabaseValueSchema);

function bytesAsArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function canonicalDatabaseValue(value: NativeArchiveDatabaseValue): ArchiveDatabaseValue {
  return value instanceof Uint8Array ? bytesAsArrayBuffer(value) : value;
}

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
      const rows = db.prepare<NativeArchiveDatabaseRow>(query).all(...bound);
      return {
        toArray: () => rows.map((row) => Object.fromEntries(
          Object.entries(row).map(([column, value]) => [column, canonicalDatabaseValue(value)]),
        )),
      };
    },
  };
}

/** Bumped only when a reader would misread an older archive. */
export const WORKSPACE_ARCHIVE_VERSION = 2;

/** File extension the CLI and the browser download use, so an archive is
 *  recognizable as one wherever it is stored. */
export const WORKSPACE_ARCHIVE_EXTENSION = '.kinu.jsonl';

/**
 * Tables an archive never carries. Everything else in the workspace's SQLite
 * is data the owner is entitled to a copy of.
 *
 * `webhook_secrets` holds the plaintext HMAC/bearer secret an ingress
 * endpoint was created with (events/ingress/secrets.ts) — a live credential,
 * not workspace data, and restoring it verbatim would round-trip a secret
 * through a file on disk. `listTriggers` already reads triggers without it
 * (secrets live in their own table for exactly this reason); an archive
 * follows the same rule.
 */
const EXCLUDED_TABLES = new Set(['workspace_capability', 'webhook_secrets']);

/** Durable-Object-internal tables (the KV shim and its metadata) and SQLite's
 *  own bookkeeping — neither is ours to restore. */
function isInternalTable(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_');
}

export interface ArchiveSqlCursor {
  phase: 'sql';
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

export interface ArchiveFilesCursor {
  phase: 'files';
  /** Last relative path already emitted, in lexical archive order. */
  after: string;
  rows: number;
  /** File and directory records emitted so far. */
  files: number;
}

export type ArchiveCursor = ArchiveSqlCursor | ArchiveFilesCursor;

export interface ArchiveFileEntry {
  /** Relative to the workspace root. */
  path: string;
  type: 'file' | 'directory';
}

/** Read side of the archive's filesystem seam. Listing returns metadata only;
 * file bodies are fetched one at a time as the page budget admits them. */
export interface ArchiveFileSource {
  listEntries(): Promise<readonly ArchiveFileEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
}

/** Restore side of the same seam. A factory is accepted by restore so an
 * embedded filesystem is opened only after its database schema and rows have
 * landed. */
export interface ArchiveFileTarget {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
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
  /** Authoritative workspace files when they do not live in `sql`. */
  files?: ArchiveFileSource;
}

interface ArchiveHeader {
  t: 'header';
  kinu_workspace_archive: number;
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

interface EncodedBinary {
  $b64: string;
}

type EncodedSqlValue = JsonPrimitive | EncodedBinary;

interface RowRecord {
  t: 'row';
  table: string;
  values: Record<string, EncodedSqlValue>;
}

interface FileRecord {
  t: 'file';
  path: string;
  data: string;
}

interface DirectoryRecord {
  t: 'directory';
  path: string;
}

interface EndRecord {
  t: 'end';
  rows: number;
  files: number;
}

type ArchiveRecord = ArchiveHeader | SchemaRecord | RowRecord | FileRecord | DirectoryRecord | EndRecord;

const EncodedSqlValueSchema: v.GenericSchema<EncodedSqlValue> = v.union([
  v.string(), v.number(), v.boolean(), v.null(), v.object({ $b64: v.string() }),
]);
const ArchiveRecordSchema: v.GenericSchema<ArchiveRecord> = v.variant('t', [
  v.object({
    t: v.literal('header'),
    kinu_workspace_archive: v.number(),
    workspace: v.string(),
    source: v.picklist(['cloud', 'local']),
    exported_at: v.number(),
  }),
  v.object({
    t: v.literal('schema'),
    kind: v.picklist(['table', 'index', 'trigger', 'view']),
    name: v.string(),
    sql: v.string(),
    virtual: v.optional(v.literal(true)),
    derived: v.optional(v.literal(true)),
  }),
  v.object({
    t: v.literal('row'),
    table: v.string(),
    values: v.record(v.string(), EncodedSqlValueSchema),
  }),
  v.object({ t: v.literal('file'), path: v.string(), data: v.string() }),
  v.object({ t: v.literal('directory'), path: v.string() }),
  v.object({ t: v.literal('end'), rows: v.number(), files: v.number() }),
]);

const DEFAULT_MAX_BYTES = 512 * 1024;
/**
 * Rows fetched before anything is known about how big this table's rows are.
 * Small on purpose: one `SELECT` of a VFS chunk table pulls whole file bodies
 * into memory, and a worker isolate has far less headroom than a page has budget.
 *
 * PENDING MEASUREMENT. That concern is the right one and it is named against
 * nothing: the isolate walls it is worried about are measured and sit one import
 * away — `PLATFORM_CATALOG['do.isolate.reset_silent']` (a retained working set
 * past ~200 MiB resetting the object with nothing thrown) and
 * `worker.isolate.memory` — and neither bound below is derived from either. What
 * would settle it: resident bytes for one page of the widest VFS chunk table,
 * which then divides into the catalogued wall the way `vfs/diff.ts` divides its
 * LCS table. Until that exists these are two round numbers guarding a real
 * hazard by being small, which is a guess in the safe direction rather than a
 * derivation.
 */
const FIRST_BATCH = 8;
const MAX_BATCH = 200;
/** Column the row query adds to carry the keyset position; stripped before a
 *  row is emitted. */
const ROWID_ALIAS = '__kinu_rowid';

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
  const SchemaRowSchema = v.object({
    name: v.string(),
    type: v.picklist(['table', 'index', 'trigger', 'view']),
    sql: v.string(),
  });
  const rows = sql.exec(
    `SELECT name, type, sql FROM sqlite_master
      WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view')`,
  ).toArray().map((row) => v.parse(SchemaRowSchema, row));

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

function encodeValue(value: ArchiveDatabaseValue): EncodedSqlValue {
  if (value instanceof ArrayBuffer) return { $b64: bytesToBase64(new Uint8Array(value)) };
  return value;
}

function decodeValue(value: EncodedSqlValue): ArchiveDatabaseValue {
  const encoded = v.safeParse(v.object({ $b64: v.string() }), value);
  if (encoded.success) return bytesAsArrayBuffer(base64ToBytes(encoded.output.$b64));
  return v.parse(v.union([v.string(), v.number(), v.boolean(), v.null()]), value);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function archivePath(path: string): string {
  if (!path || path.startsWith('/') || path.endsWith('/')) {
    throw new Error(`Invalid workspace archive path: ${JSON.stringify(path)}.`);
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid workspace archive path: ${JSON.stringify(path)}.`);
  }
  return path;
}

async function archiveEntries(source: ArchiveFileSource): Promise<ArchiveFileEntry[]> {
  const entries = [...await source.listEntries()].map((entry) => ({
    path: archivePath(entry.path),
    type: entry.type,
  }));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1]!.path === entries[i]!.path) {
      throw new Error(`Workspace archive file source listed ${JSON.stringify(entries[i]!.path)} more than once.`);
    }
  }
  return entries;
}

/**
 * One page of `workspace`'s archive. Call with `cursor: null` for the first
 * page and with the previous page's `next` thereafter, until `next` is null.
 */
export async function readWorkspaceArchivePage(
  sql: SqlExec,
  opts: ArchiveExportOptions,
): Promise<ArchivePage> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const schema = readSchema(sql);
  const dumpable = schema.filter((o) => o.dumpRows);
  const lines: string[] = [];
  let bytes = 0;
  const emit = (
    record: ArchiveRecord,
  ): void => {
    const line = JSON.stringify(record);
    lines.push(line);
    bytes += line.length + 1;
  };

  const fileCursor = opts.cursor?.phase === 'files' ? opts.cursor : null;
  const sqlCursor = opts.cursor?.phase === 'sql' ? opts.cursor : null;
  let index = fileCursor ? dumpable.length : 0;
  let after: number | null = null;
  let rows = opts.cursor?.rows ?? 0;
  if (sqlCursor) {
    index = dumpable.findIndex((o) => o.name === sqlCursor.table);
    if (index < 0) {
      throw new Error(`Cannot resume this export: table "${sqlCursor.table}" no longer exists.`);
    }
    after = sqlCursor.after;
  } else if (!fileCursor) {
    const header: ArchiveHeader = {
      t: 'header',
      kinu_workspace_archive: WORKSPACE_ARCHIVE_VERSION,
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
        virtual: object.virtual ? true : undefined,
        derived: object.derived ? true : undefined,
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
    const rawBatch = table.withoutRowid
      ? sql.exec(`SELECT * FROM ${quoteIdent(table.name)} LIMIT ? OFFSET ?`, size, after ?? 0).toArray()
      : after === null
        ? sql.exec(`${rowidSelect} ORDER BY rowid LIMIT ?`, size).toArray()
        : sql.exec(`${rowidSelect} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, size).toArray();
    const batch = rawBatch.map((row) => v.parse(ArchiveDatabaseRowSchema, row));

    for (const row of batch) {
      const values: Record<string, EncodedSqlValue> = {};
      for (const [column, value] of Object.entries(row)) {
        if (column !== ROWID_ALIAS) values[column] = encodeValue(value);
      }
      const before = bytes;
      emit({ t: 'row', table: table.name, values });
      rows++;
      emitted++;
      emittedBytes += bytes - before;
      after = table.withoutRowid ? (after ?? 0) + 1 : v.parse(v.number(), row[ROWID_ALIAS]);
      // Checked per row, not per batch: one oversized row must end the page
      // rather than ride along with a batch's worth of others.
      if (bytes >= maxBytes) {
        return { lines, next: { phase: 'sql', table: table.name, after, rows } };
      }
    }

    if (batch.length < size) {
      index++;
      after = null;
      emitted = 0;
      emittedBytes = 0;
    }
  }

  let files = fileCursor?.files ?? 0;
  if (opts.files) {
    const entries = await archiveEntries(opts.files);
    for (const entry of entries) {
      if (fileCursor && entry.path <= fileCursor.after) continue;
      if (entry.type === 'directory') {
        emit({ t: 'directory', path: entry.path });
      } else {
        emit({ t: 'file', path: entry.path, data: bytesToBase64(await opts.files.readFile(entry.path)) });
      }
      files++;
      if (bytes >= maxBytes) {
        return {
          lines,
          next: { phase: 'files', after: entry.path, rows, files },
        };
      }
    }
  } else if (fileCursor) {
    throw new Error('Cannot resume this export: its workspace file source is unavailable.');
  }

  emit({ t: 'end', rows, files });
  return { lines, next: null };
}

/** Whole archive in one call — for a caller with the database in hand and no
 *  transport in the middle (the local export, and tests). */
export async function writeWorkspaceArchive(sql: SqlExec, opts: ArchiveExportOptions): Promise<string[]> {
  const lines: string[] = [];
  let cursor: ArchiveCursor | null = null;
  do {
    const page = await readWorkspaceArchivePage(sql, { ...opts, cursor });
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
  /** Regular files restored (directory records are not included). */
  files: number;
}

export interface ArchiveRestoreOptions {
  /** Lazily open the destination workspace filesystem when the first file or
   * directory record arrives. Required for an archive that carries files. */
  files?: () => ArchiveFileTarget;
}

/**
 * Rebuild a workspace's SQLite state from an archive, into an EMPTY database.
 * Streams: base tables are created as their records arrive, rows are inserted
 * as they arrive, and the objects that depend on the rows (FTS indexes, other
 * indexes, triggers, views) are applied at the end — so a large archive never
 * has to be held in memory, and an FTS index is rebuilt against complete
 * content rather than maintained row by row.
 */
export async function restoreWorkspaceArchive(
  sql: SqlExec,
  lines: Iterable<string>,
  opts: ArchiveRestoreOptions = {},
): Promise<ArchiveRestoreResult> {
  let header: ArchiveHeader | null = null;
  let end: EndRecord | null = null;
  const deferred: SchemaRecord[] = [];
  let tables = 0;
  let rows = 0;
  let fileRecords = 0;
  let files = 0;
  let fileTarget: ArchiveFileTarget | null = null;
  let insert: { table: string; columns: string[]; statement: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: ArchiveRecord;
    try {
      record = v.parse(ArchiveRecordSchema, JSON.parse(trimmed));
    } catch (error) {
      throw new Error('This file is not a Kinu workspace archive (unparsable line).', { cause: error });
    }
    if (!header) {
      if (record.t !== 'header' || record.kinu_workspace_archive !== WORKSPACE_ARCHIVE_VERSION) {
        throw new Error(
          `This file is not a Kinu workspace archive v${WORKSPACE_ARCHIVE_VERSION}.`,
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
      case 'directory': {
        const path = archivePath(record.path);
        fileTarget ??= opts.files?.() ?? null;
        if (!fileTarget) throw new Error('This archive contains workspace files, but no filesystem target was provided.');
        await fileTarget.mkdir(path, { recursive: true });
        fileRecords++;
        break;
      }
      case 'file': {
        const path = archivePath(record.path);
        fileTarget ??= opts.files?.() ?? null;
        if (!fileTarget) throw new Error('This archive contains workspace files, but no filesystem target was provided.');
        const slash = path.lastIndexOf('/');
        if (slash > 0) await fileTarget.mkdir(path.slice(0, slash), { recursive: true });
        await fileTarget.writeFile(path, base64ToBytes(record.data));
        fileRecords++;
        files++;
        break;
      }
      case 'end':
        end = record;
        break;
    }
  }

  if (!header) throw new Error('This file is not a Kinu workspace archive (no header).');
  if (!end) throw new Error('This archive is incomplete — the export did not finish.');
  if (end.rows !== rows) {
    throw new Error(`This archive is damaged: it declares ${end.rows} rows but carries ${rows}.`);
  }
  if (end.files !== fileRecords) {
    throw new Error(`This archive is damaged: it declares ${end.files} file records but carries ${fileRecords}.`);
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
    files,
  };
}
