/**
 * A diagnostics line that names no workspace lands under the workspace of the invocation it ran in
 * (`attributeWorkspace`, read off the Agents SDK's per-invocation context). Only workerd runs the
 * SDK's real wrapping of an RPC method, an alarm and a detached task, so only here does a change
 * in that wrapping show.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { ownerCaller } from '@kinu.run/core';
import { diagnostics } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { AttributedLine } from './attribution-shapes';

export { UserDO } from '../../src/user/user-do';

export { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';

const PROBE_OWNER_ID = '0123456789abcdef0123456789abcdef';

/** The slice of an Analytics Engine data point this probe reads. */
interface AnalyticsDataPoint {
  readonly indexes?: readonly (ArrayBuffer | string | null)[];
  readonly blobs?: readonly (ArrayBuffer | string | null)[];
}

/** The sink writes the event name at blob 3 and the workspace digest at index 1, both strings. */
const WrittenLine = v.object({ event: v.string(), index: v.string() });

/** Every data point any workspace object in this isolate wrote. */
const written: AnalyticsDataPoint[] = [];

/** Callers waiting for the dataset to hold a number of probe lines; resolved by the write that reaches it. */
const waiters: { readonly count: number; readonly arrived: () => void }[] = [];

function probeLines(): AttributedLine[] {
  return written
    .map((point) => v.parse(WrittenLine, { event: point.blobs?.[2], index: point.indexes?.[0] }))
    .filter((line) => line.event.startsWith('probe.'));
}

const recorder = {
  writeDataPoint: (point?: AnalyticsDataPoint): void => {
    if (point === undefined) return;
    written.push(point);
    const held = probeLines().length;

    for (const waiter of waiters.filter((entry) => entry.count <= held)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.arrived();
    }
  },
};

const PROBE_METHODS = ['lineFromRpc', 'lineLater', 'lineFromAlarm', 'written'] as const;

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

/** The production orchestrator writing to an in-isolate dataset, plus three ways to log unattributed. */
export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ProbeEnv) {
    super(ctx, { ...env, AGENT_METRICS: recorder });

    for (const method of PROBE_METHODS) Reflect.deleteProperty(this, method);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, ...PROBE_METHODS]);
  }

  async lineFromRpc(): Promise<void> {
    diagnostics.event('probe.rpc_line');
  }

  /** Nothing awaits the line: it runs in a task the call queued and left behind. */
  async lineLater(): Promise<void> {
    queueMicrotask(() => { diagnostics.event('probe.detached_line'); });
  }

  async lineFromAlarm(): Promise<void> {
    await this.schedule(0, 'probeAlarmLine');
  }

  async probeAlarmLine(): Promise<void> {
    diagnostics.event('probe.alarm_line');
  }

  /** Answers once the isolate's dataset holds `count` probe lines, the alarm's and the timer's included. */
  async written(count: number): Promise<AttributedLine[]> {
    if (probeLines().length < count) {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, arrived: resolve });
      await promise;
    }

    return probeLines();
  }
}

interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

type Target = Pick<OrchestratorAgent, 'claimOwner' | (typeof PROBE_METHODS)[number]>;

export class AttributionProbeRoot extends DurableObject<ProbeRootEnv> {
  private workspace(name: string): Promise<Target> {
    return getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, name);
  }

  /** Claimed as the page claims it, then one line by RPC, one detached, one from an alarm. */
  async logThreeWays(name: string): Promise<void> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, name, name);
    const target = await this.workspace(name);
    const claim = await target.claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(name, claim.capabilityHash);
    await target.lineFromRpc();
    await target.lineLater();
    await target.lineFromAlarm();
  }

  async written(name: string, count: number): Promise<AttributedLine[]> {
    return (await this.workspace(name)).written(count);
  }
}
