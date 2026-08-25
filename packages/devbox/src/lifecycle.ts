/**
 * Every decision a devbox makes, as a pure function.
 *
 * The class in devbox.ts holds the platform: schedules, storage, container
 * RPC. This file holds the reasoning. The split is not tidiness — a container
 * lifecycle is nearly impossible to test through the platform, and every rule
 * here has a boundary that has to be pinned by a table rather than by reading
 * it twice. Nothing in this file touches a container, a bucket or a clock.
 */

import type { CheckpointKind, CheckpointOutcome } from './storage';

// ── policy ──────────────────────────────────────────────────────────────────

/**
 * The timings a devbox runs on. One override point for all of them.
 *
 * A subclass returns a whole policy, so a deployment that changes one number
 * still states the other three, and there is one place to read to know how a
 * box behaves.
 */
export interface DevboxPolicy {
  /** How often the heartbeat runs, in seconds. Well under every platform idle
   *  window, and cheap enough to leave armed for the container's whole life. */
  readonly heartbeatSeconds: number;
  /** The last interaction must be at least this old before quiescing starts. */
  readonly idleMs: number;
  /** Quiescing also requires this much OBSERVED quiet — consecutive
   *  heartbeats that agreed — so one unlucky sample cannot stop a box. */
  readonly quietConfirmMs: number;
  /** Minimum gap between two checkpoints, and the period the checkpoint
   *  schedule ticks at. Both are this one number: a tick that fires early
   *  (a container restart re-arms the schedule) must not double-commit. */
  readonly checkpointIntervalMs: number;
  /**
   * Budget for the attach.
   *
   * Entirely this package's own bound, and one that can actually fire. The
   * attach runs in a scheduled callback, outside `blockConcurrencyWhile`, so a
   * timer is delivered normally. It used to run inside that block, where the
   * platform cancels (`do.block_concurrency.cancel_ms`) by RESETTING the
   * object and where a timer set inside the block is not delivered until the
   * block releases — so the bound
   * was unreachable and the reset happened instead. Overrunning now fails the
   * attach, records an incident, and refuses operations until a scheduled retry
   * succeeds.
   */
  readonly attachBudgetMs: number;
  /**
   * How long a restart keeps asking whether a restored server is listening.
   *
   * A supervised process is reported STARTED the moment the container forked
   * it, which is long before `npm run dev` or a Python app has bound its port.
   * One instant probe therefore declares a healthy server silent, and the
   * incident that follows reaches the agent as a blocker telling it not to hand
   * out a URL that is about to work. This is the window silence has to last
   * before it is a fact.
   */
  readonly portWaitMs: number;
  /** Gap between two listener probes inside that window. */
  readonly portProbeIntervalMs: number;
}

export const DEFAULT_DEVBOX_POLICY: DevboxPolicy = {
  heartbeatSeconds: 60,
  idleMs: 30 * 60_000,
  quietConfirmMs: 10 * 60_000,
  checkpointIntervalMs: 5 * 60_000,
  attachBudgetMs: 25_000,
  portWaitMs: 30_000,
  portProbeIntervalMs: 2_000,
};

// ── the container-start budget ──────────────────────────────────────────────

/** What abandoned container-start work rejected with, if it ever settled.
 *
 *  JavaScript lets any value be thrown, so the field is `cause` and its type is
 *  `unknown`: that pairing is the one place a value with no contract is allowed
 *  to travel, and every reader narrows it before touching anything. */
export interface LateStartFailure {
  readonly cause: unknown;
}

/**
 * Run container start-path work under a hard budget. ONE mechanism for both
 * hooks (`onStart` under the concurrency gate, the scheduled attach outside
 * it) — two copies of this race drifted within a day of the second landing.
 *
 * Inside `blockConcurrencyWhile` the timer is NOT delivered until the block
 * releases (measured, not assumed), so there the platform cancel
 * (`do.block_concurrency.cancel_ms`) is the real backstop and this budget is
 * the shape the do-init gate pins. Outside the block — the scheduled attach —
 * the timer delivers normally and the budget genuinely fires.
 *
 * Detaching the work is not an alternative either: a promise left floating in a
 * Durable Object is cancelled on eviction with its rejection swallowed, so the
 * work would silently not happen.
 *
 * `onOverrun` receives the outcome of the abandoned work if it ever settles.
 * Abandoning a value is not the same as discarding an error, and that late
 * error is usually the only diagnostic there is.
 */
