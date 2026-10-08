import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** Shipped workspace and facet bundles: isolated turns over one shared Nimbus file plane. */
import { getAgentByName, type AgentContext } from 'agents';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { agentHome, JsonValueSchema, ownerCaller, runNodeAgent, toolsInWorkMode, type Clock } from '@kinu.run/core';
import { narrowToolSurface } from '@kinu.run/core';
import { handClock } from '@kinu.run/test-utils/hand-clock';
import { diagnostics } from '@kinu.run/core/obs';
import { hostNodeSeat, nodeCodemodeTool } from '../../src/hosted-actors';
import { HIRE_CHILD_MODEL, hireControlUrl, hireModelsBaseUrl, JOB_MISSION, type JobRow } from './hire-shapes';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { hostedActorPlacement } from '../../src/actor-hosting';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { AgentWorkspaceRPC } from '../../src/agent-facets';
import { ROOT_SLATE_CALLER, SlateBinding } from '../../src/slates/bindings';
import { createRuntimeExecutor, jobContextAnswers } from '../../src/codemode-sandbox';
import { SLATE_STORAGE_BINDING, type SlateCallResult } from '@kinu.run/core';
import type { AgentFacet } from './agent-facet-probe-agent';
import type { AgentFacetAnswer, CraftedFromNodeObservation, NodeJobObservation, OnePlaneObservation, ProbeContention, RelayedAnswer, SwarmFacetObservation } from './agent-facet-shapes';

export * from '../../src/server';

const PROBE_OWNER_ID = 'a9e1c0de5eed0000a9e1c0de5eed0000';

const PROBE_RPC = ['probeLatencies', 'burn', 'markedFacet', 'facetMarks', 'onePlane', 'swarmNode', 'agentFor', 'craftedFromNode', 'swarmJobNode', 'jobWindowArmed', 'outrunJobWindow', 'jobRows', 'taskEvents'];

/** Reads `probe_marks` from whatever facet storage it starts over. */
const MARKS_READER = `import { DurableObject } from 'cloudflare:workers';
export class MarksReader extends DurableObject {
  marks() {
    const table = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'probe_marks'").toArray();
    return table.length === 0 ? [] : this.ctx.storage.sql.exec('SELECT value FROM probe_marks').toArray().map((row) => String(row.value));
  }
}
`;

interface MarksReader extends Rpc.DurableObjectBranded {
  marks(): string[];
}

let bootId: string | null = null;

