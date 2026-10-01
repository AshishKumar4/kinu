import { readText, type VFS, type VfsDirent, type VfsStat, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * The `parent` executor: a fork's window onto the workspace it forked, in the parent's own paths.
 * An executor rather than a mount, like the sandbox and device: `parent.exec` runs the parent's real shell.
 */

import * as v from 'valibot';
import { raceAbort } from '@kinu.run/agent-utils';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus } from './types';

import { isVfsError, toVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { readExecSignal } from './signal';
import { commandResult, existsTool } from './exec-result';
import { Effect } from 'effect';
import { attempt, KinuError, refusalOf, renderThrownChain, settle } from '../obs/index';

/** `write` is a closed command union covering file write and mkdir. */
export type ParentRpcWrite =
  | { kind: 'file'; path: string; data: Uint8Array }
  | { kind: 'directory'; path: string; recursive: boolean };

export interface ParentExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The parent workspace as a fork reaches it (DO RPC, or in-process in the CLI). */
export interface ParentWorkspaceHandle {
  read(path: string): Promise<Uint8Array>;
  write(input: ParentRpcWrite): Promise<null>;
  list(path: string): Promise<VfsDirent[]>;
  stat(path: string, options?: { follow?: boolean }): Promise<VfsStat | null>;
  delete(path: string): Promise<null>;
  /** The parent's real workspace shell. */
  exec(command: string): Promise<ParentExecResult>;
}

export function answerParentRpc<T>(path: string, operate: () => Promise<T>): Promise<T> {
  return settle(attempt({ doing: `answering a fork's call on ${path}`, otherwise: 'io' }, operate));
}

/** The RPC error's cause keeps the parent's errno; reconstruct the local VFS contract. */
function parentCall<T>(path: string, operate: () => Promise<T>): Effect.Effect<T, VfsError> {
  return Effect.tryPromise({
    try: operate,
    catch: (error) => {
      const cause = error instanceof Error && 'cause' in error ? error.cause : error;
      const normalized = toVfsError(cause, path);
      const code = isVfsError(normalized) ? normalized.code : 'EIO';
      const message = renderThrownChain({ cause });
      const prefix = `${code}:`;
      const suffix = `, '${path}'`;
      const detail = message.startsWith(prefix) ? message.slice(prefix.length).trimStart() : message;

      return new VfsError(code, detail.endsWith(suffix) ? detail.slice(0, -suffix.length) : detail, path, { cause: error });
    },
  });
}

const StringSchema = v.string();

function parseInput<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: { value: unknown },
): v.InferOutput<TSchema> | undefined {
  const result = v.safeParse(schema, input.value);

  return result.success ? result.output : undefined;
}

/** A `VFS` over the parent workspace in the parent's own paths; never merged into this agent's `Storage.vfs`. */
export function createParentWorkspaceVfs(handle: ParentWorkspaceHandle): VFS {
  return {
    readFile(path) { return settle(parentCall(path, () => handle.read(path))); },
    writeFile(path, data) { return settle(Effect.asVoid(parentCall(path, () => handle.write({ kind: 'file', path, data })))); },
    readdir(path) { return settle(parentCall(path, () => handle.list(path))); },
    stat(path, options) { return settle(parentCall(path, () => handle.stat(path, options))); },
    unlink(path) { return settle(Effect.asVoid(parentCall(path, () => handle.delete(path)))); },
    mkdir(path, opts) {
      return settle(Effect.asVoid(parentCall(path, () => handle.write({ kind: 'directory', path, recursive: opts?.recursive ?? false }))));
    },
  };
}

const TYPES = `declare namespace parent {
  /** Read a file from the parent workspace, in the parent's own paths. */
  function readFile(path: string): Promise<string | Refusal>;
  function writeFile(path: string, content: string): Promise<string | Refusal>;
  function readdir(path: string): Promise<string[] | Refusal>;
  function exists(path: string): Promise<boolean | Refusal>;
  /**
   * Run a command in the parent workspace's REAL shell: the same ~95
   * coreutils, pipes, redirects and loops its own agent has. This is the fast
   * way to search it: \`grep -rn TODO .\`, \`find . -name '*.ts'\`.
   */
  function exec(command: string): Promise<string | Refusal>;
}`;

