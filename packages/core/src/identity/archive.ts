/**
 * The one portable JSON Lines workspace archive, written and read by both backends as a logical dump
 * (a Worker cannot hand out its DO's SQLite file). The `end` record's row, file and actor counts make
 * truncation detectable. SQL pages are not a point-in-time snapshot. Secrets are excluded (EXCLUDED_TABLES).
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import type { VfsExportChunk, VfsExportPage } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import type { AgentDatabase } from './inline-primitives';
import type { SqlExec } from '../types/primitives';
import type { JsonPrimitive } from '../utils/json';
import { SCHEMA_GENESIS } from './schema-genesis';
import { requireSchemaGenesis } from './schema-stamp';
import { settle } from '../obs/effect';
import { KinuError } from '../obs/error';
import { VfsExportPageSchema } from '../vfs/export-page';
import { isNimbusTable } from '../vfs/nimbus-tables';
import { isTreeRelativePath, SLATES_ROOT, WORKSPACE_ROOT } from '../vfs/workspace-path';
import { SOUL_PATH } from './soul';

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
      const rows = db.query<NativeArchiveDatabaseRow>(query).all(...bound);

      return {
        toArray: () => rows.map((row) => Object.fromEntries(
          Object.entries(row).map(([column, value]) => [column, canonicalDatabaseValue(value)]),
        )),
      };
    },
  };
}

/** Bumped only when a reader would misread an older archive. */
const WORKSPACE_ARCHIVE_VERSION = 3;

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

export const ARCHIVE_PIN_PREFIX = 'archive:';

export const ARCHIVE_SNAPSHOT_ENDED = "This export's snapshot ended when the workspace restarted.";

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

export interface ArchiveAgentsCursor {
  phase: 'agents';
  actor: string;
  inner: ArchiveSqlCursor | null;
  rows: number;
}

export interface ArchiveStoreCursor {
  phase: 'store';
  pin: string;
  root: number;
  after: string | null;
  sent: number;
  rows: number;
  files: number;
}

