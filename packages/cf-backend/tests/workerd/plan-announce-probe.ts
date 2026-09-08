/**
 * The plan-arrival announcement, over a REAL sealed root stub.
 *
 * Every in-process fixture resolves a root's inherited `broadcast`, because
 * `sealRpcSurface` leaves it callable on the instance — it only stops workerd
 * resolving it across a stub. So a suite that hands the producer a JavaScript
 * object cannot see the difference between a name the wire carries and a name
 * it rejects, and one that did exactly that passed while the wire was broken.
 * This probe is the difference: a production `SubordinateAgent` facet resolving
 * its workspace exactly the way `workspaceOwner()` does, and calling across the
 * boundary that decides.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { SubordinateAgent as ProductionSubordinate } from '../../src/subordinate-agent';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface, SUBORDINATE_RPC_SURFACE } from '../../src/rpc-surface';
import { SubordinateRosterStore, type WorkspacePlanReference } from '@kinu.run/core';
import * as v from 'valibot';

type ActorEnv = ConstructorParameters<typeof ProductionSubordinate>[1];

/** What one hop across the stub did. A rejection is the observation, not a
 *  failure of the probe, so it is reported rather than thrown. */
export interface HopResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/** The name the child is registered under, and the head of every reference
 *  below — the roster row the endpoint checks against is created for it. */
const CHILD = 'child';
const ROSTERED: WorkspacePlanReference = { path: [CHILD], id: 'plan-wire', revision: 1 };
const UNROSTERED: WorkspacePlanReference = { path: ['never-hired'], id: 'plan-wire', revision: 1 };

async function hop(call: () => Promise<void>): Promise<HopResult> {
  try {
    await call();
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * A production subordinate, plus the one fixture method that drives the hops.
 *
 * `reachRoot` resolves the workspace through `getAgentByName` over the
 * `OrchestratorAgent` binding, which is character for character what
 * `SubordinateAgent.workspaceOwner()` does, so the stub under test is the stub
 * production holds.
 */
export class PlanAnnounceChild extends ProductionSubordinate {
  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'reachRoot');
    sealRpcSurface(this, [...SUBORDINATE_RPC_SURFACE, 'reachRoot']);
  }

  async reachRoot(workspace: string): Promise<Record<string, HopResult>> {
    // `env.OrchestratorAgent` is the production binding name — `workspaceOwner()`
    // reads the same one through `WORKSPACE_ACTOR_CLASS`, so no cast is needed
    // and the probe cannot drift from the lookup it stands for.
    const root = await getAgentByName<ActorEnv, ProductionOrchestrator>(this.env.OrchestratorAgent, workspace);
    return {
      // The call the shipped producer made. TypeScript accepts it — the stub
      // type is derived from the class and the seal is a runtime shadow the
      // type system does not model — which is exactly why this compiled and
      // then failed on the wire.
      broadcast: await hop(async () => root.broadcast(JSON.stringify({ type: 'workspace_plan_updated', reference: ROSTERED }))),
      // The narrow name the root's allowlist carries.
      announce: await hop(async () => root.announceSubordinatePlan(ROSTERED)),
      // Reachable, and still refused: the root answers from its own roster.
      unrostered: await hop(async () => root.announceSubordinatePlan(UNROSTERED)),
    };
  }
}

/**
 * The production root, sealed with the production surface plus the two fixture
 * names. Additive only: `broadcast` stays absent from the allowlist and so stays
 * shadowed, and `announceSubordinatePlan` is listed by production rather than by
 * this file, so neither name under test is affected by the extension.
 */
export class OrchestratorAgent extends ProductionOrchestrator {
  readonly published: string[] = [];

  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'exercise');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'exercise']);
  }

  /** In-process capture of what reached the workspace's own clients. The text
   *  frames are the ones this probe reads back; the binary ones are a different
   *  representation, not a smaller version of the same one, so the string is
   *  parsed out rather than narrowed to. */
  override broadcast(message: string | ArrayBuffer | ArrayBufferView): void {
    const text = v.safeParse(v.string(), message);
    if (text.success) this.published.push(text.output);
  }

  async exercise(): Promise<{ hops: Record<string, HopResult>; published: string[] }> {
    const roster = new SubordinateRosterStore(this.ctx.storage.sql);
    roster.ensureSchema();
    if (!roster.get(CHILD)) {
      roster.create({
        name: CHILD, createdBy: 'user', status: 'idle', currentTask: null,
        createdAt: Date.now(), dismissedAt: null, lifetime: 'durable', taskEventId: null,
      });
    }
    const child = await this.subAgent(PlanAnnounceChild, CHILD);
    const hops = await child.reachRoot(this.name);
    return { hops, published: this.published };
  }
}
