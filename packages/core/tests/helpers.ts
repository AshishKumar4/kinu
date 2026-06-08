/**
 * Test helpers — in-memory SQLite via bun:sqlite, mock LLM, mock Executor.
 * These satisfy the core primitive interfaces for testing.
 */

import { Database } from 'bun:sqlite';
import type {
  SqlExecutor,
  SqlValue,
  RawSqlExec,
  Storage,
  Memory,
  Executor,
  LLM,
  Schedule,
  Identity,
  FiberCtx,
  MemorySearchResult,
  ExecuteResult,
  ResolvedProvider,
  VFS,
} from '../src/types/primitives.js';
import type { AgentRuntime, CraftStore, BranchHandle } from '../src/types/agent-runtime.js';
import type { CraftedTool } from '../src/types/craft.js';

// ── SqlExecutor from bun:sqlite ──────────────────────────────────

export function makeSql(db: Database): SqlExecutor {
  const sql = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? '?' : ''),
      '',
    );
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare(query);
    if (isRead) return stmt.all(...values) as T[];
    stmt.run(...values);
    return [];
  } as SqlExecutor;
  return sql;
}

export function makeExecRaw(db: Database): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

// ── In-memory VFS ────────────────────────────────────────────────

export function createMemoryVFS(db: Database): VFS {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vfs_files (
      path TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '',
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0
    )
  `);

  return {
    async readFile(path: string, opts?: { encoding?: string }) {
      const row = db.query('SELECT data FROM vfs_files WHERE path = ?').get(path) as { data: string } | null;
      if (!row) throw new Error(`ENOENT: ${path}`);
      return opts?.encoding === 'utf8' ? row.data : new TextEncoder().encode(row.data);
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      db.run(
        'INSERT OR REPLACE INTO vfs_files (path, data, size, mtime) VALUES (?, ?, ?, ?)',
        [path, text, text.length, Date.now()],
      );
    },
    async readdir(path: string) {
      const prefix = path.endsWith('/') ? path : path + '/';
      const rows = db.query(
        "SELECT path FROM vfs_files WHERE path LIKE ? AND path != ?",
      ).all(prefix + '%', path) as { path: string }[];
      return rows.map(r => r.path.slice(prefix.length).split('/')[0]!).filter(Boolean);
    },
    async stat(path: string) {
      const row = db.query('SELECT size, mtime, is_dir FROM vfs_files WHERE path = ?').get(path) as
        { size: number; mtime: number; is_dir: number } | null;
      if (!row) return null;
      return { size: row.size, mtime: row.mtime, isDir: !!row.is_dir };
    },
    async unlink(path: string) {
      db.run('DELETE FROM vfs_files WHERE path = ?', [path]);
    },
    async mkdir(path: string) {
      db.run(
        'INSERT OR IGNORE INTO vfs_files (path, is_dir, mtime) VALUES (?, 1, ?)',
        [path, Date.now()],
      );
    },
    async exists(path: string) {
      const row = db.query('SELECT 1 FROM vfs_files WHERE path = ?').get(path);
      return row !== null;
    },
  };
}

// ── In-memory Memory ─────────────────────────────────────────────

export function createMemoryMemory(db: Database, vfs: VFS): Memory {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      content TEXT NOT NULL
    )
  `);

  return {
    async write(path, content) { await vfs.writeFile(path, content); },
    async append(path, content) {
      try {
        const existing = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        await vfs.writeFile(path, existing + content);
      } catch {
        await vfs.writeFile(path, content);
      }
    },
    async index(path) {
      try {
        const content = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        db.run('INSERT INTO memory_chunks (path, content) VALUES (?, ?)', [path, content]);
      } catch { /* file may not exist */ }
    },
    async search(query, limit = 10) {
      const rows = db.query(
        'SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?',
      ).all(`%${query}%`, limit) as { path: string; content: string }[];
      return rows.map((r, i) => ({
        path: r.path, startLine: 0, endLine: 0, snippet: r.content.slice(0, 200), score: 1 - i * 0.1,
      }));
    },
    async read(path) {
      try {
        return await vfs.readFile(path, { encoding: 'utf8' }) as string;
      } catch { return null; }
    },
  };
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
    async execute(code: string, _providers: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>): Promise<ExecuteResult> {
      // Just check if the code parses
      try {
        new Function(code);
        return { result: true };
      } catch (e) {
        return { result: undefined, error: (e as Error).message };
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
    },
    get(name) {
      return db.query('SELECT * FROM crafted_tools WHERE name = ?').get(name) as CraftedTool | undefined;
    },
    delete(name) { db.run('DELETE FROM crafted_tools WHERE name = ?', [name]); },
    list() { return db.query('SELECT * FROM crafted_tools').all() as CraftedTool[]; },
    search(query, limit = 10) {
      // Word-level search: match tools where any query word appears in description
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const all = db.query('SELECT * FROM crafted_tools').all() as CraftedTool[];
      return all
        .filter(t => words.some(w => t.description.toLowerCase().includes(w)))
        .slice(0, limit);
    },
    getAll() { return db.query('SELECT * FROM crafted_tools').all() as CraftedTool[]; },
  };
}

// ── In-memory Schedule ───────────────────────────────────────────

export function createMemorySchedule(db: Database): Schedule {
  const sql = makeSql(db);
  db.exec(`CREATE TABLE IF NOT EXISTS fibers (id TEXT PRIMARY KEY, name TEXT, snapshot TEXT, created_at INTEGER)`);

  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      const id = crypto.randomUUID();
      db.run('INSERT INTO fibers (id, name, snapshot, created_at) VALUES (?, ?, NULL, ?)', [id, name, Date.now()]);
      const stash = (data: unknown) => {
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
}): { rt: AgentRuntime; db: Database } {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const vfs = createMemoryVFS(db);
  const memory = createMemoryMemory(db, vfs);
  const craftStore = createMemoryCraftStore(db);
  const llm = createMockLLM(opts?.llmResponses);
  const executor = createMockExecutor();
  const schedule = createMemorySchedule(db);

  // Initialize tables needed by EvolutionEngine and identity system
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default',
    parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_identity (
    id TEXT NOT NULL, name TEXT NOT NULL, owner_user_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`);

  // Initialize scaffold in VFS
  db.run("INSERT INTO vfs_files (path, data, size, mtime) VALUES ('scaffold/agent.js', 'initial', 7, ?)", [Date.now()]);

  const identity: Identity = {
    id: 'test-agent-id',
    name: 'test-agent',
    scaffold: {
      exists: () => vfs.exists('scaffold/agent.js'),
      read: () => vfs.readFile('scaffold/agent.js', { encoding: 'utf8' }) as Promise<string>,
      write: (code) => vfs.writeFile('scaffold/agent.js', code),
      version: async () => (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
    },
  };

  const mockBranch: BranchHandle = {
    explore: async () => ({ text: 'explored approach A', codeUsed: null }),
    evaluate: async () => 0.7,
    generateReflection: async () => 'reflection: approach was suboptimal',
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
      const content = msg.parts.map((p: any) => p.text).join('');
      messages.push({ id: msg.id, parentId, role: msg.role, content });
    },
    getHistory(leafId) {
      if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
      // Walk up via parentId
      const result: Array<{ role: string; content: string }> = [];
      let current = messages.find(m => m.id === leafId);
      while (current) {
        result.unshift({ role: current.role, content: current.content });
        current = current.parentId ? messages.find(m => m.id === current!.parentId) : undefined;
      }
      return result;
    },
    async compact() { /* no-op in tests */ },
  };
}