export type ArchiveCursor = ArchiveSqlCursor | ArchiveAgentsCursor | ArchiveFilesCursor | ArchiveStoreCursor;

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
    phase: v.literal('agents'),
    actor: v.pipe(v.string(), v.nonEmpty()),
    inner: v.nullable(v.object({
      phase: v.literal('sql'),
      table: v.pipe(v.string(), v.nonEmpty()),
      tables: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
      after: v.nullable(v.union([v.pipe(v.number(), v.safeInteger()), v.string()])),
      rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    })),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.object({
    phase: v.literal('files'),
    after: v.pipe(v.string(), v.nonEmpty()),
    rows: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    files: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.object({
    phase: v.literal('store'),
    pin: v.pipe(v.string(), v.startsWith(ARCHIVE_PIN_PREFIX)),
    root: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    after: v.nullable(v.string()),
    sent: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
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

export interface ArchivePinnedStore {
  readdir(path: string): readonly string[];
  exportPage(root: string, after: string | null): VfsExportPage;
  /** At least one chunk. */
  exportChunks(hashes: readonly string[], maxBytes: number): { chunks: VfsExportChunk[]; rest: string[] };
  release(): Promise<void>;
}

export interface ArchiveStoreSource {
  pin(name: string): Promise<ArchivePinnedStore>;
  /** Null once a restart dropped the pin. */
  pinned(name: string): Promise<ArchivePinnedStore | null>;
}

export interface ArchiveStoreTarget {
  /** A first page replaces the tree. */
  importPage(page: VfsExportPage): Promise<{ pending: readonly string[] }>;
  hydrateChunks(chunks: readonly VfsExportChunk[]): Promise<{ stored: readonly string[]; invalid: readonly string[] }>;
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

/** Cloud-only: a local workspace keeps its files on disk and every actor's rows in `sql`. */
export interface CloudArchiveSources {
  store?: ArchiveStoreSource | null;
  agents?: ArchiveAgentSource | null;
}

type ExportOptions = ArchiveExportOptions & CloudArchiveSources;

/** One page of an agent's own rows: row records, then its section's close once `next` is null. */
export interface ArchiveAgentPage {
  lines: string[];
  rows: number;
  next: ArchiveSqlCursor | null;
}

export interface ArchiveAgentSource {
  list(): readonly string[];
  page(actorId: string, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage>;
}

interface ArchiveHeader {
  t: 'header';
  kinu_workspace_archive: number;
  workspace: string;
  source: 'cloud' | 'local';
  exported_at: number;
  /** The schema genesis of the Kinu that wrote it; an archive under another is refused by name. */
  schema_genesis?: string;
  /** Each agent must close its section, or the archive is refused. */
  agents?: string[];
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
  agent?: string;
}

/** Closes an agent's section: every row its database holds was written above. */
interface AgentRecord {
  t: 'agent';
  actor: string;
  rows: number;
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

interface PageRecord {
  t: 'page';
  page: VfsExportPage;
}

interface ChunksRecord {
  t: 'chunks';
  chunks: { hash: string; data: string }[];
}

interface EndRecord {
  t: 'end';
  rows: number;
  files: number;
  /** Roster size, retired actors included: their rows are workspace state. */
  actors: number;
}

type ArchiveRecord = ArchiveHeader | SchemaRecord | RowRecord | AgentRecord | FileRecord | DirectoryRecord | PageRecord | ChunksRecord | EndRecord;

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
    agents: v.optional(v.array(v.string())),
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
    agent: v.optional(v.string()),
  }),
  v.object({ t: v.literal('agent'), actor: v.string(), rows: v.number() }),
  v.object({ t: v.literal('file'), path: v.string(), data: v.string() }),
  v.object({ t: v.literal('directory'), path: v.string() }),
  v.object({ t: v.literal('page'), page: VfsExportPageSchema }),
  v.object({ t: v.literal('chunks'), chunks: v.array(v.object({ hash: v.string(), data: v.string() })) }),
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
  table: string;
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
    tbl_name: v.string(),
  });

  const rows = sql.exec(
    `SELECT name, type, sql, tbl_name FROM sqlite_master
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
      table: row.tbl_name,
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
  return !isTreeRelativePath(path) ? Effect.die(new Error(`Invalid workspace archive path: ${JSON.stringify(path)}.`)) : Effect.succeed(path);
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

interface PageSink {
  readonly lines: string[];
  bytes: number;
}

function emitLine(sink: PageSink, line: string): void {
  sink.lines.push(line);
  sink.bytes += line.length + 1;
}

function emitTo(sink: PageSink, record: ArchiveRecord): void {
  emitLine(sink, JSON.stringify(record));
}

function cannotResume(why: string): Effect.Effect<never> {
  return Effect.die(new Error(`Cannot resume this export: ${why}.`));
}

interface TableWalk {
  index: number;
  after: number | string | null;
  rows: number;
}

/** Null once every table is written; with `agent`, only that actor's rows, marked as its section's. */
function dumpRows(
  sql: SqlExec, dumpable: readonly SchemaObject[], walk: TableWalk,
  page: { readonly sink: PageSink; readonly maxBytes: number; readonly agent?: string },
): Effect.Effect<{ table: string; after: number | string } | null> {
  return Effect.gen(function* () {
    const { sink } = page;
    // Batch size adapts per table to the observed row cost.
    let emitted = 0;
    let emittedBytes = 0;

    const nextBatch = (): number => {
      if (emitted === 0) return FIRST_BATCH;

      return Math.min(MAX_BATCH, Math.max(1, Math.ceil(page.maxBytes / (emittedBytes / emitted))));
    };

    while (walk.index < dumpable.length) {
      const table = dumpable[walk.index];
      const size = nextBatch();
      const scoped = page.agent === undefined ? [] : [page.agent];
      const rowidSelect = `SELECT rowid AS ${quoteIdent(ROWID_ALIAS)}, * FROM ${quoteIdent(table.name)}`;
      // WITHOUT ROWID resumes by row-value seek on the primary key; an offset would duplicate rows.
      const keyset = table.withoutRowid ? yield* withoutRowidKey(sql, table) : null;
      const after = walk.after;

      const rawBatch = ((): readonly unknown[] => {
        const where = (conditions: readonly string[]): string => (conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`);
        const mine = page.agent === undefined ? [] : ['actor_id = ?'];

        if (keyset === null) {
          return after === null
            ? sql.exec(`${rowidSelect} ${where(mine)} ORDER BY rowid LIMIT ?`, ...scoped, size).toArray()
            : sql.exec(`${rowidSelect} ${where(['rowid > ?', ...mine])} ORDER BY rowid LIMIT ?`, after, ...scoped, size).toArray();
        }

        const cols = keyset.map(quoteIdent).join(', ');

        if (after === null) {
          return sql.exec(`SELECT * FROM ${quoteIdent(table.name)} ${where(mine)} ORDER BY ${cols} LIMIT ?`, ...scoped, size).toArray();
        }

        const anchor = v.parse(KeysetAnchorSchema, JSON.parse(v.parse(v.string(), after)));

        return sql.exec(
          `SELECT * FROM ${quoteIdent(table.name)} ${where([`(${cols}) > (${keyset.map(() => '?').join(', ')})`, ...mine])} `
          + `ORDER BY ${cols} LIMIT ?`,
          ...anchor, ...scoped, size,
        ).toArray();
      })();

      const batch = rawBatch.map((row) => v.parse(ArchiveDatabaseRowSchema, row));

      for (const row of batch) {
        const values: Record<string, EncodedSqlValue> = {};

        for (const [column, value] of Object.entries(row)) {
          if (column !== ROWID_ALIAS) values[column] = encodeValue(value);
        }

        const before = sink.bytes;
        emitTo(sink, { t: 'row', table: table.name, values, ...(page.agent !== undefined && { agent: page.agent }) });
        walk.rows++;
        emitted++;
        emittedBytes += sink.bytes - before;
        walk.after = keyset === null
          ? v.parse(v.number(), row[ROWID_ALIAS])
          : JSON.stringify(keyset.map((name) => v.parse(
            KeysetValueSchema, row[name],
            { message: `"${table.name}"."${name}" holds a non-keyset value; a WITHOUT ROWID export key must be TEXT, INTEGER or REAL` },
          )));

        // Per row, so one oversized row ends the page.
        if (sink.bytes >= page.maxBytes) return { table: table.name, after: walk.after };
      }

      if (batch.length < size) {
        walk.index++;
        walk.after = null;
        emitted = 0;
        emittedBytes = 0;
      }
    }

    return null;
  });
}

