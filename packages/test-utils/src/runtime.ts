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

/**
 * Refuse to measure an agent that cannot execute anything.
 *
 * THE DEFECT THIS EXISTS FOR. Two full behavioural eval runs were taken against
 * the runtime `createWorkspace` returns — which `cli-backend/src/open.ts:49-50`
 * calls, in its own comment, a "degraded inline VFS/Memory/Executor". It
 * registers no `ExecutorProvider` at all, so `rt.executionRouter` had no
 * providers and the entire workspace/codemode surface was undefined: real tool
 * results included `workspace.createTool is not a function` and
 * `workspace.readFile is not a function`. A `tool_outcomes` rate of 0.817 was
 * computed over that surface and read as a fact about the model.
 *
 * Production calls `createWorkspace` exactly once, at workspace BIRTH; every
 * running surface opens through `openWorkspaceCLI` -> `createCLIRuntime`, which
 * registers the inline and laptop providers. So "zero providers" always means the
 * harness is pointed at the wrong runtime, never that the agent had a bad turn.
 *
 * It THROWS, and callers must call it before the first turn — upstream of every
 * write path, like the graded-turn precondition. A run on a crippled runtime must
 * be a red test AND no record, because a record is evidence and this is not.
 *
 * One implementation on purpose: every tier that drives a real runtime calls
 * this rather than retyping the check, so a tier added later cannot forget it in
 * its own idiom.
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
