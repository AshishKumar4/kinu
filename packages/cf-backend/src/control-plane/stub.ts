/**
 * How the control plane is addressed. Separate from `control-plane-do.ts` so
 * ingest callers do not load `cloudflare:workers` and the DO graph; keep the class import type-only.
 */
import * as v from 'valibot';
import type { ControlPlaneDO } from './control-plane-do';
import type { ObjectNamespace } from '@kinu.run/core';

/** The only place the name is spelled; a second literal addresses a different object. */
const CONTROL_PLANE_SINGLETON = 'site';

/** Structural bindings so a module can type its env without editing the generated `Env`. */
export interface ControlPlaneEnv<Id = DurableObjectId, Stub = DurableObjectStub<ControlPlaneDO>> {
  ControlPlaneDO: ObjectNamespace<Id, Stub>;
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

export function controlPlaneStub<Id, Stub>(env: ControlPlaneEnv<Id, Stub>): Stub {
  return env.ControlPlaneDO.get(env.ControlPlaneDO.idFromName(CONTROL_PLANE_SINGLETON));
}

/**
 * Whether this environment has a control plane at all. Lets feeds tell "no
 * destination" (partial harness env) from "destination refused the write".
 */
export function hasControlPlane<Id, Stub>(
  env: Partial<ControlPlaneEnv<Id, Stub>>,
): env is ControlPlaneEnv<Id, Stub> {
  // Parse for the two methods callers use; a `typeof === 'object'` check defers failure to the first call.
  return v.is(NamespaceSchema, env.ControlPlaneDO);
}

const NamespaceSchema = v.object({
  idFromName: v.function(),
  get: v.function(),
});
