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
 *
 * ── Cancellation reaches the process, not the wait ────────────────
 * The process lane is also what makes an abort mean something. A background
 * process has an ID, and an ID has `killProcess`, so a cancelled exec kills the
 * command and waits for its exit code before it reports anything. What core used
 * to do was race the signal against the wait and return, which told the agent
 * "the command may still finish inside the container" — a turn moving on while
 * an unwatched build kept writing to /workspace. See `SandboxHandle.exec`.
 */

import type { Process } from "@cloudflare/sandbox";
import { decodeJsonValue, WORKSPACE_BACKUP_DIR, type SandboxHandle } from "@kinu.run/core";
import type { KinuSandbox } from "./kinu-sandbox";

async function jsonResultOrVoid<Result>(result: Promise<Result>) {
  const value = await result;
  return value === undefined ? undefined : decodeJsonValue({ value });
}

/**
 * Wait until this process HAS an exit code, and return it.
 *
 * `waitForExit` reads the process log stream, and that stream idles out after
 * 300s of silence. A silent long-running process trips it while perfectly alive,
 * so the answer is to look again: nothing was killed, and the process's own exit
 * is the only thing that ends the wait.
 */
async function observeExit(handle: KinuSandbox, started: Process): Promise<number> {
  let exitCode = started.exitCode;
  while (exitCode === undefined) {
    try {
      exitCode = (await started.waitForExit()).exitCode;
    } catch (cause) {
      const status = await started.getStatus();
      // A process that has not finished is observed again; anything else is
      // settled and its exit code is read from the store.
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
 * Run a command with no work deadline: as a background process, awaited to exit.
 *
 * `startProcess` returns in one request and the process then belongs to the
 * container rather than to this call, so nothing here holds a wall clock over
 * it. Work that would rather be observed than awaited has `sandbox.startProcess`
 * and the `process_done` container event.
 *
 * An abort kills THAT process by id and then waits for its exit code, because an
 * exit code is the only evidence that nothing of the command is still running.
 * Both ways out are definitive and neither is a timer:
 *
 *   the kill lands — the exit observation completes, and the caller gets an
 *   AbortError naming the process that is now gone;
 *
 *   the kill FAILS — the caller hears that instead, immediately, because a
 *   process that could not be killed is still running and reporting
 *   `cancelled` over it would be the defect this replaced.
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
  // The kill's outcome AS A PROMISE, so the wait below joins it instead of
  // leaving it floating: resolved means the process is gone by our hand, and
  // rejected means it is still there. It settles only if an abort asks for a
  // kill, and asks once — a turn's signal is shared, and each exec in flight
  // kills only its own process.
  const { promise: killed, resolve, reject } = Promise.withResolvers<void>();
  const kill = (): void => {
    cancelling = true;
    void handle.killProcess(started.id).then(resolve, reject);
  };
  if (signal?.aborted === true) kill();
  else signal?.addEventListener("abort", kill, { once: true });
  try {
    // `killed` never settles without an abort, so in the ordinary case this is a
    // plain wait for the exit code.
    const exitCode = await Promise.race([observed, killed.then(() => observed)]);
    // The race can only RESOLVE through `observed`, so an exit code here means
    // the process is gone whatever the kill itself reported.
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

/**
 * WHERE THE CONFLICT QUEUE IS, AND WHY IT IS NOT HERE.
 *
 * This adapter used to hold one: a keyed FIFO ordering two writes to a path, an
 * exposure against its own un-exposure, a token against the removal of its row.
 * It ordered the wrong population. Each facet of a workspace — a head, a
 * subordinate, an exploration branch — is a separate Durable Object with its own
 * isolate and therefore its own copy of this adapter, and every one of them
 * addresses the SAME container, because `sandboxId` is `kinu-<workspaceName>` for
 * a facet and for its root alike. A queue built here orders one facet's calls and
 * lets two facets interleave on the same path, which is the defect it was written
 * to fix.
 *
 * So the claim lives in the object all of them reach: `Devbox` (see
 * `createResourceLane` and the "one caller at a time, per resource" section in
 * @kinu.run/devbox). Everything below calls ordinary methods and keeps no queue,
 * no scope table and no copy of the method list — one authority, and it is the
 * owner.
 */

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
    // A deadline only when a caller ASKED for one; absent, the process lane,
    // which is also the only lane an abort can kill.
    exec: (command, opts) => onContainer(() => (opts?.timeout === undefined
      ? execWithoutDeadline(handle, command, opts?.cwd, opts?.signal)
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
    // token has to be mintable BEFORE the exposure it names. The owner puts it on
    // the port's claim, which is where that ordering belongs.
    portToken: (port, name) => handle.portToken(port, name),
    notePortRemoved: (port) => handle.notePortRemoved(port).then(() => undefined),
  };
}
