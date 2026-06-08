/**
 * Default ExecutionRouter — manages executor providers for codemode sandbox.
 */

import type { ExecutionRouter, ExecutorProvider, ExecutorInfo } from './types.js';

export class DefaultExecutionRouter implements ExecutionRouter {
  private providers = new Map<string, ExecutorProvider>();

  register(provider: ExecutorProvider): void {
    this.providers.set(provider.name, provider);
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  getProvider(name: string): ExecutorProvider | undefined {
    return this.providers.get(name);
  }

  getProviders(): Array<{
    name: string;
    tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
    types?: string;
    positionalArgs?: boolean;
  }> {
    const result: Array<{
      name: string;
      tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
      types?: string;
      positionalArgs?: boolean;
    }> = [];

    for (const provider of this.providers.values()) {
      if (!provider.isAvailable()) continue;
      result.push({
        name: provider.name,
        tools: provider.tools,
        types: provider.types,
        positionalArgs: provider.positionalArgs,
      });
    }

    return result;
  }

  listExecutors(): ExecutorInfo[] {
    return [...this.providers.values()].map(p => {
      const fallback = p.isAvailable();
      const status = p.getStatus?.() ?? {
        configured: fallback,
        available: fallback,
        active: fallback,
        status: fallback ? 'active' as const : 'not_configured' as const,
      };
      return {
        name: p.name,
        kind: p.kind,
        capabilities: [...p.capabilities],
        available: status.available,
        configured: status.configured,
        active: status.active,
        status: status.status,
        ...(status.reason ? { reason: status.reason } : {}),
      };
    });
  }
}
