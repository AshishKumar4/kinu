/**
 * ReleaseExec over the sandbox executor's RAW handle.
 *
 * The engine needs real exit codes, so this adapter rides `SandboxHandle.exec`
 * directly (the LLM-facing `sandbox.exec` tool flattens results into lossy
 * strings). Port exposure goes through the ExecutorProvider's generic
 * `exposePort` — the existing preview-proxy path with its listener probe —
 * so a preview URL is only ever returned for a verified listener.
 */

import type { ExecutorProvider } from '../execution/types';
import { withSandboxRetry, type SandboxHandle } from '../execution/sandbox';
import type { ReleaseExec } from './engine';

export function createSandboxReleaseExec(
  handle: SandboxHandle,
  provider: Pick<ExecutorProvider, 'exposePort'>,
): ReleaseExec {
  return {
    async exec(command, opts) {
      const res = await withSandboxRetry(() => handle.exec(command, {
        cwd: opts?.cwd,
        timeout: opts?.timeout,
      }));
      return {
        stdout: res.stdout ?? res.output ?? '',
        stderr: res.stderr ?? '',
        // Absent exit code is failure, not success: the SDK resolves { stdout, exitCode } or { output, exitCode }, never a bare result.
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
