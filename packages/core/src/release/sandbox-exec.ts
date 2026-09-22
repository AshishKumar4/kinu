// Rides the raw SandboxHandle.exec for real exit codes; the LLM-facing sandbox.exec tool flattens them.

import type { ExecutorProvider } from '../execution/types';
import { withSandboxRetry, type SandboxHandle } from '../execution/sandbox';
import type { ReleaseExec } from './engine';

export function createSandboxReleaseExec(
  handle: SandboxHandle,
  provider: Pick<ExecutorProvider, 'exposePort'>,
): ReleaseExec {
  return {
    async exec(command, opts) {
      // No `timeout`: `signal` ends it early, and SandboxHandle.exec kills the process and waits for it.
      const res = await withSandboxRetry(() => handle.exec(command, { cwd: opts?.cwd, signal: opts?.signal }));

      return {
        stdout: res.stdout ?? res.output ?? '',
        stderr: res.stderr ?? '',
        // Absent exit code is failure: the SDK always resolves an exitCode.
        exitCode: res.exitCode ?? 1,
      };
    },
    async writeFile(path, content) {
      await withSandboxRetry(() => handle.writeFile(path, content));
    },
    async exposePort(port, name) {
      if (!provider.exposePort) return { error: 'sandbox executor has no port exposure' };
      const result = await provider.exposePort(port, name ? { name } : undefined);

      return result.supported ? { url: result.url } : { error: result.reason };
    },
  };
}
