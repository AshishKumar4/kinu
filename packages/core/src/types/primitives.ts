/**
 * Six abstract primitive interfaces — the portability layer.
 * Everything in the agent core is written against these.
 * Backends (CF Workers / Linux CLI) satisfy them.
 *
 * Architecture reference: docs/ARCHITECTURE.md — "Backends and the AgentRuntime contract"
 */

import type { SqlExecutor, SqlValue } from '@kinu.run/agent-utils';
import type { ToolSet as AiToolSet } from 'ai';
import type { JsonObject, JsonValue } from '../utils/json';

/**
 * The tagged-template SQL primitive. Both DO sql and better-sqlite3 satisfy it.
 * For DDL (CREATE TABLE etc), use execRaw below, which accepts a plain string.
 *
 * Defined in `@kinu.run/agent-utils` rather than here: core already depends on
 * that package and it sits at the bottom of the DAG, so it is the only place
 * one definition can serve both. Re-exported here because this file is the
 * portability layer a backend author reads.
 */
export type { SqlValue, SqlExecutor } from '@kinu.run/agent-utils';

/**
 * Raw SQL execution for DDL statements that don't use parameter binding.
 * On CF: ctx.storage.sql.exec(ddl)
 * On Linux: db.exec(ddl)
 */
export interface RawSqlExec {
  (ddl: string): void;
}

/**
 * Positional-binding SQL. Durable Object `ctx.storage.sql` implements it
 * natively; bun:sqlite is one `db.query(q).all(...)` wrapper away.
 *
 * The second SQL primitive, and a deliberate one: a tagged template cannot
 * express a query whose shape is built at runtime, so the stores holding DDL
 * and dynamic statements — the events hub, the experience library, the
 * release board, the subordinate roster — speak this instead. Prefer
 * {@link SqlExecutor} wherever the statement is a literal.
 */
export interface SqlExec {
  exec(query: string, ...bindings: SqlValue[]): {
    toArray(): SqlExecRow[];
  };
}

/** One dynamically queried SQLite row in the portable value vocabulary. */
export type SqlExecRow = Record<string, SqlValue>;

/** What {@link VFS.stat} answers for a path that exists. Named because a
 *  consumer holding one needs the type, and `ReturnType<typeof vfs.stat>`
 *  couples it to the method rather than to the contract. */
export interface VfsEntryStat { size: number; mtimeMs: number; isDir: boolean }

/**
 * VFS interface — the workspace filesystem implements it, and so does each
 * executor's own file view. `stat` names its time field `mtimeMs` (the Node
 * fs.Stats convention).
 *
 * In production `Storage.vfs` is the workspace filesystem
 * (vfs/nimbus-workspace.ts). Relative paths resolve at its root — the same
 * directory the workspace shell starts in, so both address one set of bytes by
 * one set of names.
 */
export interface VFS {
  readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<VfsEntryStat | null>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** 1. STORAGE — filesystem + raw SQL */
export interface Storage {
  vfs: VFS;
  sql: SqlExecutor;
  /** Raw DDL execution (CREATE TABLE, CREATE INDEX) */
  execRaw: RawSqlExec;
}

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

/** 2. MEMORY — FTS5-indexed markdown files in VFS */
export interface Memory {
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  index(path: string): Promise<void>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  read(path: string): Promise<string | null>;
}

export interface ResolvedProvider {
  name: string;
  fns: Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>;
}

export interface ExecuteResult {
  result: JsonValue | undefined;
  error?: string;
  logs?: string[];
}

/**
 * 3. EXECUTOR — sandboxed multi-tool orchestration.
 * The LLM writes an async arrow function. Tool namespaces are Proxy globals.
 * Network blocked by default (globalOutbound: null on CF). No persistent state.
 */
export interface Executor {
  /** Languages this executor can actually run, in preference order. */
  readonly languages: readonly [string, ...string[]];
  execute(
    code: string,
    providers: ResolvedProvider[] | Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>,
    /** Caller-declared wall-clock budget. Tool-call code gets the executor's
     *  own short default; a scaffold turn is a whole agentic loop and declares
     *  its own (runScaffold). Executors that cannot honour it may ignore it —
     *  every caller races its own timeout regardless. */
    opts?: {
      timeoutMs?: number;
      /** Omitted means the executor's first declared language. */
      language?: string;
    },
  ): Promise<ExecuteResult>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StepResult {
  toolCalls?: Array<{ toolName: string; args: JsonObject }>;
  text?: string;
}

export type ToolSet = AiToolSet;

/** 4. LLM — inference */
export interface LLM {
  stream(opts: {
    system: string;
    messages: ModelMessage[];
    tools?: ToolSet;
    maxSteps?: number;
    onStepFinish?: (s: StepResult) => void;
  }): AsyncIterable<string>;
  complete(prompt: string): Promise<string>;
}

/** Fiber checkpoint context. stash() is a synchronous SQLite write. */
export interface FiberCtx {
  stash(data: JsonValue): void;
  snapshot: JsonValue | null;
}

/**
 * 5. SCHEDULE — deferred + durable execution.
 * CONSTRAINT: fiber() ONLY callable from orchestrator. Throws in sub-agents.
 */
export interface Schedule {
  after(delayMs: number, fn: () => Promise<void>): Promise<void>;
  cron(expr: string, name: string, fn: () => Promise<void>): Promise<void>;
  fiber<T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T>;
}

/** 6. IDENTITY — stable id + mutable scaffold */
export interface Identity {
  id: string;
  name: string;
  scaffold: {
    /** Canonical live scaffold path for this actor. Version archives append
     * `.vN` to this path. */
    path: string;
    exists(): Promise<boolean>;
    read(): Promise<string>;
    write(code: string): Promise<void>;
    version(): Promise<number>;
  };
}

/**
 * 7. SHELL — POSIX command execution over a VFS.
 * Both the workspace shell (structural match) and any other
 * host-native shell bridge satisfy this. Optional on AgentRuntime; tools that
 * need shell access (e.g. `run`) read it and fall back to the executionRouter.
 */
export interface ShellExecOptions {
  stdin?: string;
  signal?: AbortSignal;
}

/** What a command leaves behind. Named because gating and checkpointing
 *  wrappers have to construct one without running anything. */
export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Shell {
  exec(command: string, stdinOrOptions?: string | ShellExecOptions): Promise<ShellExecResult>;
}