/** Register the parent workspace as an executor. `vfs` may be pre-wrapped (e.g. `observeWrites`) for attribution. */
export function createParentExecutor(deps: {
  handle: ParentWorkspaceHandle;
  /** The file view the tools address. Defaults to an unobserved one. */
  vfs?: VFS;
  /** The workspace this fork is a fork OF, for status/UI. */
  workspaceName?: string;
}): ExecutorProvider {
  const vfs = deps.vfs ?? createParentWorkspaceVfs(deps.handle);

  const status: ExecutorStatus = {
    configured: true,
    available: true,
    active: true,
    status: 'active',
    reason: deps.workspaceName ? `forked from ${deps.workspaceName}` : undefined,
  };

  return {
    name: 'parent',
    kind: 'parent',
    // The parent is a Kinu workspace; its shell starts at the workspace root.
    homeDir: async () => WORKSPACE_ROOT,
    capabilities: new Set<ExecutorCapability>(['shell', 'fs_shared']),
    // Not the fork's own.
    filesOwner: 'user',
    isAvailable: () => true,
    getStatus: () => status,
    connect: async () => {},
    disconnect: async () => {},
    positionalArgs: true,
    types: TYPES,
    tools: {
      readFile: {
        planAllowed: true,
        description: "Read a file from the parent workspace you were forked from, in the parent's own paths.",
        execute: async (...args: unknown[]) => {
          const path = parseInput(StringSchema, { value: args[0] });

          if (path === undefined) {
            return refusalOf(new KinuError('bad_input', 'parent readFile: path must be a string'));
          }

          return readText(vfs, path);
        },
      },
      writeFile: {
        description: 'Write a file in the parent workspace. Your changes are attributed to you in the merge.',
        execute: async (...args: unknown[]) => {
          const path = parseInput(StringSchema, { value: args[0] });

          if (path === undefined) {
            return refusalOf(new KinuError('bad_input', 'parent writeFile: path must be a string'));
          }

          const text = String(args[1]);
          await writeText(vfs, path, text);

          return `Written ${text.length} bytes to ${path}`;
        },
      },
      readdir: {
        planAllowed: true,
        description: 'List a directory of the parent workspace.',
        execute: async (...args: unknown[]) => {
          const path = args[0] === undefined ? '.' : parseInput(StringSchema, { value: args[0] });

          if (path === undefined) {
            return refusalOf(new KinuError('bad_input', 'parent readdir: path must be a string'));
          }

          return Promise.resolve(vfs.readdir(path)).then(entries => entries.map(({ name }) => name));
        },
      },
      exists: existsTool(vfs, { description: 'Check whether a path exists in the parent workspace.', operation: 'parent exists' }),

      exec: {
        description:
          "Run one command in the parent workspace's real shell: the full coreutils set, pipes, "
          + 'redirects and loops. The fast way to search it (grep -rn, find).',
        execute: async (...args: unknown[]) => {
          // DO RPC exposes no kill: the parent's command runs on, but the caller stops waiting.
          // The AbortError classifies as `cancelled`; not rewrapped so its code survives.
          const command = parseInput(StringSchema, { value: args[0] });

          if (command === undefined) {
            return refusalOf(new KinuError('bad_input', 'parent exec: command must be a string'));
          }

          const signal = readExecSignal({ context: args[1] });

          return commandResult(await raceAbort(
            () => deps.handle.exec(command),
            signal,
            'parent exec aborted: the command may still finish in the parent workspace',
          ));
        },
      },
    },
    async exposePort(port) {
      return {
        supported: false,
        reason:
          `The parent workspace runs in a Worker and cannot expose inbound ports. `
          + `Use an available preview-capable executor for a Node/Vite server (port ${port}).`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };
}
