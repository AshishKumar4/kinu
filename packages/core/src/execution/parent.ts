/**
 * The `parent` executor: a fork's window onto the workspace it forked, in the parent's own paths.
 * An executor rather than a mount, like the sandbox and device: `parent.exec` runs the parent's real shell.
 */

import * as v from 'valibot';
import { raceAbort } from '@kinu.run/agent-utils';
import type { ExecutorProvider, ExecutorCapability, ExecutorStatus } from './types';
import type { VFS } from '../types/primitives';
import { makeVfsError, type VfsErrorCode } from '../vfs/errno';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { readExecSignal } from './signal';
import { commandResult, existsTool } from './exec-result';
import { KinuError, refusalOf } from '../obs/index';

type Stat = { size: number; mtimeMs: number; isDir: boolean } | null;

/** A failure crossing the RPC boundary; `code` keeps the parent's errno. */
export interface ParentRpcError {
  code: VfsErrorCode;
  /** Original Error.message, possibly `<code>: `-prefixed; the view canonicalizes it. */
  message: string;
  path: string;
}

export type ParentRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ParentRpcError };

/** `write` is a closed command union covering file write and mkdir. */
export type ParentRpcWrite =
  | { kind: 'file'; path: string; data: string | Uint8Array }
  | { kind: 'directory'; path: string; recursive: boolean };

export interface ParentExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The parent workspace as a fork reaches it (DO RPC, or in-process in the CLI). */
export interface ParentWorkspaceHandle {
  read(path: string): Promise<ParentRpcResult<Uint8Array>>;
  write(input: ParentRpcWrite): Promise<ParentRpcResult<null>>;
  list(path: string): Promise<ParentRpcResult<string[]>>;
  stat(path: string): Promise<ParentRpcResult<Stat>>;
  delete(path: string): Promise<ParentRpcResult<null>>;
  /** The parent's real workspace shell. */
  exec(command: string): Promise<ParentRpcResult<ParentExecResult>>;
}

/** The failure a refused RPC becomes; the errno `code` is preserved, not reclassified. */
function detail(error: ParentRpcError): string {
  const prefix = `${error.code}:`;

  return error.message.startsWith(prefix) ? error.message.slice(prefix.length).trimStart() : error.message;
}

function value<T>(result: ParentRpcResult<T>): T {
  if (result.ok) return result.value;
  throw makeVfsError(result.error.code, detail(result.error), result.error.path);
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
    async readFile(path, opts) {
      const content = value(await handle.read(path));

      return opts?.encoding === 'utf8' ? new TextDecoder().decode(content) : content;
    },
    async writeFile(path, data) { value(await handle.write({ kind: 'file', path, data })); },
    async readdir(path) { return value(await handle.list(path)); },
    async stat(path) { return value(await handle.stat(path)); },
    async unlink(path) { value(await handle.delete(path)); },
    async mkdir(path, opts) {
      value(await handle.write({ kind: 'directory', path, recursive: opts?.recursive ?? false }));
    },
    async exists(path) { return value(await handle.stat(path)) !== null; },
  };
}

const TYPES = `declare namespace parent {
  /** Read a file from the parent workspace, in the parent's own paths. */
  function readFile(path: string): Promise<string | Refusal>;
  function writeFile(path: string, content: string): Promise<string | Refusal>;
  function readdir(path: string): Promise<string[] | Refusal>;
  function exists(path: string): Promise<boolean | Refusal>;
  /**
   * Run a command in the parent workspace's REAL shell — the same ~95
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

          const content = await vfs.readFile(path, { encoding: 'utf8' });

          return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
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
          await vfs.writeFile(path, text);

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

          return vfs.readdir(path);
        },
      },
      exists: existsTool(vfs, { description: 'Check whether a path exists in the parent workspace.', operation: 'parent exists' }),

      exec: {
        description:
          "Run one command in the parent workspace's real shell — the full coreutils set, pipes, "
          + 'redirects and loops. The fast way to search it (grep -rn, find).',
        execute: async (...args: unknown[]) => {
          // DO RPC exposes no kill: the parent's command runs on, but the caller stops waiting.
          // The AbortError classifies as `cancelled`; not rewrapped so its code survives.
          const command = parseInput(StringSchema, { value: args[0] });

          if (command === undefined) {
            return refusalOf(new KinuError('bad_input', 'parent exec: command must be a string'));
          }

          const signal = readExecSignal({ context: args[1] });

          return commandResult(value(await raceAbort(
            () => deps.handle.exec(command),
            signal,
            'parent exec aborted — the command may still finish in the parent workspace',
          )));
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
