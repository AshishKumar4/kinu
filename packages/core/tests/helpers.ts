import { type Awaitable, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Test helpers: in-memory SQLite via bun:sqlite, mock LLM, mock Executor. */

import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import type { SqlExecutor, SqlExec, RawSqlExec, Memory, Executor, LLM, Schedule, Identity, FiberCtx, ExecuteResult, ResolvedProvider } from '../src/types/primitives';
import type { AgentRuntime, CraftStore } from '../src/types/agent-runtime';
import type { ActorHandle } from '../src/identity/actor-handle';
import { JsonValueSchema, type JsonValue } from '../src/utils/json';

import {
  createInlineWorkspace, sqlStorageOver, wrapDatabase,
} from '../src/identity/inline-primitives';
import { MemoryStore } from '@kinu.run/agent-utils/memory';
import { adaptMemory } from '../src/memory/vector-sync';
import type { WorkspaceBundle } from '../src/vfs/nimbus-workspace';
import { createWorkspaceForkSource } from '../src/vfs/workspace-planes';
import type { ForkFileSource } from '../src/identity/fork';
import { ConversationSearchStore, type ConversationRecall } from '../src/memory/conversation-search';
import { initActorStateSchema, initWorkspaceSchema } from '../src/state/workspace-schema';
import { createAgentStores, type AgentStores } from '../src/state/agent-stores';
import { CraftStore as AgentUtilsCraftStore } from '@kinu.run/agent-utils/stores';
import { createScaffoldSurface } from '../src/scaffold/surface';
import { WORKSPACE_IDENTITY_DDL, tableExists } from '../src/identity/schema';
import { initWorkspaceActorTable, WorkspaceActorDirectory, openWorkspaceMainActor } from '../src/identity/workspace-actors';
import { initAgentConfigTable } from '../src/config/store';
import { initCodemodeStateTable } from '../src/identity/program-state';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';

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
  readonly vfs: WorkspaceBundle['vfs'];
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
export function createMemoryVFS(db: Database): WorkspaceBundle['vfs'] {
  return createWorkspaceBundle(db).vfs;
}

/**
 * `vfs` with every call ordered after the fixture's seed. `seed` is a thunk run on the first VFS call:
 * an eager seed outlives a test that closes its database. A seed failure rejects the first call.
 */
function afterSeed(vfs: WorkspaceBundle['vfs'], seed: () => Promise<void>): VFS & Required<Pick<VFS, 'readRange'>> {
  let seeded: Promise<void> | null = null;

  const chain = <A extends unknown[], R>(fn: (...args: A) => Awaitable<R>) =>
    async (...args: A): Promise<R> => {
      seeded ??= seed();
      await seeded;

      return fn(...args);
    };

  return {
    readFile: chain((p: string) => vfs.readFile(p)),
    readRange: chain((p: string, offset: number, length: number) => vfs.readRange(p, offset, length)),
    writeFile: chain((p: string, d: Uint8Array) => vfs.writeFile(p, d)),
    readdir: chain((p: string) => vfs.readdir(p)),
    stat: chain((p: string, options?: { follow?: boolean }) => vfs.stat(p, options)),

    readlink: chain((p: string) => vfs.readlink(p)),
    unlink: chain((p: string) => vfs.unlink(p)),
    mkdir: chain((p: string, o?: { recursive?: boolean }) => vfs.mkdir(p, o)),

  };
}

/** The workspace filesystem over the test database, bound as the local host binds its own. */
export function createWorkspaceBundle(db: Database) {
  return createInlineWorkspace(db);
}

/** The Memory every backend builds: MemoryStore through the one adapter, FTS5 alone. */
export function createMemoryMemory(db: Database, vfs: VFS & Required<Pick<VFS, 'readRange'>>): Memory {
  const store = new MemoryStore(vfs, wrapDatabase(db).sql);
  store.ensureSchema();

  return adaptMemory(store, vfs);
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

  return store;
}

/**
 * A fiber lane per actor over the production `fibers` table; the production initializer owns the DDL
 * because the real primary key includes `actor_id`.
 */
export function createMemorySchedule(db: Database, actor: ActorHandle): Schedule {
  initActorStateSchema({ execRaw: makeExecRaw(db), sql: makeSql(db), exec: makeSqlExec(db), transactionSync: write => db.transaction(write)() });

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
  const seededFiles = afterSeed(workspace.vfs, () =>
    Promise.resolve(workspace.vfs.mkdir('scaffold', { recursive: true }))
      .then(() => writeText(workspace.vfs, 'scaffold/agent.js', 'initial')));

  const vfs: VFS = { ...seededFiles };
  delete vfs.readRange;

  // Production schema first: a helper's own copy of an actor-scoped table would win `IF NOT EXISTS`.
  initWorkspaceSchema({ execRaw, sql, exec: makeSqlExec(db), transactionSync });
  const actor = createTestActor(sql, execRaw, 'test-agent-id', 'test-agent');
  const memory = createMemoryMemory(db, seededFiles);
  const craftStore = createMemoryCraftStore(db);
  const llm = createMockLLM(opts?.llmResponses);
  const executor = createMockExecutor();
  const schedule = createMemorySchedule(db, actor);

  const identity: Identity = {
    id: 'test-agent-id',
    name: 'test-agent',
    scaffold: createScaffoldSurface({ vfs, sql, actor, path: 'scaffold/agent.js' }),
  };

  const rt: AgentRuntime = {
    workspaceIsMachine: false,
    actor,
    toolFiles: vfs,
    storage: { vfs, home: WORKSPACE_ROOT, sql, execRaw, transactionSync },
    memory,
    executor,
    llm,
    schedule,
    identity,
    craftStore,
    judgeModel: llm,
    shell: workspace.shell,
  };

  return { rt, db, workspace, stores: storesFor(rt) };
}

/** The store bundle over an already-built runtime. */
/** The actor's own past conversations, over its own rows. */
export function conversationsFor(rt: AgentRuntime, history: AgentStores['history'] = storesFor(rt).history): ConversationRecall {
  return new ConversationSearchStore(rt.storage.sql, rt.actor, (sessionId) => history.transcript(sessionId));
}

export function storesFor(rt: AgentRuntime): AgentStores {
  return createAgentStores(
    () => rt.storage.sql,
    () => rt.actor,
    write => rt.storage.transactionSync(write),
    async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' }),
  );
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
