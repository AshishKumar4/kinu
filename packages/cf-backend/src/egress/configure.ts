/**
 * Configuring a container's egress — when it happens, and why not sooner.
 *
 * The Container base PERSISTS its outbound configuration into the Sandbox DO's
 * own storage and re-applies it from there via `refreshOutboundInterception()`
 * immediately before `container.start()`. Two consequences shape everything
 * here:
 *
 *   Configuration must land BEFORE the container starts, because that is when
 *   the interception is installed.
 *
 *   Configuration is once-per-CHANGE, not once-per-request. It survives DO
 *   eviction and container restart on its own, so a per-call preflight would
 *   be an RPC per exec buying nothing.
 *
 * Until it lands, the container has no network at all: `enableInternet = false`
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
  type SandboxHandle,
} from '@kinu/core';
import {
  CONTAINER_EVENT_HOST, EGRESS_HANDLER, EVENT_HANDLER, type KinuEgressParams,
} from './outbound';

/** The two Container base methods this needs. Narrow, so a test can supply a
 *  recorder and the wiring is checkable without a container. */
export interface OutboundConfigurable {
  setOutboundHandler(methodName: string, params: KinuEgressParams): Promise<void>;
  setOutboundByHost(hostname: string, methodName: string, params: KinuEgressParams): Promise<void>;
}

export interface EgressConfigurationInput {
  readonly workspaceName: string;
  readonly ownerUserId: string;
  /** The owner's whole vault, secret-free. */
  readonly vault: readonly EgressSecretBinding[];
  /** This workspace's standing approval grants. */
  readonly grants: readonly ApprovalGrant[];
}

/**
 * Bind both handlers to this container, with the bindings this workspace has
 * actually been granted.
 *
 * The event host is bound FIRST. Per-host handlers take precedence over the
 * catch-all, so binding the catch-all first would leave a window in which a
 * container event went to the egress handler, found no placeholder in it, and
 * was forwarded to a `.internal` name that resolves nowhere. Nothing leaks
 * either way; this just removes a confusing transient failure.
 */
export async function configureContainerEgress(
  sandbox: OutboundConfigurable,
  input: EgressConfigurationInput,
): Promise<KinuEgressParams> {
  const params: KinuEgressParams = {
    workspaceName: input.workspaceName,
    ownerUserId: input.ownerUserId,
    // A vault binding with no matching grant is not passed to the handler at
    // all, so the container never learns its placeholder and cannot try to
    // spend it. Consent gates VISIBILITY here, not just substitution.
    bindings: grantedEgressBindings(input.vault, input.grants),
  };
  await sandbox.setOutboundByHost(CONTAINER_EVENT_HOST, EVENT_HANDLER, params);
  await sandbox.setOutboundHandler(EGRESS_HANDLER, params);
  return params;
}

/**
 * Wrap a sandbox handle so the first operation on it configures egress, and
 * waits for that to finish.
 *
 * Memoized on the promise, not a boolean: two concurrent first operations must
 * both wait for the same configuration rather than one of them racing past a
 * flag that was set before the work completed. A failure is not cached — the
 * next operation retries — because a container left unconfigured has no
 * network, and permanently latching that would be the same defect as the
 * restore flag that marked a container restored before reading what to
 * restore.
 */
export function withConfiguredEgress(
  handle: SandboxHandle,
  configure: () => Promise<void>,
): SandboxHandle {
  let inFlight: Promise<void> | null = null;
  const configured = async (): Promise<void> => {
    if (inFlight === null) {
      const attempt = configure();
      inFlight = attempt;
      try {
        await attempt;
      } catch (error) {
        // Not cached: a container left unconfigured has no network at all, and
        // latching that permanently is the defect the restore flag had.
        inFlight = null;
        throw error;
      }
      return;
    }
    await inFlight;
  };
  const before = async <T>(fn: () => Promise<T>): Promise<T> => {
    await configured();
    return fn();
  };
  // Spread first, then override. Every method that can cause the container to
  // RUN gets the preflight; anything else on the handle passes through
  // untouched, so this wrapper does not have to be edited each time the
  // handle's shape changes.
  return {
    ...handle,
    exec: (command, opts) => before(() => handle.exec(command, opts)),
    readFile: (path, opts) => before(() => handle.readFile(path, opts)),
    writeFile: (path, content, opts) => before(() => handle.writeFile(path, content, opts)),
    listFiles: (path, opts) => before(() => handle.listFiles(path, opts)),
    deleteFile: (path) => before(() => handle.deleteFile(path)),
    exposePort: (port, opts) => before(() => handle.exposePort(port, opts)),
    unexposePort: (port) => before(() => Promise.resolve(handle.unexposePort(port))),
    getExposedPorts: (hostname) => before(() => handle.getExposedPorts(hostname)),
  };
}
