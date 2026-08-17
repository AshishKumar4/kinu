/**
 * Test helpers — in-memory SQLite via bun:sqlite, mock LLM, mock Executor.
 * These satisfy the core primitive interfaces for testing.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import type {
  SqlExecutor,
  SqlExec,
  SqlExecRow,
  SqlValue,
  RawSqlExec,
  Memory,
  Executor,
  LLM,
  Schedule,
  Identity,
  FiberCtx,
  ExecuteResult,
  ResolvedProvider,
  VFS,
} from '../src/types/primitives.js';
import type { AgentRuntime, CraftStore, BranchHandle } from '../src/types/agent-runtime.js';
import type { CraftedTool } from '../src/types/craft.js';
import { JsonValueSchema, type JsonValue } from '../src/utils/json.js';
import { createInlineMemory, type AgentDatabase } from '../src/identity/inline-primitives.js';
import { createWorkspace, nextWorkspaceGeneration } from '../src/vfs/nimbus-workspace.js';
import { initWorkspaceSchema } from '../src/identity/workspace-schema.js';
import { walkWorkspaceTextFiles } from '../src/read-models/workspace-diff.js';

/** One in-memory workspace database with the three SQL handles onto it. */
export interface TestWorkspace {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
  readonly vfs: VFS;
}

/**
 * A workspace database carrying the PRODUCTION schema.
 *
 * `initWorkspaceSchema` rather than a hand-picked subset: a harness that
 * creates fewer tables than a real workspace tests a shape no workspace ever
 * has, and the code under test then has to tolerate absences that only the
 * harness produces. That tolerance is what hid a fork silently dropping the
 * parent's assistant messages and memory index.
 */
export function createTestWorkspace(): TestWorkspace {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db) });
  return { db, sql, execRaw, vfs: createWorkspaceBundle(db).vfs };
}

/**
 * The agents SDK's own session-store DDL, verbatim from
 * `AgentSessionProvider.ensureTable`. `created_at` is a whole-second DATETIME —
 * the reason a fork cut cannot be a timestamp comparison.
 *
 * Deliberately NOT part of `createTestWorkspace`: the SDK creates this table on
 * its first append, so a real workspace that has never run a turn does not have
 * it, and the code under test has to keep answering that absence correctly.
 * A test that needs the table seeds it explicitly, from this one definition.
 */
