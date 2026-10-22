/**
 * `KinuDevbox` presented as core's `SandboxHandle`. No `timeout` means no work deadline, so such
 * commands run on the runtime's own exec (plain `exec` is bounded by the container and the request path),
 * and an abort kills the process, not just the wait. See `SandboxHandle.exec`.
 */

import { jsonResultOrVoid, REAL_CLOCK, SandboxPending, WORKSPACE_BACKUP_DIR, type Clock, type OutputSink, type SandboxHandle } from '@kinu.run/core';
import { attempt, classifyErrorCode, diagnostics, KinuError, renderThrownChain, settle, toKinuError, type ErrorCode } from "@kinu.run/core/obs";
import { devboxFailure, holdReadiness, readExec, type DevboxErrorCode } from '@kinu.run/devbox';
import { Effect } from 'effect';
import type { KinuDevbox } from "./kinu-devbox";
import { sandboxPreviewLabelOf } from "@kinu.run/core";
import type { SandboxPreviewExposures } from "@kinu.run/core";

type ContainerOperations = Pick<KinuDevbox,
  "exec" | "execStream" | "killExec" | "releaseExec" | "resolveReadiness" | "readFile" | "writeFile" | "writeFileIfDigest" | "listFiles" | "statFile"
  | "deleteFile" | "exposePort" | "getExposedPorts" | "unexposePort" | "startSupervised"
  | "stopSupervised" | "listSupervised" | "supervisedLogs" | "portToken" | "probePort" | "resize" | "portListeners" | "stampedProcesses" | "answerRest" | "desktop" | "releaseDesktop">;

/** Without AUTH_KV the edge cannot verify a preview hostname, so a minted URL would be dead. */
const PREVIEWS_UNPUBLISHABLE =
  'Port exposure is unavailable: this deployment has no AUTH_KV binding, so a '
  + 'preview URL could not be published for the edge to verify.';

const DEVBOX_FAILURE_CODES: Readonly<Record<DevboxErrorCode, ErrorCode>> = {
  io: 'io', configuration: 'unavailable', 'invalid-input': 'bad_input', 'not-ready': 'unavailable',
  cancelled: 'cancelled', missing: 'missing', file: 'io', process: 'io',
  'start-overrun': 'timeout', 'start-interrupted': 'unavailable', 'chain-advanced': 'io', 'mount-marker': 'unsupported',
  refused: 'unavailable', indeterminate: 'io',
};

/** A terminal refusal names what its reader can do; the owner's own is on the Environment card (D52). */
const REFUSED_NEXT = 'refused until something changes (choose another size with computer.resize(...), or ask the owner to start the computer again)';

/** The one conversion from the standalone library's failures to the application's channel. An
 *  unclassified failure, a transport one included, is `io`: `unavailable` is a verdict
 *  `withSandboxRetry` never re-enters, and the text keeps its transient marker. */
function fromDevbox(thrown: { readonly cause: unknown }): KinuError {
  const { cause } = thrown;

  if (cause instanceof KinuError) return cause;
  const failure = devboxFailure(thrown);

  if (failure === undefined) return new KinuError(classifyErrorCode(thrown) ?? 'io', renderThrownChain(thrown), { cause });

  return new KinuError(DEVBOX_FAILURE_CODES[failure.code], failure.code === 'refused' ? `${REFUSED_NEXT}: ${failure.message}` : failure.message, { cause });
}

type Readiness = Awaited<ReturnType<ContainerOperations['resolveReadiness']>>;

/** After `ms`, or at once when `signal` aborts. */
function pause(clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const disarm = clock.after(ms, resolve);

  const abort = (): void => {
    disarm();
    resolve();
  };

  signal?.addEventListener('abort', abort, { once: true });

  return promise.finally(() => { signal?.removeEventListener('abort', abort); });
}

/** The box's readiness, held while it is on its way (holdReadiness, D79, D108), so a call asks again instead of handing
 *  its agent a refusal to retry; the call's `signal` ends the hold as it ends the call. */
