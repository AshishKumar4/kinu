/**
 * Open an existing agent — runs the resume protocol and returns AgentRuntime.
 *
 * Resume protocol:
 * 1. Read agent_identity → get stable UUID + name
 * 2. Read agent_soul → get immutable purpose
 * 3. Read scaffold_versions → get current version
 * 4. Read scaffold/agent.js from VFS → current agentic loop
 * 5. Read craft_scores → quality metrics
 * 6. Detect orphaned fibers → recover or clean up
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import type { LLMProviderConfig } from '../llm.js';
import { createAgent, wrapDatabase, type AgentDatabase } from './create.js';
import { initAllTables } from './schema.js';
import { readSoul } from './soul.js';
import { createVercelAILLM } from '../llm.js';
import { buildRuntime } from '../runtime-builder.js';

export interface AgentResumeConfig {
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
}

export interface AgentInfo {
  id: string;
  name: string;
  purpose: string;
  scaffoldVersion: number;
  craftedToolCount: number;
  searchNodeCount: number;
  taskCount: number;
  memorySize: number;
  createdAt: number;
}

/** Open an existing agent database and resume it */
export function openAgent(db: AgentDatabase, config: AgentResumeConfig): {
  rt: AgentRuntime;
  info: AgentInfo;
} {
  const { sql, execRaw } = wrapDatabase(db);

  // Ensure all tables exist (handles schema upgrades gracefully)
  initAllTables(execRaw);

  // Step 1: Read identity
  const identity = sql<{ id: string; name: string; created_at: number }>`
    SELECT id, name, created_at FROM agent_identity LIMIT 1
  `[0];
  if (!identity) throw new Error('No agent identity found. Use createAgent() to create one.');

  // Step 2: Read soul
  const purpose = readSoul(sql);
  if (!purpose) throw new Error('No agent soul found. Database may be corrupted.');

  // Step 3: Scaffold version
  const scaffoldVersion = sql<{ v: number }>`
    SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions
  `[0]?.v ?? 0;

  // Step 4: CraftStore stats
  const craftedToolCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;

  // Step 5: Search tree stats
  const searchNodeCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`[0]?.c ?? 0;

  // Step 6: Task history
  const taskCount = sql<{ c: number }>`SELECT COUNT(*) as c FROM task_history`[0]?.c ?? 0;

  // Step 7: Memory size
  const memorySize = sql<{ total: number }>`
    SELECT COALESCE(SUM(size), 0) as total FROM vfs_files WHERE path LIKE 'memory/%'
  `[0]?.total ?? 0;

  // Step 8: Detect orphaned fibers
  const orphanedFibers = sql<{ id: string; name: string }>`SELECT id, name FROM fibers`;
  if (orphanedFibers.length > 0) {
    console.warn(`[agent] ${orphanedFibers.length} orphaned fiber(s) from previous run:`,
      orphanedFibers.map(f => f.name).join(', '));
    // Clean up orphaned fibers
    for (const fiber of orphanedFibers) {
      sql`DELETE FROM fibers WHERE id = ${fiber.id}`;
    }
  }

  // Build runtime with real bun:sqlite primitives
  // We reuse createAgent's internal component builders via a shim
  const vfs = createBunVFS(db);
  const memory = createBunMemory(db, vfs);
  const craftStore = createBunCraftStore(db);

  const llm = createVercelAILLM(config.llm);
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : llm;

  const schedule = createBunSchedule(sql);

  const rt = buildRuntime({
    sql, execRaw, vfs, llm, executor: createBunExecutor(), schedule,
    agentId: identity.id, agentName: identity.name,
    memory, craftStore, judgeModel,
    spawnBranch: async () => ({
      explore: async () => ({ text: 'exploration', codeUsed: null }),
      evaluate: async () => 0.5,
      generateReflection: async () => 'reflection',
    }),
    abortBranch: async () => {},
  });

  return {
    rt,
    info: {
      id: identity.id,
      name: identity.name,
      purpose,
      scaffoldVersion,
      craftedToolCount,
      searchNodeCount,
      taskCount,
      memorySize,
      createdAt: identity.created_at,
    },
  };
}

// ── Re-export the bun:sqlite primitive builders from create.ts ────
// These are identical — we factor them here to avoid import cycles.

import type { VFS, Memory, Executor, Schedule, SqlExecutor, FiberCtx } from '../types/primitives.js';
import type { CraftStore } from '../types/agent-runtime.js';
import type { CraftedTool } from '../types/craft.js';
import { nanoid } from '../utils/nanoid.js';

function createBunVFS(db: AgentDatabase): VFS {
  return {
    async readFile(path: string, opts?: { encoding?: string }) {
      const row = db.query('SELECT data FROM vfs_files WHERE path = ?').get(path) as { data: string } | null;
      if (!row) throw new Error(`ENOENT: ${path}`);
      return opts?.encoding === 'utf8' ? row.data : new TextEncoder().encode(row.data);
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      db.run('INSERT OR REPLACE INTO vfs_files (path, data, size, mtime) VALUES (?, ?, ?, ?)',
        [path, text, text.length, Date.now()]);
    },
    async readdir(path: string) {
      const prefix = path.endsWith('/') ? path : path + '/';
      const rows = db.query('SELECT path FROM vfs_files WHERE path LIKE ? AND path != ?')
        .all(prefix + '%', path) as { path: string }[];
      const names = new Set<string>();
      for (const r of rows) { const n = r.path.slice(prefix.length).split('/')[0]; if (n) names.add(n); }
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
  // Create the simplified memory_chunks table locally. The production
  // MemoryStore (agent-utils) creates its own richer schema with FTS5.
  // This inline version is only used by openAgent() from core (E2E tests).
  db.exec(`CREATE TABLE IF NOT EXISTS memory_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL
  )`);
  return {
    async write(path, content) { await vfs.writeFile(path, content); },
    async append(path, content) {
      try {
        const existing = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        await vfs.writeFile(path, existing + content);
      } catch { await vfs.writeFile(path, content); }
    },
    async index(path) {
      try {
        const content = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        db.run('INSERT INTO memory_chunks (path, content) VALUES (?, ?)', [path, content]);
      } catch {}
    },
    async search(query, limit = 10) {
      const rows = db.query('SELECT path, content FROM memory_chunks WHERE content LIKE ? LIMIT ?')
        .all(`%${query}%`, limit) as { path: string; content: string }[];
      return rows.map((r, i) => ({ path: r.path, startLine: 0, endLine: 0, snippet: r.content.slice(0, 200), score: 1 - i * 0.1 }));
    },
    async read(path) {
      try { return await vfs.readFile(path, { encoding: 'utf8' }) as string; } catch { return null; }
    },
  };
}

function createBunCraftStore(db: AgentDatabase): CraftStore {
  return {
    create(tool) {
      db.run('INSERT INTO crafted_tools (name, description, params, code, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tool.name, tool.description, tool.params ? JSON.stringify(tool.params) : null, tool.code, tool.scope, Date.now(), Date.now()]);
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
    async execute(code) {
      try { new Function(code); return { result: true }; }
      catch (e) { return { result: undefined, error: (e as Error).message }; }
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
      const stash = (data: unknown) => { sql`UPDATE fibers SET snapshot = ${JSON.stringify(data)} WHERE id = ${id}`; };
      try { return await fn({ stash, snapshot: null }); }
      finally { sql`DELETE FROM fibers WHERE id = ${id}`; }
    },
  };
}
