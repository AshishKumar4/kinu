/**
 * `sealRpcSurface` as workerd enforces it, over a real DO stub: the seal shadows unlisted members as own
 * properties, callable in process and refused only on the wire. `unit-rpc-surface.test.ts` pins the rule;
 * this measures it against the runtime, peer-to-peer, with every hop outbound from `exercise()`.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import * as v from 'valibot';

// A root claims an owner and reaches `env.UserDO` for the device plane, so this worker binds the class.
export { UserDO } from '../../src/user/user-do';

export { UserSocketProbeDO } from './user-socket-probe';

type ActorEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

/** A rejection is the observation, so it is reported rather than thrown. */
export interface HopResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/** The sealed callee; `exercise()` runs on a different id, so every call crosses the wire. */
const SEALED = 'sealed-root';

/** Unique, so published frames are checked for its absence rather than a count. */
const SMUGGLED = 'kinu-probe-smuggled-frame';

/** A frame this workspace really publishes, so the absence above is in a live channel. */
const HEAD_ID = 'head-wire';

const DELTA = 'kinu-probe-narrow-delta';

async function hop<Answer>(call: () => Promise<Answer>): Promise<HopResult> {
  try {
    await call();

    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * The production root sealed with one additive fixture name; the name is deleted from the instance before
 * the seal runs, since the production constructor already sealed and a stale own property would shadow it.
 */
export class OrchestratorAgent extends ProductionOrchestrator {
  readonly published: string[] = [];

  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'exercise');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'exercise']);
  }

  override broadcast(message: string | ArrayBuffer | ArrayBufferView): void {
    const text = v.safeParse(v.string(), message);

    if (text.success) this.published.push(text.output);
  }

  async exercise(): Promise<{ hops: Record<string, HopResult>; published: string[] }> {
    // Made live before any hop, or every absence asserted over `published` would be vacuous.
    this.publishHeadStreamFrame({ headId: HEAD_ID, kind: 'reasoning', delta: DELTA });
    // The production binding and class type, as every cross-object caller uses; a different id, so hops are outbound.
    const target = await getAgentByName<ActorEnv, ProductionOrchestrator>(this.env.OrchestratorAgent, SEALED);

    // Expression bodies: `broadcast`/`setState` are `void`, so a block body drops the RPC promise and the
    // rejection escapes unhandled while the hop reports success.
    const hops = {
      // Positive control: a listed name the owner's UserDO really calls.
      claim: await hop(async () => target.claimOwner('owner')),
      // Listed and refused by the callee's own rule, proving it ran the callee's logic.
      second: await hop(async () => target.claimOwner('a-different-user')),
      // TypeScript accepts it: the seal is a runtime shadow the type system does not model.
      broadcast: await hop(async () => target.broadcast(SMUGGLED)),
      state: await hop(async () => target.setState(null)),
    };

    return { hops, published: this.published };
  }
}
