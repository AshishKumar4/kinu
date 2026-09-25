/** Test helpers: in-memory SQLite via bun:sqlite, mock LLM, mock Executor. */

import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type {
  SqlExecutor,
  SqlExec,
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
} from '../src/types/primitives';
import type { AgentRuntime, CraftStore, BranchHandle } from '../src/types/agent-runtime';
import type { ActorHandle } from '../src/identity/actor-handle';
import { JsonValueSchema, type JsonValue } from '../src/utils/json';

import {
  createInlineMemory, createInlineWorkspace, sqlStorageOver, wrapDatabase,
} from '../src/identity/inline-primitives';
import type { WorkspaceBundle, WorkspaceVFS } from '../src/vfs/nimbus-workspace';
import { createWorkspaceForkSource } from '../src/vfs/workspace-planes';
import type { ForkFileSource } from '../src/identity/fork-transfer';
import type { VfsNativeReads } from '../src/vfs/mounts';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { createAgentStores, type AgentStores } from '../src/state/agent-stores';
import { CraftStore as AgentUtilsCraftStore, craftStoreView } from '@kinu.run/agent-utils/stores';
import { createScaffoldSurface } from '../src/scaffold/surface';
import { WORKSPACE_IDENTITY_DDL, tableExists } from '../src/identity/schema';
import { initActorTables } from '../src/state/workspace-schema';
import { initWorkspaceActorTable, WorkspaceActorDirectory, openWorkspaceMainActor } from '../src/identity/workspace-actors';
import { initAgentConfigTable } from '../src/config/store';
import { initCodemodeStateTable } from '../src/identity/program-state';

