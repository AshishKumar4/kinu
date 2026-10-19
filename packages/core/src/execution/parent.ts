/**
 * The `parent` executor: a fork's window onto the workspace it forked, in the parent's own paths.
 * An executor rather than a mount, like the sandbox and device: `parent.exec` runs the parent's real shell.
 */

import * as v from 'valibot';
import { raceAbort } from '@kinu.run/agent-utils';
import { commandTool, type ExecutorProvider, type ExecutorCapability, type ExecutorStatus } from './types';

import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { readExecSignal } from './signal';
import { commandAnswer, ExecPartsSchema } from './exec-result';
import { shellExecOptions } from './shell-session';
import { shellQuote } from '../utils/shell';
import { attempt, KinuError, refusalOf, settle } from '../obs/index';
import { parseInput } from '../utils/json';

const StringSchema = v.string();

/** `write` is a closed command union covering file write and mkdir. */
export type ParentRpcWrite =
  | { kind: 'file'; path: string; data: Uint8Array }
  | { kind: 'directory'; path: string; recursive: boolean };

export interface ParentExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The parent workspace as a fork reaches it (DO RPC, or in-process in the CLI): its shell; its files are the folder
 *  the fork shares with it. */
export interface ParentWorkspaceHandle {
  /** The parent's real workspace shell. */
  exec(command: string): Promise<ParentExecResult>;
}

export function answerParentRpc<T>(path: string, operate: () => Promise<T>): Promise<T> {
  return settle(attempt({ doing: `answering a fork's call on ${path}`, otherwise: 'io' }, operate));
}

/** Register the parent workspace as an executor. */
export function createParentExecutor(deps: {
  handle: ParentWorkspaceHandle;
  /** The workspace this fork is a fork OF, for status/UI. */
  workspaceName?: string;
}): ExecutorProvider {

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
    tools: {

      exec: commandTool(
        "Run one command in the parent workspace's real shell: the full coreutils set, pipes, "
          + 'redirects and loops. The fast way to search it (grep -rn, find).',
        (args) => {
          // DO RPC exposes no kill: the parent's command runs on, but the caller stops waiting.
          // The AbortError classifies as `cancelled`; not rewrapped so its code survives.
          const command = parseInput(StringSchema, { value: args[0] });

          if (command === undefined) return { refused: refusalOf(new KinuError('bad_input', 'parent exec: command must be a string')) };
          const signal = readExecSignal({ context: args[1] });
          const { cwd, name } = shellExecOptions({ value: args[1] });

          if (name !== undefined) return { refused: refusalOf(new KinuError('unsupported', 'parent exec: the parent workspace keeps no named shells for a fork')) };
          // The handle takes only the words, starting at the parent workspace's root; a `cwd` is where they start instead.
          const words = cwd === undefined ? command : `cd -- ${shellQuote(cwd)} && ${command}`;

          return {
            call: { text: command, context: {}, ...(cwd !== undefined && { cwd }), ...(signal !== undefined && { signal }) },
            run: async () => commandAnswer(await raceAbort(
              () => deps.handle.exec(words),
              signal,
              'parent exec aborted: the command may still finish in the parent workspace',
            ), v.is(ExecPartsSchema, args[1]), false),
          };
        },
      ),
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
