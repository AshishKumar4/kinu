/**
 * `KinuDevbox` presented as core's `SandboxHandle`. No `timeout` means no work deadline, so such
 * commands run on the runtime's own exec (plain `exec` is bounded by the container and the request path),
 * and an abort kills the process, not just the wait. See `SandboxHandle.exec`.
 */

import { jsonResultOrVoid, SandboxPending, WORKSPACE_BACKUP_DIR, type SandboxHandle } from '@kinu.run/core';
import { classifyErrorCode, diagnostics, KinuError, renderThrownChain, settle, toKinuError, type ErrorCode } from "@kinu.run/core/obs";
import { devboxFailure, type DevboxErrorCode } from '@kinu.run/devbox';
import { Effect } from 'effect';
import type { KinuDevbox } from "./kinu-devbox";
import { sandboxPreviewLabelOf } from "@kinu.run/core";
import type { SandboxPreviewExposures } from "@kinu.run/core";

type ContainerOperations = Pick<KinuDevbox,
  "execUntimed" | "killUntimed" | "resolveReadiness" | "readFile" | "writeFile" | "listFiles"
  | "deleteFile" | "exposePort" | "getExposedPorts" | "unexposePort" | "startSupervised"
  | "stopSupervised" | "listSupervised" | "portToken" | "notePortRemoved">;

/** Without AUTH_KV the edge cannot verify a preview hostname, so a minted URL would be dead. */
const PREVIEWS_UNPUBLISHABLE =
  'Port exposure is unavailable: this deployment has no AUTH_KV binding, so a '
  + 'preview URL could not be published for the edge to verify.';

const DEVBOX_FAILURE_CODES: Readonly<Record<DevboxErrorCode, ErrorCode>> = {
  io: 'io', configuration: 'unavailable', 'invalid-input': 'bad_input', 'not-ready': 'unavailable',
  cancelled: 'cancelled', missing: 'missing', file: 'io', process: 'io',
  'start-overrun': 'timeout', 'start-interrupted': 'unavailable', 'container-changed': 'unavailable',
  'layer-unreadable': 'io', 'chain-advanced': 'io', 'delta-namespace': 'io', 'mount-marker': 'unsupported',
};

/** The one conversion from the standalone library's failures to the application's channel. An
 *  unclassified failure, a transport one included, is `io`: `unavailable` is a verdict
 *  `withSandboxRetry` never re-enters, and the text keeps its transient marker. */
function fromDevbox(thrown: { readonly cause: unknown }): KinuError {
  const { cause } = thrown;

  if (cause instanceof KinuError) return cause;
  const failure = devboxFailure(thrown);

  return failure === undefined
    ? new KinuError(classifyErrorCode(thrown) ?? 'io', renderThrownChain(thrown), { cause })
    : new KinuError(DEVBOX_FAILURE_CODES[failure.code], failure.message, { cause });
}

function callDevbox<A>(run: () => PromiseLike<A>): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({ try: run, catch: (cause) => fromDevbox({ cause }) });
}

/**
 * No work deadline: the command on the container runtime's own exec (`Devbox.execUntimed`), which returns its
 * output whole. An abort ends its process tree and reports once it is gone; a refused kill is reported as itself,
 * since the process is still running, and a command that finished first is returned as finished.
 */
