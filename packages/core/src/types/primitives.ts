/**
 * Six abstract primitive interfaces — the portability layer.
 * Everything in the agent core is written against these.
 * Backends (CF Workers / Linux CLI) satisfy them.
 *
 * Architecture reference: final-architecture.md §3
 */

export type SqlValue = string | number | boolean | null | ArrayBuffer;

/**
 * Tagged-template SQL executor. Both DO sql and better-sqlite3 satisfy this.
 * For DDL (CREATE TABLE etc), use execRaw which accepts a plain string.
 */
export interface SqlExecutor {
  <T = unknown>(query: TemplateStringsArray, ...values: SqlValue[]): T[];
}

/**
 * Raw SQL execution for DDL statements that don't use parameter binding.
 * On CF: ctx.storage.sql.exec(ddl)
 * On Linux: db.exec(ddl)
 */
export interface RawSqlExec {
  (ddl: string): void;
}

/**
 * VFS interface — matches SqliteFS from agent-utils.
 * Backed by a single vfs_files table with 1.8 MB chunking.
 */
export interface VFS {
  readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; mtime: number; isDir: boolean } | null>;
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
export interface Shell {
  exec(command: string, stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