async function readinessPastBase(
  handle: Pick<ContainerOperations, 'resolveReadiness'>, clock: Clock, signal: AbortSignal | undefined,
): Promise<Readiness> {
  const readiness = await holdReadiness({
    ask: () => handle.resolveReadiness(), wait: (ms) => pause(clock, ms, signal), now: () => clock.now(), gone: () => signal?.aborted === true,
  });

  signal?.throwIfAborted();

  return readiness;
}

function callDevbox<A>(run: () => PromiseLike<A>): Effect.Effect<A, KinuError> {
  return Effect.tryPromise({ try: run, catch: (cause) => fromDevbox({ cause }) });
}

/**
 * No work deadline: the command on the container runtime's own exec (`Devbox.exec`), which returns its
 * output whole. An abort ends its process tree and reports once it is gone; a refused kill is reported as itself,
 * since the process is still running, and a command that finished first is returned as finished.
 */
async function execWithoutDeadline(
  handle: Pick<KinuDevbox, "exec" | "execStream" | "killExec">,
  command: string,
  { cwd, signal, env, execId }: {
    readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined; readonly env?: Readonly<Record<string, string>> | undefined; readonly execId: string;
  },
  output: OutputSink | undefined,
) {
  const options = { cwd: cwd ?? WORKSPACE_BACKUP_DIR, execId, ...(env !== undefined && { env }) };

  return await stoppable(handle, { execId, signal, doing: 'computer.exec' }, () => (output === undefined
    ? handle.exec(command, options)
    : handle.execStream(command, options).then((stream) => readExec(stream, (name, data) => { output.write(name, data); }))));
}

/**
 * The canonical cancellable path for a call that runs on the box under `execId` (D69): an abort of `signal` ends it there
 * (`killExec`), and this settles once the box answers, which it does only after its process has gone. A refused kill
 * is reported as itself, since the process is still running; a call that finished first is returned as finished; one
 * the box answers as stopped is that answer.
 */
async function stoppable<T>(
  handle: Pick<KinuDevbox, "killExec">,
  { execId, signal, doing }: { readonly execId: string; readonly signal: AbortSignal | undefined; readonly doing: string },
  run: () => Promise<T>,
): Promise<T> {
  const ran = run();
  // Set only on abort: true means this call ended the process tree, false that the command had already exited.
  let verdict: Promise<boolean> | undefined;
  const { promise: killRefused, reject } = Promise.withResolvers<never>();

  const kill = (): void => {
    verdict = handle.killExec(execId);
    verdict.catch(reject);
  };

  if (signal?.aborted === true) kill();
  else signal?.addEventListener("abort", kill, { once: true });

  try {
    const result = await Promise.race([ran, killRefused]);

    if (verdict !== undefined && await verdict) {
      throw new DOMException(`${doing} cancelled: its container process tree was ended (exec ${execId})`, "AbortError");
    }

    return result;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

/** What a moved exposure owes is recorded before the call returns; its failure is reported, never the exposure's. */
function recordPortsMoved(portsMoved: (() => Promise<void>) | undefined): Effect.Effect<void> {
  return attempt({ doing: 'recording what an exposure moved', otherwise: 'unavailable' }, async () => { await portsMoved?.(); })
    .pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('jobs.serving_unread', failure); })));
}

/** The edge's record of published previews, and the zone their hosts are under. */
export interface LanePreviews {
  readonly exposures: SandboxPreviewExposures;
  readonly zone: string;
}