async function execWithoutDeadline(
  handle: Pick<KinuDevbox, "execUntimed" | "killUntimed">,
  command: string,
  cwd?: string,
  signal?: AbortSignal,
) {
  const execId = crypto.randomUUID();
  const ran = handle.execUntimed(command, { cwd: cwd ?? WORKSPACE_BACKUP_DIR, execId });
  // Set only on abort: true means this call ended the process tree, false that the command had already exited.
  let verdict: Promise<boolean> | undefined;
  const { promise: killRefused, reject } = Promise.withResolvers<never>();

  const kill = (): void => {
    verdict = handle.killUntimed(execId);
    verdict.catch(reject);
  };

  if (signal?.aborted === true) kill();
  else signal?.addEventListener("abort", kill, { once: true });

  try {
    const result = await Promise.race([ran, killRefused]);

    if (verdict !== undefined && await verdict) {
      throw new DOMException(`sandbox exec cancelled: its container process tree was ended (exec ${execId})`, "AbortError");
    }

    return result;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

/** No conflict queue here: `Devbox` serializes resource conflicts for every caller of the container. */

/**
 * Every container-touching method goes through `onContainer`: egress first (until bound the
 * container has no network, so it fails closed), then attach (pre-attach reads/writes hit a blank disk
 * that the overlay hides). Methods writing only this DO's rows skip it.
 */
export function adaptCloudflareSandbox(
  handle: ContainerOperations,
  configureEgress: () => Promise<void>,
  previews: SandboxPreviewExposures | null,
  portsMoved?: () => void,
): SandboxHandle {
  // Memoized on the promise so concurrent first calls share it; failures are not cached.
  let inFlight: Promise<void> | null = null;

  const configured = async (): Promise<void> => {
    if (inFlight !== null) return await inFlight;
    const attempt = configureEgress();
    inFlight = attempt;

    try {
      await attempt;
    } catch (error) {
      inFlight = null;
      throw error;
    }
  };

  const onContainer = <T>(run: () => Promise<T>): Effect.Effect<T, KinuError> => Effect.tryPromise({
    try: async () => {
      await configured();
      const readiness = await handle.resolveReadiness();

      if (readiness.kind === 'pending') throw new SandboxPending(readiness.reason);

      return await run();
    },
    catch: (cause) => fromDevbox({ cause }),
  });


  return {
    ensureReady: () => settle(onContainer(() => Promise.resolve())),
    exec: (command, opts) => settle(onContainer(() => {
      const signals = [opts?.signal, opts?.timeout === undefined ? undefined : AbortSignal.timeout(opts.timeout)].filter((held) => held !== undefined);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      return execWithoutDeadline(handle, command, opts?.cwd, signal);
    })),
    readFile: (path, opts) => settle(onContainer(() => handle.readFile(path, opts))),
    writeFile: (path, content, opts) =>
      settle(onContainer(() => jsonResultOrVoid(handle.writeFile(path, content, opts)))),
    listFiles: (path, opts) => settle(onContainer(() => handle.listFiles(path, opts))),
    deleteFile: (path) => settle(onContainer(() => jsonResultOrVoid(handle.deleteFile(path)))),
    // Published first: the edge verifies preview hostnames against the record (`preview-proxy.ts`).
    // Then `servePreviewRequest`'s gates run here, without forwarding.
    exposePort: (port, opts) => settle(Effect.gen(function* () {
      if (previews === null) return yield* Effect.fail(new KinuError('unavailable', PREVIEWS_UNPUBLISHABLE));
      const exposed = yield* onContainer(() => handle.exposePort(port, opts));
      const label = yield* Effect.try({ try: () => sandboxPreviewLabelOf(new URL(exposed.url), { PREVIEW_HOST_SUFFIX: opts.hostname }), catch: (cause) => fromDevbox({ cause }) });

      if (label === null || label.port !== port) return yield* Effect.fail(new KinuError('io', `the container minted a preview URL this deployment cannot publish: ${exposed.url}`));
      yield* callDevbox(() => previews.publish(port, label.token));
      portsMoved?.();

      if (!(yield* callDevbox(() => previews.exposed(port, label.token)))) {
        return { ...exposed, route: { reached: false, gate: 'published' as const, detail: 'the edge holds no published record for this URL' } };
      }

      const live = yield* onContainer(() => handle.getExposedPorts(opts.hostname));

      return live.some(row => row.port === port && row.url === exposed.url)
        ? { ...exposed, route: { reached: true } }
        : { ...exposed, route: { reached: false, gate: 'exposed' as const, detail: `the container holds no live exposure of port ${port} for this URL` } };
    })),
    // Withdraw first: a revoked port the edge still admits is unsafe.
    unexposePort: (port) => settle(Effect.gen(function* () {
      if (previews !== null) yield* callDevbox(() => previews.withdraw(port));
      const removed = yield* onContainer(() => jsonResultOrVoid(handle.unexposePort(port)));
      portsMoved?.();

      return removed;
    })),
    // Re-publishing keeps long-lived previews from ageing out. A failed refresh is reported and the
    // listing stands: the record is already correct, unlike an unpublished URL in `exposePort`.
    // Not `onContainer`: a read never starts a container.
    getExposedPorts: (hostname) => settle(callDevbox(async () => {
      const rows = await handle.getExposedPorts(hostname);

      if (previews !== null) {
        const index = previews;
        await Promise.all(rows.map(async (row) => {
          const label = sandboxPreviewLabelOf(new URL(row.url), { PREVIEW_HOST_SUFFIX: hostname });

          if (label === null || label.port !== row.port) return;

          try {
            await index.refresh(row.port, label.token);
          } catch (cause) {
            diagnostics.failure('preview.refresh_failed', toKinuError({
              doing: 'refreshing a published sandbox preview',
              cause,
              otherwise: 'unavailable',
            }), { port: row.port });
          }
        }));
      }

      return rows;
    })),
    startSupervisedProcess: (command, opts) =>
      settle(onContainer(() => handle.startSupervised(command, opts?.cwd))),
    stopSupervisedProcess: (processId) => settle(onContainer(() => handle.stopSupervised(processId))),
    listSupervisedProcesses: () => settle(onContainer(async () =>
      (await handle.listSupervised()).map(row => ({
        processId: row.processId, pid: row.pid, status: row.status,
        command: row.command, restartable: row.restartable,
      })))),
    // DO rows only: no egress, no attach wait, since the token must be mintable before its exposure.
    portToken: (port, name) => settle(callDevbox(() => handle.portToken(port, name))),
    notePortRemoved: (port) => settle(callDevbox(async () => {
      await previews?.withdraw(port);
      await handle.notePortRemoved(port);
    })),
  };
}
