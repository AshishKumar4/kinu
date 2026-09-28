/**
 * `KinuSandbox` presented as core's `SandboxHandle`. No `timeout` means no work deadline, so such
 * commands run on the runtime's own exec (plain `exec` is bounded by the container and the request path),
 * and an abort kills the process, not just the wait. See `SandboxHandle.exec`.
 */

import { getSandbox, type SandboxOptions } from "@cloudflare/sandbox";
import { decodeJsonValue, SANDBOX_TRANSPORT, SandboxPending, WORKSPACE_BACKUP_DIR, type SandboxHandle } from "@kinu.run/core";
import { diagnostics, toKinuError } from "@kinu.run/core/obs";
import type { KinuSandbox } from "./kinu-sandbox";
import { sandboxPreviewLabelOf } from "@kinu.run/core";
import type { SandboxPreviewExposures } from "@kinu.run/core";

/**
 * The one way product code reaches a sandbox. The SDK persists the transport a sandbox was first reached over
 * and drops the in-flight requests of a client that names another, so the transport is fixed here and never
 * a caller's to choose. The route-based clients cannot restore a large workspace (`sandbox.route_client.restore_bytes`).
 */
export function openSandbox(
  namespace: DurableObjectNamespace<KinuSandbox>,
  id: string,
  options: Omit<SandboxOptions, 'transport'>,
): KinuSandbox {
  return getSandbox(namespace, id, { ...options, transport: SANDBOX_TRANSPORT });
}

/** Without AUTH_KV the edge cannot verify a preview hostname, so a minted URL would be dead. */
const PREVIEWS_UNPUBLISHABLE =
  'Port exposure is unavailable: this deployment has no AUTH_KV binding, so a '
  + 'preview URL could not be published for the edge to verify.';

/**
 * capnweb re-materializes unknown error names as plain `Error`, leaving the SDK kind only as the
 * message's leading token; restore `name` and `errorResponse.code` from it, file errors only.
 */
const RPC_SDK_FILE_CODE = new Map<string, string>([
  ["FileNotFoundError", "FILE_NOT_FOUND"],
  ["FileExistsError", "FILE_EXISTS"],
  ["FileTooLargeError", "FILE_TOO_LARGE"],
  ["PermissionDeniedError", "PERMISSION_DENIED"],
  ["FileSystemError", "FILESYSTEM_ERROR"],
  ["ValidationFailedError", "VALIDATION_FAILED"],
]);

function restoreSandboxFileError(cause: Error, path: string): Error {
  if (cause.name !== "Error") return cause;

  const sdkName = /^([A-Za-z_$][\w$]*Error): /.exec(cause.message)?.[1];

  if (sdkName === undefined) return cause;

  const code = RPC_SDK_FILE_CODE.get(sdkName);

  if (code === undefined) return cause;

  const restored = new Error(cause.message);
  restored.name = sdkName;
  restored.cause = cause;
  Object.defineProperty(restored, "errorResponse", {
    value: { code, context: { path } },
    enumerable: true,
  });

  return restored;
}

async function jsonResultOrVoid<Result>(result: Promise<Result>) {
  const value = await result;

  return value === undefined ? undefined : decodeJsonValue({ value });
}

/**
 * No work deadline: the command on the container runtime's own exec (`Devbox.execUntimed`), which returns its
 * output whole. An abort ends its process tree and reports once it is gone; a refused kill is reported as itself,
 * since the process is still running, and a command that finished first is returned as finished.
 */
async function execWithoutDeadline(
  handle: KinuSandbox,
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
  handle: KinuSandbox,
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

  const onContainer = async <T>(run: () => Promise<T>): Promise<T> => {
    await configured();
    // Readiness arrives as data: a thrown refusal's name does not survive the DO RPC.
    const readiness = await handle.resolveReadiness();

    if (readiness.kind === 'pending') throw new SandboxPending(readiness.reason);

    return await run();
  };

  const onFile = async <T>(path: string, run: () => Promise<T>): Promise<T> =>
    onContainer(async () => {
      try {
        return await run();
      } catch (cause) {
        if (!(cause instanceof Error)) throw cause;

        throw restoreSandboxFileError(cause, path);
      }
    });

  return {
    ensureReady: () => onContainer(() => Promise.resolve()),
    // Absent timeout: the runtime's exec, the only lane an abort can kill.
    exec: (command, opts) => onContainer(() => (opts?.timeout === undefined
      ? execWithoutDeadline(handle, command, opts?.cwd, opts?.signal)
      : handle.exec(command, opts))),
    readFile: (path, opts) => onFile(path, () => handle.readFile(path, opts)),
    writeFile: (path, content, opts) =>
      onFile(path, () => jsonResultOrVoid(handle.writeFile(path, content, opts))),
    listFiles: (path, opts) => onFile(path, () => handle.listFiles(path, opts)),
    deleteFile: (path) => onFile(path, () => jsonResultOrVoid(handle.deleteFile(path))),
    // Published first: the edge verifies preview hostnames against the record (`preview-proxy.ts`).
    // Then `servePreviewRequest`'s gates run here, without forwarding.
    exposePort: async (port, opts) => {
      if (previews === null) throw new Error(PREVIEWS_UNPUBLISHABLE);
      const exposed = await onContainer(() => handle.exposePort(port, opts));
      const label = sandboxPreviewLabelOf(new URL(exposed.url), { PREVIEW_HOST_SUFFIX: opts.hostname });

      if (label === null || label.port !== port) {
        throw new Error(`the SDK minted a preview URL this deployment cannot publish: ${exposed.url}`);
      }

      await previews.publish(port, label.token);
      portsMoved?.();

      if (!await previews.exposed(port, label.token)) {
        return { ...exposed, route: { reached: false, gate: 'published', detail: 'the edge holds no published record for this URL' } };
      }

      const live = await onContainer(() => handle.getExposedPorts(opts.hostname));

      return live.some((row) => row.port === port && row.url === exposed.url)
        ? { ...exposed, route: { reached: true } }
        : { ...exposed, route: { reached: false, gate: 'exposed', detail: `the container holds no live exposure of port ${port} for this URL` } };
    },
    // Withdrawn first: a live unreachable port is safe; a revoked port the edge still admits is not.
    unexposePort: async (port) => {
      await previews?.withdraw(port);
      const removed = await onContainer(() => jsonResultOrVoid(handle.unexposePort(port)));
      portsMoved?.();

      return removed;
    },
    // Re-publishing keeps long-lived previews from ageing out. A failed refresh is reported and the
    // listing stands: the record is already correct, unlike an unpublished URL in `exposePort`.
    // Not `onContainer`: a read never starts a container.
    getExposedPorts: async (hostname) => {
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
    },
    startSupervisedProcess: (command, opts) =>
      onContainer(() => handle.startSupervised(command, opts?.cwd)),
    stopSupervisedProcess: (processId) => onContainer(() => handle.stopSupervised(processId)),
    listSupervisedProcesses: () => onContainer(async () =>
      (await handle.listSupervised()).map(row => ({
        processId: row.processId, pid: row.pid, status: row.status,
        command: row.command, restartable: row.restartable,
      }))),
    // DO rows only: no egress, no attach wait, since the token must be mintable before its exposure.
    portToken: (port, name) => handle.portToken(port, name),
    notePortRemoved: async (port) => {
      await previews?.withdraw(port);
      await handle.notePortRemoved(port);
    },
  };
}
