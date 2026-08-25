/**
 * Default ExecutionRouter — manages executor providers for codemode sandbox.
 */

import type {
  ExecutionRouter,
  ExecutorProvider,
  ExecutorInfo,
  ExecutorProviderSurface,
} from './types';
import { gateProviderExec } from './approval';
import { STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate';

export class DefaultExecutionRouter implements ExecutionRouter {
  private providers = new Map<string, ExecutorProvider>();

  /**
   * Every provider this router hands out — to `run`'s dispatch via
   * `getProvider` and to codemode via `getProviders` — answers to the SAME
   * approval policy, applied once here rather than by each caller. Backends
   * with no live policy to thread (heads, tests) fall back to the safe
   * default: strict, nobody to ask. See execution/approval.ts.
   */
  constructor(private readonly approvalPolicy: ShellApprovalPolicy = STRICT_NO_CHANNEL_POLICY) {}

  register(provider: ExecutorProvider): void {
    this.providers.set(provider.name, gateProviderExec(provider, this.approvalPolicy));
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  getProvider(name: string): ExecutorProvider | undefined {
    return this.providers.get(name);
  }

  getProviders(): ExecutorProviderSurface[] {
    const result: ExecutorProviderSurface[] = [];

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
      const info: ExecutorInfo = {
        name: p.name,
        kind: p.kind,
        capabilities: [...p.capabilities],
        available: status.available,
        configured: status.configured,
        active: status.active,
        status: status.status,
      };
      if (p.unmeasuredCapabilities !== undefined && p.unmeasuredCapabilities.size > 0) {
        info.unmeasuredCapabilities = [...p.unmeasuredCapabilities];
      }
      if (status.reason !== undefined) Object.assign(info, { reason: status.reason });
      if (status.label !== undefined) Object.assign(info, { label: status.label });
      if (status.granted !== undefined) Object.assign(info, { granted: status.granted });
      if (p.resourceLimits !== undefined) Object.assign(info, { resourceLimits: p.resourceLimits });
      return info;
    });
  }
}