/** Tables an agent's own database holds rows of that actor in; the roster copies are the workspace's. */
function agentTables(sql: SqlExec): SchemaObject[] {
  return readSchema(sql).filter((o) => o.dumpRows && o.name !== 'workspace_actors' && o.name !== 'workspace_identity'
    && sql.exec(`PRAGMA table_info(${quoteIdent(o.name)})`).toArray().some((column) => v.parse(v.object({ name: v.string() }), column).name === 'actor_id'));
}

export function readAgentArchivePage(sql: SqlExec, actorId: string, cursor: ArchiveSqlCursor | null, maxBytes: number): Promise<ArchiveAgentPage> {
  return settle(Effect.gen(function* () {
    const live = agentTables(sql);
    const pinned = cursor?.tables ?? live.map((o) => o.name);
    const dumpable = cursor === null ? live : live.filter((o) => pinned.includes(o.name));
    const sink: PageSink = { lines: [], bytes: 0 };
    const index = cursor === null ? 0 : dumpable.findIndex((o) => o.name === cursor.table);

    if (index < 0) return yield* cannotResume(`table "${cursor?.table ?? ''}" no longer exists in an agent's database`);
    const before = cursor?.rows ?? 0;
    const walk: TableWalk = { index, after: cursor?.after ?? null, rows: before };
    const stopped = yield* dumpRows(sql, dumpable, walk, { sink, maxBytes, agent: actorId });
    const rows = walk.rows - before;

    if (stopped !== null) {
      return { lines: sink.lines, rows, next: { phase: 'sql', table: stopped.table, after: stopped.after, rows: walk.rows, tables: pinned } };
    }

    emitTo(sink, { t: 'agent', actor: actorId, rows: walk.rows });

    return { lines: sink.lines, rows, next: null };
  }));
}

