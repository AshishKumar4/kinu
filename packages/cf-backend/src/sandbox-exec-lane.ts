/**
 * The container boundary: `KinuSandbox` (a Durable Object over the Cloudflare
 * sandbox SDK) presented as core's portable `SandboxHandle`.
 *
 * It lives beside `runtime.ts` rather than inside it because the one decision it
 * makes is worth reading — and worth testing — on its own: WHICH SDK LANE a
 * command runs on. `runtime.ts` reaches the Agents SDK at load, so nothing in it
 * can be exercised without a Durable Object; this module's only value import is
 * core's JSON decoder.
 *
 * ── The decision, and the incident that produced it ───────────────
 * `SandboxHandle.exec` says: no `timeout` means NO WORK DEADLINE. Honouring that
 * is not a matter of omitting a number, because the SDK's plain `exec` is
 * bounded twice over — the container enforces a command deadline, and the
 * request carrying it rides the non-streaming path, whose own ceiling is 120s.
 * The SDK's own git client is the proof: it raises `requestTimeoutMs` explicitly
 * for a long clone rather than trusting that default.
 *
 * Production evidence for why this matters (owner screenshot, workspace
 * my-ai-engineer-b3b8b792): a tee'd training script returned `CommandError: …
 * Command timeout after 60000ms`. The 60000 was ours — core sent it, and the
 * container echoed it back. A lane deadline outranks every detach window above
 * it, so the 300s one-shot window could never fire and long work was killed
 * where it should have been handed to a background job.
 */

import { decodeJsonValue, WORKSPACE_BACKUP_DIR, type SandboxHandle } from "@kinu.run/core";
import type { KinuSandbox } from "./kinu-sandbox";


async function jsonResultOrVoid<Result>(result: Promise<Result>) {
  const value = await result;
  return value === undefined ? undefined : decodeJsonValue({ value });
}

/**
 * Run a command with no work deadline: as a background process, awaited to exit.
 *
 * `startProcess` returns in one request and the process then belongs to the
 * container rather than to this call, so nothing here holds a wall clock over
 * it. What remains bounded is only the OBSERVATION — `waitForExit` reads the
 * process log stream, and that stream idles out after 300s of silence. A silent
 * long-running process trips it while perfectly alive, so the answer is to look
 * again: nothing was killed, and the process's own exit is the only thing that
 * ends the wait. Work that would rather be observed than awaited has
 * `sandbox.startProcess` and the `process_done` container event.
 */
async function execWithoutDeadline(handle: KinuSandbox, command: string, cwd?: string) {
  const started = await handle.startProcess(command, { cwd: cwd ?? WORKSPACE_BACKUP_DIR });
  let exitCode = started.exitCode;
  while (exitCode === undefined) {
    try {
      exitCode = (await started.waitForExit()).exitCode;
    } catch (cause) {
      const status = await started.getStatus();
      // A process that has not finished is observed again; anything else is
      // settled and its exit code is read from the store.
      if (status === 'starting' || status === 'running') continue;
      const settled = await handle.getProcess(started.id);
      if (settled?.exitCode === undefined) {
        throw new Error(`sandbox process ${started.id} ended without an exit code`, { cause });
      }
      exitCode = settled.exitCode;
    }
  }
  const logs = await handle.getProcessLogs(started.id);
  return { stdout: logs.stdout, stderr: logs.stderr, exitCode };
}

/**
 * The SDK's response classes are serializable but intentionally do not carry
 * JsonObject index signatures. Rebuild the small portable SandboxHandle at the
 * boundary and validate opaque mutation responses before core observes them.
 *
 * ── The preflight, and why it is ONE list ─────────────────────────
 * Two things must be true before an operation can touch the container, in this
 * order, and both used to be enforced somewhere else:
 *
 *   Egress interception must be installed, because the Container base re-applies
 *   its persisted outbound configuration immediately before `container.start()`
 *   and the workspace attach mounts its object store THROUGH that interception.
 *   Until it lands the container has no network at all — `enableInternet = false`
 *   with no handler bound means the platform denies everything — so the window
 *   before configuration fails CLOSED rather than leaking, which is what makes
 *   configuring lazily safe.
 *
 *   The workspace must be attached, because a container the SDK auto-started for
 *   a bare `readFile` serves that read from a blank disk, and a `writeFile` that
 *   lands before the attach is hidden under the overlay a moment later — written
 *   by the caller, invisible to the caller and to every checkpoint after it.
 *
 * They were two wrappers with two hand-maintained method lists, and the second
 * list did not have the file lanes on it. One list, here, beside the lane
 * decision it belongs with: a method that reaches the container goes through
 * `onContainer`, and a method that only writes this Durable Object's own rows
 * does not.
 */
export function adaptCloudflareSandbox(
  handle: KinuSandbox,
  configureEgress: () => Promise<void>,
): SandboxHandle {
  // Memoized on the PROMISE, not a boolean: two concurrent first operations must
  // both wait for the same configuration rather than one of them racing past a
  // flag that was set before the work completed. A failure is not cached — the
  // next operation retries — because a container left unconfigured has no
  // network, and latching that permanently is the same defect as a restore flag
  // that marked a container restored before reading what to restore.
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
    await handle.ensureReady();
    return await run();
  };
  return {
    ensureReady: () => onContainer(() => Promise.resolve()),
    // A deadline only when a caller ASKED for one; absent, the process lane.
    exec: (command, opts) => onContainer(() => (opts?.timeout === undefined
      ? execWithoutDeadline(handle, command, opts?.cwd)
      : handle.exec(command, opts))),
    readFile: (path, opts) => onContainer(() => handle.readFile(path, opts)),
    writeFile: (path, content, opts) =>
      onContainer(() => jsonResultOrVoid(handle.writeFile(path, content, opts))),
    listFiles: (path, opts) => onContainer(() => handle.listFiles(path, opts)),
    deleteFile: (path) => onContainer(() => jsonResultOrVoid(handle.deleteFile(path))),
    exposePort: (port, opts) => onContainer(() => handle.exposePort(port, opts)),
    unexposePort: (port) => onContainer(() => jsonResultOrVoid(handle.unexposePort(port))),
    getExposedPorts: (hostname) => onContainer(() => handle.getExposedPorts(hostname)),
    startSupervisedProcess: (command, opts) =>
      onContainer(() => handle.startSupervised(command, opts?.cwd)),
    stopSupervisedProcess: (processId) => onContainer(() => handle.stopSupervised(processId)),
    listSupervisedProcesses: () => onContainer(async () =>
      (await handle.listSupervised()).map(row => ({
        processId: row.processId, pid: row.pid, status: row.status,
        command: row.command, restartable: row.restartable,
      }))),
    // The port manifest is this Durable Object's own durable rows. It touches no
    // container, so it neither needs egress nor may wait for an attach: the
    // token has to be mintable BEFORE the exposure it names.
    portToken: (port, name) => handle.portToken(port, name),
    notePortRemoved: (port) => handle.notePortRemoved(port).then(() => undefined),
  };
}
