import { Agent, getAgentByName } from 'agents';
import { OrchestratorAgent as ProductionRoot } from '../../src/orchestrator';
import { SubordinateAgent as ProductionFacet } from '../../src/subordinate-agent';
import { sealRpcSurface, ORCHESTRATOR_RPC_SURFACE, SUBORDINATE_AGENT_BOOT_SURFACE } from '../../src/rpc-surface';
import { RunEventRecorder, actorReferenceOf } from '@kinu.run/core';
import { refusalOf, toKinuError } from '@kinu.run/core/obs';
import { bindAgentSql } from '../../src/runtime';
import { AgentSessionProvider } from 'agents/experimental/memory/session';
export { UserDO } from '../../src/user/user-do';

async function refused(operation) {
  try { await operation(); return { unexpected: 'success' }; }
  catch (cause) { return refusalOf(toKinuError({ doing: 'running the native identity probe', cause, otherwise: 'io' })); }
}

export class OrchestratorAgent extends ProductionRoot {
  constructor(ctx, env) {
    super(ctx, env);
    for (const name of ['seedLegacy', 'activate', 'counts', 'probe', 'register', 'lifecycle']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'seedLegacy', 'activate', 'counts', 'probe', 'register', 'lifecycle']);
  }
  seedLegacy() {
    this.ensureSchema();
    this.ctx.storage.sql.exec("INSERT INTO workspace_identity(id,name,owner_user_id,created_at) VALUES (?, 'legacy', 'owner', 1)", this.ctx.id.toString());
    this.ctx.storage.sql.exec('CREATE TABLE agent_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO agent_config VALUES ('model','legacy-model')");
    this.ctx.storage.sql.exec('CREATE TABLE codemode_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    this.ctx.storage.sql.exec("INSERT INTO codemode_state VALUES ('saved','{\"legacy\":true}',1)");
    this.ctx.storage.sql.exec(`CREATE TABLE workspace_subordinates (name TEXT PRIMARY KEY, created_by TEXT NOT NULL, status TEXT NOT NULL, current_task TEXT, created_at INTEGER NOT NULL, dismissed_at INTEGER, lifetime TEXT NOT NULL, task_event_id TEXT)`);
    this.ctx.storage.sql.exec("INSERT INTO workspace_subordinates VALUES ('retained-child','orchestrator','dismissed',NULL,1,2,'task',NULL)");
    const recorder = new RunEventRecorder(bindAgentSql(this));
    recorder.emit('historic-run', { type: 'run_start', agentId: 'historic-observed-id' });
    new AgentSessionProvider(this, 'default').ensureTable();
    const content = JSON.stringify({ id: 'historic-message', role: 'user', parts: [{ type: 'text', text: 'preserve this' }] });
    this.ctx.storage.sql.exec("INSERT INTO assistant_messages(id,session_id,parent_id,role,content,created_at) VALUES ('historic-message','default',NULL,'user',?,'2026-01-01 00:00:01')", content);
    this.ctx.storage.sql.exec("INSERT INTO messages(id,session_id,role,content,created_at) VALUES ('historic-message','default','user',?,1)", content);
    return this.counts();
  }
  async activate() { await super.onStart(); return this.counts(); }
  counts() {
    return {
      actors: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM workspace_actors').one().n,
      events: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM run_events').one().n,
      historicalId: this.ctx.storage.sql.exec("SELECT json_extract(payload,'$.agentId') AS id FROM run_events WHERE run_id='historic-run'").toArray()[0]?.id ?? null,
      legacyConfig: this.ctx.storage.sql.exec('SELECT key,value FROM agent_config ORDER BY key').toArray(),
      legacyState: this.ctx.storage.sql.exec('SELECT key,value,updated_at FROM codemode_state ORDER BY key').toArray(),
      liveConfig: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM actor_config').one().n,
      liveState: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM actor_program_state').one().n,
    };
  }
  async probe() {
    const failures = [];
    failures.push(await refused(() => this.getModel()));
    failures.push(await refused(() => this.onFiberRecovered({ id: 'old-fiber', name: 'evolution:settle', snapshot: null, createdAt: 1, recoveryReason: 'interrupted' })));
    failures.push(await refused(() => this.getTools()));
    failures.push(await refused(() => this.alarm()));
    const page = await this.getChatHistoryPage({ limit: 10 });
    const archive = await this.exportWorkspaceArchive();
    const frames = [];
    const connection = { tags: [], send: (frame) => frames.push(JSON.parse(frame)), close: () => { throw new Error('The owner inspection connection was closed.'); } };
    await this.onMessage(connection, JSON.stringify({ type: 'cf_agent_use_chat_request', id: 'old-queued-turn', init: { method: 'POST', body: '{}' } }));
    await this.onMessage(connection, JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'reconnect' }));
    const children = await this.inspectSubordinate({ path: [], view: 'children', page: { limit: 1 } });
    return { failures, frames, page, children, archiveLines: archive.lines, after: this.counts() };
  }
  async register(name, creationId) {
    return this.actorDirectory({ action: 'register', name, creationId, kind: 'subordinate', lifetime: 'durable' });
  }
  async lifecycle() {
    const old = await this.register('reader', 'admitted-old');
    const seed = { name: 'reader', creationId: 'admitted-old', actor: old.reference, displayName: 'Reader', nameOrigin: 'user', role: 'researcher', mission: 'Read the file.', lifetime: 'durable' };
    const child = await this.subAgent(SubordinateAgent, old.storageKey);
    const first = await child.seed(seed);
    if ('reason' in first) throw new Error(`${first.reason}: ${first.error}`);
    const retainedName = await refused(() => this.register('reader', 'new-before-delete'));
    await this.actorDirectory({ action: 'retire', name: 'reader', reference: old.reference });
    const next = await this.register('reader', 'admitted-new');
    const replacement = await this.subAgent(SubordinateAgent, next.storageKey);
    const fresh = await replacement.seed({ ...seed, actor: next.reference, creationId: 'admitted-new' });
    if ('reason' in fresh) throw new Error(`${fresh.reason}: ${fresh.error}`);
    const late = await this.subAgent(SubordinateAgent, old.storageKey);
    const staleSeed = await late.seed(seed);
    await this.actorDirectory({ action: 'retire', name: 'reader', reference: old.reference });
    const oldGone = (await this.getExistingSubAgent(SubordinateAgent, old.storageKey)) === null;
    const nextPresent = (await this.getExistingSubAgent(SubordinateAgent, next.storageKey)) !== null;
    const alive = await this.actorDirectory({ action: 'validate', name: 'reader', reference: next.reference });
    return { first, fresh, retainedName, staleSeed, oldGone, nextPresent, distinctKeys: old.storageKey !== next.storageKey, alive: alive.state };
  }
}