export function createTestActor(sql: SqlExecutor, execRaw: RawSqlExec, workspaceId: string, name: string) {
  if (tableExists(sql, 'workspace_identity') && sql`SELECT id FROM workspace_identity LIMIT 1`.length > 0) return openWorkspaceMainActor(sql);
  execRaw(WORKSPACE_IDENTITY_DDL);
  void sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, ${name})`;
  initWorkspaceActorTable(execRaw);
  initAgentConfigTable(execRaw);
  initCodemodeStateTable(execRaw);

  return new WorkspaceActorDirectory(sql, { workspaceId, ownerUserId: '' }).createMain({ name });
}

export interface TestWorkspace {
  readonly db: Database;
  readonly sql: SqlExecutor;
  readonly execRaw: RawSqlExec;
  /** The embedded Nimbus plane. */
  readonly vfs: WorkspaceVFS;
  readonly bundle: WorkspaceBundle;
  /** The same plane as a fork reads it: one synchronous snapshot, so a write through `vfs` is seen. */
  readonly forkSource: ForkFileSource;
}

/** A workspace database with the production schema: a subset would test a shape no workspace has. */
export function createTestWorkspace(): TestWorkspace {
  const db = new Database(':memory:');
  const { sql, execRaw, transactionSync } = wrapDatabase(db);
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db), transactionSync });
  const bundle = createWorkspaceBundle(db);

  return { db, sql, execRaw, vfs: bundle.vfs, bundle, forkSource: createWorkspaceForkSource(bundle) };
}

export function makeSql(db: Database): SqlExecutor {
  return wrapDatabase(db).sql;
}

export function makeExecRaw(db: Database): RawSqlExec {
  return (ddl: string) => db.exec(ddl);
}

export function makeSqlExec(db: Database): SqlExec {
  return sqlStorageOver(db);
}

/** The production workspace filesystem (Nimbus) over the test database. */
export function createMemoryVFS(db: Database): WorkspaceVFS {
  return createWorkspaceBundle(db).vfs;
}

/**
 * `vfs` with every call ordered after the fixture's seed. `seed` is a thunk run on the first VFS call:
 * an eager seed outlives a test that closes its database. A seed failure rejects the first call.
 */
function afterSeed(vfs: WorkspaceVFS, seed: () => Promise<void>): VFS & Pick<VfsNativeReads, 'readRange'> {
  let seeded: Promise<void> | null = null;

  const chain = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      seeded ??= seed();
      await seeded;

      return fn(...args);
    };

  return {
    readFile: chain((p: string, o?: { encoding?: string }) => vfs.readFile(p, o)),
    readRange: chain((p: string, offset: number, length: number) => vfs.readRange(p, offset, length)),
    writeFile: chain((p: string, d: string | Uint8Array) => vfs.writeFile(p, d)),
    readdir: chain((p: string) => vfs.readdir(p)),
    stat: chain((p: string) => vfs.stat(p)),
    unlink: chain((p: string) => vfs.unlink(p)),
    mkdir: chain((p: string, o?: { recursive?: boolean }) => vfs.mkdir(p, o)),
    exists: chain((p: string) => vfs.exists(p)),
  };
}

/** The workspace filesystem over the test database, bound as the local host binds its own. */
export function createWorkspaceBundle(db: Database) {
  return createInlineWorkspace(db);
}

/** The same inline Memory the local CLI builds, over the shared `memory_chunks` DDL. */
export function createMemoryMemory(db: Database, vfs: VFS & Pick<VfsNativeReads, 'readRange'>): Memory {
  return createInlineMemory(db, vfs);
}

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

export function createMockExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute(code: string, _providers: ResolvedProvider[] | Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>): Promise<ExecuteResult> {
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

// ── CraftStore ───────────────────────────────────────────────────

/** The store both backends bind, over the test database. */
export function createMemoryCraftStore(db: Database): CraftStore {
  const store = new AgentUtilsCraftStore(makeSql(db));
  store.ensureSchema();

  return craftStoreView(store);
}

/**
 * A fiber lane per actor over the production `fibers` table; the production initializer owns the DDL
 * because the real primary key includes `actor_id`.
 */
export function createMemorySchedule(db: Database, actor: ActorHandle): Schedule {
  initActorTables(makeExecRaw(db), makeSql(db));

  return {
    after: async (_ms, fn) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      const id = crypto.randomUUID();
      db.run('INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES (?, ?, ?, NULL, ?)',
        [actor.actorId, id, name, Date.now()]);

      const stash = (data: JsonValue) => {
        db.run('UPDATE fibers SET snapshot = ? WHERE actor_id = ? AND id = ?',
          [JSON.stringify(data), actor.actorId, id]);
      };

      try {
        return await fn({ stash, snapshot: null });
      } finally {
        db.run('DELETE FROM fibers WHERE actor_id = ? AND id = ?', [actor.actorId, id]);
      }
    },
  };
}

export function createTestRuntime(opts?: {
  llmResponses?: Record<string, string>;
}) {
  const db = new Database(':memory:');
  const { sql, execRaw, transactionSync } = wrapDatabase(db);
  // One workspace, so the shell and the VFS are two views of the same bytes.
  const workspace = createWorkspaceBundle(db);

  // `afterSeed` runs the scaffold seed on the first VFS call and orders later calls behind it.
  const { readRange, ...vfs } = afterSeed(workspace.vfs, () =>
    workspace.vfs.mkdir('scaffold', { recursive: true })
      .then(() => workspace.vfs.writeFile('scaffold/agent.js', 'initial')));

  // Production schema first: a helper's own copy of an actor-scoped table would win `IF NOT EXISTS`.
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db), transactionSync });
  const actor = createTestActor(sql, execRaw, 'test-agent-id', 'test-agent');
  // The memory's tail reads through the plane's ranged read; `storage.vfs` stays the seven base methods.
  const memory = createMemoryMemory(db, { ...vfs, readRange });
  const craftStore = createMemoryCraftStore(db);
  const llm = createMockLLM(opts?.llmResponses);
  const executor = createMockExecutor();
  const schedule = createMemorySchedule(db, actor);

  const identity: Identity = {
    id: 'test-agent-id',
    name: 'test-agent',
    scaffold: createScaffoldSurface({ vfs, sql, actor, path: 'scaffold/agent.js' }),
  };

  const mockBranch: BranchHandle = {
    explore: async () => ({ text: 'explored approach A' }),
    generateReflection: async () => ({ text: 'reflection: approach was suboptimal' }),
    release: async () => {},
  };

  const rt: AgentRuntime = {
    workspaceIsMachine: false,
    actor,
    storage: { vfs, sql, execRaw, transactionSync },
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

  return { rt, db, stores: storesFor(rt) };
}

/** The store bundle over an already-built runtime. */
export function storesFor(rt: AgentRuntime): AgentStores {
  return createAgentStores(
    () => rt.storage.sql,
    () => rt.actor,
    write => rt.storage.transactionSync(write),
    async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' }),
  );
}

export function createMockSession(): import('../src/mcts/record-node').SessionWriter {
  const messages: Array<{ id: string; parentId?: string | null; role: string; content: string }> = [];

  return {
    async appendMessage(msg, parentId) {
      const content = msg.parts.map((part) => part.text).join('');
      messages.push({ id: msg.id, parentId, role: msg.role, content });
    },
    async getHistory(leafId) {
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

/** Both console channels for one awaited call; stdout is the CLI's machine stream. */
export interface ConsoleCapture {
  stdout: string[];
  stderr: string[];
}

/** Run `fn` with both console channels collected. Reassigns rather than `spyOn`: bun:test's spy misses async calls. */
export async function captureConsole<Result>(fn: () => Promise<Result>): Promise<ConsoleCapture> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => { stdout.push(String(args[0])); };

  console.error = (...args: unknown[]) => { stderr.push(String(args[0])); };

  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { stdout, stderr };
}
