/**
 * A small AgentRuntime fixture over a fresh in-memory database. Work it cannot perform faithfully
 * refuses by name until a test supplies it, so no test passes on work nothing performed.
 */
import type {
  AgentRuntime, LLM, Memory, Executor, Schedule, Identity, ExecutionRouter,
  CraftStore, AgentStores,
} from '@kinu.run/core';
import { createTestSql, type TestSql } from './sql';
import {
  WORKSPACE_IDENTITY_DDL, initWorkspaceActorTable, WorkspaceActorDirectory, initAgentConfigTable,
  initCodemodeStateTable, createAgentStores, DefaultExecutionRouter,
} from '@kinu.run/core';
import { createMemoryVfs } from './vfs';

export interface TestRuntimeOptions {
  llm?: LLM;
  executor?: Executor;
  memory?: Memory;
  craftStore?: CraftStore;
  executionRouter?: ExecutionRouter;
  schedule?: Schedule;
}

export interface TestRuntime {
  rt: AgentRuntime;
  testSql: TestSql;
  /** The same store bundle both backends build, over this runtime's database. */
  stores: AgentStores;
}

/** Work the test runtime does not perform, named with the option that supplies it. */
export class UnsupportedTestCapability extends Error {
  constructor(readonly capability: string, readonly option: string) {
    super(`createTestRuntime does not perform ${capability}; pass ${option} with a real adapter or `
      + 'an explicit fake');
    this.name = 'UnsupportedTestCapability';
  }
}

const refuse = (capability: string, option: string): never => {
  throw new UnsupportedTestCapability(capability, option);
};

function unscriptedLLM(): LLM {
  return {
    stream: () => refuse('a model call (stream)', 'opts.llm'),
    complete: async () => refuse('a model call (complete)', 'opts.llm'),
  };
}

function emptyMemory(): Memory {
  return {
    write: async () => refuse('a memory write', 'opts.memory'),
    append: async () => refuse('a memory append', 'opts.memory'),
    index: async () => refuse('memory indexing', 'opts.memory'),
    search: async () => [],
    read: async () => null,
    tail: async () => null,
  };
}

function emptyCraftStore(): CraftStore {
  return {
    create: () => refuse('a crafted-tool write', 'opts.craftStore'),
    update: () => refuse('a crafted-tool write', 'opts.craftStore'),
    delete: () => refuse('a crafted-tool write', 'opts.craftStore'),
    list: () => [],
    get: () => undefined,
    search: () => [],
  };
}

function noExecutor(): Executor {
  return {
    languages: ['javascript'],
    execute: async () => refuse('code execution', 'opts.executor'),
  };
}

function noSchedule(): Schedule {
  return {
    after: async () => refuse('a delayed callback', 'opts.schedule'),
    cron: async () => refuse('a cron schedule', 'opts.schedule'),
    fiber: async () => refuse('a durable fiber', 'opts.schedule'),
  };
}

function noScaffold(): Identity['scaffold'] {
  return {
    path: 'scaffold/agent.js',
    exists: async () => false,
    version: async () => 0,
    read: async () => refuse('a scaffold read', 'a runtime with a scaffold surface'),
    write: async () => refuse('a scaffold write', 'a runtime with a scaffold surface'),
  };
}

/** A minimal AgentRuntime with a fresh in-memory database. */
export function createTestRuntime(opts: TestRuntimeOptions = {}): TestRuntime {
  const testSql = createTestSql();
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
    executor: opts.executor ?? noExecutor(),
    llm: opts.llm ?? unscriptedLLM(),
    schedule: opts.schedule ?? noSchedule(),
    identity: { id: workspaceId, name: 'test', scaffold: noScaffold() },
    craftStore: opts.craftStore ?? emptyCraftStore(),
    spawnBranch: async () => refuse('a branch exploration', 'a runtime that spawns branches'),
    abortBranch: async () => refuse('a branch abort', 'a runtime that spawns branches'),
    executionRouter: opts.executionRouter ?? new DefaultExecutionRouter(),
  };

  const stores = createAgentStores(
    () => rt.storage.sql,
    () => rt.actor,
    write => rt.storage.transactionSync(write),
    async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' }),
  );

  return { rt, testSql, stores };
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