const SQL_RECORDS: ReadonlySet<ArchiveRecord['t']> = new Set(['schema', 'row', 'agent']);

class ArchiveRowWriter {
  private insert: { table: string; columns: string[]; agent: boolean; statement: string } | null = null;

  private readonly carried = new Map<string, number>();

  private readonly closed = new Map<string, number>();

  constructor(private readonly sql: SqlExec) {}

  write(record: RowRecord): void {
    const columns = Object.keys(record.values);
    const agent = record.agent !== undefined;
    const held = this.insert;

    // Reused only for the same columns in the same order: a row's values bind in its own key order.
    if (held === null || held.table !== record.table || held.agent !== agent || held.columns.join('\0') !== columns.join('\0')) {
      this.insert = {
        table: record.table,
        columns,
        agent,
        // An agent's database and the workspace may both hold one row (an effect claim either side made).
        statement: `INSERT ${agent ? 'OR IGNORE ' : ''}INTO ${quoteIdent(record.table)} (${columns.map(quoteIdent).join(', ')})`
          + ` VALUES (${columns.map(() => '?').join(', ')})`,
      };
    }

    this.sql.exec(this.insert?.statement ?? '', ...columns.map((c) => decodeValue(record.values[c])));

    if (record.agent !== undefined) this.carried.set(record.agent, (this.carried.get(record.agent) ?? 0) + 1);
  }

  close(record: AgentRecord): void {
    this.closed.set(record.actor, record.rows);
  }

  requireSections(agents: readonly string[]): Effect.Effect<void> {
    const problem = agents.map((actor) => {
      const declared = this.closed.get(actor);
      const carried = this.carried.get(actor) ?? 0;

      if (declared === undefined) return `it lists agent ${actor}, whose own database it does not carry`;

      return declared === carried ? null : `agent ${actor}'s section declares ${declared} rows but carries ${carried}`;
    }).find((found) => found !== null);

    return problem === undefined ? Effect.void : Effect.die(new Error(`This archive is damaged: ${problem}.`));
  }
}

interface PageState {
  readonly sink: PageSink;
  readonly walk: TableWalk;
}

function emitHeader(sink: PageSink, schema: readonly SchemaObject[], opts: ExportOptions, agents: readonly string[]): void {
  emitTo(sink, {
    t: 'header',
    kinu_workspace_archive: WORKSPACE_ARCHIVE_VERSION,
    workspace: opts.workspace,
    source: opts.source,
    exported_at: opts.now ?? Date.now(),
    schema_genesis: SCHEMA_GENESIS,
    ...(agents.length > 0 && { agents: [...agents] }),
  });

  for (const object of schema) {
    emitTo(sink, {
      t: 'schema',
      kind: object.kind,
      name: object.name,
      sql: object.sql,
      virtual: object.virtual ? true : undefined,
      derived: object.derived ? true : undefined,
    });
  }
}

function sqlPhase(sql: SqlExec, live: readonly SchemaObject[], { sink, walk }: PageState, page: {
  readonly cursor: ArchiveSqlCursor | null; readonly maxBytes: number;
}): Effect.Effect<ArchivePage | null> {
  return Effect.gen(function* () {
    const pinned = page.cursor?.tables ?? live.map((o) => o.name);
    const dumpable = page.cursor === null ? live : live.filter((o) => pinned.includes(o.name));

    if (page.cursor !== null) {
      walk.index = dumpable.findIndex((o) => o.name === page.cursor?.table);

      if (walk.index < 0) return yield* cannotResume(`table "${page.cursor.table}" no longer exists`);
      walk.after = page.cursor.after;
    }

    const stopped = yield* dumpRows(sql, dumpable, walk, { sink, maxBytes: page.maxBytes });

    return stopped === null
      ? null
      : { lines: sink.lines, next: { phase: 'sql', table: stopped.table, after: stopped.after, rows: walk.rows, tables: pinned } };
  });
}

