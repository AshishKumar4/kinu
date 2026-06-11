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
import type { ExecutorProvider } from '@proteus/core';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import {
  type LLMProviderConfig, type SandboxPolicy, buildRuntime,
  DefaultExecutionRouter, createInlineExecutor,
  initAgentConfigTable, createAgentConfigStore,
  resolveSandboxPolicy, isPathWritable, escalationForWrite, formatSandboxEscalation,
} from '@proteus/core';
import { detectSandboxBackend, sandboxLaunch, annotateSandboxDenial, type HostSandbox } from './sandbox.js';
import { SqliteFS } from '@proteus/agent-utils';
import { MemoryStore } from '@proteus/agent-utils';
import { CraftStore as AgentUtilsCraftStore } from '@proteus/agent-utils';
import { createSandboxedExecutor } from './executor.js';
import { createLinuxFiber, initFiberTable, detectOrphanedFibers } from './fiber.js';
import { createBranchSpawner } from './branch-process.js';
import { createLocalProviderLLM, type LocalProviderCredentials } from './model-resolver.js';
import type { LocalCodexAuthStore } from './codex-auth-store.js';
import type { OAuthCredential } from '@proteus/core';

export interface CLIRuntimeConfig {
  dbPath: string;
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  agentName?: string;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  onCodexRefresh?: (credential: OAuthCredential) => void;
}

export function makeSql(db: { prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void } }): SqlExecutor {
  const sql = function <T = unknown>(
    strings: TemplateStringsArray,
    ...values: SqlValue[]
  ): T[] {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? '?' : ''), '');
    // SqliteFS encodes BLOBs as ArrayBuffer (Cloudflare DO storage.sql's native
    // type); bun:sqlite only binds TypedArrays, so coerce ArrayBuffer → Uint8Array.
    const bound = values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
    const stmt = db.prepare(query);
    if (isRead) return stmt.all(...bound) as T[];
    stmt.run(...bound);
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
    mkdir: (path, opts) => sqliteFs.mkdir(path, opts),
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

  const llm = createLocalProviderLLM({
    llm: config.llm,
    credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    onCodexRefresh: config.onCodexRefresh,
  });
  // Cross-model judge only when one is actually configured. Leaving this
  // undefined lets consumers apply their documented same-model fallback
  // (mcts/evaluation.ts judge ensemble, local-session auto-judge) instead of
  // hiding it here.
  const judgeModel = config.judge
    ? createLocalProviderLLM({ llm: config.judge, credentials: config.providerCredentials, codexAuthStore: config.codexAuthStore, onCodexRefresh: config.onCodexRefresh })
    : undefined;

  const schedule: Schedule = {
    after: async (_ms, fn) => { setTimeout(fn, 0); },
    cron: async () => {},
    fiber: createLinuxFiber(sql),
  };

  const basePath = config.dbPath.replace(/\.db$/, '');
  const { spawn, abort } = createBranchSpawner(basePath, {
    llm: config.llm,
    providerCredentials: config.providerCredentials,
    codexConfigPath: config.codexConfigPath,
  });

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
  // workspace provider and a bound POSIX shell. In CLI/local mode the shell is
  // the user's real machine, rooted at the process cwd where `proteus` or an
  // alias was invoked. Durable agent memory still lives in SQLite/VFS.
  //
  // Every local spawn runs under the agent's OS sandbox policy (config-store
  // sandbox_mode, default workspace-write: cwd + tmp writable, network off).
  // The policy resolves fresh per spawn so operator changes apply immediately.
  initAgentConfigTable(execRaw);
  const agentConfig = createAgentConfigStore(sql);
  const hostSandbox: HostSandbox = {
    backend: detectSandboxBackend(),
    getPolicy: () => resolveSandboxPolicy({
      mode: agentConfig.getSandboxMode(),
      workspaceRoot: process.cwd(),
      tmpDir: tmpdir(),
      extraWritableRoots: agentConfig.getSandboxWritableRoots(),
      network: agentConfig.getSandboxNetwork(),
    }),
  };
  const shell: Shell = createHostShell(process.cwd(), hostSandbox);
  const executionRouter = new DefaultExecutionRouter();
  executionRouter.register(createInlineExecutor({ vfs, memory, craftStore, shell }));
  executionRouter.register(createLocalLaptopExecutor(process.cwd(), shell, hostSandbox.getPolicy));

  return buildRuntime({
    sql, execRaw, vfs, llm, executor: createSandboxedExecutor(hostSandbox), schedule,
    agentId, agentName, memory, craftStore, judgeModel,
    spawnBranch: spawn, abortBranch: abort,
    executionRouter, shell,
  });
}