export function adaptCloudflareSandbox(
  handle: ContainerOperations,
  configure: () => Promise<void>,
  previews: LanePreviews | null,
  { portsMoved, clock = REAL_CLOCK, drivers = new Set() }: {
    readonly portsMoved?: () => Promise<void>;
    /** Times a hold for the box's base snapshot (D79). */
    readonly clock?: Clock;
    /**
     * The agents that drove the desktop since the box last let them go, shared by every agent's adapter in the
     * workspace. Only theirs is asked of the box as their turns end: a turn that never touched the computer calls no box
     * (D56). One that drove before this activation holds it until it drives and ends again, or the box's X starts afresh.
     */
    readonly drivers?: Set<string>;
  } = {},
): SandboxHandle {
  // Memoized on the promise so concurrent first calls share it; failures are not cached.
  let inFlight: Promise<void> | null = null;

  const configured = async (): Promise<void> => {
    if (inFlight !== null) return await inFlight;
    const configuring = configure();
    inFlight = configuring;

    try {
      await configuring;
    } catch (error) {
      inFlight = null;
      throw error;
    }
  };

  // `signal`: the call's own, which ends a hold for the box's base as it ends the call.
  const onContainer = <T>(run: () => Promise<T>, signal?: AbortSignal): Effect.Effect<T, KinuError> => Effect.tryPromise({
    try: async () => {
      await configured();
      const readiness = await readinessPastBase(handle, clock, signal);

      if (readiness.kind === 'pending') throw new SandboxPending(readiness.reason);

      return await run();
    },
    catch: (cause) => fromDevbox({ cause }),
  });


  return {
    ensureReady: () => settle(onContainer(() => Promise.resolve())),
    configure: () => settle(Effect.tryPromise({ try: configured, catch: (cause) => fromDevbox({ cause }) })),
    // One launch id per call: after a lost reply the same id reads the box's answer, never a second launch.
    exec: (command, opts) => {
      const signals = [opts?.signal, opts?.timeout === undefined ? undefined : AbortSignal.timeout(opts.timeout)].filter((held) => held !== undefined);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const execId = crypto.randomUUID();
      const ready = onContainer(() => Promise.resolve(), signal);
      const run = callDevbox(() => execWithoutDeadline(handle, command, { cwd: opts?.cwd, signal, env: opts?.env, execId }, opts?.output));
      // The exec call itself gave no verdict, and nothing cancelled it: it may or may not have reached the box.
      const lost = (failure: KinuError): boolean => signal?.aborted !== true && failure.code === 'io' && devboxFailure({ cause: failure.cause }) === undefined;

      const again = Effect.andThen(ready, run).pipe(Effect.mapError((failure) => (lost(failure)
        ? new KinuError('io', `the box lost the reply twice, so whether \`${command}\` ran is unknown (exec ${execId}); it was not run again`, { cause: failure })
        : failure)));

      return settle(Effect.andThen(ready, run.pipe(
        Effect.catch((failure) => (lost(failure) ? again : Effect.fail(failure))),
        Effect.ensuring(callDevbox(() => handle.releaseExec(execId)).pipe(
          Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('computer.exec_release_failed', failure, { execId }); })),
        )),
      )));
    },
    // Not `onContainer`: a read never starts a container.
    portListeners: (stamp, ports) => settle(callDevbox(() => handle.portListeners(stamp, ports))),
    stampedProcesses: (stamp, value) => settle(callDevbox(() => handle.stampedProcesses(stamp, value))),
    probePort: (port) => settle(onContainer(() => handle.probePort(port))),
    readFile: (path, opts) => settle(onContainer(() => handle.readFile(path, opts))),
    writeFile: (path, content, opts) =>
      settle(onContainer(() => jsonResultOrVoid(handle.writeFile(path, content, opts)))),
    writeFileIfDigest: (write) => settle(onContainer(() => handle.writeFileIfDigest(write))),
    listFiles: (path, opts) => settle(onContainer(() => handle.listFiles(path, opts))),
    statFile: (path, opts) => settle(onContainer(() => handle.statFile(path, opts))),
    deleteFile: (path) => settle(onContainer(() => jsonResultOrVoid(handle.deleteFile(path)))),
    // Never retried: a repeated click is a second click. Its own id, by which a stop ends its run on the box.
    desktop: (request, opts) => {
      const execId = crypto.randomUUID();
      const signal = opts?.signal;

      drivers.add(request.driver);

      return settle(Effect.andThen(onContainer(() => Promise.resolve(), signal), callDevbox(() => stoppable(
        handle, { execId, signal, doing: `computer.${request.action.kind}` }, () => handle.desktop({ ...request, execId }),
      ))));
    },
    releaseDesktop: (driver) => {
      if (!drivers.has(driver)) return Promise.resolve();

      return settle(callDevbox(() => handle.releaseDesktop(driver)).pipe(Effect.tap(() => Effect.sync(() => { drivers.delete(driver); }))));
    },
    // Published first: the edge verifies preview hostnames against the record (`preview-proxy.ts`).
    // Then `servePreviewRequest`'s gates run here, without forwarding.
    exposePort: (port, opts) => settle(Effect.gen(function* () {
      if (previews === null) return yield* Effect.fail(new KinuError('unavailable', PREVIEWS_UNPUBLISHABLE));
      const exposed = yield* onContainer(() => handle.exposePort(port, opts));
      const label = yield* Effect.try({ try: () => sandboxPreviewLabelOf(new URL(exposed.url), { PREVIEW_HOST_SUFFIX: previews.zone }), catch: (cause) => fromDevbox({ cause }) });

      if (label === null || label.port !== port) return yield* Effect.fail(new KinuError('io', `the container minted a preview URL this deployment cannot publish: ${exposed.url}`));
      yield* callDevbox(() => previews.exposures.publish(port, label.token));
      yield* recordPortsMoved(portsMoved);

      if (!(yield* callDevbox(() => previews.exposures.exposed(port, label.token)))) {
        return { ...exposed, route: { reached: false, gate: 'published' as const, detail: 'the edge holds no published record for this URL' } };
      }

      const live = yield* onContainer(() => handle.getExposedPorts());

      return live.some(row => row.port === port && row.url === exposed.url)
        ? { ...exposed, route: { reached: true } }
        : { ...exposed, route: { reached: false, gate: 'exposed' as const, detail: `the container holds no live exposure of port ${port} for this URL` } };
    })),
    // Withdraw first: a revoked port the edge still admits is unsafe. The container's own revoke needs no readiness,
    // and a container that keeps the exposure regardless serves nothing the edge admits.
    unexposePort: (port) => settle(Effect.gen(function* () {
      if (previews !== null) yield* callDevbox(() => previews.exposures.withdraw(port));
      const removed = yield* callDevbox(() => jsonResultOrVoid(handle.unexposePort(port)));
      yield* recordPortsMoved(portsMoved);

      return removed;
    })),
    // Renewing what was published keeps long-lived previews from ageing out; what the container reports publishes
    // nothing. A failed renewal is reported and the listing stands: the record is already correct.
    // Not `onContainer`: a read never starts a container.
    getExposedPorts: () => settle(callDevbox(async () => {
      const rows = await handle.getExposedPorts();

      if (previews !== null) {
        const { exposures: index, zone } = previews;
        await Promise.all(rows.map(async (row) => {
          const label = sandboxPreviewLabelOf(new URL(row.url), { PREVIEW_HOST_SUFFIX: zone });

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
      settle(onContainer(() => handle.startSupervised(command, opts?.cwd, opts?.env, { reveal: opts?.reveal === true, ...(opts?.job !== undefined && { job: opts.job }) }))),
    stopSupervisedProcess: (processId) => settle(onContainer(() => handle.stopSupervised(processId))),
    supervisedProcessLogs: (processId, limits) => settle(onContainer(() => handle.supervisedLogs(processId, limits))),
    listSupervisedProcesses: () => settle(onContainer(async () =>
      (await handle.listSupervised()).map(row => ({
        processId: row.processId, pid: row.pid, status: row.status,
        command: row.command, restartable: row.restartable,
        waiting: row.waiting, session: row.session,
      })))),
    resize: (size) => settle(callDevbox(async () => {
      await configured();

      return await handle.resize(size);
    })),
    // Not `onContainer`: an answer never starts a resting container.
    answerRest: (answer) => settle(callDevbox(() => handle.answerRest(answer))),
    // DO rows only: no egress, no attach wait, since the token must be mintable before its exposure.
    portToken: (port, name) => settle(callDevbox(() => handle.portToken(port, name))),
  };
}
