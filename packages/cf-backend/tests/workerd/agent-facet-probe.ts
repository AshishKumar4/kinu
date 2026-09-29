/**
 * The shipped workspace object with an agent in its own isolate (a Worker Loader facet loading the agent bundle):
 * what the agent writes through Nimbus's session surface is the workspace's file, read back through the
 * workspace's own view and its shell. Slice 5's check in kinu-logs/design/SUBAGENTS.md.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import { agentHome, ownerCaller } from '@kinu.run/core';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { hostedActorPlacement } from '../../src/actor-hosting';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { AgentFacet } from './agent-facet-probe-agent';
import type { AgentFacetAnswer, OnePlaneObservation } from './agent-facet-shapes';

export { UserDO } from '../../src/user/user-do';

export { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';

export { AgentWorkspaceRPC } from '../../src/agent-facets';

const PROBE_OWNER_ID = 'a9e1c0de5eed0000a9e1c0de5eed0000';

const PROBE_RPC = ['onePlane'];

let bootId: string | null = null;

export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of PROBE_RPC) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, ...PROBE_RPC]);
  }

  async onePlane(name: string): Promise<OnePlaneObservation> {
    const directory = this.actorDirectoryStore();
    const child = directory.create({ parent: directory.main(), name, creationId: name, origin: 'user', lifetime: 'durable' });
    const record = directory.describe(child);
    const homeName = hostedActorPlacement(record).homeName;

    if (homeName === null) throw new Error('a subordinate has a home');
    const home = agentHome(homeName);
    const facet = await this.agentFacetOf<AgentFacet>(child.actorId);
    const agentShell: AgentFacetAnswer = await facet.exec('pwd; id -u');

    await facet.write(`${home}/a`, 'written by the agent');
    const main = this.workspaceBox(hostedActorPlacement(directory.describe(directory.main())).shellId);
    const mainCat = await main.exec(`cat ${home}/a`);

    bootId ??= crypto.randomUUID();

    return {
      home,
      agentShell,
      mainRead: await main.files.read(`${home}/a`),
      mainCat: { exitCode: mainCat.exitCode, stdout: mainCat.stdout, stderr: mainCat.stderr },
      sameIsolate: (await facet.boot()) === bootId,
    };
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

export class AgentFacetProbeRoot extends DurableObject<ProbeRootEnv> {
  async onePlane(workspace: string, agent: string): Promise<OnePlaneObservation> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, workspace, workspace);
    const root = await getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);
    const claim = await root.claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);

    return await root.onePlane(agent);
  }
}
