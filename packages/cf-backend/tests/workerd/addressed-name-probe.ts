/**
 * A workspace object whose first entry after an eviction arrives by id, as Nimbus's `SupervisorRPC` and
 * `NimbusAssetsRPC` address it (`idFromString(doId)`): only workerd shows what name the object holds for the rest
 * of that activation. warm-forge-4d6acc02 on 2026-09-25: a `supervisorOp` built the object at 12:54:54 and every
 * named entry after it failed "could not determine its Durable Object name" until the activation ended at 13:57.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import { ownerCaller } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { AddressedAnswers } from './addressed-name-shapes';

export { UserDO } from '../../src/user/user-do';

// Exported as `src/server.ts` does: the hosted runtime refuses a worker whose `ctx.exports` lacks it.
export { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';

const PROBE_OWNER_ID = 'fedcba9876543210fedcba9876543210';

const EVICTED = 'the workspace object is evicted';

/** The production orchestrator plus the eviction a deploy or a memory reset performs. */
export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    Reflect.deleteProperty(this, 'evict');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'evict']);
  }

  async evict(): Promise<void> {
    await this.ctx.storage.sync();
    this.ctx.abort(EVICTED);
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

type NamedTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator, 'claimOwner'> & Pick<OrchestratorAgent, 'evict'>;

type IdTarget = Pick<ProductionOrchestrator, 'supervisorOp'>;

/** A thrown chain as its text, so the test reads what each entry answered. */
async function answer(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (cause) {
    return renderThrownChain({ cause });
  }
}

export class AddressedNameProbeRoot extends DurableObject<ProbeRootEnv> {
  private named(workspace: string): Promise<NamedTarget> {
    return getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);
  }

  /** The stub Nimbus's supervisor entrypoint builds: the id's string form, no name. */
  private byId(workspace: string): IdTarget {
    const id = this.env.OrchestratorAgent.idFromName(workspace).toString();

    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromString(id));
  }

  /** Claimed by name, as the page does on first open, then evicted. */
  async claimAndEvict(workspace: string): Promise<string> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, workspace, workspace);
    const claim = await (await this.named(workspace)).claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);

    return answer(async () => {
      await (await this.named(workspace)).evict();

      return 'the object answered after its eviction';
    });
  }

  /** A facet's filesystem write by id first, then the page's claim and history seed by name. */
  async idThenNamed(workspace: string): Promise<AddressedAnswers> {
    const supervisor = await answer(async () => {
      await this.byId(workspace).supervisorOp({ op: 'writeFile', args: ['/home/main/addressed.txt', 'by id'] });

      return 'served';
    });

    const claim = await answer(async () => (await (await this.named(workspace)).claimOwner(PROBE_OWNER_ID)).owner);

    const seed = await answer(async () => {
      const response = await (await this.named(workspace))
        .fetch(new Request(`https://probe/agents/orchestrator-agent/${workspace}/get-messages`));

      return String(response.status);
    });

    return { supervisor, claim, seed };
  }
}
