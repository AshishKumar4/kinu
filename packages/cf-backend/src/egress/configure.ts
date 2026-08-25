/**
 * What a container's egress configuration is made of — and nothing about when
 * it is applied.
 *
 * APPLYING it belongs to `KinuSandbox.configureEgress`, which is the Durable
 * Object that owns the container and the only place the two handlers may be
 * bound in the one order that is safe. This module used to bind them too,
 * through a narrow `OutboundConfigurable` interface, and that second path is
 * what left the workspace name unpinned: the DO method wrote the name and
 * nothing called it, while the live path bound the handlers without it. Both
 * host hooks that need the name — telling the agent its container failed, and
 * asking the workspace whether background work still holds it — were dead as a
 * result. One writer now.
 *
 * WHEN it is applied belongs to the sandbox handle adapter
 * (`sandbox-exec-lane.ts`), which runs it before any operation that can make
 * the container start. Two facts shape that:
 *
 *   Configuration must land BEFORE the container starts, because the Container
 *   base re-applies its persisted outbound configuration immediately before
 *   `container.start()`, and that is when interception is installed.
 *
 *   Configuration is once-per-CHANGE, not once-per-request. It survives DO
 *   eviction and container restart on its own, so a per-call round trip would
 *   buy nothing.
 *
 * Until it lands the container has no network at all: `enableInternet = false`
 * with no handler registered means the platform denies everything, so the
 * window before configuration fails CLOSED rather than leaking an
 * unintercepted request. That is the property that makes lazy configuration
 * safe.
 *
 * WHY NOT `onStart`. It is the obvious home — it runs once per container start,
 * which is exactly the cadence — and it is wrong here. `gate:do-init` forbids
 * an `onStart` that is `async`, that awaits in its own scope, or that opens a
 * nested `blockConcurrencyWhile`, because the hook is held inside a
 * concurrency gate that every request on the object waits behind, and at 30
 * seconds workerd cancels the gate and RESETS the object. Configuring egress
 * needs a UserDO round trip. So the await belongs in the invocation that
 * needed the container, not in the hook that opened it.
 */

import {
  grantedEgressBindings,
  type ApprovalGrant,
  type EgressSecretBinding,
} from '@kinu.run/core';
import type { KinuEgressParams } from './outbound';

export interface EgressConfigurationInput {
  readonly workspaceName: string;
  readonly ownerUserId: string;
  /** The owner's whole vault, secret-free. */
  readonly vault: readonly EgressSecretBinding[];
  /** This workspace's standing approval grants. */
  readonly grants: readonly ApprovalGrant[];
}

/** What this workspace's container may be told, given what it has been granted. */
export function kinuEgressParams(input: EgressConfigurationInput): KinuEgressParams {
  return {
    workspaceName: input.workspaceName,
    ownerUserId: input.ownerUserId,
    // A vault binding with no matching grant is not passed to the handler at
    // all, so the container never learns its placeholder and cannot try to
    // spend it. Consent gates VISIBILITY here, not just substitution.
    bindings: grantedEgressBindings(input.vault, input.grants),
  };
}
