import { Agent, type AgentContext } from 'agents';
import { SubordinateAgent } from '../../src/subordinate-agent';
import { sealRpcSurface, SUBORDINATE_RPC_SURFACE, EXPLORATION_RPC_SURFACE } from '../../src/rpc-surface';
import type { JsonValue, SlateReadModel } from '@kinu.run/core';
import * as v from 'valibot';
type ActorEnv = ConstructorParameters<typeof SubordinateAgent>[1];

/** Real actor constructor, dispatch and native RPC; only the final read model
 * is fixture data, so no model call or external service is needed. */
export class SlateSubordinateProbe extends SubordinateAgent {
  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    sealRpcSurface(this, SUBORDINATE_RPC_SURFACE);
  }

  protected override async slateReadModel(method: SlateReadModel): Promise<JsonValue> {
    return { answeredBy: 'facet', method, browserCallable: this.getCallableMethods().has('slateBindingDispatch') };
  }
}

export class SlateExplorationProbe extends SlateSubordinateProbe {
  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    sealRpcSurface(this, EXPLORATION_RPC_SURFACE);
  }
}

export class SlateFacetRootProbe extends Agent<ActorEnv> {
  async exercise(family: 'subordinate' | 'exploration') {
    const child = family === 'subordinate'
      ? await this.subAgent(SlateSubordinateProbe, 'subordinate')
      : await this.subAgent(SlateExplorationProbe, 'exploration');
    const value = await child.slateBindingDispatch([], { kind: 'rpc', method: 'getExecutors' });
    return v.parse(v.object({ answeredBy: v.string(), method: v.string(), browserCallable: v.boolean() }), value);
  }
}