export class OrchestratorAgent extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of PROBE_RPC) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, ...PROBE_RPC]);
  }

  /** A hired agent whose facet storage holds one row; its storage key, to read the facet after a wipe. */
  /** A running job's probe, `rounds` times back to back: how long each answer took to reach this object. */
  async probeLatencies(rounds: number): Promise<number[]> {
    const latencies: number[] = [];

    for (let round = 0; round < rounds; round += 1) {
      const asked = Date.now();

      await jobContextAnswers();
      latencies.push(Date.now() - asked);
    }

    return latencies;
  }

  /** CPU-bound work holding this object's one thread, as a heavy invocation does. */
  burn(iterations: number): Promise<number> {
    let mixed = 0;

    for (let step = 0; step < iterations; step += 1) mixed = Math.imul(mixed ^ step, 2_654_435_761) >>> 0;

    return Promise.resolve(mixed);
  }

  async markedFacet(name: string): Promise<{ readonly storageKey: string; readonly marks: string[] }> {
    const directory = this.actorDirectoryStore();
    const child = directory.create({ parent: directory.main(), name, creationId: name, origin: 'user', lifetime: 'durable' });
    const facet = await this.agentFacetOf<AgentFacet>(child.actorId);
    await facet.mark('the agent\'s own row');

    return { storageKey: directory.describe(child).storageKey, marks: await facet.marks() };
  }

  /** What the facet stored under `storageKey` holds now, read by a fresh start of it: storage is the name's, not the class's. */
  async facetMarks(storageKey: string): Promise<string[]> {
    const reader = this.env.LOADER.get('facet-marks-reader', () => ({
      compatibilityDate: '2026-09-30',
      mainModule: 'reader.js',
      modules: { 'reader.js': MARKS_READER },
    }));

    this.ctx.facets.abort(storageKey, new Error('read afresh'));

    return await this.ctx.facets.get<MarksReader>(storageKey, () => ({ class: reader.getDurableObjectClass<MarksReader>('MarksReader') })).marks();
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

  private readonly probeClock = handClock(Date.now());

  /** Every job runner here detaches on this clock: a window fires only when the test moves it. */
  protected override jobClock(): Clock {
    return this.probeClock;
  }

  async jobWindowArmed(count: number): Promise<void> {
    await this.probeClock.whenArmed(count);
  }

  /** The armed window fires: the call it bounds outruns it. */
  async outrunJobWindow(): Promise<void> {
    this.probeClock.tick();
  }

  async jobRows(): Promise<JobRow[]> {
    return this.ctx.storage.sql.exec<{ actor_id: string; id: string; status: string }>(
      'SELECT actor_id, id, status FROM background_jobs ORDER BY created_at').toArray()
      .map((row) => ({ actorId: row.actor_id, id: row.id, status: row.status }));
  }

  /** Tasks admitted to `actorId`'s log: a hired agent's queue, which a swarm node has no drain for. */
  async taskEvents(actorId: string): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_log WHERE actor_id = ? AND variant = 'subordinate_task'`, actorId).one().n;
  }

  /** A node on the builtin loop whose brief starts a command that outruns its window; streams once the node's run ends. */
  async swarmJobNode(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({
      start: async (controller) => {
        try {
          await this.runFiber('probe:swarm-job', async () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(await this.runJobNode())));
            controller.close();
          });
        } catch (cause) {
          controller.error(cause);
        }
      },
    });
  }

  private async runJobNode(): Promise<NodeJobObservation> {
    const seams = this.hostedSeams();
    const identity = { nodeId: 'job-node', rootId: 'job-swarm', depth: 1 };
    const seat = await hostNodeSeat(seams, identity);
    const home = await seams.nodeHome(seat.actor);

    const run = await runNodeAgent({
      ...identity, parentId: null, task: JOB_MISSION,
      rationale: 'run the job', base: 'Answer the assigned question.',
      messages: [{ role: 'user', content: JOB_MISSION }], inherited: [],
      context: 'fresh', mode: 'build', settle: 'best', arbitrate: null,
      modelSpec: `openai-compat/${HIRE_CHILD_MODEL}`,
    }, {
      hostNode: hostNodeSeat.bind(undefined, seams),
      journal: this.headJournal, logger: diagnostics,
      reportModelCall: (report) => { this.reportModelCall(report); },
      provisionHome: async () => home,
      nodeCodemode: nodeCodemodeTool.bind(undefined, seams), webSearch: seams.webSearch(),
    });

    return { actorId: seat.actor.record.actorId, status: run.report.status, summary: run.report.summary };
  }

  async agentFor(name: string): Promise<string> {
    const directory = this.actorDirectoryStore();

    return directory.create({ parent: directory.main(), name, creationId: name, origin: 'user', lifetime: 'durable' }).actorId;
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

  /** Main crafts `double`; a node seated as a swarm seats it calls it through the `eval` production gives a node. */
  async craftedFromNode(): Promise<CraftedFromNodeObservation> {
    this.rt.craftStore.create({ name: 'double', description: 'doubles a number', code: 'async (n) => n * 2' });
    const seams = this.hostedSeams();
    const seat = await hostNodeSeat(seams, { nodeId: 'crafted-node', rootId: 'crafted-swarm', depth: 1 });
    const execute = toolsInWorkMode('build', { eval: nodeCodemodeTool(seams, seat.actor)({}, narrowToolSurface(undefined)) }).eval?.execute;

    if (execute === undefined) throw new Error('the node has no eval');

    const call = async (): Promise<string> => {
      try {
        return JSON.stringify(await execute({ code: 'return await tools.double(21);' }, { toolCallId: 'crafted-node', messages: [], context: undefined }));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const called = await call();
    void this.boundSql`UPDATE crafted_tools SET score = 0.01, uses = 9, last_used_at = ${Date.now()} WHERE name = 'double'`;

    return { mainActorId: this.actorHandle().actorId, nodeActorId: seat.actor.record.actorId, called, retired: await call() };
  }

  private async runSwarmNode(): Promise<SwarmFacetObservation> {
    const source = `async function* run() {
      const here = await workspace.exec('pwd');
      await host.callTool('report', { status: 'completed', content: here.trim() });
      await host.defaultInference();
    }`;

    const files = this.rt.agentStateVfs ?? this.rt.storage.vfs;
    await writeText(files, `${this.rt.identity.scaffold.path}.v7`, source);
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
  private async target(workspace: string): Promise<Pick<OrchestratorAgent,
    'probeLatencies' | 'burn' | 'markedFacet' | 'facetMarks' | 'destroyAgent' | 'onePlane' | 'swarmNode' | 'agentFor' | 'craftedFromNode' | 'setModel' | 'setSoul' | 'swarmJobNode' | 'jobWindowArmed' | 'outrunJobWindow' | 'jobRows'
    | 'taskEvents' | 'cancelBackgroundJob'>> {
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

  /**
   * A running job's probe, answered while `burns` invocations of `iterations` CPU each queue on the same object; the
   * same probe with nothing queued first. Each latency runs from the probe's call to its continuation on the object.
   */
  async probeUnderLoad(workspace: string, burns: number, iterations: number): Promise<ProbeContention> {
    const root = await this.target(workspace);
    // Alone, a burn's span is its CPU: nothing else holds the thread. The clock moves at the call's answer.
    const alone = Date.now();

    await root.burn(iterations);
    const burnMs = Date.now() - alone;
    const quiet = await root.probeLatencies(PROBE_ROUNDS);
    const started = Date.now();
    const probing = root.probeLatencies(PROBE_ROUNDS);

    await Promise.all(Array.from({ length: burns }, async () => await root.burn(iterations)));
    const loadedMs = Date.now() - started;

    return { quiet, loaded: await probing, loadedMs, burnMs };
  }

  /** A hired agent's facet storage before and after the shipped workspace delete. */
  async deletedWorkspaceFacet(workspace: string): Promise<{ readonly before: string[]; readonly after: string[] }> {
    const marked = await (await this.target(workspace)).markedFacet('scribe');
    const root = await getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);
    await root.destroyAgent(PROBE_OWNER_ID);
    const fresh = await getAgentByName<ProbeEnv, OrchestratorAgent>(this.env.OrchestratorAgent, workspace);

    return { before: marked.marks, after: await fresh.facetMarks(marked.storageKey) };
  }

  // Each relay is built here, in this isolate, so the answer read is the one it hands the platform.
  async agentWorkspaceAnswer(workspace: string, agent: string): Promise<RelayedAnswer<Readonly<Record<string, string>> | null>> {
    const root = await this.target(workspace);
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.setCredential(owner, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: hireModelsBaseUrl(workspace), apiKey: 'relay-probe-key',
    });
    const props = { workspace: this.env.OrchestratorAgent.idFromName(workspace).toString(), actorId: await root.agentFor(agent) };
    const relay = new AgentWorkspaceRPC(Object.create(this.ctx, { props: { value: props } }), this.env);
    const auth = await relay.getAuth('openai-compat.default');

    return { answer: auth === null ? null : { ...auth.headers }, carriesDisposer: auth !== null && Symbol.dispose in auth };
  }

  async agentWorkspaceListing(workspace: string, agent: string): Promise<RelayedAnswer<readonly { readonly key: string; readonly kind: string }[]>> {
    const root = await this.target(workspace);
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.setCredential(owner, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: hireModelsBaseUrl(workspace), apiKey: 'relay-probe-key',
    });
    const props = { workspace: this.env.OrchestratorAgent.idFromName(workspace).toString(), actorId: await root.agentFor(agent) };
    const relay = new AgentWorkspaceRPC(Object.create(this.ctx, { props: { value: props } }), this.env);
    const listing = await relay.listCredentials();

    return { answer: listing.map(({ key, kind }) => ({ key, kind })), carriesDisposer: Symbol.dispose in listing };
  }

  async slateBindingAnswer(workspace: string): Promise<RelayedAnswer<SlateCallResult>> {
    await this.target(workspace);
    const props = { workspace, id: 'relay-probe', name: SLATE_STORAGE_BINDING, caller: ROOT_SLATE_CALLER };
    const binding = new SlateBinding(Object.create(this.ctx, { props: { value: props } }), this.env);
    await binding.call(['put'], ['seen', 'kept'], null);
    const answer = await binding.call(['get'], ['seen'], null);

    return { answer: { ...answer }, carriesDisposer: Symbol.dispose in answer };
  }

  /** A program's host call answering with what the host got over RPC, as a tool call's result reaches it. */
  async programHostAnswer(workspace: string): Promise<RelayedAnswer<Readonly<Record<string, string>> | null>> {
    await this.target(workspace);
    const owner = await ownerCaller(this.env);
    const userDO = this.env.UserDO.get(this.env.UserDO.idFromName(PROBE_OWNER_ID));
    await userDO.setCredential(owner, 'openai-compat.default', {
      kind: 'openai-compat', baseURL: hireModelsBaseUrl(workspace), apiKey: 'relay-probe-key',
    });
    let handed: unknown;

    // In place of the launcher: the program's host call, made as the launcher's call reaches the bridge.
    const executor = createRuntimeExecutor({
      run: async (_source, providers) => {
        handed = await providers[0]?.fns.answer?.();

        return { result: undefined, logs: [] };
      },
    });

    await executor.execute('', [{ name: 'host', fns: { answer: async () => {
      const received = await userDO.getAuth(owner, 'openai-compat.default');

      return v.is(JsonValueSchema, received) ? received : undefined;
    } } }]);

    const auth = v.parse(v.nullish(v.object({ headers: v.record(v.string(), v.string()) })), handed);

    return { answer: auth?.headers ?? null, carriesDisposer: v.is(v.looseObject({}), handed) && Symbol.dispose in handed };
  }

  async craftedFromNode(workspace: string): Promise<CraftedFromNodeObservation> {
    return await (await this.target(workspace)).craftedFromNode();
  }

  /** The node's model answers from the hire fake's `job` script, keyed by the brief its conversation opened on. */
  async swarmJobNode(workspace: string): Promise<ReadableStream<Uint8Array>> {
    await fetch(hireControlUrl(workspace, 'reset'), { method: 'POST', body: JSON.stringify({ script: 'job' }) });
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

    return await root.swarmJobNode();
  }

  async jobWindowArmed(workspace: string, count: number): Promise<void> {
    await (await this.target(workspace)).jobWindowArmed(count);
  }

  async outrunJobWindow(workspace: string): Promise<void> {
    await (await this.target(workspace)).outrunJobWindow();
  }

  async jobRows(workspace: string): Promise<JobRow[]> {
    return await (await this.target(workspace)).jobRows();
  }

  async taskEvents(workspace: string, actorId: string): Promise<number> {
    return await (await this.target(workspace)).taskEvents(actorId);
  }

  /** The workspace's own Cancel on a job card, by the job's id alone. */
  async cancelJob(workspace: string, jobId: string): Promise<{ ok: boolean }> {
    return await (await this.target(workspace)).cancelBackgroundJob(jobId);
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

/** Probe rounds per sample. */
const PROBE_ROUNDS = 12;
