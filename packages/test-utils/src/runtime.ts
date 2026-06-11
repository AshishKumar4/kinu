// Minimal AgentRuntime for unit tests.
//
// Stubs every field with the smallest possible implementation that satisfies
// the contract. Override individual fields via the options bag — that's how
// tests focus on the slice they're exercising.
import type {
  AgentRuntime, LLM, Memory, Executor, Schedule, Identity, ExecutionRouter,
  CraftStore, BranchHandle, FiberCtx,
} from '@proteus/core';
import { ensureVfsSchema } from '@proteus/agent-utils/vfs';
import { createTestSql, type TestSql } from './sql.js';
import { createEchoLLM } from './llm.js';

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
    async append() { /* no-op */ },
    async search() { return []; },
    async list() { return []; },
  } as unknown as Memory;
}

function emptyCraftStore(): CraftStore {
  return {
    list: () => [],
    get: () => null,
    upsert: () => {},
    delete: () => {},
    search: () => [],
    getAll: () => [],
  } as unknown as CraftStore;
}

function emptyExecutor(): Executor {
  return {
    async execute() { return { result: undefined }; },
  } as unknown as Executor;
}

function emptyRouter(): ExecutionRouter {
  return {
    register: () => {},
    listExecutors: () => [],
    getProvider: () => null,
    getProviders: () => [],
  } as unknown as ExecutionRouter;
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
      exists: async () => false,
      read: async () => '',
      write: async () => {},
      version: async () => 0,
    },
  };
}

function emptyBranchHandle(): BranchHandle {
  return {
    explore: async () => ({ text: '', codeUsed: null }),
    generateReflection: async () => '',
  };
}

/** Build a minimal AgentRuntime suitable for unit tests. Each call gets a
 *  fresh in-memory database. Override any field via `opts`. */
export function createTestRuntime(opts: TestRuntimeOptions = {}): TestRuntime {
  const testSql = createTestSql();
  // Real agent databases always carry the canonical vfs_files schema
  // (initAllTables / SqliteFS.init); identity reads (SOUL.md) depend on it.
  ensureVfsSchema(testSql.sql);
  const llm = opts.llm ?? createEchoLLM();
  const rt: AgentRuntime = {
    storage: {
      vfs: {
        readFile: async () => '',
        writeFile: async () => {},
        readdir: async () => [],
        exists: async () => false,
        delete: async () => {},
        listAll: async () => [],
      } as never,
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
    executionRouter: opts.executionRouter ?? emptyRouter(),
    shell: undefined as never,
  } as AgentRuntime;
  return { rt, testSql, llm };
}
