// Minimal AgentRuntime for unit tests.
//
// Stubs every field with the smallest possible implementation that satisfies
// the contract. Override individual fields via the options bag — that's how
// tests focus on the slice they're exercising.
import type {
  AgentRuntime, LLM, Memory, Executor, Schedule, Identity, ExecutionRouter,
  CraftStore, BranchHandle, FiberCtx,
} from '@proteus/core';
import { createTestSql, type TestSql } from './sql.js';
import { createEchoLLM } from './llm.js';
import { createMemoryVfs } from './vfs.js';

export interface TestRuntimeOptions {
  /** Override the LLM. Default: echo LLM. */
  llm?: LLM;
  /** Override the executor. Default: throwing-no-op. */
  executor?: Executor;
  /** Override the memory. Default: empty in-memory store. */
  memory?: Memory;
  /** Override the craft store. Default: empty. */
  craftStore?: CraftStore;
  /** Override the execution router. Default: empty router. */
  executionRouter?: ExecutionRouter;
}

export interface TestRuntime {
  rt: AgentRuntime;
  testSql: TestSql;
  /** Returns the recorded LLM (when default scripted/echo) for assertions. */
  llm: LLM;
}

function emptyMemory(): Memory {
  return {
    async write() { /* no-op */ },
    async append() { /* no-op */ },
    async index() { /* no-op */ },
    async search() { return []; },
    async read() { return null; },
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
    getAll: () => [],
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
  };
}

/** Build a minimal AgentRuntime suitable for unit tests. Each call gets a
 *  fresh in-memory database. Override any field via `opts`. */
export function createTestRuntime(opts: TestRuntimeOptions = {}): TestRuntime {
  const testSql = createTestSql();
  const llm = opts.llm ?? createEchoLLM();
  const workspace = createMemoryVfs();
  const rt: AgentRuntime = {
    storage: {
      vfs: workspace.vfs,
      sql: testSql.sql,
      execRaw: testSql.execRaw,
    },
    memory: opts.memory ?? emptyMemory(),
    executor: opts.executor ?? emptyExecutor(),
    llm,
    schedule: syntheticSchedule(),
    identity: syntheticIdentity(),
    craftStore: opts.craftStore ?? emptyCraftStore(),
    spawnBranch: async () => emptyBranchHandle(),
    abortBranch: async () => {},
    releaseBranch: async () => {},
    executionRouter: opts.executionRouter ?? emptyRouter(),
  };
  return { rt, testSql, llm };
}
