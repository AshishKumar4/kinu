/**
 * What one hot-path operation costs the database, counted rather than timed: every statement the
 * operation runs goes through a metered `SqlStorage`, and the cursors' own `rowsRead` and
 * `rowsWritten`, with the rows the caller took back out of each, are summed by the tables each
 * statement names, beside each table's row count and payload before and after. The subjects are
 * production code over this object's own SQLite: the session store as `createAgentStores` builds
 * it for an actor, driven through the calls `ActorSession` makes for a turn; the Nimbus workspace and
 * its Diffs baseline; and a slate's versions and forks through `SlateFiles`.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { SlateId } from '@agent-core/core/slates';
import {
  DynamicContextLedger, MAIN_AGENT, WORKSPACE_IDENTITY_DDL, WorkspaceActorDirectory,
  agentArtifactDirectory, agentHome, composePrepareStep, createAgentStores, getWorkspaceDiff, initActorClaimTables,
  initAgentConfigTable, initCodemodeStateTable, initWorkspaceActorTable, initWorkspaceBaselineTable,
  nimbusSessionFiles, resetWorkspaceBaseline, standardMounts, withMountTable,
  type ActorHandle, type AgentStores, type NimbusSandboxHandle, type SqlExecutor,
  type SqlValue, type StepContextPlane, type StepPipeline, type VFS,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { SlateFiles, WorkspaceSlateContentStore, slateDirectory } from '@kinu.run/core/slates';
import { workspaceBoxFiles } from '@kinu.run/core/workspace';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
// The writer `ActorSession` hands a turn's steps to; core keeps it internal.
import { SessionStream } from '../../../../core/src/orchestrator/session-stream';

/** One table's share of an operation: the rows its statements read and wrote, how many ran, and the
 *  rows they read beyond those they returned. A statement that seeks reads what it returns; one that
 *  scans reads the rest as well, and that surplus is `rowsScanned`. */
export interface TableCost {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly statements: number;
  readonly rowsScanned: number;
}

/** One figure per table, after minus before, nonzero only. */
export type TableChange = Readonly<Record<string, number>>;

/** An operation's whole cost. `storedRows` and `storedBytes` are each table's row count and payload
 *  bytes; `dbBytes` is the database file's, by the page. */
export interface OperationCost {
  readonly tables: Readonly<Record<string, TableCost>>;
  readonly dbBytes: number;
  readonly storedRows: TableChange;
  readonly storedBytes: TableChange;
  /** The model request bytes the operation prepared, where it prepares any. */
  readonly requestBytes: number | null;
}

