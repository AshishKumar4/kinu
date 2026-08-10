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
import type { ExecutorProvider, ResourceLimits } from '@proteus/core';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  type LLMProviderConfig, buildRuntime,
  CompositeVFS, type MountPolicy,
  DefaultExecutionRouter, createInlineExecutor, formatExecResult,
  selectFastModel, createAgentConfigStore, initAgentConfigTable,
} from '@proteus/core';
import { SqliteFS } from '@proteus/agent-utils';
import { MemoryStore } from '@proteus/agent-utils';
import { CraftStore as AgentUtilsCraftStore } from '@proteus/agent-utils';
import { createShell } from '@proteus/agent-utils/shell';
import { createSandboxedExecutor } from './executor.js';
import { createHostCheckpoints } from './checkpoints.js';
import { hostResourceLimits } from './cgroup-limits.js';
import { createHostMountVFS } from './host-mount.js';
import { createLinuxFiber, initFiberTable, detectOrphanedFibers } from './fiber.js';
import { createBranchSpawner } from './branch-process.js';
import {
  createLocalModelResolver, createLocalProviderLLM, type LocalProviderCredentials,
} from './model-resolver.js';
import type { LocalCodexAuthStore } from './codex-auth-store.js';
import type { OAuthCredential, FileCheckpoints } from '@proteus/core';

export interface CLIRuntimeConfig {
  dbPath: string;
  llm: LLMProviderConfig;
  judge?: LLMProviderConfig;
  agentName?: string;
  providerCredentials?: LocalProviderCredentials;
  codexAuthStore?: LocalCodexAuthStore;
  codexConfigPath?: string;
  onCodexRefresh?: (credential: OAuthCredential) => void;
  /** Shadow-git checkpoints kept per working directory (the one retention knob). */
  checkpointKeep?: number;
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
  execRaw('CREATE TABLE IF NOT EXISTS workspace_identity (id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))');
  const existing = sql<{ id: string; name: string }>`SELECT id, name FROM workspace_identity LIMIT 1`;
  let agentId: string;
  let agentName: string;
  if (existing.length > 0 && existing[0]) {
    agentId = existing[0].id;
    agentName = existing[0].name;
  } else {
    agentId = crypto.randomUUID();
    agentName = config.agentName ?? 'agent';
    sql`INSERT INTO workspace_identity (id, name) VALUES (${agentId}, ${agentName})`;
  }

