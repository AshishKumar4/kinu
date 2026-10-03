import type {
  ExecutionRouter,
  ExecutorProvider,
  ExecutorInfo,
  ExecutorProviderSurface,
} from './types';
import * as v from 'valibot';
import { gateProviderExec } from './approval';
import { CommandResultSchema } from './exec-result';
import { Effect } from 'effect';
import { attempt, KinuError, refusalOf, settle, type Refusal } from '../obs/index';
import { STRICT_NO_CHANNEL_POLICY, type ShellApprovalPolicy } from '../safety/approval-gate';

export class DefaultExecutionRouter implements ExecutionRouter {
  private readonly providers = new Map<string, ExecutorProvider>();

  /** Every provider is gated once with this policy on register; default is strict with no channel. */
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

      if (status.sandbox !== undefined) Object.assign(info, { sandbox: status.sandbox });

      if (status.sizes !== undefined) Object.assign(info, { sizes: status.sizes });

      if (p.resourceLimits !== undefined) Object.assign(info, { resourceLimits: p.resourceLimits });

      return info;
    });
  }
}

/** An owner's command on a registered executor: refused before it ran, ran (a non-zero exit carries its refusal), or failed. */
export type ExecutorRun =
  | { readonly kind: 'refused'; readonly error: string; readonly refusal: Refusal }
  | { readonly kind: 'ran'; readonly stdout: string; readonly stderr: string; readonly exitCode: number; readonly refusal?: Refusal }
  | { readonly kind: 'failed'; readonly error: string; readonly refusal: Refusal };

/** Both backends run an owner's command here, through the workspace's own registered provider and its approval gate. */
export async function runOnExecutor(router: ExecutionRouter, executorId: string, command: string, device?: string): Promise<ExecutorRun> {
  const refused = (error: KinuError): ExecutorRun => ({ kind: 'refused', error: error.message, refusal: refusalOf(error) });
  const provider = router.getProvider(executorId);

  if (!provider) return refused(new KinuError('missing', `Executor "${executorId}" not found`));

  if (!provider.isAvailable()) return refused(new KinuError('unavailable', `Executor "${executorId}" is not available`));
  const execTool = provider.tools.exec;

  if (!execTool) return refused(new KinuError('unsupported', `Executor "${executorId}" has no exec tool`));

  // Device rides as tool context read by readDeviceSelection; with none, the call keeps the unnamed default.
  const executed = attempt({ doing: 'execute on ' + executorId, otherwise: 'io' }, async () => v.parse(
    CommandResultSchema, device === undefined ? await execTool.execute(command) : await execTool.execute(command, { device }),
  ));

  return settle(Effect.match(executed, {
    onFailure: (error): ExecutorRun => ({ kind: 'failed', error: refusalOf(error).error, refusal: refusalOf(error) }),
    onSuccess: (result): ExecutorRun => (v.is(v.string(), result)
      ? { kind: 'ran', stdout: result, stderr: '', exitCode: 0 }
      : { kind: 'ran', stdout: result.error, stderr: result.error, exitCode: 1, refusal: result }),
  }));
}
