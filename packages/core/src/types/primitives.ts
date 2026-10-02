/** The portability layer: the agent core is written against these; backends satisfy them. */

import type { SqlExecutor } from '@kinu.run/agent-utils';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import * as v from 'valibot';
import type { MemorySearchResult } from '@kinu.run/agent-utils/memory';
import type { ToolSet as AiToolSet } from 'ai';
import type { JsonObject, JsonValue } from '../utils/json';

/** SQL primitives are defined in agent-utils (bottom of the DAG). DDL goes through execRaw. */
export type { SqlValue, SqlExecutor, SqlExec, SqlExecRow } from '@kinu.run/agent-utils';

import type { Refusal } from '../obs/error';

export interface RawSqlExec {
  (ddl: string): void;
}

/** Native generations remain numbers; relational projections expose their persisted identity tuple. */
export const VfsRevisionSchema = v.union([v.number(), v.string()]);

export interface Uncheckpointed {
  readonly dir: string;
  readonly why: string;
}

export interface VfsWriteReport {
  readonly uncheckpointed: Uncheckpointed;
}

export interface CheckpointFiles {
  writeFileWithReport?(path: string, data: Uint8Array): Promise<VfsWriteReport | null>;
}

export interface Storage {
  vfs: VFS & CheckpointFiles;
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
    opts?: {
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

export type OutputStreamName = 'stdout' | 'stderr';

export interface OutputChunk {
  readonly stream: OutputStreamName;
  readonly text: string;
}

export interface OutputSink {
  write(stream: OutputStreamName, data: Uint8Array | string): void;
  lost(count: number): void;
}

const WritableSchema = v.object({ write: v.function(), lost: v.function() });

export const OutputSinkSchema = v.custom<OutputSink>((value) => v.is(WritableSchema, value));

export interface ShellExecOptions {
  stdin?: string;
  signal?: AbortSignal;
  /** The caller stopped waiting: later commands run, and this one keeps no `cd`. */
  detach?: AbortSignal;
  output?: OutputSink;
}

export const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
  detach: v.optional(v.instance(AbortSignal)),
  output: v.optional(OutputSinkSchema),
}));

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
