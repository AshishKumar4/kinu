/**
 * The one portable JSON Lines workspace archive, written and read by both backends as a logical dump
 * (a Worker cannot hand out its DO's SQLite file). The `end` record's row, file and actor counts make
 * truncation detectable. Pages are not a point-in-time snapshot. Secrets are excluded (EXCLUDED_TABLES).
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import type { AgentDatabase } from './inline-primitives';
import type { SqlExec } from '../types/primitives';
import type { JsonPrimitive } from '../utils/json';
import { SCHEMA_GENESIS } from './schema-genesis';
import { requireSchemaGenesis } from './schema-stamp';
import { settle } from '../obs/effect';

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

/** `SqlExec` over a local `AgentDatabase`; statements run eagerly. */
export function archiveSqlFromDatabase(db: AgentDatabase): SqlExec {
  return {
    exec(query, ...bindings) {
      // Canonical BLOBs are ArrayBuffers; bun:sqlite binds TypedArrays only.
      const bound = bindings.map((binding) => (binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding));
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
const WORKSPACE_ARCHIVE_VERSION = 2;

export const WORKSPACE_ARCHIVE_EXTENSION = '.kinu.jsonl';

/** Credentials (the workspace capability, ingress secrets) and derived indexes are never archived. */
const EXCLUDED_TABLES = {
  workspace_capability: true,
  webhook_secrets: true,
  conversation_fts: true,
  conversation_fts_state: true,
} satisfies Record<string, true>;

function isInternalTable(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf_');
}

export interface ArchiveSqlCursor {
  phase: 'sql';
  table: string;
  /** The table set the first page pinned, so a table born mid-export is excluded; absent means derive. */
  tables?: string[];
  /** Keyset, never offset: last rowid, or the JSON primary-key tuple for WITHOUT ROWID. `null` starts the table. */
  after: number | string | null;
  rows: number;
}

export interface ArchiveFilesCursor {
  phase: 'files';
  after: string;
  rows: number;
  files: number;
}

export type ArchiveCursor = ArchiveSqlCursor | ArchiveFilesCursor;

/** The only cursor wire schema: a copy's `v.object` would silently strip unknown keys such as `tables`. */
export const ArchiveCursorSchema: v.GenericSchema<ArchiveCursor> = v.variant('phase', [
  v.object({
    phase: v.literal('sql'),
    table: v.pipe(v.string(), v.nonEmpty()),
    tables: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
    after: v.nullable(v.union([v.pipe(v.number(), v.safeInteger()), v.string()])),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.object({
    phase: v.literal('files'),
    after: v.pipe(v.string(), v.nonEmpty()),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    files: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
]);

export interface ArchiveFileEntry {
  path: string;
  type: 'file' | 'directory';
}

export interface ArchiveFileSource {
  listEntries(): Promise<readonly ArchiveFileEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
}

export interface ArchiveFileTarget {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface ArchivePage {
  lines: string[];
  next: ArchiveCursor | null;
}

export interface ArchiveExportOptions {
  workspace: string;
  source: 'cloud' | 'local';
  cursor?: ArchiveCursor | null;
  /** Soft page budget; an oversized row is still emitted whole. */
  maxBytes?: number;
  now?: number;
  /** Authoritative files outside `sql`; null declares a SQL-only workspace. */
  files?: ArchiveFileSource | null;
}

interface ArchiveHeader {
  t: 'header';
  kinu_workspace_archive: number;
  workspace: string;
  source: 'cloud' | 'local';
  exported_at: number;
  /** The schema genesis of the Kinu that wrote it; an archive under another is refused by name. */
  schema_genesis?: string;
}

type SchemaKind = 'table' | 'index' | 'trigger' | 'view';

interface SchemaRecord {
  t: 'schema';
  kind: SchemaKind;
  name: string;
  sql: string;
  virtual?: true;
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
  /** Roster size, retired actors included: their rows are workspace state. */
  actors: number;
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
    schema_genesis: v.optional(v.string()),
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
  v.object({ t: v.literal('end'), rows: v.number(), files: v.number(), actors: v.number() }),
]);

const DEFAULT_MAX_BYTES = 512 * 1024;

// Small because one SELECT of a VFS chunk table pulls whole bodies into isolate memory; not yet derived
// from PLATFORM_CATALOG['do.isolate.reset_silent'] or `worker.isolate.memory`.
const FIRST_BATCH = 8;

const MAX_BATCH = 200;

const ROWID_ALIAS = '__kinu_rowid';

interface SchemaObject {
  kind: SchemaKind;
  name: string;
  sql: string;
  virtual: boolean;
  derived: boolean;
  dumpRows: boolean;
  withoutRowid: boolean;
}

/** Restore order: base tables, then what sits on them. Re-read per page so resumes see schema changes. */
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

  // FTS5 shadow tables are rebuilt from the virtual table, never dumped.
  const isShadow = (name: string) => virtualNames.some((virtualName) => name.startsWith(`${virtualName}_`));

  const objects: SchemaObject[] = [];

  for (const row of rows) {
    if (
      isInternalTable(row.name)
      || Object.hasOwn(EXCLUDED_TABLES, row.name)
      || row.name.startsWith('conversation_rev_')
    ) continue;

    if (row.type === 'table' && isShadow(row.name)) continue;
    const virtual = row.type === 'table' && virtualNames.includes(row.name);
    // External-content FTS is re-derived after the rows land, not dumped.
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

/** 0 without a roster table (older databases stay exportable); export and restore share this count. */
function countArchivedActors(sql: SqlExec): number {
  const present = sql.exec(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_actors'`,
  ).toArray();

  if (present.length === 0) return 0;
  const counted = sql.exec(`SELECT COUNT(*) AS n FROM workspace_actors`).toArray()[0];

  return v.parse(v.number(), counted?.n);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const KeysetValueSchema = v.union([v.string(), v.number()]);

const KeysetAnchorSchema = v.array(KeysetValueSchema);

/** Primary-key columns in key order for a WITHOUT ROWID walk. */
function withoutRowidKey(sql: SqlExec, table: SchemaObject): Effect.Effect<readonly string[]> {
  const columns = sql.exec(
    `PRAGMA table_info(${quoteIdent(table.name)})`,
  ).toArray()
    .map((row) => v.parse(v.object({ name: v.string(), pk: v.number() }), row))
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk);

  return columns.length === 0
    ? Effect.die(new Error(`Cannot order a WITHOUT ROWID export of "${table.name}": it has no primary key.`))
    : Effect.succeed(columns.map((column) => column.name));
}

function archivePath(path: string): Effect.Effect<string> {
  const invalid = !path || path.startsWith('/') || path.endsWith('/')
    || path.split('/').some((part) => !part || part === '.' || part === '..');

  return invalid ? Effect.die(new Error(`Invalid workspace archive path: ${JSON.stringify(path)}.`)) : Effect.succeed(path);
}

function archiveEntries(source: ArchiveFileSource): Effect.Effect<ArchiveFileEntry[]> {
  return Effect.gen(function* () {
    const listed = yield* Effect.promise(async () => [...await source.listEntries()]);
    const entries = yield* Effect.forEach(listed, (entry) => Effect.map(archivePath(entry.path), (path) => ({ path, type: entry.type })));

    entries.sort((a, b) => {
      if (a.path === b.path) return 0;

      return a.path < b.path ? -1 : 1;
    });

    for (let i = 1; i < entries.length; i++) {
      if (entries[i - 1].path === entries[i].path) {
        return yield* Effect.die(new Error(`Workspace archive file source listed ${JSON.stringify(entries[i].path)} more than once.`));
      }
    }

    return entries;
  });
}

/** Call with `cursor: null`, then each page's `next` until it is null. */
export function readWorkspaceArchivePage(
  sql: SqlExec,
  opts: ArchiveExportOptions,
): Promise<ArchivePage> {
  return settle(Effect.gen(function* () {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const schema = readSchema(sql);
    const fileCursor = opts.cursor?.phase === 'files' ? opts.cursor : null;
    const sqlCursor = opts.cursor?.phase === 'sql' ? opts.cursor : null;
    const live = schema.filter((o) => o.dumpRows);
    const pinned = sqlCursor?.tables ?? live.map((o) => o.name);
    const dumpable = sqlCursor === null ? live : live.filter((o) => pinned.includes(o.name));
    const page: PageLines = { lines: [], bytes: 0 };
    const { lines } = page;
    const emit = (record: ArchiveRecord): void => emitLine(page, record);
    let index = fileCursor ? dumpable.length : 0;
    let after: number | string | null = null;
    let rows = opts.cursor?.rows ?? 0;

    if (sqlCursor) {
      index = dumpable.findIndex((o) => o.name === sqlCursor.table);

      if (index < 0) {
        return yield* Effect.die(new Error(`Cannot resume this export: table "${sqlCursor.table}" no longer exists.`));
      }

      after = sqlCursor.after;
    } else if (!fileCursor) {
      emitPreamble(page, schema, opts);
    }

    // Batch size adapts per table to the observed row cost.
    let emitted = 0;
    let emittedBytes = 0;

    const nextBatch = (): number => {
      if (emitted === 0) return FIRST_BATCH;

      return Math.min(MAX_BATCH, Math.max(1, Math.ceil(maxBytes / (emittedBytes / emitted))));
    };

    while (index < dumpable.length) {
      const table = dumpable[index];
      const size = nextBatch();
      const rowidSelect = `SELECT rowid AS ${quoteIdent(ROWID_ALIAS)}, * FROM ${quoteIdent(table.name)}`;
      // WITHOUT ROWID resumes by row-value seek on the primary key; an offset would duplicate rows.
      const keyset = table.withoutRowid ? yield* withoutRowidKey(sql, table) : null;

      const rawBatch = ((): readonly unknown[] => {
        if (keyset === null) {
          return after === null
            ? sql.exec(`${rowidSelect} ORDER BY rowid LIMIT ?`, size).toArray()
            : sql.exec(`${rowidSelect} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, size).toArray();
        }

        const cols = keyset.map(quoteIdent).join(', ');

        if (after === null) {
          return sql.exec(`SELECT * FROM ${quoteIdent(table.name)} ORDER BY ${cols} LIMIT ?`, size).toArray();
        }

        const anchor = v.parse(KeysetAnchorSchema, JSON.parse(v.parse(v.string(), after)));

        return sql.exec(
          `SELECT * FROM ${quoteIdent(table.name)} WHERE (${cols}) > (${keyset.map(() => '?').join(', ')}) `
          + `ORDER BY ${cols} LIMIT ?`,
          ...anchor, size,
        ).toArray();
      })();

      const batch = rawBatch.map((row) => v.parse(ArchiveDatabaseRowSchema, row));

      for (const row of batch) {
        const values: Record<string, EncodedSqlValue> = {};

        for (const [column, value] of Object.entries(row)) {
          if (column !== ROWID_ALIAS) values[column] = encodeValue(value);
        }

        const before = page.bytes;
        emit({ t: 'row', table: table.name, values });
        rows++;
        emitted++;
        emittedBytes += page.bytes - before;
        after = keyset === null
          ? v.parse(v.number(), row[ROWID_ALIAS])
          : JSON.stringify(keyset.map((name) => v.parse(
            KeysetValueSchema, row[name],
            { message: `"${table.name}"."${name}" holds a non-keyset value; a WITHOUT ROWID export key must be TEXT, INTEGER or REAL` },
          )));

        // Per row, so one oversized row ends the page.
        if (page.bytes >= maxBytes) {
          return { lines, next: { phase: 'sql', table: table.name, after, rows, tables: pinned } };
        }
      }

      if (batch.length < size) {
        index++;
        after = null;
        emitted = 0;
        emittedBytes = 0;
      }
    }

    const filed = yield* emitFiles(page, { source: opts.files, cursor: fileCursor, rows, maxBytes });

    if (!filed.done) return filed.page;
    emit({ t: 'end', rows, files: filed.files, actors: countArchivedActors(sql) });

    return { lines, next: null };
  }));
}

interface PageLines {
  readonly lines: string[];
  bytes: number;
}

function emitLine(page: PageLines, record: ArchiveRecord): void {
  const line = JSON.stringify(record);
  page.lines.push(line);
  page.bytes += line.length + 1;
}

function emitPreamble(page: PageLines, schema: readonly SchemaObject[], opts: ArchiveExportOptions): void {
  const header: ArchiveHeader = {
    t: 'header',
    kinu_workspace_archive: WORKSPACE_ARCHIVE_VERSION,
    workspace: opts.workspace,
    source: opts.source,
    exported_at: opts.now ?? Date.now(),
    schema_genesis: SCHEMA_GENESIS,
  };

  emitLine(page, header);

  for (const object of schema) {
    emitLine(page, {
      t: 'schema',
      kind: object.kind,
      name: object.name,
      sql: object.sql,
      virtual: object.virtual ? true : undefined,
      derived: object.derived ? true : undefined,
    });
  }
}

type FilesOutcome = { readonly done: true; readonly files: number } | { readonly done: false; readonly page: ArchivePage };

interface FilesPhase {
  readonly source: ArchiveFileSource | null | undefined;
  readonly cursor: ArchiveFilesCursor | null;
  readonly rows: number;
  readonly maxBytes: number;
}

function emitFiles(page: PageLines, phase: FilesPhase): Effect.Effect<FilesOutcome> {
  return Effect.gen(function* () {
    const { source, cursor, rows, maxBytes } = phase;
    let files = cursor?.files ?? 0;

    if (!source) {
      return cursor ? yield* Effect.die(new Error('Cannot resume this export: its workspace file source is unavailable.')) : { done: true, files };
    }

    for (const entry of yield* archiveEntries(source)) {
      if (cursor && entry.path <= cursor.after) continue;

      if (entry.type === 'directory') {
        emitLine(page, { t: 'directory', path: entry.path });
      } else {
        emitLine(page, { t: 'file', path: entry.path, data: bytesToBase64(yield* Effect.promise(() => source.readFile(entry.path))) });
      }

      files++;

      if (page.bytes >= maxBytes) return { done: false, page: { lines: page.lines, next: { phase: 'files', after: entry.path, rows, files } } };
    }

    return { done: true, files };
  });
}

/** Whole archive in one call, for callers with no transport in between. */
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
  actors: number;
  files: number;
}

export interface ArchiveRestoreOptions {
  /** Opened lazily at the first file record, after SQL has landed; required if the archive carries files. */
  files?: () => ArchiveFileTarget;
}

/** Streams into an empty database; dependent objects (indexes, FTS, triggers, views) apply after the rows. */
function matchesEnd(sql: SqlExec, end: EndRecord | null, carried: { rows: number; fileRecords: number }): Effect.Effect<number> {
  if (!end) return Effect.die(new Error('This archive is incomplete: the export did not finish.'));

  if (end.rows !== carried.rows) {
    return Effect.die(new Error(`This archive is damaged: it declares ${end.rows} rows but carries ${carried.rows}.`));
  }

  if (end.files !== carried.fileRecords) {
    return Effect.die(new Error(`This archive is damaged: it declares ${end.files} file records but carries ${carried.fileRecords}.`));
  }

  // A right row total can still drop one actor's rows, so the roster size is checked too.
  const restoredActors = countArchivedActors(sql);

  return end.actors === restoredActors
    ? Effect.succeed(restoredActors)
    : Effect.die(new Error(`This archive is damaged: it declares ${end.actors} actors but restored ${restoredActors}.`));
}

const NO_FILE_TARGET = 'This archive contains workspace files, but no filesystem target was provided.';

/** The first record, refused unless it is this format's header under this Kinu's schema genesis. */
function archiveHeader(record: ArchiveRecord): Effect.Effect<ArchiveHeader> {
  if (record.t !== 'header' || record.kinu_workspace_archive !== WORKSPACE_ARCHIVE_VERSION) {
    return Effect.die(new Error(`This file is not a Kinu workspace archive v${WORKSPACE_ARCHIVE_VERSION}.`));
  }

  return Effect.sync(() => {
    requireSchemaGenesis(`This archive of "${record.workspace}"`, record.schema_genesis?.slice(0, 7) ?? null);

    return record;
  });
}

export function restoreWorkspaceArchive(
  sql: SqlExec,
  lines: Iterable<string>,
  opts: ArchiveRestoreOptions = {},
): Promise<ArchiveRestoreResult> {
  return settle(Effect.gen(function* () {
    let header: ArchiveHeader | null = null;
    let end: EndRecord | null = null;
    const deferred: SchemaRecord[] = [];
    let tables = 0;
    let rows = 0;
    let fileRecords = 0;
    let files = 0;
    let fileTarget: ArchiveFileTarget | null = null;
    let insert: { table: string; columns: string[]; statement: string } | null = null;

    const finishSql = (): void => {
      const pending = deferred.splice(0);

      for (const record of pending) sql.exec(record.sql);

      for (const record of pending) {
        if (record.derived) {
          sql.exec(`INSERT INTO ${quoteIdent(record.name)} (${quoteIdent(record.name)}) VALUES ('rebuild')`);
        }
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) continue;

      const record = yield* Effect.try({
        try: (): ArchiveRecord => v.parse(ArchiveRecordSchema, JSON.parse(trimmed)),
        catch: (cause) => ({ cause }),
      }).pipe(Effect.catch((failed) => Effect.die(new Error('This file is not a Kinu workspace archive (unparsable line).', { cause: failed.cause }))));

      if (!header) {
        header = yield* archiveHeader(record);
        continue;
      }

      if (end) return yield* Effect.die(new Error('This archive has records after its end marker.'));

      if (fileRecords > 0 && (record.t === 'schema' || record.t === 'row')) {
        return yield* Effect.die(new Error('This archive has SQL records after its workspace files.'));
      }

      switch (record.t) {
        case 'header':
          return yield* Effect.die(new Error('This archive has more than one header.'));
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
          const path = yield* archivePath(record.path);
          finishSql();
          const target = fileTarget ??= opts.files?.() ?? null;

          if (!target) return yield* Effect.die(new Error(NO_FILE_TARGET));
          yield* Effect.promise(() => target.mkdir(path, { recursive: true }));
          fileRecords++;
          break;
        }

        case 'file': {
          const path = yield* archivePath(record.path);
          finishSql();
          const target = fileTarget ??= opts.files?.() ?? null;

          if (!target) return yield* Effect.die(new Error(NO_FILE_TARGET));
          const slash = path.lastIndexOf('/');

          if (slash > 0) yield* Effect.promise(() => target.mkdir(path.slice(0, slash), { recursive: true }));
          yield* Effect.promise(() => target.writeFile(path, base64ToBytes(record.data)));
          fileRecords++;
          files++;
          break;
        }

        case 'end':
          end = record;
          break;
      }
    }

    if (!header) return yield* Effect.die(new Error('This file is not a Kinu workspace archive (no header).'));
    const restoredActors = yield* matchesEnd(sql, end, { rows, fileRecords });

    finishSql();

    return {
      workspace: header.workspace,
      source: header.source,
      exportedAt: header.exported_at,
      tables,
      rows,
      actors: restoredActors,
      files,
    };
  }));
}