export class SubordinateAgent extends ProductionFacet {
  constructor(ctx, env) {
    super(ctx, env);
    for (const name of ['seed', 'readState']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...SUBORDINATE_AGENT_BOOT_SURFACE, 'seed', 'readState']);
  }
  async seed(input) {
    const result = await this.setSubordinateIdentity(input);
    return 'reason' in result ? result : { ...result, name: this.actorHandle().name, home: this.facetHome().home };
  }
  readState() { return { name: this.actorHandle().name, key: this.actorHandle().storageKey, actor: actorReferenceOf(this.actorHandle()) }; }
}

export class ActorIdentityController extends Agent {
  async legacy() {
    const root = this.env.OrchestratorAgent.get(this.env.OrchestratorAgent.idFromName('legacy'));
    const before = await root.seedLegacy();
    await getAgentByName(this.env.OrchestratorAgent, 'legacy');
    const response = await root.fetch(new Request('https://identity-probe/agents/orchestrator-agent/legacy/get-messages'));
    if (!response.ok) throw new Error(`Native activation failed with ${response.status}.`);
    const result = await root.probe();
    return { before, ...result };
  }
  async fresh() {
    const root = await getAgentByName(this.env.OrchestratorAgent, 'fresh');
    await root.claimOwner('owner');
    const first = await root.register('reader', 'first-creation');
    return first;
  }
  async lifecycle() {
    const root = await getAgentByName(this.env.OrchestratorAgent, 'lifecycle');
    await root.claimOwner('owner');
    return root.lifecycle();
  }
}
