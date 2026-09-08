import { Agent, getAgentByName } from 'agents';
import { Think } from '@cloudflare/think';

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

export default {
  async fetch(request, env) {
    const root = await getAgentByName(env.FacetReadRoot, 'local-read-probe');
    return Response.json(await root.exercise(new URL(request.url).pathname.slice(1)));
  },
};