export const SDK_SESSION_DDL = `CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

// ── SqlExecutor from bun:sqlite ──────────────────────────────────

export function makeSql(db: Database): SqlExecutor {
  return function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? '?' : ''),
      '',
    );
    // bun:sqlite binds TypedArrays, not ArrayBuffers (the canonical VFS BLOB type).
    const bound: SQLQueryBindings[] = values.map((value) =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare<T, SQLQueryBindings[]>(query);
    if (isRead) return stmt.all(...bound);
    stmt.run(...bound);
    return [];
  };
}

export function makeExecRaw(db: Database): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

type NativeSqlValue = string | number | boolean | null | Uint8Array;
type NativeSqlRow = Record<string, NativeSqlValue>;
type NativeWorkspaceSqlRow = Record<string, string | number | bigint | null | Uint8Array>;

function canonicalSqlValue(value: NativeSqlValue): SqlValue {
  if (!(value instanceof Uint8Array)) return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

/** Dynamic-SQL peer of makeSql, with the same canonical ArrayBuffer BLOBs. */
export function makeSqlExec(db: Database): SqlExec {
  return {
    exec(query, ...bindings) {
      const bound: SQLQueryBindings[] = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value);
      const stmt = db.prepare<NativeSqlRow, SQLQueryBindings[]>(query);
      if (stmt.columnNames.length === 0) {
        stmt.run(...bound);
        return { toArray: () => [] };
      }
      const rows: SqlExecRow[] = stmt.all(...bound).map((row) => Object.fromEntries(
        Object.entries(row).map(([column, value]) => [column, canonicalSqlValue(value)]),
      ));
      return { toArray: () => rows };
    },
  };
}

// ── In-memory VFS ────────────────────────────────────────────────

/** The production workspace filesystem over the test database — the same
 *  Nimbus component both backends run, so tests catch real writer/reader
 *  drift rather than a fixture's. */
export function createMemoryVFS(db: Database): VFS {
  return createWorkspaceBundle(db).vfs;
}

/**
 * `vfs`, with every call ordered after the fixture's own seed — so a fixture's seed can never land
 * on top of what a test wrote.
 *
 * `seed` is a THUNK, run at most once on the first VFS call, not a promise started eagerly. An
 * eagerly-started seed is a floating promise racing the test: a test that never touches the VFS and
 * closes its database still had a `writeFile` in flight, and it landed as
 * `RangeError: Cannot use a closed database` from inside nimbus's sqlite-vfs, attributed to
 * whichever test happened to be running. Deferring it means a test that does not use the
 * filesystem never starts one. A seed FAILURE is still not absorbed — it rejects the first VFS
 * call, because a suite silently running against a workspace with no scaffold is how a production
 * swallow gets excused as "the test target lacks the file".
 */
function afterSeed(vfs: VFS, seed: () => Promise<void>): VFS {
  let seeded: Promise<void> | null = null;
  const chain = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      seeded ??= seed();
      await seeded;
      return fn(...args);
    };
  return {
    readFile: chain((p: string, o?: { encoding?: string }) => vfs.readFile(p, o)),
    writeFile: chain((p: string, d: string | Uint8Array) => vfs.writeFile(p, d)),
    readdir: chain((p: string) => vfs.readdir(p)),
    stat: chain((p: string) => vfs.stat(p)),
    unlink: chain((p: string) => vfs.unlink(p)),
    mkdir: chain((p: string, o?: { recursive?: boolean }) => vfs.mkdir(p, o)),
    exists: chain((p: string) => vfs.exists(p)),
  };
}

/** The workspace filesystem AND its shell over the test database. */
export function createWorkspaceBundle(db: Database) {
  const sql = {
    exec<Binding>(query: string, ...bindings: Binding[]) {
      const bound = bindings.map(nativeSqlBinding);
      const stmt = db.prepare<NativeWorkspaceSqlRow, SQLQueryBindings[]>(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...bound);
      stmt.run(...bound);
      return [];
    },
  };
  return createWorkspace({
    sql,
    transactions: { storage: { transactionSync: <T,>(cb: () => T): T => db.transaction(cb)() } },
    generation: nextWorkspaceGeneration(sql),
  });
}

function nativeSqlBinding<Binding>(value: Binding): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  const scalar = v.safeParse(v.union([v.string(), v.number(), v.boolean(), v.null()]), value);
  if (scalar.success) return scalar.output;
  if (v.safeParse(v.undefined(), value).success) return null;
  throw new TypeError('Unsupported SQLite test binding');
}

/** bun:sqlite projected onto the identity bootstrap's deliberately small DB seam. */
export function makeAgentDatabase(db: Database): AgentDatabase {
  return {
    prepare<T = unknown>(query: string) {
      const statement = db.prepare<T, SQLQueryBindings[]>(query);
      return {
        all: (...params) => statement.all(...params.map(nativeSqlBinding)),
        run: (...params) => { statement.run(...params.map(nativeSqlBinding)); },
      };
    },
    exec: (query) => { db.exec(query); },
    run: (query, params = []) => { db.run(query, params.map(nativeSqlBinding)); },
    transaction: <T>(fn: () => T) => db.transaction(fn),
  };
}

// ── In-memory Memory ─────────────────────────────────────────────

/**
 * The Memory a test runtime gets: the SAME inline primitive the local CLI path
 * builds, over the same `memory_chunks` shape.
 *
 * It used to be a hand-rolled copy with a third schema, `(id, path, content)`.
 * Once `initWorkspaceSchema` created the real seven-column table the copy's
 * insert failed on every call, and the catch around it reported a file as
 * indexed — so every memory assertion in this suite was passing against a
 * memory that had never stored anything.
 */
export function createMemoryMemory(db: Database, vfs: VFS): Memory {
  return createInlineMemory(makeAgentDatabase(db), vfs);
}

// ── Mock LLM ─────────────────────────────────────────────────────

export function createMockLLM(responses: Record<string, string> = {}): LLM {
  return {
    async *stream(opts) {
      const key = Object.keys(responses).find(k => opts.system.includes(k) || opts.messages.some(m => m.content.includes(k)));
      yield responses[key ?? ''] ?? 'mock response';
    },
    async complete(prompt) {
      const key = Object.keys(responses).find(k => prompt.includes(k));
      return responses[key ?? ''] ?? '{"score": 0.5, "rationale": "mock"}';
    },
  };
}

// ── Mock Executor ────────────────────────────────────────────────

export function createMockExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code: string, _providers: ResolvedProvider[] | Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>): Promise<ExecuteResult> {
      // Just check if the code parses
      try {
        new Function(code);
        return { result: true };
      } catch (e) {
        return { result: undefined, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Executes codemode statements with resolved providers exposed as globals. */
export function createEvalExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code, providers) {
      if (!Array.isArray(providers)) {
        return { result: undefined, error: 'eval executor requires resolved providers' };
      }
      try {
        const evaluate = new Function(
          ...providers.map((provider) => provider.name),
          `return (async () => {\n${code}\n})();`,
        );
        const rawResult: unknown = await evaluate(...providers.map((provider) => provider.fns));
        if (rawResult === undefined) return { result: undefined };
        const result = v.safeParse(JsonValueSchema, rawResult);
        return result.success
          ? { result: result.output }
          : { result: undefined, error: 'eval executor returned a non-JSON value' };
      } catch (err) {
        return { result: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ── In-memory CraftStore ─────────────────────────────────────────

export function createMemoryCraftStore(db: Database): CraftStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crafted_tools (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      params TEXT,
      code TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);

  // The row→tool mapping the production CraftStore performs. Handing raw rows
  // back instead would hide real drift: `params` is stored as JSON text and the
  // timestamps are snake_case, so a caller reading `tool.params` would get a
  // string in tests and an object in production.
  interface CraftRow {
    name: string; description: string; params: string | null; code: string;
    scope: string; created_at: number; updated_at: number;
  }
  const CraftRowSchema: v.GenericSchema<CraftRow> = v.object({
    name: v.string(), description: v.string(), params: v.nullable(v.string()), code: v.string(),
    scope: v.string(), created_at: v.number(), updated_at: v.number(),
  });
  const CraftParamsSchema = v.record(v.string(), v.string());
  const CraftScopeSchema = v.picklist(['local', 'shared']);
  const toTool = (row: CraftRow): CraftedTool => ({
    name: row.name,
    description: row.description,
    params: row.params ? v.parse(CraftParamsSchema, JSON.parse(row.params)) : null,
    code: row.code,
    scope: v.parse(CraftScopeSchema, row.scope),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const rows = <Binding>(query: string, ...bindings: Binding[]): CraftRow[] =>
    db.query<NativeSqlRow, SQLQueryBindings[]>(query).all(...bindings.map(nativeSqlBinding))
      .map((row) => v.parse(CraftRowSchema, row));

  return {
    create(tool) {
      db.run(
        'INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tool.name, tool.description, tool.params ? JSON.stringify(tool.params) : null, tool.code, tool.scope, Date.now(), Date.now()],
      );
    },
    update(name, patch) {
      if (patch.code !== undefined) db.run('UPDATE crafted_tools SET code = ?, updated_at = ? WHERE name = ?', [patch.code, Date.now(), name]);
      if (patch.description !== undefined) db.run('UPDATE crafted_tools SET description = ?, updated_at = ? WHERE name = ?', [patch.description, Date.now(), name]);
      if (patch.params !== undefined) db.run('UPDATE crafted_tools SET params = ?, updated_at = ? WHERE name = ?', [patch.params ? JSON.stringify(patch.params) : null, Date.now(), name]);
    },
    get(name) {
      const row = rows('SELECT * FROM crafted_tools WHERE name = ?', name)[0];
      return row ? toTool(row) : undefined;
    },
    delete(name) { db.run('DELETE FROM crafted_tools WHERE name = ?', [name]); },
    list() { return rows('SELECT * FROM crafted_tools').map(toTool); },
    search(query, limit = 10) {
      // Word-level search: match tools where any query word appears in description
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      return rows('SELECT * FROM crafted_tools')
        .filter(t => words.some(w => t.description.toLowerCase().includes(w)))
        .slice(0, limit)
        .map(toTool);
    },
    getAll() { return rows('SELECT * FROM crafted_tools').map(toTool); },
  };
}

// ── In-memory Schedule ───────────────────────────────────────────

export function createMemorySchedule(db: Database): Schedule {
  db.exec(`CREATE TABLE IF NOT EXISTS fibers (id TEXT PRIMARY KEY, name TEXT, snapshot TEXT, created_at INTEGER)`);

  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      const id = crypto.randomUUID();
      db.run('INSERT INTO fibers (id, name, snapshot, created_at) VALUES (?, ?, NULL, ?)', [id, name, Date.now()]);
      const stash = (data: JsonValue) => {
        db.run('UPDATE fibers SET snapshot = ? WHERE id = ?', [JSON.stringify(data), id]);
      };
      try {
        return await fn({ stash, snapshot: null });
      } finally {
        db.run('DELETE FROM fibers WHERE id = ?', [id]);
      }
    },
  };
}

// ── Full test runtime ────────────────────────────────────────────

export function createTestRuntime(opts?: {
  llmResponses?: Record<string, string>;
}) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  // One workspace, so the shell and the VFS are two views of the SAME bytes —
  // building a second bundle over the same database would be two filesystems
  // again, which is the thing this design removed.
  const workspace = createWorkspaceBundle(db);
  // The scaffold seed is a real file write, so it is a promise. `afterSeed` runs it on the first
  // VFS call and orders every later call behind it: a test that writes its own scaffold cannot be
  // overtaken by the seed landing afterwards, and a test that never touches the filesystem never
  // starts a write that could outlive its database. A failed seed is NOT absorbed.
  const vfs = afterSeed(workspace.vfs, () =>
    workspace.vfs.mkdir('scaffold', { recursive: true })
      .then(() => workspace.vfs.writeFile('scaffold/agent.js', 'initial')));
  const memory = createMemoryMemory(db, vfs);
  const craftStore = createMemoryCraftStore(db);
  const llm = createMockLLM(opts?.llmResponses);
  const executor = createMockExecutor();
  const schedule = createMemorySchedule(db);

  // The PRODUCTION schema, for the reason spelled out on createTestWorkspace:
  // a hand-picked subset tests a shape no workspace ever has, and the code
  // under test is then forced to tolerate absences only this harness produces.
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db) });

  const identity: Identity = {
    id: 'test-agent-id',
    name: 'test-agent',
    scaffold: {
      path: 'scaffold/agent.js',
      exists: () => vfs.exists('scaffold/agent.js'),
      read: async () => v.parse(v.string(), await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })),
      write: (code) => vfs.writeFile('scaffold/agent.js', code),
      version: async () => (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };

  const mockBranch: BranchHandle = {
    explore: async () => ({ text: 'explored approach A' }),
    generateReflection: async () => ({ text: 'reflection: approach was suboptimal' }),
  };

  const rt: AgentRuntime = {
    storage: { vfs, sql, execRaw },
    memory,
    executor,
    llm,
    schedule,
    identity,
    craftStore,
    judgeModel: llm,
    shell: workspace.shell,
    spawnBranch: async () => mockBranch,
    abortBranch: async () => {},
  };

  return { rt, db };
}

// ── Mock session writer ──────────────────────────────────────────

export function createMockSession(): import('../src/mcts/record-node.js').SessionWriter {
  const messages: Array<{ id: string; parentId?: string | null; role: string; content: string }> = [];

  return {
    async appendMessage(msg, parentId) {
      const content = msg.parts.map((part) => part.text).join('');
      messages.push({ id: msg.id, parentId, role: msg.role, content });
    },
    getHistory(leafId) {
      if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
      // Walk up via parentId
      const result: Array<{ role: string; content: string }> = [];
      let current = messages.find(m => m.id === leafId);
      while (current) {
        result.unshift({ role: current.role, content: current.content });
        const parentId = current.parentId;
        current = parentId ? messages.find(m => m.id === parentId) : undefined;
      }
      return result;
    },
  };
}

/** Collect the workspace text-file walk into a map. Production never does this
 *  — holding every body at once is the defect `walkWorkspaceTextFiles` exists
 *  to prevent — but a test asserting the walk's admission policy wants the
 *  whole result in one place. */
export async function collectWorkspaceTextFiles(rt: AgentRuntime): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await walkWorkspaceTextFiles(rt, (path, content) => { out[path] = content; });
  return out;
}