/** A table a statement names; an upsert's `DO UPDATE SET` names none. */
const NAMED = /\b(?:FROM|JOIN|INTO|UPDATE(?:\s+OR\s+[A-Za-z]+)?)\s+(?!SET\b)["`[]?([A-Za-z_]\w*)/giu;

const SCHEMA = /^\s*(?:CREATE|DROP|ALTER|PRAGMA)\b/iu;

/**
 * What a statement is charged to: every table it names, jointly (`a+b`). A cursor counts the rows
 * the whole statement read, subqueries and joins included, and nothing says which table each came
 * from, so charging the first name would pin one table's rows on another.
 */
function tableOf(query: string): string {
  if (SCHEMA.test(query)) return '(schema)';

  const names = new Set([...query.matchAll(NAMED)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));

  return names.size === 0 ? '(no table)' : [...names].sort().join('+');
}

const TableName = v.object({ name: v.string() });

const RowCount = v.object({ rows: v.number() });

const ColumnName = v.object({ name: v.string() });

const PayloadBytes = v.object({ bytes: v.nullable(v.number()) });

/** The two counts a cursor keeps as it runs; read once the operation has settled. */
interface CursorCounts {
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

interface MeteredStatement {
  readonly table: string;
  readonly cursor: CursorCounts;
  /** Rows the caller took out of the cursor, by any of its reads. */
  readonly returned: { rows: number };
}

/** `cursor`, counting every row its caller takes out of it. */
function countingCursor<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>, returned: { rows: number }): SqlStorageCursor<T> {
  const counted = <Row,>(rows: IterableIterator<Row>): IterableIterator<Row> => {
    const iterator: IterableIterator<Row> = {
      next: () => {
        const step = rows.next();

        if (step.done !== true) returned.rows += 1;

        return step;
      },
      [Symbol.iterator]: () => iterator,
    };

    return iterator;
  };

  return {
    next: () => {
      const step = cursor.next();

      if (step.done !== true) returned.rows += 1;

      return step;
    },
    toArray: () => {
      const rows = cursor.toArray();

      returned.rows += rows.length;

      return rows;
    },
    one: () => {
      const row = cursor.one();

      returned.rows += 1;

      return row;
    },
    raw: <U extends SqlStorageValue[]>() => counted(cursor.raw<U>()),
    columnNames: cursor.columnNames,
    get rowsRead() { return cursor.rowsRead; },
    get rowsWritten() { return cursor.rowsWritten; },
    get reusedCachedQueryForTest() { return cursor.reusedCachedQueryForTest; },
    [Symbol.iterator]: () => counted(cursor[Symbol.iterator]()),
  };
}

/** Every statement run through `sql` while an operation is measured, with the cursor that ran it. */
class SqlMeter {
  private open: MeteredStatement[] | null = null;

  readonly sql: SqlStorage;

  constructor(private readonly real: SqlStorage) {
    const record = (query: string, cursor: CursorCounts) => {
      const returned = { rows: 0 };

      this.open?.push({ table: tableOf(query), cursor, returned });

      return returned;
    };

    this.sql = {
      exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
        const cursor = real.exec<T>(query, ...bindings);

        return countingCursor(cursor, record(query, cursor));
      },
      prepare: (query) => real.prepare(query),
      ingest: (query) => real.ingest(query),
      setMaxPageCountForTest: (count) => { real.setMaxPageCountForTest(count); },
      get databaseSize() { return real.databaseSize; },
      Cursor: real.Cursor,
      Statement: real.Statement,
    };
  }

  private tableNames(): string[] {
    return this.real.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND substr(name, 1, 4) <> '_cf_'`)
      .toArray().map((row) => v.parse(TableName, row).name);
  }

  private rowsByTable(): Map<string, number> {
    return new Map(this.tableNames().map((name) => [name, v.parse(RowCount, this.real.exec(`SELECT count(*) AS rows FROM "${name}"`).one()).rows]));
  }

  /** Each table's stored payload, exactly: every column's encoded bytes (`octet_length`, which
   *  reads a blob's size without its content), where the page count moves 4 KiB at a time. */
  private bytesByTable(): Map<string, number> {
    return new Map(this.tableNames().map((name) => {
      const columns = this.real.exec(`SELECT name FROM pragma_table_info('${name}')`).toArray().map((row) => v.parse(ColumnName, row).name);
      const sum = columns.map((column) => `coalesce(sum(octet_length("${column}")), 0)`).join(' + ');

      return [name, v.parse(PayloadBytes, this.real.exec(`SELECT ${sum || '0'} AS bytes FROM "${name}"`).one()).bytes ?? 0];
    }));
  }

  private static grown(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): TableChange {
    return Object.fromEntries([...after].flatMap(([table, value]) => {
      const change = value - (before.get(table) ?? 0);

      return change === 0 ? [] : [[table, change]];
    }));
  }

  /** Runs `operation` with every statement counted; cursors are read after it settles, so a cursor it
   *  left half-read counts the rows it actually read. */
  async measure(operation: () => Promise<number | null>): Promise<OperationCost> {
    const rowsBefore = this.rowsByTable();
    const payloadBefore = this.bytesByTable();
    const bytesBefore = this.real.databaseSize;

    const ran: MeteredStatement[] = [];
    let prepared: number | null;

    this.open = ran;

    try {
      prepared = await operation();
    } finally {
      // A cursor stays readable after its statement; statements after the operation go uncounted.
      this.open = null;
    }

    const tables: Record<string, { rowsRead: number; rowsWritten: number; statements: number; rowsScanned: number }> = {};

    for (const { table, cursor, returned } of ran) {
      const entry = tables[table] ??= { rowsRead: 0, rowsWritten: 0, statements: 0, rowsScanned: 0 };
      entry.rowsRead += cursor.rowsRead;
      entry.rowsWritten += cursor.rowsWritten;
      entry.statements += 1;
      entry.rowsScanned += Math.max(0, cursor.rowsRead - returned.rows);
    }

    return {
      tables,
      dbBytes: this.real.databaseSize - bytesBefore,
      storedRows: SqlMeter.grown(rowsBefore, this.rowsByTable()),
      storedBytes: SqlMeter.grown(payloadBefore, this.bytesByTable()),
      requestBytes: prepared,
    };
  }
}

function addChanges(a: TableChange, b: TableChange): TableChange {
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);

  return Object.fromEntries([...tables].map((table) => [table, (a[table] ?? 0) + (b[table] ?? 0)]));
}

/** Several operations' costs as one: what the run of them cost together. */
function sumCosts(costs: readonly OperationCost[]): OperationCost {
  const tables: Record<string, TableCost> = {};

  for (const cost of costs) {
    for (const [table, counted] of Object.entries(cost.tables)) {
      const sum = tables[table] ?? { rowsRead: 0, rowsWritten: 0, statements: 0, rowsScanned: 0 };

      tables[table] = {
        rowsRead: sum.rowsRead + counted.rowsRead, rowsWritten: sum.rowsWritten + counted.rowsWritten,
        statements: sum.statements + counted.statements, rowsScanned: sum.rowsScanned + counted.rowsScanned,
      };
    }
  }

  return {
    tables,
    dbBytes: costs.reduce((sum, cost) => sum + cost.dbBytes, 0),
    storedRows: costs.reduce<TableChange>((sum, cost) => addChanges(sum, cost.storedRows), {}),
    storedBytes: costs.reduce<TableChange>((sum, cost) => addChanges(sum, cost.storedBytes), {}),
    requestBytes: null,
  };
}

/** How many versions in a row the slate subject counts: enough that Nimbus's content maintenance,
 *  which reads one page of content ids a write from a cursor that wraps at the end of the store, is
 *  counted across its pages rather than at whichever page one write happened to land on. */
const VERSIONS_COUNTED = 8;

/** A deterministic source file of about 2 KiB, distinct per index and per version. */
function fileText(index: number, version = 0): string {
  const lines: string[] = [];

  for (let line = 0; line < 48; line += 1) {
    lines.push(`export const v${String(index)}_${String(line)} = ${String((index * 7919 + line * 104729 + version * 15485863) % 1000003)};`);
  }

  return `${lines.join('\n')}\n`;
}

/** A hundred files a directory, as a real tree spreads them. */
function filePath(index: number): string {
  return `src/m${String(Math.floor(index / 100))}/f${String(index)}.ts`;
}

const PROGRAM = { kind: 'builtin' as const, version: 0, digest: null, build: null };

/** The two steps of one scripted turn: a file write the model asks for, then its answer. */
function toolCall(turn: number): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call-${String(turn)}`, toolName: 'file', input: { action: 'write', path: `notes/${String(turn)}.md`, content: `note ${String(turn)}` } }] };
}

