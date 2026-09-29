/** Shipped workspace and facet bundles: isolated turns over one shared Nimbus file plane. */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import { agentHome, ownerCaller, runNodeAgent } from '@kinu.run/core';
import { diagnostics } from '@kinu.run/core/obs';
import { hostNodeSeat, nodeCodemodeTool } from '../../src/hosted-actors';
import { HIRE_CHILD_MODEL, hireModelsBaseUrl } from './hire-shapes';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { hostedActorPlacement } from '../../src/actor-hosting';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import type { AgentFacet } from './agent-facet-probe-agent';
import type { AgentFacetAnswer, OnePlaneObservation, SwarmFacetObservation } from './agent-facet-shapes';

export * from '../../src/server';

const PROBE_OWNER_ID = 'a9e1c0de5eed0000a9e1c0de5eed0000';

const PROBE_RPC = ['onePlane', 'swarmNode'];

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

  async swarmNode(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({
      start: async (controller) => {
        try {
          await this.runFiber('probe:swarm-facet', async () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(await this.runSwarmNode())));
            controller.close();
          });
        } catch (cause) {
          controller.error(cause);
        }
      },
    });
  }

  private async runSwarmNode(): Promise<SwarmFacetObservation> {
    const source = `async function* run() {
      const here = await workspace.exec('pwd');
      await host.callTool('report', { status: 'completed', content: here.trim() });
      await host.defaultInference();
    }`;

    const files = this.rt.agentStateVfs ?? this.rt.storage.vfs;
    await files.writeFile(`${this.rt.identity.scaffold.path}.v7`, source);
    void this.boundSql`UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ${this.actorHandle().actorId}`;
    void this.boundSql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
      VALUES (${this.actorHandle().actorId}, 7, ${Date.now()}, 'facet probe custom loop', 'current')`;

    const seams = this.hostedSeams();
    const identity = { nodeId: 'facet-node', rootId: 'facet-swarm', depth: 1 };
    const seat = await hostNodeSeat(seams, identity);
    const home = await seams.nodeHome(seat.actor);

    const run = await runNodeAgent({
      ...identity, parentId: null, task: 'Report the working directory from the inherited loop.',
      rationale: 'exercise the swarm turn boundary', base: 'Answer the assigned question.',
      messages: [{ role: 'user', content: 'Confirm the assigned work.' }], inherited: [],
      context: 'fresh', mode: 'build', settle: 'best', arbitrate: null,
      modelSpec: `openai-compat/${HIRE_CHILD_MODEL}`,
    }, {
      hostNode: hostNodeSeat.bind(undefined, seams),
      model: seams.resolveModel(`openai-compat/${HIRE_CHILD_MODEL}`),
      journal: this.headJournal, logger: diagnostics,
      reportModelCall: (report) => { this.reportModelCall(report); },
      provisionHome: async () => home,
      nodeCodemode: nodeCodemodeTool.bind(undefined, seams), webSearch: seams.webSearch(),
    });

    await this.reclaimSettledExplorationActors();
    const facet = await this.agentFacetOf<AgentFacet>(seat.actor.record.actorId);
    bootId ??= crypto.randomUUID();

    return {
      actorId: seat.actor.record.actorId, home: home.home,
      sameIsolate: (await facet.boot()) === bootId,
      workspaceClaims: this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM actor_turn_claims WHERE actor_id = ?', seat.actor.record.actorId).one().n,
      claims: await facet.turns(),
      retired: this.actorDirectoryStore().retained(seat.actor.record.actorId)?.retiringAt != null,
      summary: run.report.summary, candidate: run.candidate, reportedItself: run.reportedItself,
    };
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

interface ProbeRootEnv extends Omit<ProbeEnv, 'OrchestratorAgent'> {
  readonly OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
}

export class AgentFacetProbeRoot extends DurableObject<ProbeRootEnv> {
  private async target(workspace: string): Promise<Pick<OrchestratorAgent, 'onePlane' | 'swarmNode' | 'setModel' | 'setSoul'>> {
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.ensureProfile(owner, 'owner@probe.local', 'Owner');
    await userDO.registerWorkspace(owner, workspace, workspace);
    const root = await getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);
    const claim = await root.claimOwner(PROBE_OWNER_ID);
    await userDO.ensureWorkspaceCapability(workspace, claim.capabilityHash);

    return root;
  }

  async onePlane(workspace: string, agent: string): Promise<OnePlaneObservation> {
    return await (await this.target(workspace)).onePlane(agent);
  }

  async swarmNode(workspace: string): Promise<ReadableStream<Uint8Array>> {
    const root = await this.target(workspace);
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.setCredential(owner, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: hireModelsBaseUrl(workspace), apiKey: 'facet-probe-key',
    });
    const catalog = await userDO.getProfileCatalog(owner);
    await userDO.putProfileCatalog(owner, { roles: {}, tiers: { default: { model: `openai-compat/${HIRE_CHILD_MODEL}` } } }, catalog.version);
    await root.setModel(`openai-compat/${HIRE_CHILD_MODEL}`);
    await root.setSoul('# Facet Probe\n\nRun the assigned swarm work.');

    return await root.swarmNode();
  }
}
