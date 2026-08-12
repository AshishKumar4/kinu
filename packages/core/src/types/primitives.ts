/**
 * Six abstract primitive interfaces — the portability layer.
 * Everything in the agent core is written against these.
 * Backends (CF Workers / Linux CLI) satisfy them.
 *
 * Architecture reference: docs/ARCHITECTURE.md — "Backends and the AgentRuntime contract"
 */

import type { SqlExecutor } from '@proteus/agent-utils';

/**
 * The tagged-template SQL primitive. Both DO sql and better-sqlite3 satisfy it.
 * For DDL (CREATE TABLE etc), use execRaw below, which accepts a plain string.
 *
 * Defined in `@proteus/agent-utils` rather than here: core already depends on
 * that package and it sits at the bottom of the DAG, so it is the only place
 * one definition can serve both. Re-exported here because this file is the
 * portability layer a backend author reads.
 */
export type { SqlValue, SqlExecutor } from '@proteus/agent-utils';

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
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Array<Record<string, unknown>>;
  };
}

/**
 * VFS interface — SqliteFS (agent-utils) implements it directly; the 3 mount
 * adapters and the CompositeVFS also satisfy it. `stat` names its time field
 * `mtimeMs` (Node fs.Stats convention) so SqliteFS's native stat is assignable
 * with no adapter. Backed by a single vfs_files table with 1.8 MB chunking.
 *
 * In production `Storage.vfs` is a CompositeVFS (vfs/composite.ts): the same
 * 7 methods over a mount table (/local = SqliteFS, plus /sandbox /nimbus /pc
 * raw-handle mounts). Bare and deeper-absolute paths compat-route to /local,
 * so implementations and consumers of this interface are unaffected.
 */
export interface VFS {
  readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null>;
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
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * 3. EXECUTOR — sandboxed multi-tool orchestration.
 * The LLM writes an async arrow function. Tool namespaces are Proxy globals.
 * Network blocked by default (globalOutbound: null on CF). No persistent state.
 */
export interface Executor {
  execute(
    code: string,
    providers: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
    /** Caller-declared wall-clock budget. Tool-call code gets the executor's
     *  own short default; a scaffold turn is a whole agentic loop and declares
     *  its own (runScaffold). Executors that cannot honour it may ignore it —
     *  every caller races its own timeout regardless. */
    opts?: { timeoutMs?: number },
  ): Promise<ExecuteResult>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StepResult {
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
  text?: string;
}

export type ToolSet = Record<string, unknown>;

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
  stash(data: unknown): void;
  snapshot: unknown | null;
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
    exists(): Promise<boolean>;
    read(): Promise<string>;
    write(code: string): Promise<void>;
    version(): Promise<number>;
  };
}

/**
 * 7. SHELL — POSIX command execution over a VFS.
 * Both `agent-utils/shell.createShell(vfs)` (structural match) and any other
 * host-native shell bridge satisfy this. Optional on AgentRuntime; tools that
 * need shell access (e.g. `run`) read it and fall back to the executionRouter.
 */
export interface ShellExecOptions {
  stdin?: string;
  signal?: AbortSignal;
}

export interface Shell {
  exec(command: string, stdinOrOptions?: string | ShellExecOptions): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