  const llm = createLocalProviderLLM({
    llm: config.llm,
    credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore,
    onCodexRefresh: config.onCodexRefresh,
  });
  // The mechanical-work tier: the chat vendor's own small model, for the
  // evolution engine's classification/labelling/short-reflection calls. Same
  // resolver, same credentials — one cheaper model id (core selectFastModel).
  // Resolved once here: a CLI process is one workspace's session, and a
  // `fast_model` change takes effect on the next one.
  const fastResolver = createLocalModelResolver({
    llm: config.llm, credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore, onCodexRefresh: config.onCodexRefresh,
  });
  initAgentConfigTable(execRaw);
  const fast = selectFastModel({
    fastSpec: createAgentConfigStore(sql).getFastModel(),
    chatSpec: fastResolver.normalizeSpecSync(null),
    providers: fastResolver.fastModelCandidates(),
  });
  // Only when it IS a different model — otherwise leave it unset so every
  // reader's documented `?? rt.llm` fallback is what runs, rather than a
  // second identical client.
  const fastLlm = fast.source === 'chat-model' ? undefined : createLocalProviderLLM({
    llm: config.llm, credentials: config.providerCredentials,
    codexAuthStore: config.codexAuthStore, onCodexRefresh: config.onCodexRefresh,
    spec: fast.spec,
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
  // Storage.vfs is the CompositeVFS mount table. /local (SqliteFS, which
  // implements the core VFS directly) is the durable base; /pc is the host
  // filesystem, mounted below once the checkpoint engine exists. /sandbox and
  // /nimbus are Cloudflare bindings with no local equivalent, so they are
  // RESERVED rather than absent — an agent addressing them gets the honest
  // reason the cloud backend gives for an unconfigured binding, instead of a
  // silent compat-route into /local.
  const vfs = new CompositeVFS({ local: sqliteFs });
  const remoteOnlyPolicy: MountPolicy =
    { readOnly: false, rootPath: '/', consistency: 'ephemeral', credentialsStayInHost: true };
  vfs.reserve('sandbox', 'the sandbox container is a Cloudflare binding — not available on the local backend', remoteOnlyPolicy);
  vfs.reserve('nimbus', 'the Nimbus sandbox is a Cloudflare binding — not available on the local backend', remoteOnlyPolicy);

  // MemoryStore consumes the full agent-utils VFS surface (FTS index walks).
  const memoryStore = new MemoryStore(sqliteFs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, vfs);

  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);

  // v2.0: shell + executionRouter so the canonical `run` tool in core has a
  // workspace provider and a bound POSIX shell. In CLI/local mode the shell is
  // the user's real machine, rooted at the process cwd where `proteus` or an
  // alias was invoked. Durable agent memory still lives in SQLite/VFS.
  // Shadow-git checkpoints: every host-FS mutation path (the bound shell — the
  // run tool + laptop.exec — and laptop.writeFile) snapshots its target dir
  // before the first mutation of each turn. Invisible until /undo.
  const checkpoints = createHostCheckpoints({ agent: agentName, keep: config.checkpointKeep });
  const shell: Shell = withCheckpointedShell(createHostShell(process.cwd()), checkpoints, process.cwd());
  const executionRouter = new DefaultExecutionRouter();
  // Both local executors run their commands in THIS process's container, so
  // both carry its measured cgroup limits — the truth `nproc` cannot tell the
  // model. Null off a cgroup, and then nothing is claimed.
  const limits = hostResourceLimits();
  executionRouter.register(createInlineExecutor({
    vfs, memory, craftStore, shell, ...(limits ? { resourceLimits: limits } : {}),
  }));
  executionRouter.register(createLocalLaptopExecutor(process.cwd(), shell, checkpoints, limits));
  // The laptop executor's FILE plane, at the same /pc prefix the cloud backend
  // reaches the user's machine through (EXECUTOR_MOUNT_PREFIX.laptop). Live
  // unconditionally: the machine is right here. Unscoped, like the `run` tool
  // and laptop.writeFile that already address the host filesystem directly.
  vfs.mount('pc', {
    vfs: createHostMountVFS(checkpoints),
    policy: { readOnly: false, rootPath: '/', consistency: 'live-shared', credentialsStayInHost: true },
    workingDir: process.cwd(),
  });

  return buildRuntime({
    sql, execRaw, vfs, llm, executor: createSandboxedExecutor(), schedule,
    agentId, agentName, memory, craftStore, judgeModel, fastLlm,
    spawnBranch: spawn, abortBranch: abort,
    executionRouter, shell, checkpoints,
  });
}

/**
 * The runtime a single local head (a fork of the parent workspace) runs over.
 *
 * A head is the parent's execution surface with a PRIVATE durable scratch — the
 * local mirror of the cf head (own facet storage, parent exec planes, parent
 * files at /workspace). It shares the parent's REAL host executor (the `laptop`
 * provider → `run laptop` and codemode `laptop.*`), the parent's llm/executor/
 * schedule, and the parent's shadow-git checkpoints. Its /workspace and /pc
 * mounts are windows onto the real host — the cwd the CLI was invoked in and the
 * machine root — so a head can read the code it was spawned to study and run
 * commands against it, exactly what the doctrine promises a fork.
 *
 * What is PRIVATE (a scratch overlay, not an empty world): the head's own
 * in-memory SqliteFS `/local`, its Memory + CraftStore, and the emulated
 * `workspace` shell (`run` with runtime omitted). Sibling heads share the real
 * workspace but never each other's scratch — the same isolation the cf head gets
 * from its own facet storage.
 */
export function buildCLIHeadRuntime(
  db: {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): void };
    exec(sql: string): void;
  },
  opts: { parentRuntime: AgentRuntime; cwd: string; agentId: string; agentName: string },
): AgentRuntime {
  const { parentRuntime: parent, cwd } = opts;
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);

  const sqliteFs = new SqliteFS(sql);
  sqliteFs.init();
  const vfs = new CompositeVFS({ local: sqliteFs });

  // /workspace and /pc are windows onto the REAL host — the same planes the
  // parent reaches — snapshotting into the parent's shadow-git checkpoints so a
  // head's host writes are covered by /undo too. /workspace roots at the cwd
  // (where the task files live); /pc roots at the machine root, as the parent's.
  const checkpoints = parent.checkpoints;
  const livePolicy: MountPolicy = { readOnly: false, rootPath: cwd, consistency: 'live-shared', credentialsStayInHost: true };
  vfs.mount('workspace', { vfs: createHostMountVFS(checkpoints), policy: livePolicy, workingDir: cwd });
  vfs.mount('pc', {
    vfs: createHostMountVFS(checkpoints),
    policy: { readOnly: false, rootPath: '/', consistency: 'live-shared', credentialsStayInHost: true },
    workingDir: cwd,
  });
  // Cloud-only planes stay reserved so a head addressing them gets the honest
  // unavailability the parent gives, not a silent compat-route into /local.
  const remoteOnlyPolicy: MountPolicy = { readOnly: false, rootPath: '/', consistency: 'ephemeral', credentialsStayInHost: true };
  vfs.reserve('sandbox', 'the sandbox container is a Cloudflare binding — not available on the local backend', remoteOnlyPolicy);
  vfs.reserve('nimbus', 'the Nimbus sandbox is a Cloudflare binding — not available on the local backend', remoteOnlyPolicy);

  const memoryStore = new MemoryStore(sqliteFs, sql);
  memoryStore.ensureSchema();
  const memory = adaptMemory(memoryStore, vfs);
  const craftStoreImpl = new AgentUtilsCraftStore(sql);
  craftStoreImpl.ensureSchema();
  const craftStore = adaptCraftStore(craftStoreImpl);

  // The `workspace` run runtime + codemode `workspace.*` is the head's private
  // emulated scratch shell (mirrors the cf head's createShell over its SqliteFS).
  const shell = createShell(sqliteFs);
  const executionRouter = new DefaultExecutionRouter();
  executionRouter.register(createInlineExecutor({ vfs, memory, craftStore, shell, sql }));
  // The parent's REAL host executor, shared unchanged: `run laptop` / `laptop.*`
  // reach the machine at the parent's cwd. This is the fork's real execution.
  const laptop = parent.executionRouter?.getProvider('laptop');
  if (laptop) executionRouter.register(laptop);

  return buildRuntime({
    sql, execRaw, vfs, llm: parent.llm, executor: parent.executor, schedule: parent.schedule,
    agentId: opts.agentId, agentName: opts.agentName, memory, craftStore, judgeModel: parent.judgeModel,
    spawnBranch: parent.spawnBranch, abortBranch: parent.abortBranch,
    executionRouter, shell, ...(checkpoints ? { checkpoints } : {}),
  });
}

