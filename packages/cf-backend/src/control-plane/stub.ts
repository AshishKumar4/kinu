/**
 * How the control plane is addressed.
 *
 * Its own module, and not a pair of exports on `control-plane-do.ts`, for a
 * reason that is structural rather than tidy: that file imports
 * `cloudflare:workers` and installs the analytics sink at module load, so any
 * caller that only needed to know WHICH object to talk to would drag a Durable
 * Object's whole graph in to learn a string. The ingest paths — feedback, the
 * index feed — are exactly those callers.
 *
 * The class reference here is `import type` only, so nothing in this module's
 * runtime graph reaches the Durable Object.
 */
import * as v from 'valibot';
import type { ControlPlaneDO } from './control-plane-do';

/** One instance, by name. Fleet state is not per-user or per-workspace, and this
 *  is the only place the name is spelled — a second literal is how two callers
 *  end up addressing two different objects. Module-private for the same reason:
 *  `controlPlaneStub` is how a caller reaches the object, so nobody outside needs
 *  the string. */
const CONTROL_PLANE_SINGLETON = 'site';

/** The bindings a control-plane caller needs, stated structurally so a module can
 *  type its own env against it without editing the generated `Env`. */
export interface ControlPlaneEnv {
  ControlPlaneDO: DurableObjectNamespace<ControlPlaneDO>;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

export function controlPlaneStub(env: ControlPlaneEnv): DurableObjectStub<ControlPlaneDO> {
  return env.ControlPlaneDO.get(env.ControlPlaneDO.idFromName(CONTROL_PLANE_SINGLETON));
}

/**
 * Whether this environment has a control plane to talk to at all.
 *
 * `Env` declares the binding as required, and both deployable environments bind
 * it, so in production this is always true. It exists for the difference that
 * matters to the FEEDS: "there is no destination" and "the destination refused
 * the write" are different facts, and only the second is worth reporting as a
 * failure. Without the distinction, every harness that builds a partial env —
 * and every local run against one — reports a lost index write on each workspace
 * it creates, which is noise that trains a reader to ignore the real one.
 */
export function hasControlPlane(env: Partial<ControlPlaneEnv>): env is ControlPlaneEnv {
  // Parsed, not `typeof`-narrowed: what makes this a namespace is that it
  // ADDRESSES objects, so the check is for the two methods every caller here
  // uses. A structural parse states that; a `typeof binding === 'object'` would
  // accept any object at all and defer the failure to the first call.
  return v.is(NamespaceSchema, env.ControlPlaneDO);
}

const NamespaceSchema = v.object({
  idFromName: v.function(),
  get: v.function(),
});
