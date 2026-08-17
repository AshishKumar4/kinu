/**
 * The `parent` executor — a fork's window onto the workspace it forked.
 *
 * WHY AN EXECUTOR AND NOT A MOUNT
 *
 * A head (and a subordinate) runs in its own Durable Object facet with its own
 * SQLite, so its own Nimbus workspace is genuinely its own — private scratch a
 * sibling cannot see. The parent's durable files live in a DIFFERENT object and
 * are reachable only over Durable Object RPC, which is asynchronous by nature.
 *
 * That makes the parent workspace exactly what the sandbox container and the
 * user's machine are: another environment, reached over an async channel, in
 * ITS OWN native paths. So it is registered the same way they are — as an
 * `ExecutorProvider` with a `parent.*` codemode namespace and a `run { runtime:
 * 'parent' }` target — rather than being folded into this agent's filesystem as
 * a `/parent` directory. Folding it in is what previously required a router
 * above Nimbus and a second, emulated shell that could walk that router; both
 * are gone.
 *
 * The fork gains capability from the change, not loses it. `/parent` could only
 * ever be read by the emulated shell's dozen-and-a-half builtins, one RPC per
 * file; `parent.exec` runs the parent's REAL shell — its ~95 coreutils, pipes
 * and all — in a single round trip. `grep -rn X .` over the parent's tree is now
 * one call that greps, instead of a walk that reads every file across the wire.
 */

import type { ExecutorProvider, ExecutorCapability, ExecutorStatus } from './types.js';
import type { VFS } from '../types/primitives.js';
import { makeVfsError, type VfsErrorCode } from '../vfs/errno.js';
import { WORKSPACE_ROOT } from '../vfs/workspace-path.js';
import { readExecSignal } from './signal.js';
import { formatExecResult } from './exec-result.js';

type Stat = { size: number; mtimeMs: number; isDir: boolean } | null;

/** A failure crossing the RPC boundary. `code` survives so the caller can raise
 *  the same errno the parent's filesystem raised. */
export interface ParentRpcError {
  code: VfsErrorCode;
  /** Original Error.message. It may already carry the conventional `<code>: `
   *  prefix; the view canonicalizes it when rehydrating. */
  message: string;
  path: string;
}

export type ParentRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ParentRpcError };

/** `write` is a closed command union so the RPC surface implements both a file
 *  write and a mkdir without a second mutation method. */
export type ParentRpcWrite =
  | { kind: 'file'; path: string; data: string | Uint8Array }
  | { kind: 'directory'; path: string; recursive: boolean };

export interface ParentExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The parent workspace as a fork can reach it — worker-side Durable Object RPC,
 * implemented by the parent agent. Keeping the shape here rather than in a
 * backend keeps the executor backend-agnostic: the CLI's in-process fork
 * satisfies the same interface without any RPC at all.
 */
export interface ParentWorkspaceHandle {
  read(path: string): Promise<ParentRpcResult<Uint8Array>>;
  write(input: ParentRpcWrite): Promise<ParentRpcResult<null>>;
  list(path: string): Promise<ParentRpcResult<string[]>>;
  stat(path: string): Promise<ParentRpcResult<Stat>>;
  delete(path: string): Promise<ParentRpcResult<null>>;
  /** The parent's real workspace shell. */
  exec(command: string): Promise<ParentRpcResult<ParentExecResult>>;
}

function detail(error: ParentRpcError): string {
  const prefix = `${error.code}:`;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length).trimStart() : error.message;
}

function value<T>(result: ParentRpcResult<T>): T {
  if (result.ok) return result.value;
  throw makeVfsError(result.error.code, detail(result.error), result.error.path);
}

/**
 * A `VFS` over the parent workspace, in the PARENT's own paths.
 *
 * Not this agent's `Storage.vfs` and never merged into it — it is handed to the
 * `parent.*` tools, to the file browser's parent pane, and to a head's change
 * recorder (wrapped in `observeWrites`). One environment, one file view, the
 * same way the sandbox and the device have theirs.
 */
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
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function readdir(path: string): Promise<string[]>;
  function exists(path: string): Promise<boolean>;
  /**
   * Run a command in the parent workspace's REAL shell — the same ~95
   * coreutils, pipes, redirects and loops its own agent has. This is the fast
   * way to search it: \`grep -rn TODO .\`, \`find . -name '*.ts'\`.
   */
  function exec(command: string): Promise<string>;
}`;

/**
 * Register the parent workspace as an executor.
 *
 * `vfs` is passed in rather than derived so the caller can wrap it first — a
 * head hands in an `observeWrites` view, which is how its writes to the parent
 * get attributed to it and no sibling.
 */
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
    // The parent is a Proteus workspace, so its shell starts where every
    // workspace shell starts.
    homeDir: async () => WORKSPACE_ROOT,
    capabilities: new Set<ExecutorCapability>(['shell', 'fs_shared']),
    isAvailable: () => true,
    getStatus: () => status,
    connect: async () => {},
    disconnect: async () => {},
    positionalArgs: true,
    types: TYPES,
    tools: {
      readFile: {
        description: "Read a file from the parent workspace you were forked from, in the parent's own paths.",
        execute: async <Path>(path: Path) => {
          const content = await vfs.readFile(String(path), { encoding: 'utf8' });
          return content instanceof Uint8Array ? new TextDecoder().decode(content) : content;
        },
      },
      writeFile: {
        description: 'Write a file in the parent workspace. Your changes are attributed to you in the merge.',
        execute: async <Path, Content>(path: Path, content: Content) => {
          const text = String(content);
          await vfs.writeFile(String(path), text);
          return `Written ${text.length} bytes to ${path}`;
        },
      },
      readdir: {
        description: 'List a directory of the parent workspace.',
        execute: async <Path>(path: Path) => vfs.readdir(String(path ?? '.')),
      },
      exists: {
        description: 'Check whether a path exists in the parent workspace.',
        execute: async <Path>(path: Path) => vfs.exists(String(path)),
      },
      exec: {
        description:
          "Run one command in the parent workspace's real shell — the full coreutils set, pipes, "
          + 'redirects and loops. The fast way to search it (grep -rn, find).',
        execute: async <Command, Context>(command: Command, context?: Context) => {
          // The signal is read for parity with every other executor; a Durable
          // Object RPC exposes no kill for an in-flight call, so an aborted
          // caller stops waiting while the parent's command finishes.
          readExecSignal({ context });
          return formatExecResult(value(await deps.handle.exec(String(command))));
        },
      },
    },
    async exposePort(port) {
      return {
        supported: false,
        reason:
          `The parent workspace runs in a Worker and cannot expose inbound ports. `
          + `Use the 'sandbox' executor for any server you want to preview (port ${port}).`,
      };
    },
    async unexposePort() { /* nothing to do */ },
    async listExposedPorts() { return []; },
  };
}
