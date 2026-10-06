/**
 * A workspace object whose first entry after an eviction arrives by id, as Nimbus's `SupervisorRPC` and
 * `NimbusAssetsRPC` address it (`idFromString(doId)`): only workerd shows what name the object holds for the rest
 * of that activation. warm-forge-4d6acc02 on 2026-09-25: a `supervisorOp` built the object at 12:54:54 and every
 * named entry after it failed "could not determine its Durable Object name" until the activation ended at 13:57.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { ownerCaller } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { AddressedAnswers, AlarmAfterDestroy, FailedStartAnswers } from './addressed-name-shapes';

export * from '../../src/server';

const PROBE_OWNER_ID = 'fedcba9876543210fedcba9876543210';

const EVICTED = 'the workspace object is evicted';

/** Names the probe adds; none is start-gated, so reading them never starts the object. */
const PROBE_RPC = ['evict', 'startCount', 'failNextStart', 'allowStart', 'probeAlarm', 'probeState'];

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

    // A sibling holds no workspace to read.
    if (this.ctx.id.name?.startsWith('nbf:') !== true) await this.workspaceTitle();
  }

  // Plain functions, never `async`: since agents 0.25 an async method a stub calls starts the object first.
  startCount(): Promise<number> {
    return Promise.resolve(this.starts());
  }

  failNextStart(): Promise<void> {
    this.ctx.storage.kv.put('probe-fail-start', true);

    return Promise.resolve();
  }

  allowStart(): Promise<void> {
    this.ctx.storage.kv.delete('probe-fail-start');

    return Promise.resolve();
  }

  evict(): Promise<void> {
    return this.ctx.storage.sync().then(() => { this.ctx.abort(EVICTED); });
  }

  /** The platform's alarm delivery: this activation, however it was built, runs its alarm. */
  probeAlarm(): Promise<string> {
    return this.alarm().then(() => 'retired');
  }

  /** What a workspace holds: its starts, its identity rows and its actor rows. */
  probeState(): Promise<{ starts: number; identity: number; actors: number }> {
    const rows = (table: string): number => (this.ctx.storage.sql.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table,
    ).toArray().length === 0 ? 0 : v.parse(v.number(), this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n));

    return Promise.resolve({ starts: this.starts(), identity: rows('workspace_identity'), actors: rows('workspace_actors') });
  }

  private starts(): number {
    return this.ctx.storage.kv.get<number>('probe-starts') ?? 0;
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

type NamedTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator, 'claimOwner'> & Pick<OrchestratorAgent, 'evict'>;

type IdTarget = Pick<ProductionOrchestrator, 'supervisorOp'> & Pick<OrchestratorAgent, 'probeAlarm' | 'evict'>;

type RawTarget = Pick<ProductionOrchestrator, 'accountSpend' | 'destroyAgent'>
  & Pick<OrchestratorAgent, 'startCount' | 'failNextStart' | 'allowStart' | 'evict' | 'probeAlarm' | 'probeState'>;

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

  /**
   * A start that throws fails every request of its activation with its own cause; the next activation, its cause
   * gone, starts and answers. `destroyAgent` is never gated on a start, and a call after it finds no workspace.
   */
  async failedStartThenDestroy(workspace: string): Promise<FailedStartAnswers> {
    // A stub held across an eviction is broken; each call takes a fresh one.
    await this.raw(workspace).failNextStart();

    // The eviction is the abort itself, so the call throws what `evict` aborted with.
    const evict = () => answer(async () => {
      await this.raw(workspace).evict();

      return 'answered';
    });

    const spend = () => answer(async () => JSON.stringify(await this.raw(workspace).accountSpend()));
    const evicted = await evict();
    const refused = [await spend(), await spend()];

    await this.raw(workspace).allowStart();
    await evict();
    const restarted = await spend();

    await this.raw(workspace).failNextStart();
    await evict();

    const destroyed = await answer(async () => {
      await this.raw(workspace).destroyAgent(PROBE_OWNER_ID);

      return 'destroyed';
    });

    // A call that lands in a later activation, as one routed before the destroy would.
    await this.raw(workspace).allowStart();
    await evict();
    const late = await spend();

    return { evicted, refused, restarted, destroyed, late, left: await this.raw(workspace).probeState() };
  }

  /** Destroyed, and then an alarm the platform still owes it arrives: by id, as the platform delivers it, and by name. */
  async alarmAfterDestroy(workspace: string): Promise<AlarmAfterDestroy> {
    await this.claimAndEvict(workspace);

    const destroyed = await answer(async () => {
      await this.raw(workspace).destroyAgent(PROBE_OWNER_ID);

      return 'destroyed';
    });

    // Each delivery builds the object anew, as a redelivery after the destroyed activation is gone. Ended by id, so
    // the first by id finds no tables at all, and a later one finds the tables a named entry made, empty.
    const evictById = () => answer(async () => {
      await this.byId(workspace).evict();

      return 'evicted';
    });

    await evictById();
    const byId = await answer(() => this.byId(workspace).probeAlarm());
    const byName = await answer(() => this.raw(workspace).probeAlarm());
    await evictById();
    const byIdOverTables = await answer(() => this.byId(workspace).probeAlarm());

    return { destroyed, byId, byName, byIdOverTables, left: await this.raw(workspace).probeState() };
  }

  /** A Nimbus sibling (`nbf:`) never runs the workspace start, holds no workspace, and runs its alarm as the SDK's. */
  async siblingStarts(): Promise<{ spend: string; starts: number; alarm: string; left: { identity: number; actors: number } }> {
    const stub = this.raw('nbf:npm-resolve-fanout:0123abcd:0');
    const spend = await answer(async () => JSON.stringify(await stub.accountSpend()));
    const starts = await stub.startCount();
    const alarm = await answer(() => stub.probeAlarm());
    const { identity, actors } = await stub.probeState();

    return { spend, starts, alarm, left: { identity, actors } };
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