function toolResult(turn: number): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call-${String(turn)}`, toolName: 'file', output: { type: 'json', value: { ok: true, path: `notes/${String(turn)}.md` } } }] };
}

function requestBytes(messages: readonly ModelMessage[] | undefined): number {
  return new TextEncoder().encode(JSON.stringify(messages ?? [])).byteLength;
}

/** The chat step pipeline a turn bound for Anthropic runs (chat.ts `prepareStep`): replayed tool ids
 *  normalized for the destination and cache markers on the tail, both of which copy messages, and a
 *  prune budget. The dynamic block and the step context are the turn's own. */
const PIPELINE = {
  prune: { contextWindow: 200_000, modelOutputLimit: 8_000 },
  destinationProviderId: 'anthropic',
  cache: { strategy: { kind: 'anthropic' as const } },
} satisfies StepPipeline;

/** A woven block, as `ActorSession`'s dynamic snapshot supplies one. */
const DYNAMIC = { recoveries: ['a finding proven by execution'] };

export class ComplexityProbeDO extends DurableObject<Cloudflare.Env> {
  private readonly meter = new SqlMeter(this.ctx.storage.sql);

  private readonly executor: SqlExecutor = <Row,>(strings: TemplateStringsArray, ...values: SqlValue[]): Row[] =>
    this.meter.sql.exec<Row & Record<string, SqlStorageValue>>(strings.join('?'), ...values).toArray();

  private readonly execRaw = (ddl: string): void => { this.meter.sql.exec(ddl); };

  private opened: Promise<SqliteVFS> | undefined;

  private workspace(): Promise<SqliteVFS> {
    this.opened ??= NimbusWorkspace.create({ sql: this.meter.sql, transactions: { storage: this.ctx.storage } })
      .then((workspace) => workspace.vfs);

    return this.opened;
  }

  /** The workspace box as the orchestrator's file plane opens it; this object runs no processes. */
  private box(): NimbusSandboxHandle {
    return {
      files: workspaceBoxFiles(() => this.workspace()),
      ready: async () => undefined,
      exec: async () => { throw new Error('the complexity probe runs no processes'); },
    };
  }

  /** The agent's file plane, as `createCFRuntime` mounts it (no /pc, no /sandbox here). */
  private agentFiles(): VFS {
    return withMountTable(nimbusSessionFiles(this.box()), standardMounts(() => undefined));
  }

  private main(): ActorHandle {
    this.execRaw(WORKSPACE_IDENTITY_DDL);
    initWorkspaceActorTable(this.execRaw);
    initAgentConfigTable(this.execRaw);
    initCodemodeStateTable(this.execRaw);
    initActorClaimTables(this.execRaw);
    const workspaceId = crypto.randomUUID();

    void this.executor`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, ${'complexity'})`;

    return new WorkspaceActorDirectory(this.executor, { workspaceId, ownerUserId: '' }).createMain({ name: 'complexity' });
  }

  /** The actor's stores exactly as the orchestrator builds them (actor-agent.ts `stores`). */
  private stores(actor: ActorHandle): AgentStores {
    return createAgentStores(() => this.executor, () => actor, (write) => this.ctx.storage.transactionSync(write), async () => ({
      vfs: nimbusSessionFiles(this.box(), CRED_SESSION_USER),
      artifactDirectory: agentArtifactDirectory(agentHome(MAIN_AGENT)),
    }));
  }

  /**
   * One scripted turn through the store calls `ActorSession` makes (actor-session.ts): `openTurnInput`
   * admits and activates the input; `runTurn` admits the materialized context under a claim, runs two
   * requests through {@link PIPELINE} with its dynamic ledger, writes each step's response through a
   * `SessionStream`, settles it, reads the turn's output back, and the claim settles. The model, the
   * tools and the program are not run: the first step is a file call and its result, the second the
   * answer. Returns the bytes of the two requests.
   */
  private async turn(actor: ActorHandle, stores: AgentStores, dynamic: DynamicContextLedger, turn: number): Promise<number> {
    const turnId = `turn-${String(turn)}`;
    const assertOwner = (): void => { actor.assertCurrent(); };

    const { history, claims } = stores;

    await history.materialize();

    const input = await history.admitInput({ id: turnId, message: { role: 'user', content: `question ${String(turn)}` }, turnId, assertOwner });

    history.activateInput(input, turnId, assertOwner);
    await history.materialize();

    const admitted = await history.materialize();

    const claim = await claims.admit({ runId: `run-${String(turn)}`, turnId, workMode: 'build', program: PROGRAM, context: admitted.selection });

    const stream = new SessionStream(history, turnId, claim.epoch);

    const context: StepContextPlane = {
      base: () => history.stepBase(() => { history.assertEpoch(claim.turnId, claim.epoch); }, claim.turnId, null),
      consume: async ({ stepNumber, messages }) => {
        const consumed = await claims.consume(claim, { index: stepNumber, messages });

        stream.beginRequest(consumed.requestId, stepNumber);
      },
    };

    const pipeline: StepPipeline = { ...PIPELINE, dynamic: { ledger: dynamic, snapshot: () => DYNAMIC }, context };

    const call = toolCall(turn);
    const result = toolResult(turn);
    const answer: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: `answer ${String(turn)}` }] };

    const first = await composePrepareStep(pipeline, { stepNumber: 0, messages: [...admitted.messages], steps: [] });

    await stream.nativeStep([call, result]);

    const second = await composePrepareStep(pipeline, { stepNumber: 1, messages: [], steps: [] });

    await stream.nativeStep([call, result, answer]);
    await stream.settle();
    await history.materialize();
    await history.outputForTurn(turnId);
    claims.settle(claim, 'completed');

    return requestBytes(first?.messages) + requestBytes(second?.messages);
  }

  /** Subject: one turn of a session that already holds `history` turns. */
  async sessionTurn(history: number): Promise<OperationCost> {
    const actor = this.main();
    const stores = this.stores(actor);
    const dynamic = new DynamicContextLedger();

    for (let turn = 0; turn < history; turn += 1) await this.turn(actor, stores, dynamic, turn);

    return await this.meter.measure(async () => await this.turn(actor, stores, dynamic, history));
  }

  /** Subject: one Diffs read of a workspace of `files` files with one edited since its baseline. */
  async diffRead(files: number): Promise<OperationCost> {
    const actor = this.main();
    const vfs = this.agentFiles();

    initWorkspaceBaselineTable(this.execRaw);

    for (let index = 0; index < files; index += 1) await vfs.writeFile(filePath(index), fileText(index));

    const runtime = {
      storage: { vfs, sql: this.executor, execRaw: this.execRaw, transactionSync: <T,>(write: () => T): T => this.ctx.storage.transactionSync(write) },
      actor,
    };

    await resetWorkspaceBaseline(runtime);
    const edited = Math.floor(files / 2);

    await vfs.writeFile(filePath(edited), fileText(edited, 1));

    return await this.meter.measure(async () => {
      const diff = await getWorkspaceDiff(runtime);

      if (diff.files.length !== 1) throw new Error(`the Diffs read saw ${String(diff.files.length)} changed files, not the 1 edited`);

      return null;
    });
  }

  private async slates(): Promise<{ readonly files: SlateFiles; readonly tree: CredentialedVfs }> {
    const vfs = await this.workspace();
    const tree = vfs.as(CRED_SESSION_USER);
    const files = new SlateFiles(tree, new WorkspaceSlateContentStore(vfs.as(CRED_KERNEL)), (body) => vfs.withTransaction(body));

    return { files, tree };
  }

  private writeSlate(tree: CredentialedVfs, root: string, files: number, version: (index: number) => number): void {
    for (let index = 0; index < files; index += 1) {
      const path = `${root}/${filePath(index)}`;

      tree.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      tree.writeFile(path, new TextEncoder().encode(fileText(index, version(index))));
    }
  }

  /** One slate transaction; RPC carries no `cause`, so a rollback is rethrown with its whole chain. */
  private inTransaction<Result>(files: SlateFiles, body: () => Result): Result {
    try {
      return files.transaction(body);
    } catch (cause) {
      throw new Error(renderThrownChain({ cause }), { cause });
    }
  }

  /** Subject: the next {@link VERSIONS_COUNTED} versions of a 16-file slate that already has `versions`
   *  versions, one file changed before each. The edits are the agent's, and go uncounted. */
  async slateVersion(versions: number): Promise<OperationCost> {
    const { files, tree } = await this.slates();
    const id = new SlateId('s1');
    const root = slateDirectory(id);

    this.writeSlate(tree, root, 16, () => 0);

    for (let version = 1; version <= versions; version += 1) {
      this.writeSlate(tree, root, 1, () => version);
      this.inTransaction(files, () => files.capture(id));
    }

    const counted: OperationCost[] = [];

    for (let next = 1; next <= VERSIONS_COUNTED; next += 1) {
      this.writeSlate(tree, root, 1, () => versions + next);
      counted.push(await this.meter.measure(async () => {
        this.inTransaction(files, () => files.capture(id));

        return null;
      }));
    }

    return sumCosts(counted);
  }

  /** Subject: a fork (a restore into a new slate) of one version of a `size`-file slate. */
  async slateFork(size: number): Promise<OperationCost> {
    const { files, tree } = await this.slates();
    const source = new SlateId('s1');

    this.writeSlate(tree, slateDirectory(source), size, () => 0);
    const version = this.inTransaction(files, () => files.capture(source));

    return await this.meter.measure(async () => {
      this.inTransaction(files, () => files.restore(new SlateId('s2'), version));

      return null;
    });
  }
}
