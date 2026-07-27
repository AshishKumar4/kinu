/**
 * ProductChangeExec over the sandbox executor's RAW handle.
 *
 * The engine needs real exit codes, so this adapter rides `SandboxHandle.exec`
 * directly (the LLM-facing `sandbox.exec` tool flattens results into lossy
 * strings). Port exposure goes through the ExecutorProvider's generic
 * `exposePort` — the existing preview-proxy path with its listener probe —
 * so a preview URL is only ever returned for a verified listener.
 */

import type { ExecutorProvider } from '../execution/types.js';
import { withSandboxRetry, type SandboxHandle } from '../execution/sandbox.js';
import type { ProductChangeExec } from './engine.js';

export function createSandboxProductChangeExec(
  handle: SandboxHandle,
  provider: Pick<ExecutorProvider, 'exposePort'>,
): ProductChangeExec {
  return {
    async exec(command, opts) {
      const res = await withSandboxRetry(() => handle.exec(command, {
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.timeout != null ? { timeout: opts.timeout } : {}),
      }));
      return {
        stdout: res.stdout ?? res.output ?? '',
        stderr: res.stderr ?? '',
        exitCode: res.exitCode ?? 0,
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
