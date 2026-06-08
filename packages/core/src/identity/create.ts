/**
 * Create a new agent — initializes the database and returns an AgentRuntime.
 *
 * This is the "birth" of an agent. It creates:
 * - All tables (idempotent)
 * - SOUL.md
 * - The initial scaffold
 * - The agent identity (stable UUID)
 */

import type { AgentRuntime, CraftStore, BranchHandle } from '../types/agent-runtime.js';
import type {
  SqlExecutor, RawSqlExec, VFS, Memory, Executor, LLM, Schedule, Identity,
  FiberCtx, MemorySearchResult,
} from '../types/primitives.js';
import type { LLMProviderConfig } from '../llm.js';
import type { CraftedTool } from '../types/craft.js';
import { initAllTables } from './schema.js';
import { seedSoul } from './soul.js';
import { INITIAL_SCAFFOLD_SOURCE } from '../scaffold/bootstrap.js';
import { nanoid } from '../utils/nanoid.js';
import { nowMs } from '../utils/date.js';
import { createVercelAILLM } from '../llm.js';
import { buildRuntime } from '../runtime-builder.js';

export interface AgentBirthConfig {
  name: string;
  purpose: string;
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  /** Custom initial scaffold (defaults to INITIAL_SCAFFOLD_SOURCE) */
  scaffold?: string;
}

/** Database interface — satisfied by bun:sqlite Database */
export interface AgentDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

/** Wrap a database into our SqlExecutor interface */
export function wrapDatabase(db: AgentDatabase): { sql: SqlExecutor; execRaw: RawSqlExec } {
  const sql = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare(query);
    if (isRead) return stmt.all(...values) as T[];
    stmt.run(...values);
    return [];
  } as SqlExecutor;

  const execRaw: RawSqlExec = (ddl: string) => db.exec(ddl);
  return { sql, execRaw };
}

/** Create VFS, Memory, CraftStore, Schedule from database + LLM config */
function buildComponents(
  db: AgentDatabase,
  sql: SqlExecutor,
  execRaw: RawSqlExec,
  config: { llm: LLMProviderConfig; judge?: LLMProviderConfig; agentId: string; agentName: string },
) {
  const vfs = createBunVFS(db);
  const memory = createBunMemory(db, vfs);
  const craftStore = createBunCraftStore(db);
  const executor = createBunExecutor();
  const llm = createVercelAILLM(config.llm);
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : llm;
  const schedule = createBunSchedule(sql);

  const mockBranch: BranchHandle = {
    explore: async () => ({ text: 'exploration result', codeUsed: null }),
    evaluate: async () => 0.5,
    generateReflection: async () => 'no reflection available',
  };

  return buildRuntime({
    sql, execRaw, vfs, llm, executor, schedule,
    agentId: config.agentId, agentName: config.agentName,
    memory, craftStore, judgeModel,
    spawnBranch: async () => mockBranch,
    abortBranch: async () => {},
  });
}

/** Create a new agent identity from scratch */
export function createAgent(db: AgentDatabase, config: AgentBirthConfig): AgentRuntime {
  const { sql, execRaw } = wrapDatabase(db);

  // Initialize all tables
  initAllTables(execRaw);

  // Write the agent identity
  const agentId = nanoid();
  sql`INSERT INTO agent_identity (id, name, created_at) VALUES (${agentId}, ${config.name}, ${nowMs()})`;

  // Seed SOUL.md from the initial mission. It is the canonical agent identity.
  seedSoul(sql, { name: config.name, mission: config.purpose });

  // Bootstrap scaffold into VFS
  const scaffoldCode = config.scaffold ?? INITIAL_SCAFFOLD_SOURCE;
  const now = nowMs();
  db.run(
    'INSERT OR REPLACE INTO vfs_files (path, data, size, mtime) VALUES (?, ?, ?, ?)',
    ['scaffold/agent.js', scaffoldCode, scaffoldCode.length, now],
  );
  sql`INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale) VALUES (0, ${now}, ${'initial bootstrap'})`;

  // Initialize MEMORY.md
  const memoryContent = `# ${config.name}\n\nCreated: ${new Date().toISOString()}\n`;
  db.run(
    'INSERT OR REPLACE INTO vfs_files (path, data, size, mtime) VALUES (?, ?, ?, ?)',
    ['memory/MEMORY.md', memoryContent, memoryContent.length, now],
  );

  return buildComponents(db, sql, execRaw, {
    llm: config.llm, judge: config.judge, agentId, agentName: config.name,
  });
}

