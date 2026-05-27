/**
 * DefaultSandboxRegistry — in-memory ordered registry of SandboxApi instances.
 *
 * One per agent. The orchestrator builds each sandbox on cold-start (or lazily
 * on first request) and registers it here. The codemode tool layer queries
 * `available()` to materialize the executor providers for `createCodeTool`.
 */

import type { SandboxApi, SandboxRegistry } from './types.js';

export class DefaultSandboxRegistry implements SandboxRegistry {
  // Preserves insertion order — used by UI for stable listing.
  readonly #entries = new Map<string, SandboxApi>();

  register(namespace: string, api: SandboxApi): void {
    // Replacing an existing entry is allowed (e.g. swapping SSH socket).
    // The old API is not auto-disconnected to avoid surprising callers.
    this.#entries.set(namespace, api);
  }

  async unregister(namespace: string): Promise<void> {
    const api = this.#entries.get(namespace);
    if (!api) return;
    this.#entries.delete(namespace);
    try {
      await api.disconnect();
    } catch {
      // best-effort disconnect; the registry has already removed the binding
    }
  }

  get(namespace: string): SandboxApi | undefined {
    return this.#entries.get(namespace);
  }

  list(): Array<{ namespace: string; api: SandboxApi }> {
    return Array.from(this.#entries.entries()).map(([namespace, api]) => ({ namespace, api }));
  }

  available(): Array<{ namespace: string; api: SandboxApi }> {
    return this.list().filter(({ api }) => api.isAvailable());
  }
}
