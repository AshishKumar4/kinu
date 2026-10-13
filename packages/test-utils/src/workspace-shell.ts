/**
 * Shells over a bare `createWorkspace` bundle, for tests: the product runs commands through the hosted runtime
 * (`nimbusSessionShell`), and a test that opens the Nimbus workspace directly drives it through Nimbus's own exec. Each
 * call is a shell of its own, started at its `cwd` or the shell's directory; nothing it changes lasts.
 */
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { runCommand, type CommandResult, type RunOptions } from '@nimbus-sh/core/substrate/lifo/sandbox/run-command.js';
import { shellExecOptions, workspaceCommandNotFound, workspacePath, type Shell, type WorkspaceBundle, type WorkspaceFiles } from '@kinu.run/core';
import { storeFiles } from '@kinu.run/core/workspace';

type Run = (workspace: NimbusWorkspace, command: string, options: RunOptions & { readonly cwd: string }) => Promise<CommandResult>;

function shellOver(bundle: WorkspaceBundle, start: (workspace: NimbusWorkspace) => { readonly cwd: string; resolve(path: string): string }, run: Run): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = shellExecOptions({ value: stdinOrOptions });
      const { workspace } = await bundle.session();
      const at = start(workspace);
      const cwd = options.cwd === undefined ? at.cwd : at.resolve(options.cwd);
      const { output } = options;

      const result = await run(workspace, command, {
        cwd,
        stdin: options.stdin,
        signal: options.signal,
        ...(output !== undefined && {
          onStdout: (data: Uint8Array) => { output.write('stdout', data); },
          onStderr: (data: Uint8Array) => { output.write('stderr', data); },
        }),
      });

      return workspaceCommandNotFound({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, cwd }, (bin) => workspace.registry.has(bin));
    },
  };
}

/** The session user's shell, from the workspace's own directory. */
export function workspaceShell(bundle: WorkspaceBundle): Shell {
  return shellOver(bundle, (workspace) => workspace.fs, (workspace, command, options) => workspace.exec(command, options));
}

/** An agent as `vfs/agent-home.ts` provisions it. */
export interface TestAgent {
  readonly cred: VfsCred;
  readonly home: string;
  readonly tmp: string;
}

const agentPlanes = new WeakMap<WorkspaceBundle, Map<number, Promise<{ readonly vfs: WorkspaceFiles; readonly shell: Shell }>>>();

/** One agent's credentialed view of the bundle's rows, files and shell: its own process, from its home. One per uid. */
export function agentPlane(bundle: WorkspaceBundle, agent: TestAgent): Promise<{ readonly vfs: WorkspaceFiles; readonly shell: Shell }> {
  const planes = agentPlanes.get(bundle) ?? new Map();
  agentPlanes.set(bundle, planes);
  const held = planes.get(agent.cred.uid);

  if (held !== undefined) return held;

  const opening = (async () => {
    const session = await bundle.session();
    const process = session.processes.spawn('agent', [agent.home], agent.home, { cred: agent.cred });
    const env = { HOME: agent.home, TMPDIR: agent.tmp };

    const run: Run = async (workspace, command, options) => {
      const shell = workspace.shellFor(process.pid, { cwd: options.cwd, env });

      try {
        return await runCommand(shell, command, { ...options, cwd: undefined });
      } finally {
        await shell.closeDescriptors();
      }
    };

    return {
      vfs: storeFiles(() => Promise.resolve(session.vfs), agent),
      shell: shellOver(bundle, () => ({ cwd: agent.home, resolve: (path) => workspacePath(path, agent.home) }), run),
    };
  })();

  planes.set(agent.cred.uid, opening);

  return opening;
}