function agentsPhase(source: ArchiveAgentSource, agents: readonly string[], { sink, walk }: PageState, page: {
  readonly cursor: ArchiveAgentsCursor | null; readonly maxBytes: number;
}): Effect.Effect<ArchivePage | null> {
  return Effect.gen(function* () {
    const from = page.cursor === null ? 0 : agents.indexOf(page.cursor.actor);

    if (from < 0) return yield* cannotResume(`agent ${page.cursor?.actor ?? ''} is no longer listed`);

    for (let at = from; at < agents.length; at++) {
      const actor = agents[at];
      const inner = at === from ? page.cursor?.inner ?? null : null;
      const section = yield* Effect.promise(() => source.page(actor, inner, Math.max(1, page.maxBytes - sink.bytes)));

      for (const line of section.lines) emitLine(sink, line);
      walk.rows += section.rows;

      if (section.next !== null) return { lines: sink.lines, next: { phase: 'agents', actor, inner: section.next, rows: walk.rows } };

      if (sink.bytes >= page.maxBytes && at + 1 < agents.length) {
        return { lines: sink.lines, next: { phase: 'agents', actor: agents[at + 1], inner: null, rows: walk.rows } };
      }
    }

    return null;
  });
}

function filesPhase(source: ArchiveFileSource, { sink, walk }: PageState, page: {
  readonly cursor: ArchiveFilesCursor | null; readonly maxBytes: number; readonly count: { files: number };
}): Effect.Effect<ArchivePage | null> {
  return Effect.gen(function* () {
    for (const entry of yield* archiveEntries(source)) {
      if (page.cursor && entry.path <= page.cursor.after) continue;

      if (entry.type === 'directory') {
        emitTo(sink, { t: 'directory', path: entry.path });
      } else {
        emitTo(sink, { t: 'file', path: entry.path, data: bytesToBase64(yield* Effect.promise(() => source.readFile(entry.path))) });
      }

      page.count.files++;

      if (sink.bytes >= page.maxBytes) {
        return { lines: sink.lines, next: { phase: 'files', after: entry.path, rows: walk.rows, files: page.count.files } };
      }
    }

    return null;
  });
}

/** The soul is a row a boot seals into the file; runtimes reinstall on use. */
const MAIN_HOME_NOT_CARRIED = { [SOUL_PATH]: true, '.nimbus': true } satisfies Record<string, true>;

function carriedRoots(pinned: ArchivePinnedStore): string[] {
  const under = (parent: string, carried: (name: string) => boolean): string[] => pinned.readdir(parent)
    .filter(carried).sort().map((name) => `${parent}/${name}`);

  return [
    ...under(WORKSPACE_ROOT, (name) => !Object.hasOwn(MAIN_HOME_NOT_CARRIED, name)),
    ...under('/home', (name) => `/home/${name}` !== WORKSPACE_ROOT),
    ...under(SLATES_ROOT, () => true),
  ];
}

/** A restore writes nowhere `carriedRoots` could not name. */
function isCarriedRoot(stored: string): boolean {
  // Nimbus roots have no leading slash.
  const root = `/${normalizeVfsPath(stored)}`;
  const parent = root.slice(0, Math.max(0, root.lastIndexOf('/')));
  const name = root.slice(parent.length + 1);

  if (!isTreeRelativePath(name)) return false;

  if (parent === WORKSPACE_ROOT) return !Object.hasOwn(MAIN_HOME_NOT_CARRIED, name);

  return parent === SLATES_ROOT || (parent === '/home' && root !== WORKSPACE_ROOT);
}

