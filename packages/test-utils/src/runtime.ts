// Minimal AgentRuntime for unit tests; override fields via the options bag.
import type {
  AgentRuntime, LLM, Memory, Executor, Schedule, Identity, ExecutionRouter,
  CraftStore, BranchHandle, FiberCtx, AgentStores,
} from '@kinu.run/core';
import { createTestSql, type TestSql } from './sql';
import { WORKSPACE_IDENTITY_DDL, initWorkspaceActorTable, WorkspaceActorDirectory, initAgentConfigTable, initCodemodeStateTable, createAgentStores } from '@kinu.run/core';
import { createEchoLLM } from './llm';
import { createMemoryVfs } from './vfs';

export interface TestRuntimeOptions {
  /** Default: echo LLM. */
  llm?: LLM;
  /** Default: throwing no-op. */
  executor?: Executor;
  /** Default: empty in-memory store. */
  memory?: Memory;
  /** Default: empty. */
  craftStore?: CraftStore;
  /** Default: empty router. */
  executionRouter?: ExecutionRouter;
}

export interface TestRuntime {
  rt: AgentRuntime;
  testSql: TestSql;
  /** Returns the recorded LLM (when default scripted/echo) for assertions. */
  llm: LLM;
  /** The same store bundle both backends build, over this runtime's database. */
  stores: AgentStores;
}

function emptyMemory(): Memory {
  return {
    async write() { /* no-op */ },
    async append() { /* no-op */ },
    async index() { /* no-op */ },
    async search() { return []; },
    async read() { return null; },
    async tail() { return null; },
  };
}

function emptyCraftStore(): CraftStore {
  return {
    create: () => {},
    update: () => {},
    list: () => [],
    get: () => undefined,
    delete: () => {},
    search: () => [],
  };
}

function emptyExecutor(): Executor {
  return {
    languages: ['javascript'],
    async execute() { return { result: undefined }; },
  };
}

function emptyRouter(): ExecutionRouter {
  return {
    register: () => {},
    unregister: () => {},
    listExecutors: () => [],
    getProvider: () => undefined,
    getProviders: () => [],
  };
}

function syntheticSchedule(): Schedule {
  return {
    after: async (_ms: number, fn: () => void | Promise<void>) => { await fn(); },
    cron: async () => {},
    fiber: async <T>(_name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T> => {
      return fn({ stash: () => {}, snapshot: null });
    },
  };
}

function syntheticIdentity(): Identity {
  return {
    id: 'test-agent',
    name: 'test',
    scaffold: {
      path: 'scaffold/agent.js',
      exists: async () => false,
      read: async () => '',
      write: async () => {},
      version: async () => 0,
    },
  };
}

function emptyBranchHandle(): BranchHandle {
  return {
    explore: async () => ({ text: '' }),
    generateReflection: async () => ({ text: '' }),
    release: async () => {},
  };
}

/** A minimal AgentRuntime with a fresh in-memory database. */
export function createTestRuntime(opts: TestRuntimeOptions = {}): TestRuntime {
  const testSql = createTestSql();
  const llm = opts.llm ?? createEchoLLM();
  const workspace = createMemoryVfs();
  const workspaceId = crypto.randomUUID();
  testSql.execRaw(WORKSPACE_IDENTITY_DDL);
  void testSql.sql`INSERT INTO workspace_identity (id, name) VALUES (${workspaceId}, 'test')`;
  initWorkspaceActorTable(testSql.execRaw);
  initAgentConfigTable(testSql.execRaw);
  initCodemodeStateTable(testSql.execRaw);
  const actor = new WorkspaceActorDirectory(testSql.sql, { workspaceId, ownerUserId: '' }).createMain({ name: 'test' });

  const rt: AgentRuntime = {
    actor,
    workspaceIsMachine: false,
    storage: {
      vfs: workspace.vfs,
      sql: testSql.sql,
      execRaw: testSql.execRaw,
      transactionSync: write => testSql.db.transaction(write)(),
    },
    memory: opts.memory ?? emptyMemory(),
    executor: opts.executor ?? emptyExecutor(),
    llm,
    schedule: syntheticSchedule(),
    identity: syntheticIdentity(),
    craftStore: opts.craftStore ?? emptyCraftStore(),
    spawnBranch: async () => emptyBranchHandle(),
    abortBranch: async () => {},
    executionRouter: opts.executionRouter ?? emptyRouter(),
  };

  const stores = createAgentStores(
    () => rt.storage.sql,
    () => rt.actor,
    write => rt.storage.transactionSync(write),
    async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' }),
  );

  return { rt, testSql, llm, stores };
}

/**
 * Throws when the runtime has no `ExecutorProvider`: `createWorkspace` registers none, so a harness
 * on it measures an undefined workspace surface. Call before the first turn, upstream of every write.
 */
export function assertExecutableRuntime(rt: AgentRuntime, context: string): void {
  const router = rt.executionRouter;

  if (!router) {
    throw new Error(
      `${context}: this runtime has NO executionRouter, so nothing the agent does can execute. `
      + 'That is the signature of createWorkspace\'s birth runtime; open the workspace with '
      + 'openWorkspaceCLI (createCLIRuntime) to get one that can run commands.',
    );
  }

  const providers = router.getProviders();

  if (providers.length === 0) {
    throw new Error(
      `${context}: the executionRouter has ZERO registered providers, so every workspace and `
      + 'codemode call will fail with "is not a function" and any rate measured over them is '
      + 'meaningless. Expected the inline provider ({vfs, memory, craftStore, shell, sql}) that '
      + 'createCLIRuntime registers.',
    );
  }
}