// ── bun:sqlite primitive implementations ──────────────────────────

function createBunVFS(db: AgentDatabase): VFS {
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
      const rows = db.query('SELECT path FROM vfs_files WHERE path LIKE ? AND path != ?')
        .all(prefix + '%', path) as { path: string }[];
      const names = new Set<string>();
      for (const r of rows) {
        const relative = r.path.slice(prefix.length).split('/')[0];
        if (relative) names.add(relative);
      }
      return [...names];
    },
    async stat(path: string) {
      const row = db.query('SELECT size, mtime, is_dir FROM vfs_files WHERE path = ?').get(path) as
        { size: number; mtime: number; is_dir: number } | null;
      if (!row) return null;
      return { size: row.size, mtime: row.mtime, isDir: !!row.is_dir };
    },
    async unlink(path: string) { db.run('DELETE FROM vfs_files WHERE path = ?', [path]); },
    async mkdir(path: string) {
      db.run('INSERT OR IGNORE INTO vfs_files (path, is_dir, mtime) VALUES (?, 1, ?)', [path, Date.now()]);
    },
    async exists(path: string) {
      return db.query('SELECT 1 FROM vfs_files WHERE path = ?').get(path) !== null;
    },
  };
}

function createBunMemory(db: AgentDatabase, vfs: VFS): Memory {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL
  )`);
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
      const rows = db.query('SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?')
        .all(`%${query}%`, limit) as { path: string; content: string }[];
      return rows.map((r, i) => ({
        path: r.path, startLine: 0, endLine: 0,
        snippet: r.content.slice(0, 200), score: 1 - i * 0.1,
      }));
    },
    async read(path) {
      try { return await vfs.readFile(path, { encoding: 'utf8' }) as string; }
      catch { return null; }
    },
  };
}

function createBunCraftStore(db: AgentDatabase): CraftStore {
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
    get(name) { return db.query('SELECT * FROM crafted_tools WHERE name = ?').get(name) as CraftedTool | undefined; },
    delete(name) { db.run('DELETE FROM crafted_tools WHERE name = ?', [name]); },
    list() { return db.query('SELECT * FROM crafted_tools').all() as CraftedTool[]; },
    search(query, limit = 10) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const all = db.query('SELECT * FROM crafted_tools').all() as CraftedTool[];
      return all.filter(t => words.some(w => t.description.toLowerCase().includes(w))).slice(0, limit);
    },
    getAll() { return db.query('SELECT * FROM crafted_tools').all() as CraftedTool[]; },
  };
}

function createBunExecutor(): Executor {
  return {
    async execute(code, _providers) {
      try {
        // Execute the code, not just parse it. Wrap in async IIFE to support await.
        const fn = new Function(`return (async () => { ${code} })()`);
        const result = await fn();
        return { result: result === undefined ? '(no return value)' : result };
      } catch (e) { return { result: undefined, error: (e as Error).message }; }
    },
  };
}

function createBunSchedule(sql: SqlExecutor): Schedule {
  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      const id = nanoid();
      sql`INSERT INTO fibers (id, name, snapshot, created_at) VALUES (${id}, ${name}, ${null}, ${Date.now()})`;
      const stash = (data: unknown) => {
        sql`UPDATE fibers SET snapshot = ${JSON.stringify(data)} WHERE id = ${id}`;
      };
      try { return await fn({ stash, snapshot: null }); }
      finally { sql`DELETE FROM fibers WHERE id = ${id}`; }
    },
  };
}
