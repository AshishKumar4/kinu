/**
 * `KinuSandbox` presented as core's `SandboxHandle`. No `timeout` means no work deadline, so such
 * commands run on the process lane (plain `exec` is bounded by the container and the request path),
 * and an abort kills the process, not just the wait. See `SandboxHandle.exec`.
 */

import { getSandbox, type Process, type SandboxOptions } from "@cloudflare/sandbox";
import { decodeJsonValue, SANDBOX_TRANSPORT, WORKSPACE_BACKUP_DIR, type SandboxHandle } from "@kinu.run/core";
import { diagnostics, KinuError, toKinuError } from "@kinu.run/core/obs";
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

/** `waitForExit`'s log stream idles out on a silent live process, so look again until it exits. */
async function observeExit(handle: KinuSandbox, started: Process): Promise<number> {
  let exitCode = started.exitCode;

  while (exitCode === undefined) {
    try {
      exitCode = (await started.waitForExit()).exitCode;
    } catch (cause) {
      const status = await started.getStatus();

      if (status === "starting" || status === "running") continue;
      const settled = await handle.getProcess(started.id);

      if (settled?.exitCode === undefined) {
        throw new Error(`sandbox process ${started.id} ended without an exit code`, { cause });
      }

      exitCode = settled.exitCode;
    }
  }

  return exitCode;
}

/**
 * No work deadline: a background process awaited to exit. An abort kills it by id and waits for the
 * exit code; a failed kill is reported, never `cancelled`, since the process is still running.
 */
async function execWithoutDeadline(
  handle: KinuSandbox,
  command: string,
  cwd?: string,
  signal?: AbortSignal,
) {
  const started = await handle.startProcess(command, { cwd: cwd ?? WORKSPACE_BACKUP_DIR });
  const observed = observeExit(handle, started);
  let cancelling = false;
  // Settles only on abort: resolved means killed, rejected means still running. A turn's signal is
  // shared; each exec kills only its own process.
  const { promise: killed, resolve, reject } = Promise.withResolvers<void>();

  const kill = (): void => {
    cancelling = true;
    void handle.killProcess(started.id).then(resolve, reject);
  };

  if (signal?.aborted === true) kill();
  else signal?.addEventListener("abort", kill, { once: true });

  try {
    const exitCode = await Promise.race([observed, killed.then(() => observed)]);

    // The race resolves only through `observed`, so the process is gone.
    if (cancelling) {
      throw new DOMException(
        `sandbox exec cancelled — container process ${started.id} was killed`,
        "AbortError",
      );
    }

    const logs = await handle.getProcessLogs(started.id);

    return { stdout: logs.stdout, stderr: logs.stderr, exitCode };
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

    if (readiness.kind === 'pending') throw new KinuError('unavailable', readiness.reason);

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
    // Absent timeout: the process lane, the only lane an abort can kill.
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

      return await onContainer(() => jsonResultOrVoid(handle.unexposePort(port)));
    },
    // Re-publishing keeps long-lived previews from ageing out. A failed refresh is reported and the
    // listing stands: the record is already correct, unlike an unpublished URL in `exposePort`.
    getExposedPorts: async (hostname) => {
      const rows = await onContainer(() => handle.getExposedPorts(hostname));

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
