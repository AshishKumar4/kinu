import { Agent } from 'agents';
import { Think } from '@cloudflare/think';
import { SubordinateAgent as ProductionSubordinate } from '../../src/subordinate-agent';
import { sealRpcSurface, SUBORDINATE_RPC_SURFACE } from '../../src/rpc-surface';
import { SubordinateIdentityStore, RunEventRecorder } from '@kinu.run/core';
import { bindAgentSql } from '../../src/runtime';

export class FacetReadChild extends Think {
  onStart() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe_lifecycle (kind TEXT PRIMARY KEY, value INTEGER)');
    this.ctx.storage.sql.exec("INSERT INTO probe_lifecycle VALUES ('starts', 1) ON CONFLICT(kind) DO UPDATE SET value=value+1");
  }
  async seed() {
    await this.ctx.storage.put('probe_marker', 'retained');
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO cf_agents_runs(id,name,snapshot,created_at) VALUES ('owed','owed-recovery','{}',?)", Date.now());
    return this.read();
  }
  async read() {
    const marker = await this.ctx.storage.get('probe_marker');
    if (marker === undefined) return { kind: 'missing-history' };
    const state = this.ctx.storage.sql.exec('SELECT kind,value FROM probe_lifecycle ORDER BY kind').toArray();
    return { kind: 'retained', marker, state, owed: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM cf_agents_runs WHERE id='owed'").one().n };
  }
  async onFiberRecovered(context) {
    this.ctx.storage.sql.exec("INSERT INTO probe_lifecycle VALUES ('recovered', 1) ON CONFLICT(kind) DO UPDATE SET value=value+1");
    return { status: 'completed', snapshot: context.snapshot };
  }
  async seedNested() { return (await this.subAgent(FacetReadChild, 'grandchild')).seed(); }
  async readNested() { return (await this.getExistingSubAgent(FacetReadChild, 'grandchild'))?.read(); }
  async recoverNested() { return (await this.subAgent(FacetReadChild, 'grandchild')).read(); }
}

export class FacetReadRoot extends Agent {
  async exercise(operation) {
    if (operation === 'missing') return { present: (await this.getExistingSubAgent(FacetReadChild, 'absent')) !== null, registry: this.listSubAgents().length };
    if (operation === 'seed') return (await this.subAgent(FacetReadChild, 'child')).seed();
    if (operation === 'abort') { this.abortSubAgent(FacetReadChild, 'child', 'local cold-read probe'); return { aborted: true }; }
    if (operation === 'raw') return (await this.getExistingSubAgent(FacetReadChild, 'child'))?.read();
    if (operation === 'normal') return (await this.subAgent(FacetReadChild, 'child')).read();
    if (operation === 'nested-seed') return (await this.subAgent(FacetReadChild, 'child')).seedNested();
    if (operation === 'nested-raw') return (await this.getExistingSubAgent(FacetReadChild, 'child'))?.readNested();
    if (operation === 'nested-normal') return (await this.subAgent(FacetReadChild, 'child')).recoverNested();
    if (operation === 'wipe') { this.ctx.facets.delete(`${FacetReadChild.name}\0child`); return { wiped: true }; }
    throw new Error('Invalid probe operation');
  }
}

/** Only fixture setup and observation methods extend the production native seal. */
export class SubordinateAgent extends ProductionSubordinate {
  constructor(ctx, env) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'seedArchive');
    Reflect.deleteProperty(this, 'counts');
    sealRpcSurface(this, [...SUBORDINATE_RPC_SURFACE, 'seedArchive', 'counts']);
  }
  seedArchive() {
    const identity = new SubordinateIdentityStore(this.ctx.storage.sql);
    identity.seed({ name: 'child', mission: 'read only', parentWorkspace: 'workspace', ownerUserId: 'owner', depth: 1, lifetime: 'task' });
    const events = new RunEventRecorder(bindAgentSql(this));
    events.emit('retained-run', { type: 'run_start', agentId: 'child' });
    events.emit('retained-run', { type: 'tool_call_end', name: 'agents', toolCallId: 'nested-ask', args: { action: 'ask', role: 'general' }, outcome: { success: true } });
    return this.counts();
  }
  counts() {
    return {
      events: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM run_events').one().n,
      fibers: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM cf_agents_runs').one().n,
      callable: this.getCallableMethods().has('inspectSubordinateStorage'),
    };
  }
}
export class OrchestratorAgent extends Agent {
  async exercise(operation) {
    if (operation === 'seed') return (await this.subAgent(SubordinateAgent, 'child')).seedArchive();
    if (operation === 'abort') { this.abortSubAgent(SubordinateAgent, 'child', 'cold production probe'); return { aborted: true }; }
    const child = await this.getExistingSubAgent(SubordinateAgent, 'child');
    if (!child) throw new Error('Missing registered child');
    if (operation === 'inspect') return child.inspectSubordinateStorage({ path: ['child'], view: 'events', runId: 'retained-run', query: { limit: 1 } }, { owner: 'owner', workspace: 'workspace', traversed: ['child'] });
    if (operation === 'counts') return child.counts();
    throw new Error('Invalid operation');
  }
}