function storePhase(source: ArchiveStoreSource, { sink, walk }: PageState, page: {
  readonly cursor: ArchiveStoreCursor | null; readonly maxBytes: number; readonly count: { files: number };
}): Effect.Effect<ArchivePage | null, KinuError> {
  return Effect.gen(function* () {
    const pin = page.cursor?.pin ?? `${ARCHIVE_PIN_PREFIX}${crypto.randomUUID()}`;
    const pinned = page.cursor === null ? yield* Effect.promise(() => source.pin(pin)) : yield* Effect.promise(() => source.pinned(pin));

    if (pinned === null) return yield* Effect.fail(new KinuError('missing', ARCHIVE_SNAPSHOT_ENDED));
    const roots = carriedRoots(pinned);
    let { root, after, sent } = page.cursor ?? { root: 0, after: null, sent: 0 };

    const stopped = (): ArchivePage => ({
      lines: sink.lines, next: { phase: 'store', pin, root, after, sent, rows: walk.rows, files: page.count.files },
    });

    while (root < roots.length) {
      const exported = pinned.exportPage(roots[root], after);
      let owed = [...new Set(exported.rows.flatMap((row) => row.pieces.map(([hash]) => hash)))].slice(sent);

      if (sent === 0) {
        emitTo(sink, { t: 'page', page: exported });
        page.count.files += exported.rows.length;
      }

      while (owed.length > 0) {
        // base64: 4 characters per 3 bytes.
        const { chunks, rest } = pinned.exportChunks(owed, Math.max(1, Math.floor((page.maxBytes - sink.bytes) * 3 / 4)));

        emitTo(sink, { t: 'chunks', chunks: chunks.map((chunk) => ({ hash: chunk.hash, data: bytesToBase64(chunk.data) })) });
        sent += chunks.length;
        owed = rest;

        if (owed.length > 0 && sink.bytes >= page.maxBytes) return stopped();
      }

      [root, after, sent] = exported.next === null ? [root + 1, null, 0] : [root, exported.next, 0];

      if (root < roots.length && sink.bytes >= page.maxBytes) return stopped();
    }

    yield* Effect.promise(() => pinned.release());

    return null;
  });
}

function treePhases(opts: ExportOptions, state: PageState, page: {
  readonly cursor: ArchiveCursor | null; readonly maxBytes: number; readonly count: { files: number };
}): Effect.Effect<ArchivePage | null, KinuError> {
  return Effect.gen(function* () {
    const { cursor, maxBytes, count } = page;

    if (opts.files) {
      const full = yield* filesPhase(opts.files, state, { cursor: cursor?.phase === 'files' ? cursor : null, maxBytes, count });

      if (full !== null) return full;
    } else if (cursor?.phase === 'files') {
      return yield* cannotResume('its workspace file source is unavailable');
    }

    if (opts.store) return yield* storePhase(opts.store, state, { cursor: cursor?.phase === 'store' ? cursor : null, maxBytes, count });

    return cursor?.phase === 'store' ? yield* cannotResume('its workspace store is unavailable') : null;
  });
}

/** Call with `cursor: null`, then each page's `next` until it is null. */
export function readWorkspaceArchivePage(
  sql: SqlExec,
  opts: ExportOptions,
): Promise<ArchivePage> {
  return settle(Effect.gen(function* () {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const cursor = opts.cursor ?? null;
    const schema = readSchema(sql).filter((o) => !opts.store || !isNimbusTable(o.table));
    const live = schema.filter((o) => o.dumpRows);
    const agents = opts.agents?.list() ?? [];
    const state: PageState = { sink: { lines: [], bytes: 0 }, walk: { index: 0, after: null, rows: cursor?.rows ?? 0 } };
    const count = { files: cursor?.phase === 'files' || cursor?.phase === 'store' ? cursor.files : 0 };

    if (cursor === null) emitHeader(state.sink, schema, opts, agents);

    if (cursor === null || cursor.phase === 'sql') {
      const full = yield* sqlPhase(sql, live, state, { cursor, maxBytes });

      if (full !== null) return full;
    }

    if (cursor?.phase !== 'files' && cursor?.phase !== 'store') {
      if (opts.agents) {
        const full = yield* agentsPhase(opts.agents, agents, state, { cursor: cursor?.phase === 'agents' ? cursor : null, maxBytes });

        if (full !== null) return full;
      } else if (cursor?.phase === 'agents') {
        return yield* cannotResume('its agent source is unavailable');
      }
    }

    const full = yield* treePhases(opts, state, { cursor, maxBytes, count });

    if (full !== null) return full;
    emitTo(state.sink, { t: 'end', rows: state.walk.rows, files: count.files, actors: countArchivedActors(sql) });

    return { lines: state.sink.lines, next: null };
  }));
}

