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

/** Names the probe adds; none is start-gated, so reading them never starts the object. */
const PROBE_RPC = ['evict', 'startCount', 'failNextStart'];

/** The production orchestrator plus the eviction a deploy or a memory reset performs, and a start count. */
export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of PROBE_RPC) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, ...PROBE_RPC]);
  }

  /** Counts, then calls a gated method mid-start: a re-entering gate would count twice. */
  override async onStart(): Promise<void> {
    this.ctx.storage.kv.put('probe-starts', (this.ctx.storage.kv.get<number>('probe-starts') ?? 0) + 1);

    if (this.ctx.storage.kv.get('probe-fail-start') === true) throw new Error('the probe refused this start');
    await super.onStart();
    await this.workspaceTitle();
  }

  async startCount(): Promise<number> {
    return this.ctx.storage.kv.get<number>('probe-starts') ?? 0;
  }

  async failNextStart(): Promise<void> {
    this.ctx.storage.kv.put('probe-fail-start', true);
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

type RawTarget = Pick<ProductionOrchestrator, 'accountSpend' | 'destroyAgent'> & Pick<OrchestratorAgent, 'startCount' | 'failNextStart' | 'evict'>;

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

  /** A stub a Worker holds from `get(idFromName(…))`: native RPC, which the SDK does not start. */
  private raw(workspace: string): RawTarget {
    return this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName(workspace));
  }

  /** After an eviction, a native RPC is the activation's first event: the starts before and after it. */
  async rpcFirst(workspace: string): Promise<{ before: number; spend: string; after: number }> {
    const stub = this.raw(workspace);
    const before = await stub.startCount();
    const spend = await answer(async () => JSON.stringify(await stub.accountSpend()));

    return { before, spend, after: await stub.startCount() };
  }

  /** A start that throws leaves the object deletable: `destroyAgent` is never gated on it. */
  async destroyAfterFailedStart(workspace: string): Promise<{ evicted: string; spend: string; destroyed: string }> {
    const stub = this.raw(workspace);
    await stub.failNextStart();

    // The eviction is the abort itself, so the call throws what `evict` aborted with.
    const evicted = await answer(async () => {
      await stub.evict();

      return 'answered';
    });

    const spend = await answer(async () => JSON.stringify(await this.raw(workspace).accountSpend()));

    const destroyed = await answer(async () => {
      await this.raw(workspace).destroyAgent(PROBE_OWNER_ID);

      return 'destroyed';
    });

    return { evicted, spend, destroyed };
  }

  /** A Nimbus sibling (`nbf:`) never runs the workspace start. */
  async siblingStarts(): Promise<{ spend: string; starts: number }> {
    const stub = this.raw('nbf:npm-resolve-fanout:0123abcd:0');
    const spend = await answer(async () => JSON.stringify(await stub.accountSpend()));

    return { spend, starts: await stub.startCount() };
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