export async function withContainerStartDeadline<T>(
  label: string,
  budgetMs: number,
  work: () => Promise<T>,
  onOverrun: (failure: LateStartFailure) => void,
): Promise<T> {
  let overran = false;
  const started = work().catch((cause: LateStartFailure['cause']) => {
    if (!overran) throw cause;
    onOverrun({ cause });
    // The race already rejected on the deadline, so this branch has no value
    // to produce. It exists so the late failure is reported instead of
    // surfacing as an unhandled rejection.
    return Promise.withResolvers<T>().promise;
  });
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    overran = true;
    reject(new Error(
      `${label} exceeded its ${budgetMs}ms budget and was abandoned. A scheduled retry `
      + 'is armed; operations are refused until one succeeds.',
    ));
  }, budgetMs);
  try {
    return await Promise.race([started, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── the activity lease ──────────────────────────────────────────────────────
//
// While a devbox serves a caller it must not sleep: the disk is ephemeral, so
// every idle expiry costs an attach. The lease is one durable timestamp plus
// one scheduled heartbeat. The SDK calls `renewActivityTimeout()` on every RPC
// interaction and every preview fetch; the class turns those calls into the
// durable stamp, and the heartbeat reads it.

export interface QuiesceInput {
  readonly now: number;
  readonly containerRunning: boolean;
  readonly lastInteractionAt: number;
  /** When quiet was first observed on this stretch, or undefined. Carried
   *  between ticks by the caller: the clock lives in durable state, not here. */
  readonly quietSince: number | undefined;
  /** Does the host still hold work bound to this container? */
  readonly backgroundWork: boolean;
  readonly idleMs: number;
  readonly quietConfirmMs: number;
}

export type QuiesceAction = 'hold' | 'quiesce';

export interface QuiesceDecision {
  readonly action: QuiesceAction;
  /** What the caller must persist for the next tick. `undefined` means the
   *  quiet stretch ended and the stored value must be deleted. */
  readonly quietSince: number | undefined;
}

/**
 * One heartbeat's decision.
 *
 * Three gates must all hold — the container is up, the last interaction is old
 * enough, the host reports no background work — and then the quiet has to be
 * observed for the confirmation window before the answer flips to `quiesce`.
 * A single busy sample resets the stretch, which is why `quietSince` travels
 * out as well as in.
 */
export function quiesceStep(input: QuiesceInput): QuiesceDecision {
  if (!input.containerRunning) return { action: 'hold', quietSince: undefined };
  const idleEnough = input.now - input.lastInteractionAt >= input.idleMs
    && !input.backgroundWork;
  if (!idleEnough) return { action: 'hold', quietSince: undefined };
  const quietSince = input.quietSince ?? input.now;
  const confirmed = input.now - quietSince >= input.quietConfirmMs;
  return { action: confirmed ? 'quiesce' : 'hold', quietSince };
}

// ── mount facts ─────────────────────────────────────────────────────────────

/** One `/proc/mounts` entry. */
export interface MountLine {
  readonly source: string;
  readonly fstype: string;
  readonly options: string;
}

/**
 * The `/proc/mounts` entry for `dir`, or undefined when nothing is mounted
 * there.
 *
 * Both strategies ask the kernel whether their work directory is really
 * attached, and they ask different follow-up questions of the answer — one
 * wants the overlay's upper directory, the other only the filesystem type — so
 * the parse is shared and the predicates are not.
 *
 * Field order is fstab's: source, mountpoint, fstype, options. fstab
 * octal-escapes spaces, so a path with a space has to survive the parse.
 */
export function findMount(procMounts: string, dir: string): MountLine | undefined {
  for (const line of procMounts.split('\n')) {
    const [source, mountpoint, fstype, options] = line.trim().split(/\s+/);
    if (source === undefined || mountpoint === undefined || fstype === undefined) continue;
    if (mountpoint.replace(/\\040/g, ' ') !== dir) continue;
    return { source, fstype, options: options ?? '' };
  }
  return undefined;
}

/** Render a thrown value and its cause chain.
 *
 *  A rejection reason is whatever the thrower threw, so a value that is not an
 *  `Error` is stringified rather than assumed to carry a message. Shared,
 *  because every failure path in this package needs the same answer and a
 *  second version of it would eventually disagree. */
export function describeThrown(thrown: { readonly cause: unknown }): string {
  const { cause } = thrown;
  if (cause instanceof Error) {
    return cause.cause === undefined
      ? cause.message
      : `${cause.message}: ${describeThrown({ cause: cause.cause })}`;
  }
  return String(cause);
}

// ── supervised processes and ports ──────────────────────────────────────────

/** A durably-recorded background process a devbox restarts after attach.
 *
 *  An arbitrary `nohup … &` child is NOT restorable: nothing captured its
 *  identity, so after the container is replaced there is no way to know it
 *  should exist. A spec is the only thing that survives, which is why starting
 *  a long-lived process goes through the supervised call. */
export interface SupervisedProcessSpec {
  readonly processId: string;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly createdAt: number;
}

/** A durably-recorded port exposure. The token is generated once and reused,
 *  so a box's preview URLs survive restarts verbatim: forwarding is
 *  re-activated after attach by exposing the port with the same token. */
export interface PortExposureSpec {
  readonly port: number;
  readonly name: string | undefined;
  readonly token: string;
  readonly createdAt: number;
}

/** The token alphabet the SDK accepts for preview URLs, which is 1 to 16
 *  characters of `[a-z0-9_]`. Sixteen gives the URL the same shape an
 *  auto-generated one has. */
export const PORT_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generatePortToken(random: (n: number) => Uint8Array): string {
  const bytes = random(16);
  let token = '';
  for (const byte of bytes) token += PORT_TOKEN_ALPHABET[byte % PORT_TOKEN_ALPHABET.length];
  return token;
}

/** Shell probe deciding whether anything listens on a container port. Any HTTP
 *  answer counts, 4xx and 5xx included: the question is whether a listener
 *  exists, not whether it is happy. curl exit 7 is connection refused. */
export function healthProbeCommand(port: number): string {
  return `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 `
    + `--head http://127.0.0.1:${port}/ 2>&1 || true`;
}

/** True when the probe says NOTHING is listening, or says nothing at all. An
 *  unparsable answer is not evidence of a listener, and exposing a port on that
 *  guess hands back a URL that answers 502. */
export function healthProbeSilent(output: string): boolean {
  const [codeStr, exitStr] = output.trim().split('|');
  if (exitStr !== undefined && Number.parseInt(exitStr, 10) === 7) return true;
  const code = codeStr === undefined ? Number.NaN : Number.parseInt(codeStr, 10);
  return !Number.isFinite(code) || code === 0;
}

/** The ordered work that turns a bare attached filesystem back into the box the
 *  caller left behind. */
export type RestartOp =
  | { readonly kind: 'start-process'; readonly spec: SupervisedProcessSpec }
  | { readonly kind: 'await-port'; readonly port: number }
  | { readonly kind: 'expose-port'; readonly spec: PortExposureSpec };

/**
 * Processes first, then each port's listener probe, then that port's
 * re-exposure.
 *
 * The order is the whole content of this function. Processes serve the ports,
 * so exposing a port before its server is up publishes a URL that answers 502.
 * Ports are walked in ascending order so a restart plan is the same plan every
 * time, which is what makes the restart reproducible when it goes wrong.
 */
export function restartPlan(
  processes: readonly SupervisedProcessSpec[],
  ports: readonly PortExposureSpec[],
): readonly RestartOp[] {
  const ops: RestartOp[] = processes.map(spec => ({ kind: 'start-process', spec }) as const);
  const exposed = new Map(ports.map(spec => [spec.port, spec]));
  for (const port of [...exposed.keys()].sort((a, b) => a - b)) {
    const spec = exposed.get(port);
    if (spec === undefined) continue;
    ops.push({ kind: 'await-port', port });
    ops.push({ kind: 'expose-port', spec });
  }
  return ops;
}

/**
 * Does a self-re-arming callback still need a successor armed?
 *
 * THE ROW BEING DISPATCHED IS STILL IN THE TABLE. `@cloudflare/containers`
 * deletes a fired row AFTER the callback returns, not before: in its `alarm()`
 * loop the callback is awaited and only then is the row deleted
 * (`await callback.call(...)` precedes `DELETE FROM container_schedules WHERE
 * id = ...` in the same iteration). So a callback that asks "is a row already
 * pending for me" sees ITSELF, decides it has nothing to do, and returns. The
 * SDK then deletes that row and the chain is dead with no error anywhere.
 *
 * Measured across two deployed probe runs: one died on the first idle tick, the
 * other had already died during an earlier phase, so the next phase found zero
 * rows before any idle had happened.
 *
 * The fix is to count only rows scheduled STRICTLY IN THE FUTURE. The firing row
 * is due now or overdue, so it never counts, and a genuine pending successor
 * always does.
 */
export function needsArming(
  rows: readonly { readonly time: number }[],
  nowSeconds: number,
): boolean {
  return !rows.some(row => row.time > nowSeconds);
}


// ── one checkpoint at a time ────────────────────────────────────────────────

export interface CheckpointLane {
  /**
   * Run one strategy checkpoint under the instance-wide gate.
   *
   * A Durable Object interleaves requests at every container and store await,
   * so two overlapping checkpoints would share the chain's staging directory,
   * race its delta PUT against its state write, and stamp overlapping journal
   * sequences — one batch object overwriting another under the same key while
   * both blobs stay. The rules:
   *
   *   same kind already running → JOIN it: the callers share one operation and
   *     one outcome.
   *   a different kind is running → QUEUE behind it: a quiesce that joined an
   *     in-flight tick could inherit a `skipped` answer and stop the container
   *     over work that only just landed; it runs its own final commit instead.
   *
   * Rejections travel to every caller of the failed run; the gate itself
   * survives and the next caller starts clean.
   */
  run(kind: CheckpointKind, op: () => Promise<CheckpointOutcome>): Promise<CheckpointOutcome>;
}

export function createCheckpointLane(): CheckpointLane {
  const inFlight: Partial<Record<CheckpointKind, Promise<CheckpointOutcome>>> = {};
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(kind, op) {
      const pending = inFlight[kind];
      if (pending !== undefined) return pending;
      const run = tail.then(() => op());
      inFlight[kind] = run;
      const settled = run.then(
        () => undefined,
        (cause) => {
          console.error(`[devbox] ${kind} checkpoint rejected: ${describeThrown({ cause })}`);
        },
      );
      tail = settled;
      void settled.then(() => {
        if (inFlight[kind] === run) inFlight[kind] = undefined;
      });
      return run;
    },
  };
}

// ── incidents ───────────────────────────────────────────────────────────────


/**
 * Which part of the lifecycle failed. A host routing an incident cares about
 * this more than about the text.
 *
 * A RUNTIME LIST, not a bare type union, because the host that receives these
 * has to validate them: a stage the producer emits and the consumer's schema
 * rejects is an incident that never reaches anyone, and that is exactly what
 * happened when the two sides each kept their own list. There is one list, and
 * it is this one.
 */
export const INCIDENT_STAGES = ['attach', 'checkpoint', 'process', 'port'] as const;

export type IncidentStage = (typeof INCIDENT_STAGES)[number];

/** A lifecycle failure, recorded durably before anyone is told about it.
 *
 *  `reason` carries ids and stages only. No object key, no bucket name, no
 *  token, no presigned value ever lands in it: an incident is the one row most
 *  likely to be forwarded somewhere the container's own secrets should not go. */
export interface DevboxIncident {
  readonly incidentId: string;
  readonly stage: IncidentStage;
  readonly reason: string;
  readonly processId: string | undefined;
  readonly port: number | undefined;
  readonly at: number;
}

/**
 * What the host did with an incident.
 *
 * `queued` means accepted, and delivery stops. `rejected` means the host
 * refused the shape, which is a defect in the caller rather than a transient
 * failure, so it is recorded and never retried. A thrown handler is neither: it
 * is transient, and the schedule retries it.
 */
export type IncidentDisposition = 'queued' | 'rejected';

/** Backoff for delivering an incident: 5 s doubling to a 5-minute ceiling.
 *
 *  Delivery persists BEFORE the first attempt and retries by schedule until
 *  the host accepts, so an eviction between recording and delivering loses
 *  nothing. */
export function incidentRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 300_000);
}

/** The container-start gate budget. `onStart` is awaited inside
 *  `ctx.blockConcurrencyWhile`, which the runtime cancels
 *  (`do.block_concurrency.cancel_ms` in the platform catalog) by RESETTING the
 *  Durable Object — measured live: "blockConcurrencyWhile() waited too long",
 *  probe run 2026-08-24. This budget is the established margin below that
 *  cancel: overrunning fails THIS container start — a retryable 503 — instead
 *  of resetting the object. */
export const CONTAINER_START_BUDGET_MS = 25_000;