/** Whole archive in one call, for callers with no transport in between. */
export async function writeWorkspaceArchive(sql: SqlExec, opts: ExportOptions): Promise<string[]> {
  const lines: string[] = [];
  let cursor: ArchiveCursor | null = null;

  do {
    const page = await readWorkspaceArchivePage(sql, { ...opts, cursor });
    lines.push(...page.lines);
    cursor = page.next;
  } while (cursor);

  return lines;
}

function storeRestore(open: (() => ArchiveStoreTarget) | undefined) {
  let target: ArchiveStoreTarget | null = null;
  const owed = new Set<string>();

  const page = (exported: VfsExportPage): Effect.Effect<void> => Effect.gen(function* () {
    if (!isCarriedRoot(exported.root)) {
      return yield* Effect.die(new Error(`This archive names a tree no archive carries: ${JSON.stringify(exported.root)}.`));
    }

    const opened = target ??= open?.() ?? null;

    if (!opened) return yield* Effect.die(new Error(NO_STORE_TARGET));

    for (const hash of (yield* Effect.promise(() => opened.importPage(exported))).pending) owed.add(hash);
  });

  const chunks = (records: ChunksRecord['chunks']): Effect.Effect<void> => Effect.gen(function* () {
    const opened = target;

    if (!opened) return yield* Effect.die(new Error('This archive has chunks before any page that names them.'));
    const hydrated = yield* Effect.promise(() => opened.hydrateChunks(records.map((chunk) => ({ hash: chunk.hash, data: base64ToBytes(chunk.data) }))));

    if (hydrated.invalid.length > 0) {
      return yield* Effect.die(new Error(`This archive is damaged: chunk ${hydrated.invalid[0]} does not hash to its name.`));
    }

    for (const hash of hydrated.stored) owed.delete(hash);
  });

  return {
    take: (record: PageRecord | ChunksRecord): Effect.Effect<{ entries: number; files: number }> => (record.t === 'page'
      ? page(record.page).pipe(Effect.as({
        entries: record.page.rows.length, files: record.page.rows.filter((row) => row.kind === 'file').length,
      }))
      : chunks(record.chunks).pipe(Effect.as({ entries: 0, files: 0 }))),
    finish: (): Effect.Effect<void> => (owed.size > 0
      ? Effect.die(new Error(`This archive is damaged: ${String(owed.size)} chunks its files name never arrived.`))
      : Effect.void),
  };
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
  store?: () => ArchiveStoreTarget;
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

const NO_STORE_TARGET = 'This archive contains a workspace store, but no store target was provided.';

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
    const store = storeRestore(opts.store);

    const openFiles = (): Effect.Effect<ArchiveFileTarget> => {
      fileTarget ??= opts.files?.() ?? null;

      return fileTarget ? Effect.succeed(fileTarget) : Effect.die(new Error(NO_FILE_TARGET));
    };

    const writer = new ArchiveRowWriter(sql);

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

      if (fileRecords > 0 && SQL_RECORDS.has(record.t)) {
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
        case 'row':
          writer.write(record);
          rows++;
          break;
        case 'agent':
          writer.close(record);
          break;

        case 'directory': {
          const path = yield* archivePath(record.path);
          finishSql();
          const target = yield* openFiles();
          yield* Effect.promise(() => target.mkdir(path, { recursive: true }));
          fileRecords++;
          break;
        }

        case 'file': {
          const path = yield* archivePath(record.path);
          finishSql();
          const target = yield* openFiles();
          const slash = path.lastIndexOf('/');

          if (slash > 0) yield* Effect.promise(() => target.mkdir(path.slice(0, slash), { recursive: true }));
          yield* Effect.promise(() => target.writeFile(path, base64ToBytes(record.data)));
          fileRecords++;
          files++;
          break;
        }

        case 'page':
        case 'chunks': {
          finishSql();
          const taken = yield* store.take(record);
          fileRecords += taken.entries;
          files += taken.files;
          break;
        }

        case 'end':
          end = record;
          break;
      }
    }

    yield* store.finish();

    if (!header) return yield* Effect.die(new Error('This file is not a Kinu workspace archive (no header).'));
    yield* writer.requireSections(header.agents ?? []);
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
