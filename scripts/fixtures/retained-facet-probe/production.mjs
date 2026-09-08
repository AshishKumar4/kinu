import { Agent, getAgentByName } from 'agents';
import { SubordinateAgent as ProductionSubordinate } from '../../../packages/cf-backend/src/subordinate-agent';
import { sealRpcSurface, SUBORDINATE_RPC_SURFACE } from '../../../packages/cf-backend/src/rpc-surface';
import { SubordinateIdentityStore, RunEventRecorder } from '@kinu.run/core';
import { bindAgentSql } from '../../../packages/cf-backend/src/runtime';

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
export default {
  async fetch(request, env) {
    const root = await getAgentByName(env.OrchestratorAgent, 'workspace');
    return Response.json(await root.exercise(new URL(request.url).pathname.slice(1)));
  },
};