export function createHostShell(cwd: string, sandbox: HostSandbox): Shell {
  return {
    exec(command: string, stdinOrOptions?: string | { stdin?: string; signal?: AbortSignal }) {
      return new Promise((resolve) => {
        const stdin = typeof stdinOrOptions === 'string' ? stdinOrOptions : stdinOrOptions?.stdin;
        const signal = typeof stdinOrOptions === 'string' ? undefined : stdinOrOptions?.signal;
        let settled = false;
        const { policy, launch } = sandboxLaunch(sandbox, ['/bin/sh', '-lc', command]);
        const child = spawn(launch.argv[0]!, launch.argv.slice(1), {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
          detached: true,
        });
        let stdout = '';
        let stderr = '';
        const finish = (result: { stdout: string; stderr: string; exitCode: number }) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };
        const onAbort = () => {
          const pid = child.pid;
          if (!pid) return;
          try { process.kill(-pid, 'SIGTERM'); } catch {}
          setTimeout(() => {
            if (!settled) {
              try { process.kill(-pid, 'SIGKILL'); } catch {}
            }
          }, 1500).unref();
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => finish({ stdout, stderr: err.message, exitCode: 1 }));
        child.on('close', (code, signalName) => {
          const aborted = signal?.aborted || signalName === 'SIGTERM' || signalName === 'SIGKILL';
          const exitCode = code ?? (aborted ? 130 : 0);
          const baseStderr = aborted ? `${stderr}${stderr ? '\n' : ''}Command aborted.` : stderr;
          finish({
            stdout,
            // Sandbox-enforced denials surface as structured escalations,
            // never as bare command failures.
            stderr: aborted ? baseStderr : annotateSandboxDenial(policy, launch, { exitCode, stderr: baseStderr }),
            exitCode,
          });
        });
        if (stdin) child.stdin.end(stdin);
        else child.stdin.end();
      });
    },
  };
}

function createLocalLaptopExecutor(cwd: string, shell: Shell, getPolicy: () => SandboxPolicy): ExecutorProvider {
  const toHostPath = (path: unknown) => resolvePath(cwd, String(path || '.'));
  return {
    name: 'laptop',
    kind: 'laptop',
    capabilities: new Set(['shell', 'git', 'npm', 'fs_shared', 'net_outbound', 'process_spawn']),
    positionalArgs: true,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: {
      exec: {
        description: 'Run a shell command on the local machine in the directory where the CLI was invoked.',
        execute: async (command: unknown, context?: unknown) => {
          const signal = readAbortSignal(context);
          const result = await shell.exec(String(command), signal ? { signal } : undefined);
          if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
          return result.stdout || '(no output)';
        },
      },
      readFile: {
        description: 'Read a UTF-8 file from the local machine.',
        execute: async (path: unknown) => fs.readFile(toHostPath(path), 'utf-8'),
      },
      writeFile: {
        description: 'Write a UTF-8 file on the local machine. Parent directories are created.',
        execute: async (path: unknown, content: unknown) => {
          const p = toHostPath(path);
          // Same policy the OS enforces on spawned commands, applied at the
          // in-process write seam (this call never reaches a sandboxed spawn).
          const policy = getPolicy();
          if (!isPathWritable(policy, p)) {
            return formatSandboxEscalation(escalationForWrite(policy, p));
          }
          await fs.mkdir(resolvePath(p, '..'), { recursive: true });
          await fs.writeFile(p, String(content), 'utf-8');
          return `Written ${String(content).length} bytes to ${p}`;
        },
      },
      listFiles: {
        description: 'List local directory entries as {name,type}.',
        execute: async (path: unknown = '.') => {
          const entries = await fs.readdir(toHostPath(path), { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
        },
      },
    },
    types: `declare const laptop: {
  exec(command: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  listFiles(path?: string): Promise<Array<{name: string; type: "dir" | "file"}>>;
};`,
  };
}

function readAbortSignal(context: unknown): AbortSignal | undefined {
  if (!context || typeof context !== 'object' || !('signal' in context)) return undefined;
  const signal = (context as { signal?: unknown }).signal;
  return typeof signal === 'object' && signal !== null && 'aborted' in signal && 'addEventListener' in signal
    ? signal as AbortSignal
    : undefined;
}
