/**
 * A diagnostics line that names no workspace lands under the workspace of the invocation it ran in
 * (`attributeWorkspace`, read off the Agents SDK's per-invocation context). Only workerd runs the
 * SDK's real wrapping of an RPC method, an alarm, and I/O that completes after its call returned,
 * so only here does a change in that wrapping show.
 *
 * `https://hold.test` is the pool's outbound service (vitest.config.ts): it holds a workspace's
 * request until another workspace releases it and records the order. A promise cannot carry the
 * release: workerd refuses to resume one object's promise from another object's request.
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

const HOLD = 'https://hold.test';

/** Every data point any workspace object in this isolate wrote. */
const written: AnalyticsDataPoint[] = [];

const recorder = { writeDataPoint: (point?: AnalyticsDataPoint): void => { if (point !== undefined) written.push(point); } };

/** Held lines, kept so their promises are owned rather than floating. */
const owed = new Map<string, Promise<void>>();

async function reached(path: string): Promise<void> {
  const answer = await fetch(`${HOLD}${path}`);

  if (!answer.ok) throw new Error(`${path} answered ${String(answer.status)}`);
}

const PROBE_METHODS = ['lineFromRpc', 'lineAfterReturn', 'releaseLineOf', 'lineFromAlarm', 'written'] as const;

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
    await reached(`/logged/rpc/${this.name}`);
  }

  /** Returns at once; the line is logged when the held request answers, after this call has returned. */
  async lineAfterReturn(): Promise<void> {
    owed.set(this.name, reached(`/hold/${this.name}`).then(async () => {
      diagnostics.event('probe.detached_line');
      await reached(`/logged/detached/${this.name}`);
    }));
  }

  /** Releases another workspace's held request; the answer waits until that workspace has logged. */
  async releaseLineOf(other: string): Promise<void> {
    await reached(`/release/${other}`);
  }

  async lineFromAlarm(): Promise<void> {
    await this.schedule(0, 'probeAlarmLine');
  }

  async probeAlarmLine(): Promise<void> {
    diagnostics.event('probe.alarm_line');
    await reached(`/logged/alarm/${this.name}`);
  }

  async written(): Promise<AttributedLine[]> {
    return written
      .map((point) => v.parse(WrittenLine, { event: point.blobs?.[2], index: point.indexes?.[0] }))
      .filter((line) => line.event.startsWith('probe.') || line.event === 'analytics.sink_installed');
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
    await target.lineAfterReturn();
    await reached(`/returned/${name}`);
    await target.lineFromAlarm();
  }

  /** `name`'s open call releases `other`'s held request; answers the outbound service's record of the order. */
  async releaseLineOf(name: string, other: string): Promise<string[]> {
    await (await this.workspace(name)).releaseLineOf(other);

    return v.parse(v.array(v.string()), await (await fetch(`${HOLD}/order`)).json());
  }

  /** Answers once `count` probe lines have been logged, the alarms' included. */
  async written(name: string, count: number): Promise<AttributedLine[]> {
    await reached(`/await/${String(count)}`);

    return (await this.workspace(name)).written();
  }
}
