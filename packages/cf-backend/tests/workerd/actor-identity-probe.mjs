import { Agent, getAgentByName } from 'agents';
import { OrchestratorAgent as ProductionRoot } from '../../src/orchestrator';
import { SubordinateAgent as ProductionFacet } from '../../src/subordinate-agent';
import { sealRpcSurface, ORCHESTRATOR_RPC_SURFACE, SUBORDINATE_AGENT_BOOT_SURFACE } from '../../src/rpc-surface';
import { actorReferenceOf } from '@kinu.run/core';
import { refusalOf, toKinuError } from '@kinu.run/core/obs';
export { UserDO } from '../../src/user/user-do';

async function refused(operation) {
  try { await operation(); return { unexpected: 'success' }; }
  catch (cause) { return refusalOf(toKinuError({ doing: 'running the native identity probe', cause, otherwise: 'io' })); }
}

export class OrchestratorAgent extends ProductionRoot {
  constructor(ctx, env) {
    super(ctx, env);
    for (const name of ['register', 'lifecycle']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'register', 'lifecycle']);
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