export function createHostShell(cwd: string): Shell {
  return {
    exec(command: string, stdinOrOptions?: string | { stdin?: string; signal?: AbortSignal }) {
      return new Promise((resolve) => {
        const stdin = typeof stdinOrOptions === 'string' ? stdinOrOptions : stdinOrOptions?.stdin;
        const signal = typeof stdinOrOptions === 'string' ? undefined : stdinOrOptions?.signal;
        let settled = false;
        const child = spawn('/bin/sh', ['-lc', command], {
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
          finish({
            stdout,
            stderr: aborted ? `${stderr}${stderr ? '\n' : ''}Command aborted.` : stderr,
            exitCode: code ?? (aborted ? 130 : 0),
          });
        });
        if (stdin) child.stdin.end(stdin);
        else child.stdin.end();
      });
    },
  };
}

/** Snapshot before any shell command — a command may mutate anything in the
 *  cwd; the engine dedupes to one snapshot per turn and skips no-op trees. */
export function withCheckpointedShell(shell: Shell, checkpoints: FileCheckpoints, cwd: string): Shell {
  return {
    async exec(command, stdinOrOptions) {
      await checkpoints.ensureCheckpoint(cwd, 'shell exec');
      return shell.exec(command, stdinOrOptions);
    },
  };
}

function createLocalLaptopExecutor(
  cwd: string, shell: Shell, checkpoints: FileCheckpoints, resourceLimits: ResourceLimits | null,
): ExecutorProvider {
  const toHostPath = (path: unknown) => resolvePath(cwd, String(path || '.'));
  return {
    name: 'laptop',
    kind: 'laptop',
    capabilities: new Set(['shell', 'git', 'npm', 'fs_shared', 'net_outbound', 'process_spawn']),
    ...(resourceLimits ? { resourceLimits } : {}),
    positionalArgs: true,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: {
      exec: {
        description: 'Run a shell command on the local machine in the directory where the CLI was invoked.',
        execute: async (command: unknown, context?: unknown) => {
          const signal = readAbortSignal(context);
          return formatExecResult(await shell.exec(String(command), signal ? { signal } : undefined));
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
          await checkpoints.ensureCheckpoint(checkpoints.workdirForPath(p), 'file write');
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
