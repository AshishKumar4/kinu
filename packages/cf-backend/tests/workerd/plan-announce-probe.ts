/**
 * `sealRpcSurface` as WORKERD enforces it, over a real Durable Object stub.
 *
 * WHY A REAL STUB HOP. The seal shadows an unlisted member as an OWN property,
 * which leaves it callable IN PROCESS and unresolvable only over a stub. So a
 * producer that reaches the inherited `broadcast` instead of a listed name is
 * green in every in-process fixture and refused only on the wire. No producer
 * in the tree makes that hop: there is no facet class, and
 * `'announceSubordinatePlan'` is absent from `ORCHESTRATOR_METHODS` and has no
 * caller, so it is unreachable over a stub and the feature's fate is a scope
 * call above this file.
 *
 * THE MECHANISM is what this measures, and it carries the whole weight.
 * A hosted actor is not addressable over a stub at all, so this allowlist is
 * the whole of what stands between a stub-holder — the owner's UserDO, a peer
 * workspace, the container's own object, the preview edge, the CLI transport —
 * and every internal on the root's prototype chain. `unit-rpc-surface.test.ts`
 * states workerd's resolution rule on the suite's own side and pins
 * `sealRpcSurface` against that statement from both directions; what neither
 * can do is check the statement against the RUNTIME. That is this file: one
 * Durable Object calling another, so the rule is measured rather than asserted.
 *
 * THE CALLER IS THE OBJECT UNDER TEST'S PEER, not a facet — a second instance
 * of the same production class, which is the shape a cross-workspace call
 * (`receivePeerMessage`, `rawCopyFromFork`) really has. Every hop is made
 * OUTBOUND from `exercise()`, so nothing re-enters the object that is awaiting.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ORCHESTRATOR_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import * as v from 'valibot';
// The owner's own Durable Object. A production root claims an owner before it
// registers any actor, and building its runtime reaches `env.UserDO` for the
// device plane — so the class this worker binds has to be here.
export { UserDO } from '../../src/user/user-do';
export { UserSocketProbeDO } from './user-socket-probe';

type ActorEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

/** What one hop across the stub did. A rejection is the observation, not a
 *  failure of the probe, so it is reported rather than thrown. */
export interface HopResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/** The Durable Object id of the SEALED root — the callee every hop below
 *  addresses. `exercise()` runs on a different id, so the two are genuinely
 *  two objects and every call crosses the wire. */
const SEALED = 'sealed-root';

/** The payload the generic client channel would have carried. Unique, so the
 *  published frames can be checked for its ABSENCE rather than for a count. */
const SMUGGLED = 'kinu-probe-smuggled-frame';

/** The head id and delta the narrow, listed twin carries — a frame this
 *  workspace really publishes, which is what makes the absence above an
 *  absence in a LIVE channel rather than in a silent one. */
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
 * The production root, sealed with the production surface plus the one fixture
 * name.
 *
 * Additive only: `broadcast` and `setState` stay absent from the allowlist and
 * so stay shadowed, and `claimOwner`/`publishHeadStream` are listed by
 * production rather than by this file, so no name under test is affected by the
 * extension. The fixture name is deleted from the instance before the seal
 * runs, because the production constructor has already sealed once and a stale
 * own property would shadow the method this file just declared.
 */
export class OrchestratorAgent extends ProductionOrchestrator {
  readonly published: string[] = [];

  constructor(ctx: AgentContext, env: ActorEnv) {
    super(ctx, env);
    Reflect.deleteProperty(this, 'exercise');
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, 'exercise']);
  }

  /** In-process capture of what reached this workspace's own clients. The text
   *  frames are the ones this probe reads back; the binary ones are a different
   *  representation, not a smaller version of the same one, so the string is
   *  parsed out rather than narrowed to. */
  override broadcast(message: string | ArrayBuffer | ArrayBufferView): void {
    const text = v.safeParse(v.string(), message);
    if (text.success) this.published.push(text.output);
  }

  async exercise(): Promise<{ hops: Record<string, HopResult>; published: string[] }> {
    // The channel this object's own clients read, made LIVE before any hop —
    // in process, through the same narrow name a stub is about to be refused
    // for. Without it `published` would be an empty list and every absence
    // asserted over it would hold for a capture that never worked.
    this.publishHeadStreamFrame({ headId: HEAD_ID, kind: 'reasoning', delta: DELTA });
    // `getAgentByName` over the production `OrchestratorAgent` binding is what
    // every cross-object caller in this Worker uses, so the stub under test is
    // the stub production holds — and the target is typed as the PRODUCTION
    // class, never this subclass, because the binding is declared over that
    // class and a probe that retyped it would be measuring its own fixture.
    // A DIFFERENT id, so this is one object calling another, and every hop is
    // outbound so nothing re-enters the object that is awaiting.
    const target = await getAgentByName<ActorEnv, ProductionOrchestrator>(this.env.OrchestratorAgent, SEALED);
    // EXPRESSION BODIES, never a statement block, and the difference is the
    // whole instrument: `broadcast` and `setState` are declared `void`, so a
    // block body drops the RPC promise the stub actually returns and the
    // rejection escapes as an unhandled one while the hop reports success. An
    // async arrow that RETURNS the call adopts that promise, which is what
    // makes a refusal observable here at all.
    const hops = {
      // A listed name, and a real one: the owner's UserDO claims a workspace
      // over exactly this hop. The positive control — without it every
      // rejection below could be a stub that never worked at all.
      claim: await hop(async () => target.claimOwner('owner')),
      // Listed, reached, and REFUSED by the object's own rule: a claim never
      // changes hands, so a second user claiming throws. Reachable is not the
      // same as trusted, and the distinct error is what proves the listed name
      // ran the callee's logic rather than merely resolving on its prototype.
      second: await hop(async () => target.claimOwner('a-different-user')),
      // The unlisted inherited member a producer reaches for by accident.
      // TypeScript accepts it — the stub type is derived from the class and the
      // seal is a runtime shadow the type system does not model — so nothing
      // upstream of this hop can refuse it.
      broadcast: await hop(async () => target.broadcast(SMUGGLED)),
      // The SDK's state writer, the other inherited member worth stealing: a
      // stub-holder that reached it would rewrite the callee's own state.
      state: await hop(async () => target.setState(null)),
    };
    return { hops, published: this.published };
  }
}
