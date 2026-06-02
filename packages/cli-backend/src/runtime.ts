/**
 * Linux CLI runtime factory — uses bun:sqlite with agent-utils for
 * FTS5 memory search, chunked SqliteFS, and proper CraftStore.
 *
 * Implements the same primitives as cf-backend via adapter wrappers
 * that bridge agent-utils types to @proteus/core's interfaces.
 */

import type { AgentRuntime, CraftStore as CoreCraftStore, Shell } from '@proteus/core';
import type { Storage, Schedule, Memory, VFS, SqlExecutor, SqlValue, RawSqlExec } from '@proteus/core';
import type { CraftedTool } from '@proteus/core';
import {
  createVercelAILLM, type LLMProviderConfig, buildRuntime,
  DefaultExecutionRouter, createInlineExecutor,
} from '@proteus/core';
import { SqliteFS } from '@proteus/agent-utils';
import { MemoryStore } from '@proteus/agent-utils';
import { CraftStore as AgentUtilsCraftStore } from '@proteus/agent-utils';
import { createShell } from '@proteus/agent-utils/shell';
import { createSandboxedExecutor } from './executor.js';
import { createLinuxFiber, initFiberTable, detectOrphanedFibers } from './fiber.js';
import { createBranchSpawner } from './branch-process.js';

export interface CLIRuntimeConfig {
  dbPath: string;
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  agentName?: string;
}

export function makeSql(db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void } }): SqlExecutor {
  const sql = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare(query);
    if (isRead) return stmt.all(...values) as T[];
    stmt.run(...values);
    return [];
  } as SqlExecutor;
  return sql;
}

export function makeExecRaw(db: { exec(sql: string): void }): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

/**
 * Adapt agent-utils SqliteFS to core VFS interface.
 * Core VFS has a simpler stat() return shape than agent-utils'.
 */
function adaptVFS(sqliteFs: SqliteFS): VFS {
  return {
    // core VFS encoding is the looser `string`; SqliteFS wants the `'utf8'`
    // literal. Only utf8 is meaningful — narrow it; anything else = binary.
    readFile: (path, opts) => sqliteFs.readFile(path, opts?.encoding ? { encoding: 'utf8' } : undefined),
    writeFile: (path, data) => sqliteFs.writeFile(path, data),
    readdir: (path) => sqliteFs.readdir(path),
    async stat(path) {
      try {
        const s = await sqliteFs.stat(path);
        return { size: s.size, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } catch {
        return null;
      }
    },
    unlink: (path) => sqliteFs.unlink(path),
    mkdir: (path) => sqliteFs.mkdir(path),
    exists: (path) => sqliteFs.exists(path),
  };
}

/**
 * Adapt agent-utils MemoryStore to core Memory interface.
 */
function adaptMemory(store: MemoryStore, vfs: VFS): Memory {
  return {
    write: (path, content) => store.writeFile(path, content),
    append: (path, content) => store.appendToFile(path, content),
    async index(path) {
      try {
        const content = await vfs.readFile(path, { encoding: 'utf8' }) as string;
        await store.indexFile(path, content);
      } catch { /* file may not exist */ }
    },
    search(query, limit = 10) {
      return Promise.resolve(store.search(query, limit));
    },
    read: (path) => store.readFile(path),
  };
}

/**
 * Adapt agent-utils CraftStore to core CraftStore interface.
 * Handles the type differences (createdAt vs created_at, scope values).
 */
function adaptCraftStore(store: AgentUtilsCraftStore): CoreCraftStore {
  return {
    create(tool) {
      store.create({
        name: tool.name,
        description: tool.description,
        params: tool.params as Record<string, string> | undefined ?? undefined,
        code: tool.code,
        scope: tool.scope as 'local' | 'shared',
      });
    },
    update(name, patch) {
      store.update(name, {
        description: patch.description,
        code: patch.code,
        scope: patch.scope as 'local' | 'shared' | undefined,
      });
    },
    get(name) {
      const t = store.get(name);
      if (!t) return undefined;
      return toCraftedTool(t);
    },
    delete(name) { store.delete(name); },
    list() { return store.list().map(toCraftedTool); },
    search(query, limit = 10) { return store.search(query, limit).map(toCraftedTool); },
    getAll() { return store.getAll().map(toCraftedTool); },
  };
}

function toCraftedTool(t: { name: string; description: string; params: Record<string, string> | null; code: string; scope: string; createdAt: number; updatedAt: number }): CraftedTool {
  return {
    name: t.name,
    description: t.description,
    params: t.params,
    code: t.code,
    scope: t.scope as 'local' | 'shared',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function createCLIRuntime(
  db: {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
    exec(sql: string): void;
    run(sql: string, params?: unknown[]): void;
    query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  },
  config: CLIRuntimeConfig,
): AgentRuntime {
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  initFiberTable(execRaw);
  const orphans = detectOrphanedFibers(sql);
  if (orphans.length > 0) {
    console.warn(`[agent] ${orphans.length} orphaned fiber(s) from previous run:`, orphans.map(o => o.name));
  }

  // Stable identity
  execRaw('CREATE TABLE IF NOT EXISTS agent_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))');
  const existing = sql<{ id: string; name: string }>`SELECT id, name FROM agent_identity LIMIT 1`;
  let agentId: string;
  let agentName: string;
  if (existing.length > 0 && existing[0]) {
    agentId = existing[0].id;
    agentName = existing[0].name;
  } else {
    agentId = crypto.randomUUID();
    agentName = config.agentName ?? 'agent';
    sql`INSERT INTO agent_identity (id, name) VALUES (${agentId}, ${agentName})`;
  }

  const llm = createVercelAILLM(config.llm);
  const judgeModel = config.judge ? createVercelAILLM(config.judge) : llm;

  const schedule: Schedule = {
    after: async (_ms, fn) => { setTimeout(fn, 0); },
    cron: async () => {},
    fiber: createLinuxFiber(sql),
  };

  const basePath = config.dbPath.replace(/\.db$/, '');
  const { spawn, abort } = createBranchSpawner(basePath);

  // Use agent-utils implementations (FTS5, chunked SqliteFS, proper CraftStore)
  const sqliteFs = new SqliteFS(sql);
  sqliteFs.init();
  const vfs = adaptVFS(sqliteFs);

  // MemoryStore needs the full agent-utils VFS (SqliteFS), not the adapted core VFS
  const memoryStore = new MemoryStore(sqliteFs as any, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, vfs);

  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);

  // v2.0: shell + executionRouter so the canonical `run` tool in core has a
  // workspace provider and a bound POSIX shell. Same set the CF backend
  // exposes — CLI only registers the inline executor (no Nimbus/Container/SSH
  // bindings are relevant in a local Bun process).
  const shell: Shell = createShell(sqliteFs);
  const executionRouter = new DefaultExecutionRouter();
  executionRouter.register(createInlineExecutor({ vfs, memory, craftStore, shell }));

  return buildRuntime({
    sql, execRaw, vfs, llm, executor: createSandboxedExecutor(), schedule,
    agentId, agentName, memory, craftStore, judgeModel,
    spawnBranch: spawn, abortBranch: abort,
    executionRouter, shell,
  });
}
