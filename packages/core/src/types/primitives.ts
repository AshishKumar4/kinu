/** The portability layer: the agent core is written against these; backends satisfy them. */

import type { SqlExecutor, SqlValue } from '@kinu.run/agent-utils';
import * as v from 'valibot';
import type { MemorySearchResult } from '@kinu.run/agent-utils/memory';
import type { ToolSet as AiToolSet } from 'ai';
import type { JsonObject, JsonValue } from '../utils/json';

/** Tagged-template SQL; defined in agent-utils (bottom of the DAG). DDL goes through execRaw. */
export type { SqlValue, SqlExecutor } from '@kinu.run/agent-utils';

import type { Refusal } from '../obs/error';

export interface RawSqlExec {
  (ddl: string): void;
}

/** Positional-binding SQL for runtime-shaped queries; prefer {@link SqlExecutor} for literals. */
export interface SqlExec {
  readonly exec: (query: string, ...bindings: SqlValue[]) => {
    toArray(): SqlExecRow[];
  };
}

export type SqlExecRow = Record<string, SqlValue>;

/** Native generations remain numbers; relational projections expose their persisted identity tuple. */
export const VfsRevisionSchema = v.union([v.number(), v.string()]);

export type VfsRevision = v.InferOutput<typeof VfsRevisionSchema>;

export interface VfsEntryStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
  /** Never derived from size/mtime: a same-size/same-mtime peer write is still a new value. */
  revision?: VfsRevision;
}

export interface VfsLinkStat extends VfsEntryStat {
  readonly isSymlink: boolean;
}

/** Relative paths resolve at the workspace root, the same directory the workspace shell starts in. */
export interface VFS {
  /** Native compare-and-write. When undefined, callers must not emulate it with read/compare/write. */
  writeFileIfRevision?(
    path: string,
    data: Uint8Array,
    expectedRevision: VfsRevision,
  ): Promise<{ ok: true; revision: VfsRevision } | { ok: false; revision: VfsRevision }>;
  readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string>;
  /** Exact immutable version or refusal; never substitutes the current file. */
  readFileAtRevision?: (path: string, revision: VfsRevision, range?: { offset: number; length: number }) => Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<VfsEntryStat | null>;
  /** The entry itself, a symbolic link not followed; absent on a plane that cannot tell a link from its target. */
  lstat?(path: string): Promise<VfsLinkStat | null>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface Storage {
  vfs: VFS;
  sql: SqlExecutor;
  execRaw: RawSqlExec;
  /** Atomic synchronous writes on the same connection as sql; rolls back on throw. */
  readonly transactionSync: <T>(write: () => T) => T;
}

export type { MemorySearchResult } from '@kinu.run/agent-utils/memory';

/** FTS5-indexed markdown files in VFS. */
export interface Memory {
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  index(path: string): Promise<void>;
  search(query: string, limit?: number): Promise<MemorySearchResult[]>;
  read(path: string): Promise<string | null>;
  /** Newest `bytes` as text; reads at most `bytes` from the store and drops a split code point. */
  tail(path: string, bytes: number): Promise<string | null>;
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

/** Sandboxed; network blocked by default (globalOutbound: null on CF); no persistent state. */
export interface Executor {
  /** Languages this executor can actually run, in preference order. */
  readonly languages: readonly [string, ...string[]];
  execute(
    code: string,
    providers: ResolvedProvider[] | Record<string, (...args: JsonValue[]) => Promise<JsonValue | undefined>>,
    /** Omitted `timeoutMs` gets the executor default; executors that cannot honour it may ignore it. */
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

/** fiber() is callable only from the orchestrator; it throws in sub-agents. */
export interface Schedule {
  after(delayMs: number, fn: () => Promise<void>): Promise<void>;
  cron(expr: string, name: string, fn: () => Promise<void>): Promise<void>;
  fiber<T>(name: string, fn: (ctx: FiberCtx) => Promise<T>): Promise<T>;
}

export interface Identity {
  id: string;
  name: string;
  scaffold: {
    /** Version archives append `.vN` to this path. */
    path: string;
    exists(): Promise<boolean>;
    read(): Promise<string>;
    write(code: string): Promise<void>;
    version(): Promise<number>;
  };
}

export interface ShellExecOptions {
  stdin?: string;
  signal?: AbortSignal;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The command never ran. */
  refusal?: Refusal;
}

export interface Shell {
  exec(command: string, stdinOrOptions?: string | ShellExecOptions): Promise<ShellExecResult>;
}
