/**
 * Devbox — one ephemeral container presented as a persistent machine.
 *
 * A Cloudflare container is spot capacity with an ephemeral disk. It can be
 * recycled between two consecutive calls, and when it comes back the disk is
 * blank. Everything in this class exists to make that container look, to its
 * caller, like a machine that was simply asleep.
 *
 * WHAT THIS CLASS OWNS
 *
 *   The restoration, run ONCE PER CONTAINER INSTANCE on the first delivered
 *   frame after a container start. `Container.onStart` is awaited inside
 *   `blockConcurrencyWhile` (`@cloudflare/containers`, `container.js:583` for
 *   `start()`), and the platform delivers no timer to a Durable Object while
 *   that block is held — which is why the restore does NOT run there. The
 *   hook's first command on a fresh container opens the SDK's control
 *   connection, and that connect is bounded by `setTimeout` on the Durable
 *   Object (`@cloudflare/sandbox`, `dist/sandbox-CPj2jsbz.js:3563`, a 30 s
 *   abort) and retried through another (`:812`, a 3 s backoff): a container
 *   whose server is not yet accepting at the hook's first attempt cannot be
 *   reached from inside the gate at all, and the platform resets the object at
 *   its 30 s cap. Measured on six fresh container starts (2026-09-10): one
 *   admitted at 3,270 ms, five reset with no phase stamped
 *   (`bench/measure-first/DECISIVE-2026-09-05.md`).
 *
 *   So the hook reads this object's own storage and nothing else: it arms the
 *   three durable chains and marks the restoration PENDING, so no operation
 *   is admitted on the strength of a phase settled before this start. The
 *   restore itself runs on the delivered frame that asked — the readiness
 *   request or the `devboxStartup` row — under the raced budget, where a
 *   deadline can fire (`racedRestoreSteps`). Every door joins the one
 *   single-flight attempt, fenced by the generation, and admission reads only
 *   a SETTLED phase: `restoring` admits nobody.
 *
 *   Once per instance, and never twice on the same one: the container's own
 *   boot id (`/tmp/devbox-boot-id`, dead with the instance) is compared
 *   against the durable row on the first delivered frame after a start, and a
 *   match on a settled box is adopted without a restore. The settled phase is
 *   durable (`devbox:restoration`), so an activation after a platform reset
 *   adopts the same way.
 *
 *   The readiness gate, for everything else. A container replaced under a
 *   live object never fires the hook — the SDK sees a running, healthy
 *   container — so `ensureReady()` guards every operation, adopts or drives
 *   the one attempt, and returns what it admitted the caller INTO —
 *   restored, or repair with a reason — refusing everything else.
 *
 * HOW IT IS CONSUMED
 *
 *   The way `Sandbox` itself is consumed: extend the class and override the
 *   protected hooks. There is no options bag, no plugin registry and no event
 *   emitter, because the thing being configured is a Durable Object class and a
 *   subclass is already the platform's way to configure one.
 *
 *     class MyBox extends Devbox<Env> {
 *       protected override get store() {
 *         return { binding: 'BUCKET', bucket: this.env.BUCKET };
 *       }
 *       protected override async hasBackgroundWork() { … }
 *     }
 *
 *   A subclass that overrides nothing is a working ephemeral box: it attaches
 *   nothing, checkpoints nothing, and says so. That is a real state, not a
 *   placeholder.
 */

import { Sandbox } from '@cloudflare/sandbox';
import type {
  BackupOptions, CheckChangesOptions, ExecOptions, ExecResult, ListFilesOptions,
} from '@cloudflare/sandbox';
import * as v from 'valibot';

import {
  DEFAULT_DEVBOX_POLICY,
  generatePortToken,
  healthProbeSilent,
  describeThrown as describe,
  type LateStartFailure,
  incidentRetryDelayMs,
  needsArming,
  createCheckpointLane,
  createResourceLane,
  heldUntilDrained,
  pathScopes,
  portScope,
  processScope,
  admissionStep,
  classifyRecovery,
  parseRecoveryRow,
  parseWorkdirHolders,
  releaseWorkdirHoldersCommand,
  quiesceStep,
  recoveryStep,
  restartPlan,
  type DevboxIncident,
  type DevboxPolicy,
  type IncidentDisposition,
  type IncidentStage,
  type PortExposureSpec,
  type QuiesceAction,
  type RecoveryRow,
  type RecoveryStage,
  type SupervisedProcessSpec,
  openStartBudget, awaitListenerCommand,
  racedRestoreSteps, runRestoreStep, type RestoreSteps,
} from './lifecycle';
import type { RestorePhase, RestorePhaseStamps } from './durability/contracts';
import {
  deliverIncidents, INCIDENT_PREFIX, incidentTotals, recordIncident,
  type IncidentRow,
} from './incidents';
import {
  CHAIN_EXCLUDES,
  ChainRecordAdvanced,
  chainStoreRoot,
  normalizeChainState,
  snapshotChainStorage,
  type ChainState,
  type ChangeStatus,
  type SnapshotChainPorts,
} from './snapshot-chain';
import {
  DEFAULT_DEVBOX_STRATEGY,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type DevboxStore,
  type DevboxStrategyName,
  type StoredValue,
} from './storage';

/** How long a container gets to REPORT itself stopped after it acknowledged the
 *  signal, as a count times an interval.
 *
 *  A COUNT, BECAUSE THE ALTERNATIVE HUNG. This wait had no bound at all
 *  (`while (running) await wait(100)`), and it sits on the recovery path: a
 *  `destroy()` the platform acknowledged but never reflected in `running` pinned
 *  the in-flight attempt for ever, and a pinned attempt is one `kickStartup`
 *  early-returns on — so nothing re-armed and no further incident was filed.
 *  Fifty probes at 100 ms is five seconds, an order of magnitude more than the
 *  transition takes when it happens at all. */
const CONTAINER_STOP_ATTEMPTS = 50;

const CONTAINER_STOP_INTERVAL_MS = 100;

/** How often the container-admission probe asks the platform for an instance,
 *  inside the one window `portWaitMs` gives it. The SDK's own default poll
 *  interval; named here because the retry COUNT is derived from it and a
 *  divisor spelled twice is a divisor that drifts. */
const ADMISSION_POLL_INTERVAL_MS = 100;

/**
 * One filed failure, as the ledger holds it. `delivered` tells a failure the
 * host already saw apart from one it never did. Read-only reporting shape.
 */
export interface IncidentReasonRow {
  readonly stage: IncidentStage;
  readonly reason: string;
  readonly at: number;
  readonly attempts: number;
  readonly delivered: boolean;
}

/** Durable keys. One namespace, so a host's own keys cannot collide with these
 *  and a reader can tell at a glance which rows belong to the box machinery. */
const STORAGE_KEY = 'devbox:storage-state';

const LAST_INTERACTION_KEY = 'devbox:last-interaction';

const QUIET_SINCE_KEY = 'devbox:quiet-since';

const PROC_SPEC_PREFIX = 'devbox:proc:';

const PORT_SPEC_PREFIX = 'devbox:port:';

const LAST_ATTACH_KEY = 'devbox:last-attach';

/** How far this box has gone recovering one container identity from a failed
 *  attach. Written only by the recovery ladder, deleted by the first attach that
 *  lands. Durable because the retry is a schedule row and the object that runs
 *  it is often a fresh one — see {@link RECOVERY_STAGES}. */
const ATTACH_RECOVERY_KEY = 'devbox:attach-recovery';

const LAST_TICK_KEY = 'devbox:last-tick';

const BOOT_ID_KEY = 'devbox:boot-id';

/** The settled phase of the last restoration, written beside the boot id it
 *  settled on. Memory-only state does not survive the platform resetting the
 *  object mid-restore; this row lets the next activation adopt a restoration
 *  the container already holds instead of running it again. Deleted whenever
 *  the generation turns over, so a stale phase can never be adopted for a
 *  container it did not settle on. */
const SETTLED_KEY = 'devbox:restoration';

const REPLACED_COUNT_KEY = 'devbox:replaced-count';

/** Scheduled-callback names. Each MUST name a public method on the class:
 *  `Container.schedule` rejects anything it cannot call back. */
const STARTUP_CALLBACK = 'devboxStartup';

const CHECKPOINT_CALLBACK = 'devboxCheckpoint';

const HEARTBEAT_CALLBACK = 'devboxHeartbeat';

const INCIDENT_CALLBACK = 'devboxIncidents';

/**
 * The container-start hook's claim, read by `scripts/do-init-gate.ts`: the work
 * it hands the platform's gate touches this object's own storage and nothing
 * else — no container command, no R2, no Durable Object timer. The gate holds
 * the method the hook returns to that claim by name. The identifier appears in
 * the hook's body so the claim is made where it can be checked.
 */
const BOUNDED_STORAGE_ONLY = 'devbox:onStart touches only this object\'s own storage';

/**
 * Where the snapshot chain's seed stamp lives inside the container.
 *
 * Beside the upper, never inside it: everything under the upper is archived as
 * the next delta, and a marker that travelled into the archive would then
 * describe itself. On the container's own ephemeral disk for the same reason the
 * boot id is: the fact it records is "the upper ON THIS DISK already holds that
 * delta", which a replaced disk must not be able to claim.
 */
const CHAIN_SEED_STAMP_PATH = `${DEVBOX_RUNTIME_DIR}/upper.seed-stamp`;

/** Where the boot id lives inside the container.
 *
 *  Under `/tmp` deliberately: it must NOT survive a replacement. That is the
 *  whole signal. A file that survived would prove nothing. */
const BOOT_ID_PATH = '/tmp/devbox-boot-id';

/**
 * The s3fs bounds every store mount runs under.
 *
 * s3fs's own defaults wait 300 s to connect, 120 s of silence per request and
 * retry five times with backoff — for a mount whose every request is a hop to
 * the platform's egress interception, not a WAN. A restoration that is bounded
 * to `attachBudgetMs` abandons its attach at 25 s, and a mount still holding a
 * dead connection for minutes past that is exactly the work a retry then has
 * to run beside. A connect that has not landed in ten seconds is not going to,
 * and thirty seconds of silence on a 5 MiB part is a dead connection rather
 * than a slow one. `multireq_max` keeps s3fs's own bound of twenty.
 */
const STORE_MOUNT_S3FS_OPTIONS: readonly string[] = [
  'connect_timeout=10',
  'readwrite_timeout=30',
  'retries=3',
];

/** Interaction stamps are throttled to this. Every call already renews the
 *  SDK's own in-memory timer; the durable copy only has to be good enough to
 *  survive an eviction, and one write per call would be a write per call. */
const INTERACTION_PERSIST_INTERVAL_MS = 30_000;

/** Process states that mean the command has not finished.
 *
 *  The container SDK's own vocabulary. `@kinu.run/cf-backend`'s exec lane keeps
 *  its own copy on purpose — that module is deliberately free of any value
 *  import from this package, so it can be exercised without a Durable Object —
 *  so `LIVE_PROCESS_STATES` in `packages/cf-backend/src/sandbox-exec-lane.ts`
 *  is this predicate's twin. Compared rather than tabled: the SDK types its
 *  status as a closed union, and indexing a partial table by it is an
 *  implicit `any`. */
function isProcessLive(status: string): boolean {
  return status === 'starting' || status === 'running';
}

/**
 * The SDK's classification for "the container answered, and it holds no such
 * process". Read as a CODE, because the code is the classification.
 *
 * `@cloudflare/sandbox` gives every failure a typed error carrying one
 * `ErrorCode`, and builds `ProcessNotFoundError` for this one — but it exports
 * neither that class nor its `SandboxError` base, so the code is what a caller
 * can narrow on. `v.object` reads it through the class's own getter, and a
 * value that is not an SDK error carries no code and is therefore not absence.
 *
 * IT REPLACES MATCHING PROSE, which was `/not found|unknown/` over the
 * rendered chain. Three failures the SDK really produces satisfied that
 * pattern while saying nothing about the process: a mis-routed request's
 * `404 page not found` body, an unclassified container failure whose message
 * is `Unknown error`, and a terminated session's `(exit code: unknown)`. Each
 * one dropped the only row naming a process that was still running.
 */
const ProcessAbsentSchema = v.object({ code: v.literal('PROCESS_NOT_FOUND') });

/** What `exposePort` takes. The SDK declares it inline, and this names it so a
 *  caller can build it in steps instead of spreading a conditional. */
interface PortExposeOptions {
  hostname: string;
  token: string;
  name?: string;
}


/** What one heartbeat saw. Durable, because the question a stalled lease raises
 *  is "when did it last tick and what did it decide", and that cannot be
 *  answered from memory after the object is evicted. */
export interface HeartbeatTick {
  readonly at: number;
  readonly running: boolean;
  /** The control-plane ping outcome, or why it was not attempted. */
  readonly ping: string;
  /** Did this tick leave a successor armed? `false` is only correct when the box
   *  is stopping. */
  readonly armedNext: boolean;
  readonly decision?: QuiesceAction;
  /** True when this tick found the container instance replaced underneath it. */
  readonly replaced?: boolean;
}

/** A supervised process as reported. `restartable` says whether a durable spec
 *  exists, which is the difference between a process that comes back after a
 *  recycle and one that does not. */
export interface SupervisedProcessRow {
  readonly processId: string;
  readonly pid: number | undefined;
  readonly status: string;
  readonly command: string;
  readonly restartable: boolean;
}

/** Everything a caller can ask about a box without touching the container.
 *  Consumed by the bench driver and by any host that wants to show a box's
 *  condition. */
export interface DevboxReport {
  readonly strategy: DevboxStrategyName;
  readonly durable: boolean;
  readonly running: boolean;
  /**
   * The restoration this isolate has observed for the current container
   * generation, as ONE name a caller can act on.
   *
   * FIVE NAMES, and two of them used to be ambient. A box whose work directory
   * came back but whose services did not still ADMITS operations — that is
   * deliberate, because the agent whose dev server failed is the only thing that
   * can fix it and a box refusing `exec` cannot be repaired — but it used to
   * report `attached`, exactly like a box that had restored everything. And a
   * box with an attempt IN FLIGHT reported `unstarted`, which is what a box with
   * nothing running reports. Both conflations were measured as defects (see
   * `Restoration`), so both have their own name now: `attached` MEANS fully
   * restored, `repair` names the degraded admission, `restoring` names an
   * attempt in flight, and {@link unready} says which phase or how long.
   *
   * `unattached` is terminal until an explicit repair; a driver polls this
   * instead of inferring lifecycle state from a stale attach record.
   */
  readonly restoration: 'unstarted' | 'restoring' | 'attached' | 'repair' | 'unattached';
  /** Attached AND fully restored: every supervised process back, every exposed
   *  port's listener answering, every port re-exposed. Exactly
   *  `restoration === 'attached'` — the two cannot disagree, because a box that
   *  is only half of that is named `repair` instead. A box that advertised
   *  readiness over a failed service handed callers a URL that answers 502. */
  readonly ready: boolean;
  /** Why the box is not ready, or undefined when it is. Either nothing is
   *  attached or a required process, listener or port did not come back. The
   *  incident ledger holds the detail; this is the one sentence. */
  readonly unready: string | undefined;
  readonly lastInteractionAt: number | undefined;
  readonly quietSince: number | undefined;
  readonly chain: ChainState | null;
  /** What the most recent attach did, for THIS box, whichever call drove it.
   *
   *  Durable rather than in memory: the call that starts a container is often
   *  not the call that wants to know what the start restored, and an eviction
   *  in between would otherwise erase the only evidence that a restore
   *  happened at all. */
  readonly lastAttach: AttachOutcome | undefined;
  /** The most recent heartbeat, or undefined if none has run. A box whose
   *  `lastTick.at` is far in the past stopped ticking, and the row says what the
   *  last tick saw. */
  readonly lastTick: HeartbeatTick | undefined;
  /** The id the current container instance is stamped with, per durable state. */
  readonly bootId: string | undefined;
  /** How many times the platform has replaced this box's container instance.
   *  A measured fact about the platform, not a failure of this class. */
  readonly replacedCount: number;
  readonly supervised: readonly SupervisedProcessSpec[];
  readonly ports: readonly PortExposureSpec[];
  readonly incidents: {
    readonly total: number;
    readonly undelivered: number;
  };
}

/**
 * WHICH DOOR opened a restoration.
 * Two, both delivered frames: the `devboxStartup` schedule row a container
 * start arms, and a readiness request. Both join the same single-flight run;
 * `where` is the answer to "who is driving this" for whoever is polling. The
 * container-start hook is not a door: it arms and marks, and reaches no
 * container (see `onStart`).
 */
type RestorationDoor = 'schedule' | 'request';

/**
 * What THIS container generation's restoration established, as ONE value.
 *
 * It replaces a pair of flags that could disagree. Readiness and the attach
 * failure were separate fields, and a superseded attempt could set the failure
 * string while readiness stayed true from the attempt that had already
 * succeeded — or publish readiness for a generation that no longer existed. One
 * value cannot hold both halves of a contradiction.
 *
 * THE PARTIAL ADMISSION IS A PHASE OF ITS OWN, which is the second thing one
 * value buys. `attached` used to carry an `incomplete` reason, so the same name
 * meant both "everything came back" and "operations are being let into a world
 * where a service did not" — and every reader that keyed on the name alone
 * treated the second as the first. Splitting `repair` out makes that
 * conflation unrepresentable: an activation settles on exactly one of the two,
 * and a caller admitted into `repair` can see what it is entering.
 *
 * A RESTORATION IN FLIGHT IS ALSO A PHASE, and its absence was a measured
 * defect. `unstarted` used to mean both "nothing has begun" and "an attempt is
 * running and has published nothing yet", because the generation turnover that
 * OPENS an attempt reset this value to `unstarted` and only the walk's end wrote
 * again. So a box mid-restoration answered `restoration: 'unstarted'`, `unready:
 * 'no restoration has run for this container yet'` — while its own attempt was
 * pinned in `#startup`, `kickStartup` was early-returning on that pin, and
 * therefore nothing re-armed. Measured live in probe `blp1`: running=true,
 * `unstarted`, frozen for 300,771 ms, `/state` answering in ~300 ms throughout,
 * and the driver's poll reading that as `pending` for ever. With `restoring` in
 * the union that reading cannot be produced: an attempt is in flight or it is
 * not, and the value says which — and `since` is what makes the in-flight
 * answer actionable, because "restoring for 40 ms" and "restoring for 300 s"
 * call for different decisions from whoever is polling.
 */
type Restoration =
  /** No attempt has begun for this container generation. NOT "an attempt is
   *  running and has said nothing yet" — that is `restoring`. */
  | { readonly phase: 'unstarted' }
  /**
   * An attempt is IN FLIGHT for this generation.
   *
   * `where` names the door that opened it ({@link RestorationDoor}), and the
   * honest answer to seeing this at all is "wait", never "drive": a second
   * driver would open a rival restoration against the same container.
   */
  | { readonly phase: 'restoring'; readonly where: RestorationDoor; readonly since: number }
  /** The work directory is attached AND every supervised process, listener and
   *  port came back. The only phase that is `ready`. */
  | { readonly phase: 'attached' }
  /**
   * The work directory is attached and something else did not come back.
   *
   * OPERATIONS ARE STILL ADMITTED, and that is the point of the phase rather
   * than an oversight: a box that refused `exec` could not be repaired by the
   * agent whose service failed. `incomplete` is what did not come back, always
   * present — a `repair` with nothing to repair is `attached`.
   */
  | { readonly phase: 'repair'; readonly incomplete: string }
  /**
   * There is no attached work directory, so operations refuse.
   *
   * `retry` is the ladder's own answer, carried rather than re-derived: TRUE
   * means the taxonomy promised this identity another attempt, FALSE means the
   * class is terminal and `attachNow()` is the only repair. It is a FIELD
   * because the promise has to be actionable by something other than the one
   * schedule row that carries it — a `retry` whose arming write is lost leaves
   * a box refusing for ever on a retry nothing is holding.
   */
  | { readonly phase: 'unattached'; readonly reason: string; readonly retry: boolean };

/**
 * A settled restoration, as the durable row holds it: everything but the two
 * transient phases. Written beside the boot id it settled on, read back by an
 * activation whose memory is gone, deleted on every generation turnover. A row
 * is adopted only beside a container boot id that still names this instance,
 * so it can never settle a box onto a container it did not restore.
 */
type SettledRestoration = Extract<Restoration, { readonly phase: 'attached' | 'repair' | 'unattached' }>;

/**
 * What the FIRST operation admitted after a restoration is entering.
 *
 * The readiness gate's answer, returned rather than merely recorded. A caller
 * that is let into a `repair` box is entering a world where a named service did
 * not come back, and it used to have no way to know that from the call it made:
 * the gate resolved `void` for both outcomes and the difference lived in a
 * separate `devboxState()` poll nobody was obliged to make.
 */
export type RestoreAdmission =
  | { readonly kind: 'restored' }
  | { readonly kind: 'repair'; readonly incomplete: string };

/**
 * What a restore witness is told, in the order one attempt says it: `opened`
 * once, each {@link RestorePhase} as it lands, `settled` once with the
 * attempt's wall time. The two ends are not phases — the bench keeps them as
 * the row's `at` and `wallMs`, the phases as its stamps.
 */
export type RestoreClockPhase = 'opened' | RestorePhase | 'settled';

/** One attempt's clock: when it opened, and the phases stamped against it. */
interface RestoreClock {
  readonly openedAt: number;
  stamps: RestorePhaseStamps;
}

/** What a boot stamp that did not land contributes to the incompleteness
 *  reason, by the outcome the step reported.
 *
 *  A TABLE, because one of the three is counter-intuitive and a nested ternary
 *  hid it: `pending` — a repair that found no stamp and was not asked to retry
 *  one — reports the FAILED wording deliberately, since that is the sentence the
 *  next repair reads to decide it must retry the stamp. Changing it to "pending"
 *  would silently disable that retry. */
const STAMP_MISSING = {
  late: 'the boot id stamp is still pending',
  failed: 'the boot id stamp failed',
  pending: 'the boot id stamp failed',
} as const;

/**
 * The phase a settled restoration is in, from what did not come back.
 *
 * ONE BUILDER FOR TWO CALL SITES — the ordinary restore and the attached-container
 * repair — because this mapping IS the contract the two phases now carry:
 * nothing missing is `attached`, anything missing is `repair` and names it. The
 * two copies of this ternary that used to stand at those call sites are how
 * `attached` came to mean both things.
 */
function settledRestoration(
  down: readonly string[],
  stamp: keyof typeof STAMP_MISSING | 'done',
): Restoration {
  const missing = stamp === 'done' ? down : [...down, STAMP_MISSING[stamp]];

  if (missing.length === 0) return { phase: 'attached' };

  return { phase: 'repair', incomplete: missing.join('; ') };
}

/**
 * Is this durable value a settled restoration this box wrote? The row is only
 * ever written by `#settle`, but a value that fails this check is refused
 * rather than adopted: adopting a half-shaped phase would admit callers into a
 * state the box never established.
 *
 * Parsed strictly, the way the ladder row is: the boundary is `StoredValue` —
 * what durable storage can actually hand back — and a half-shaped row is
 * refused rather than narrowed by hand.
 */
const SettledRestorationSchema = v.variant('phase', [
  v.strictObject({ phase: v.literal('attached') }),
  v.strictObject({ phase: v.literal('repair'), incomplete: v.string() }),
  v.strictObject({ phase: v.literal('unattached'), reason: v.string(), retry: v.boolean() }),
]);

function isSettledRestoration(stored: StoredValue): stored is SettledRestoration {
  return stored !== undefined && v.safeParse(SettledRestorationSchema, stored).success;
}

/** One attempt's hold on the ladder row: the token it claimed, the stage that
 *  claim preserved, and whether the row it read was readable at all. */
interface RecoveryClaim {
  readonly token: string;
  readonly admit: boolean;
  readonly stage: RecoveryStage | undefined;
}

/** The ladder row, built so an absent stage is an absent KEY rather than a key
 *  holding undefined: the row is parsed strictly, and a shape that only one
 *  builder can produce is the reason that parse can stay strict. */
function recoveryRow(owner: string, stage: RecoveryStage | undefined): RecoveryRow {
  return stage === undefined ? { owner } : { owner, stage };
}

/**
 * The base class's own `readFile` overloads, recovered structurally.
 *
 * `Sandbox.readFile` is declared twice — `encoding: 'none'` returns a stream
 * result, everything else a value result — and the SDK exports neither result
 * type. Matching the method type against a two-signature shape infers both arms
 * in declaration order, so the override below can be typed FROM the pinned
 * declaration with nothing copied. If a release changes that declaration, this
 * stops resolving and the compiler says so.
 */
type ReadFileArms<Method> = Method extends {
  (...args: infer StreamArgs): infer StreamResult;
  (...args: infer ValueArgs): infer ValueResult;
} ? {
  stream: { args: StreamArgs; result: StreamResult };
  value: { args: ValueArgs; result: ValueResult };
} : never;

type ReadArms = ReadFileArms<Sandbox<unknown>['readFile']>;

type ReadStreamOptions = NonNullable<ReadArms['stream']['args'][1]>;

type ReadValueOptions = NonNullable<ReadArms['value']['args'][1]>;

export class Devbox<Env = unknown> extends Sandbox<Env> {
  #storage: DevboxStorage | undefined;
  /**
   * The lifecycle attempt this box is on, and the fence for every write below.
   *
   * A startup attempt is abandoned in four ways — a container start, a
   * replacement the heartbeat spotted, a graceful stop, and an attach that
   * overran its budget — and in each the abandoned continuation keeps running
   * with its own view of the world. It used to be able to publish readiness for
   * a generation that no longer existed, file that generation's attach failure,
   * and CLEAR THE SINGLE-FLIGHT ENTRY OF ITS SUCCESSOR, after which the next
   * caller started a second concurrent restoration against the same container.
   * Owning a token and re-checking it after every await makes a stale
   * continuation inert instead of destructive.
   */
  #generation = 0;
  /** The attempt in flight and the generation that owns it. A caller joins it
   *  only when the generation still matches: joining a superseded attempt means
   *  waiting on work whose result is already discarded. */
  #startup: { readonly generation: number; readonly run: Promise<void> } | undefined;
  /** The clock of the restore in flight, opened by the attempt on its
   *  delivered frame and read by every phase stamp until the attempt settles.
   *  Memory only: a witness that wants the stamps past a reset keeps them
   *  itself, through `onRestorePhase`. */
  #phaseClock: RestoreClock | undefined;
  #restoration: Restoration = { phase: 'unstarted' };
  /** RESTORE PENDING: something happened to the container that this box has
   *  not yet reconciled with the phase it holds — a container start (the hook
   *  marks it, every time it fires), or an activation over a running container
   *  whose durable rows name a settled restoration. Both gates deliver no
   *  timer, so neither asks the container: a control server that accepts the
   *  connection and never answers would hold the block to the platform's
   *  cancel, the reset would repeat it, for ever. The question — is this the
   *  instance the rows name — is asked on the first delivered frame instead
   *  (`#resolveAdoption`), where the SDK's own request deadline fires. Until
   *  then the box admits nobody on the strength of what it held before. */
  #adoptionPending = false;
  /** The work-directory holders the last release pass signalled, kept only
   *  long enough for a refused detach to name them. Cleared on every detach
   *  attempt, successful or not, so a later refusal cannot blame a stale list. */
  #lastWorkdirHolders: readonly { readonly pid: string; readonly comm: string }[] | undefined;
  #lastInteraction: number | undefined;
  #lastInteractionPersisted = 0;
  /** Every strategy checkpoint on this instance runs through one gate, so two
   *  overlapping entry points can never interleave inside a strategy. */
  #lane = createCheckpointLane();
  /** Public work with no resource name: shell commands and supervised starts.
   *  Resource and checkpoint work reports directly through their own lanes. */
  #activeCallers = 0;
  /**
   * A repair can tear down/recreate storage mounts while a checkpoint can start
   * a container runner. One FIFO owns that shared storage graph from runner
   * admission through finalization, so neither path can observe a preflight
   * fact and mutate beneath work the other path just admitted.
   */
  #storageMutationTail: Promise<void> = Promise.resolve();

  async #withStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#storageMutationTail.then(operation);
    this.#storageMutationTail = (async () => {
      try {
        await run;
      } catch (cause) {
        console.error(`[devbox] storage mutation released its FIFO after failure: ${describe({ cause })}`);
      }
    })();

    return await run;
  }

  /** One caller at a time per container resource, shared by every facet of this
   *  workspace because they all reach this object. See
   *  {@link createResourceLane} and the banner below. */
  #resources = createResourceLane();

  /**
   * Sweep dead schedule rows at OBJECT ACTIVATION, ahead of the alarm loop.
   *
   * MEASURED IN PRODUCTION (build 6d19d50e7): `Callback snapshotWorkspaceIfDue
   * not found or is not a function`, twice a second per sandbox object, with
   * the alarm re-arming for ever. The sweep used to run in `onStart`, but the
   * SDK fires that hook from `start()` and `startAndWaitForPorts`
   * (`container.js:583, 632-636`) — never on a wake whose container is asleep.
   * A sleeping container's object still runs its alarm loop
   * (`container.js:1502`), which logs a dead row and keeps it (`:1532-1535`),
   * then re-arms from the non-empty table (`:1556-1563`); a due row re-arms at
   * once, which is the twice-a-second spin.
   *
   * The constructor is the one place that runs before that loop can read the
   * table. The SDK's own constructor queues its block first
   * (`container.js:355-360`), and the runtime delivers no event — alarm
   * included — until every block queued from a constructor settles. Either
   * execution order is safe: `scheduleNextAlarm` never reads the table
   * (`container.js:1624-1634`).
   *
   * An emptied table ends the chain on its own. With the container asleep and
   * no rows left, the next alarm deletes the physical alarm itself
   * (`container.js:1556-1560`), so the sweep issues no `deleteAlarm`: one
   * fired beside a live row would end a live chain.
   *
   * The sweep is storage only: one sync SELECT plus sync deletes, no container
   * I/O and no R2. So is what follows it: when the container is already
   * running and the durable rows name a settled restoration — a post-reset
   * activation whose container never restarted — the activation marks the
   * adoption pending, and the first delivered frame asks the container
   * whether it is that instance (`#adoptOrTurnOver`). A fresh box, or a
   * stopped container, marks nothing: with no rows there is nothing to adopt.
   */
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Not awaited: a constructor cannot be. The gate holds every event until
    // the activation settles, and a storage failure here is the object's own
    // SQLite failing, which the first request will report on its own terms.
    void ctx.blockConcurrencyWhile(() => this.#activate())
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] activation failed: ${describe({ cause })}`);
      });
  }

  /**
   * One activation's own work, inside its gate: sweep the dead schedule rows,
   * then note the running container's settled restoration as ADOPTION
   * PENDING. Storage only — no container command runs in this gate, because
   * the gate delivers no timer to bound one: a control server that accepts
   * the connection and never answers would hold the block to the platform's
   * 30 s cancel, the reset would activate again, and the same command would
   * hang again, with no request, alarm, stop or destroy ever delivered. The
   * boot id is compared on the first delivered frame (`#resolveAdoption`),
   * where the SDK's request deadline can fire.
   */
  async #activate(): Promise<void> {
    await this.#sweepUnknownSchedules();

    if (this.ctx.container?.running === true) {
      this.#adoptionPending = (await this.#durableClaim()) !== undefined;
    }
  }

  /** The durable side's claim about the running instance: the boot id it
   *  stamped and the phase it settled beside it, or undefined without both. */
  async #durableClaim(): Promise<{ readonly expected: string; readonly settled: SettledRestoration } | undefined> {
    const [expected, settled] = await Promise.all([
      this.ctx.storage.get<string>(BOOT_ID_KEY),
      this.ctx.storage.get<SettledRestoration>(SETTLED_KEY),
    ]);

    if (expected === undefined || !isSettledRestoration(settled)) return undefined;

    return { expected, settled };
  }

  /**
   * Settle a pending adoption on a delivered frame, before anything reads the
   * restoration it would decide: the request door, the heartbeat and the
   * checkpoint's replacement check all pass here first.
   *
   * A MATCH ADOPTS; A MISMATCH OVER A SETTLED PHASE TURNS THE GENERATION
   * OVER. Memory can name `attached` for an instance that is gone — the
   * container was stopped and started again under this live object, and the
   * hook that fired for the new instance could only mark, not ask. Serving
   * that phase would admit a caller onto a bare `/workspace`; the turnover
   * leaves the box `unstarted`, and the door that asked drives the restore.
   */
  async #resolveAdoption(): Promise<void> {
    if (this.#adoptionPending) await this.#adoptOrTurnOver();
  }

  /**
   * Adopt the running container's restoration when the durable rows prove it
   * is the instance this box restored; turn the generation over when the
   * container REFUTES them; do nothing when there is nothing to compare.
   *
   * ONE CONTAINER COMMAND, and only when the durable side has a claim to check:
   * the boot id it stamped beside the settled phase. A fresh box holds neither
   * and returns before touching the container, so construction and unrelated
   * drives pay nothing. A match adopts the settled phase into memory — a
   * refusal included, which the caller reads for itself.
   *
   * THE EVIDENCE FOR A TURNOVER IS AN ANSWER, never an absence. A container
   * that answers with a different id, or none, when the rows name one is an
   * instance this box never restored, and a settled phase held in memory for
   * it would admit a caller onto a bare `/workspace`. Rows that are not there
   * prove nothing: memory names `attached` for a moment before the settled
   * row lands (`#settle` sets memory, then writes), and a frame that read the
   * rows in that window used to turn over a generation that was settling
   * correctly, superseding the attempt that had just restored the box.
   *
   * TIMED LIKE A RESTORE when it asks: the witness sees `opened`, `bootId` on
   * a match, and `settled`, so a wake that adopted reports what the adoption
   * cost rather than the last restore's row. An attempt in flight keeps its
   * clock: an adoption asked mid-attempt — a re-entered hook marking pending
   * while the row still names a refusal — is not timed over it.
   */
  async #adoptOrTurnOver(): Promise<void> {
    this.#adoptionPending = false;
    const claim = await this.#durableClaim();

    if (claim === undefined) return;
    const clock = this.#phaseClock === undefined ? this.#openClock() : undefined;

    try {
      if ((await this.#readBootId()) === claim.expected) {
        this.#stampPhase('bootId');
        this.#restoration = claim.settled;

        return;
      }
    } finally {
      if (clock !== undefined) this.#settleClock(clock);
    }

    const held = this.#restoration;

    if (held.phase !== 'attached' && held.phase !== 'repair') return;
    console.error(
      '[devbox] the box claims a restoration the container does not carry; restoring it '
      + 'rather than serving callers a world that is gone',
    );
    this.#invalidateGeneration();
  }

  // ── the override surface ─────────────────────────────────────────────────

  /**
   * Where this box keeps its durable bytes, or undefined for an ephemeral box.
   *
   * A subclass supplies it because only a subclass knows its own `Env`, and the
   * binding has to be named twice for two real reasons: `mountBucket` resolves
   * a binding by name inside the container, and the snapshot chain reads and
   * writes objects straight through the resolved binding.
   */
  protected get store(): DevboxStore | undefined {
    return undefined;
  }

  /** Which durability strategy this box uses. It cannot change for a box that
   *  already holds bytes: the two write different things. A subclass picks one
   *  and keeps it, which is why this is a class-level getter and not an
   *  argument. */
  protected get strategy(): DevboxStrategyName {
    return DEFAULT_DEVBOX_STRATEGY;
  }

  /** The timings this box runs on. */
  protected get policy(): DevboxPolicy {
    return DEFAULT_DEVBOX_POLICY;
  }

  /**
   * May this box fall back to archiving and extracting whole trees?
   *
   * FALSE by default, which is the production answer. Extraction exists so a
   * plain local `wrangler dev` works at all: it has no container outbound
   * interception, so no store mount and no lazy layer. A deployed box that took
   * it silently would archive a base and then never archive another byte,
   * because a plain directory has no overlay upper to capture.
   *
   * A local-development host overrides this to true. Nothing discovers it.
   */
  protected get allowExtraction(): boolean {
    return false;
  }

  /**
   * What a whole-tree base leaves behind for THIS box.
   *
   * Defaults to the regenerable trees in `CHAIN_EXCLUDES`. A box whose
   * `target/` or `dist/` really is the work overrides this and keeps them; the
   * cost is a larger base, which an attach does not pay because layers mount
   * lazily.
   */
  protected get archiveExcludes(): readonly string[] {
    return CHAIN_EXCLUDES;
  }

  /** The hostname preview URLs are served under, or undefined when previews are
   *  unavailable. Undefined is honest: a port's forwarding is not re-activated,
   *  and the box says so, instead of handing back a URL that cannot resolve. */
  protected get previewHost(): string | undefined {
    return undefined;
  }

  /**
   * Does the host still hold work bound to this container?
   *
   * A veto on quiescing. The default is `false`, which is right for a box with
   * no host-side work queue: nothing outside the box knows about pending work,
   * so nothing can claim there is any. A host that DOES queue work must
   * override this, because a box stopped underneath a running job costs that
   * job an attach and possibly its progress.
   */
  protected hasBackgroundWork(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * A lifecycle failure the host should know about.
   *
   * Already written down durably before this is called, so a handler that
   * throws loses nothing: delivery retries by schedule. Return `queued` when
   * the incident is accepted and `rejected` when its shape is wrong — a
   * rejection is a defect in this class and is never retried, while a throw is
   * treated as transient and is.
   *
   * The default records it and accepts it, so an unconfigured box keeps a
   * readable ledger instead of dropping failures on the floor.
   */
  protected onIncident(incident: DevboxIncident, attempt: number): Promise<IncidentDisposition> {
    console.error(
      `[devbox] incident ${incident.incidentId} at ${incident.stage} `
      + `(delivery attempt ${attempt}): ${incident.reason}`,
    );

    return Promise.resolve('queued');
  }

  /**
   * The restore in flight moved: it `opened` (at 0), a phase landed, or it
   * `settled` — each `atMs` after the attempt opened on its delivered frame.
   * The default reports nothing. A witness overrides it to keep the stamps
   * somewhere a platform reset cannot erase; synchronous, because the
   * attempt waits for nothing of the witness's.
   */
  protected onRestorePhase(_phase: RestoreClockPhase, _atMs: number): void {
    void _phase;
    void _atMs;
  }

  /** The first landing of `phase` on the open clock; a repeat is not a phase. */
  #stampPhase(phase: RestorePhase): void {
    const clock = this.#phaseClock;

    if (clock === undefined || clock.stamps[phase] !== undefined) return;
    const atMs = Date.now() - clock.openedAt;
    clock.stamps = { ...clock.stamps, [phase]: atMs };
    this.onRestorePhase(phase, atMs);
  }

  /** Open the clock one attempt's phases are stamped against, and tell the
   *  witness. The attempt closes it with {@link #settleClock}. */
  #openClock(): RestoreClock {
    const clock: RestoreClock = { openedAt: Date.now(), stamps: {} };
    this.#phaseClock = clock;
    this.onRestorePhase('opened', 0);

    return clock;
  }

  /** Close `clock` if it is still the one open: a superseded attempt closing
   *  its successor's clock would drop the successor's stamps. */
  #settleClock(clock: RestoreClock): void {
    if (this.#phaseClock !== clock) return;
    this.#phaseClock = undefined;
    this.onRestorePhase('settled', Date.now() - clock.openedAt);
  }

  // ── container start ──────────────────────────────────────────────────────

  /**
   * Whether this box arms its own periodic checkpoint schedule.
   *
   * TRUE for a product box: the schedule is what makes the durable state
   * converge without a caller asking. A benchmark box overrides this to
   * `false`, because during a driver-owned measurement an ambient tick can
   * commit the pending change and reset the last-checkpoint stamp, so the
   * driver's own measured tick then answers `skipped (within the minimum
   * checkpoint interval)` or `skipped (unchanged)` — the measured ops land
   * outside the flush window and the arm reports a skip class that depends on
   * alarm phase. With the schedule off, the DRIVER's checkpoint is the only
   * tick source; the interval gate itself still applies to it, which is the
   * guard a driver waits out before ticking.
   */
  protected get ambientCheckpoints(): boolean {
    return true;
  }

  /**
   * THE CONTAINER-START HOOK ARMS THE BOX, MARKS THE RESTORE PENDING, AND
   * REACHES NO CONTAINER.
   *
   * `Container.onStart` is awaited inside `blockConcurrencyWhile`
   * (`@cloudflare/containers`, `container.js:583`), so this is the one method
   * on this class that runs while the platform's own critical section is held
   * — and a Durable Object timer set inside that block is not delivered until
   * the block releases. That is the whole reason the restore does not run
   * here. The owner's earlier placement DID restore here, so that nothing
   * could observe a half-restored box; measured on six fresh container starts
   * (2026-09-10, `bench/measure-first/DECISIVE-2026-09-05.md`) it admitted
   * one and the platform reset five at the `do.block_concurrency.cancel_ms`
   * cap with no phase stamped. The first command on a fresh container opens
   * the SDK's control connection, whose connect abort (`@cloudflare/sandbox`,
   * `dist/sandbox-CPj2jsbz.js:3563`, `DEFAULT_CONNECT_TIMEOUT_MS`, 30 s) and
   * retry backoff (`:812`, `DEFAULT_INITIAL_RETRY_DELAY_MS`, 3 s) are both
   * Durable Object timers: a container whose server is not yet accepting at
   * the first attempt either hangs to an abort that cannot fire or sleeps on
   * a retry that cannot wake, and the platform's cap is what ends it. The
   * platform's own "no container instance" wait is paid OUTSIDE
   * this block, in `startContainerIfNotRunning`; the block opens the moment
   * the instance exists, before the server inside it accepts. Structural,
   * not a margin: no budget consulted between commands can shorten the one
   * command in flight.
   *
   * WHAT SURVIVES OF THE EARLIER PLACEMENT is the invariant it was chosen
   * for: nothing is admitted onto a container this box has not restored or
   * adopted. The hook marks the restore PENDING (`#adoptionPending`), so the
   * first delivered frame compares the container's boot id against the
   * durable row before any phase settled earlier can admit anyone; a match
   * adopts, a mismatch turns the generation over and the door drives the
   * restore under the raced budget, where deadlines fire. Once per instance
   * holds through the boot id, not through this hook: the SDK fires the hook
   * from its own control paths on a container that is already up, so a hook
   * that restored, or turned the generation over, on every entry would fence
   * the very attempt it opened.
   *
   * STORAGE ONLY, and the gate holds it to that: `scripts/do-init-gate.ts`
   * requires the `BOUNDED_STORAGE_ONLY` marker, refuses `async` and any
   * own-scope await, and scans the method handed back for container reaches
   * and Durable Object timers by name.
   * `packages/devbox/tests/restore-after-start.test.ts` proves the shape
   * against a container that never answers.
   */
  override onStart(): Promise<void> {
    void BOUNDED_STORAGE_ONLY;

    return this.#noteContainerStart();
  }

  /** The work the hook hands the gate: mark, then arm. Armed here rather than
   *  by the door, because a reset between this frame and the first delivered
   *  one must leave rows that continue the work; the attempt that settles
   *  retires the startup row it no longer needs. */
  async #noteContainerStart(): Promise<void> {
    this.#adoptionPending = true;
    await this.#armContainerSchedules();
  }

  /**
   * The durable row is what a post-reset activation adopts, so every site that
   * settles the box goes through here rather than writing memory alone. The
   * transient phases delete the row instead: a stale settled phase beside a
   * turned-over generation is a box the next activation would adopt onto a
   * container it never restored.
   */
  async #settle(restoration: Restoration): Promise<void> {
    this.#restoration = restoration;

    if (
      restoration.phase === 'attached'
      || restoration.phase === 'repair'
      || restoration.phase === 'unattached'
    ) {
      await this.ctx.storage.put(SETTLED_KEY, restoration);
    } else {
      await this.ctx.storage.delete(SETTLED_KEY);
    }
  }

  /**
   * The three durable chains this box rides, armed from the container-start
   * hook. Dead rows are swept at activation, not here: see the constructor.
   *
   * THE STARTUP ROW GOES THROUGH `kickStartup`, not through a bare `#arm`, and
   * the difference is a loop. A settled box arms nothing and the chain ends
   * where it should; a box with nothing restored arms one successor one second
   * out. `kickStartup` owns the only question worth asking — is anything going
   * to try — and answers it from the box's own phase.
   *
   * The checkpoint and heartbeat rows are periodic and `#arm` is future-only, so
   * asking again costs one schedule read.
   */
  async #armContainerSchedules(): Promise<void> {
    await this.kickStartup();

    if (this.ambientCheckpoints) {
      await this.#arm(CHECKPOINT_CALLBACK, Math.ceil(this.policy.checkpointIntervalMs / 1000));
    }

    await this.#arm(HEARTBEAT_CALLBACK, this.policy.heartbeatSeconds);
  }

  /**
   * Drop schedule rows naming a callback this class cannot call.
   *
   * MEASURED DEFECT THIS REPAIRS, in production logs rather than in theory:
   * `Callback snapshotWorkspaceIfDue not found or is not a function`, twice a
   * second per sandbox object, for ever. The alarm loop in
   * `@cloudflare/containers` (`container.js:1532-1535`) looks the callback up
   * on `this`, logs that line when it is missing, and `continue`s — WITHOUT
   * deleting the row, so the row outlives every deployment. It then re-arms
   * the alarm because the table is not empty, which also keeps this object's
   * alarm chain alive for work nothing can run. The rows were written by the
   * snapshot machinery, whose callbacks were renamed when it moved into this
   * package (`devboxCheckpoint` / `devboxHeartbeat` / `devboxIncidents`, at
   * c264ef04b), and nothing since has been able to reach them.
   *
   * AT ACTIVATION, NOT AT CONTAINER START. The constructor queues this in its
   * activation gate, which settles before the alarm loop can read the table;
   * `onStart` never fires on a wake whose container is asleep, so a sweep
   * there could not reach the rows that spin the loop.
   *
   * BY WHETHER THIS CLASS CARRIES THE MEMBER, which is the question the alarm
   * loop itself asks a moment later — so nothing survives the sweep that the
   * loop could have run, and nothing is dropped that it could not. A name list
   * would need editing every time a callback is retired, and it would be wrong
   * the once it was forgotten.
   *
   * BOUNDED, and that is why it may run inside the init gate: one `SELECT
   * DISTINCT` over this object's own schedule table — the SDK keeps it in this
   * object's SQLite (`container.js:389-399`) — plus one delete per dead name.
   * The delete is the SDK's own `deleteSchedules`, so the destructive half is
   * spelled in the vocabulary that owns the table.
   */
  async #sweepUnknownSchedules(): Promise<void> {
    // The SDK's own constructor created `container_schedules` synchronously
    // before this runs (`container.js`, the `CREATE TABLE IF NOT EXISTS` right
    // after its options block), so the read needs no guard.
    const rows = this.ctx.storage.sql
      .exec<{ callback: string }>('SELECT DISTINCT callback FROM container_schedules')
      .toArray();

    for (const { callback } of rows) {
      // MEMBERSHIP ON `this`, which carries the prototype chain: a callback this
      // class inherits from the SDK reads as live, and a subclass's own callback
      // reads as live too, so nothing a live class can dispatch is ever swept.
      // `in` rather than a callability check because every arming site names a
      // METHOD, and because reading a member by string is what this repo's
      // `no-reflect-get` / `no-runtime-typeof` rules refuse. Same probe, same
      // reason, as `OrchestratorAgent.canDispatch`
      // (packages/cf-backend/src/orchestrator.ts:968).
      if (callback in this) continue;
      console.error(
        `[devbox] dropping the schedule row for \`${callback}\`: this class carries no such `
        + 'member, so the alarm loop can only log it and keep the row for ever',
      );
      this.deleteSchedules(callback);
    }
  }

  /**
   * Stamp this container instance with an id, and mirror it durably.
   *
   * The platform can reclaim a container instance at any moment and give the
   * Durable Object a fresh one. Nothing tells the object that happened: measured
   * on a deployed probe, the heartbeat chain ticked healthily through an
   * 11-minute idle while the instance underneath was replaced and the ephemeral
   * marker vanished. So the container carries an id that dies with it, and the
   * object keeps a copy; a mismatch is a replacement, and it is the only
   * reliable signal there is.
   *
   * FENCED, like every other write a restoration makes, and fenced BEFORE the
   * container write as well as after it. The stamp is the last phase and the one
   * with the most awaits before its writes: the previous-id read, the container
   * read, the replacement count, and the exec itself. A stale attempt that
   * parked at any of them used to run its writes anyway — overwriting the
   * SUCCESSOR's boot id with one naming a container that no longer exists, which
   * the heartbeat's replacement detector then read as a mismatch on a healthy
   * container and answered with a spurious replacement. The replacement count is
   * fenced for the same reason: the successor counts the replacement it sees, so
   * a stale attempt counting again is the same event measured twice.
   */
  async #stampBootId(generation: number): Promise<void> {
    // COUNT THE REPLACEMENT HERE, where the evidence is, not where it happens to
    // be noticed. Every restoration passes through this method, whether the
    // startup row, a readiness request or a heartbeat that spotted the
    // mismatch itself drove it. Counting in the heartbeat alone under-reported
    // exactly the case worth measuring: a replacement handled by another door
    // incremented nothing, so a box could be replaced repeatedly and report zero.
    const previous = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    if (this.#owns(generation) && previous !== undefined && (await this.#readBootId()) !== previous) {
      const replaced = (await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0) + 1;

      if (this.#owns(generation)) await this.ctx.storage.put(REPLACED_COUNT_KEY, replaced);
      console.error(`[devbox] the container instance was replaced (${replaced} so far)`);
    }

    // NOTHING IS WRITTEN INTO A CONTAINER THIS ATTEMPT NO LONGER OWNS. Every
    // line above is an await, so the generation can already have turned over by
    // the time this one runs — and writing here and repairing below is NOT the
    // same as never writing. `#containerWasReplaced` compares the container file
    // against the durable row, so for the whole gap between a stale write and
    // its repair a HEALTHY container reads as replaced: a heartbeat landing
    // there re-drives the entire restoration and counts a phantom replacement.
    // The successor owes both writes; a superseded attempt owes neither.
    if (!this.#owns(generation)) return;
    const bootId = crypto.randomUUID();
    await this.#rawExec(`printf %s ${bootId} > ${BOOT_ID_PATH}`);

    // The exec is the one await a stale attempt can park INSIDE, which the check
    // above cannot cover, so ownership is re-asked after it too. A lost race
    // here means a successor has already stamped this container and the durable
    // row with ITS id, and this attempt's exec has just written its own id over
    // the file. The stale mint is not allowed to survive that: the durable row
    // is the identity of record, so the file is rewritten to whatever the row
    // now holds, leaving file and row in agreement rather than diverged with no
    // writer left to reconcile them.
    if (!this.#owns(generation)) {
      const settled = await this.ctx.storage.get<string>(BOOT_ID_KEY);

      if (settled !== undefined && settled !== bootId) {
        await this.#rawExec(`printf %s ${settled} > ${BOOT_ID_PATH}`);
      }

      return;
    }

    await this.ctx.storage.put(BOOT_ID_KEY, bootId);
    this.#stampPhase('bootId');
  }

  /**
   * Was the container this box restored replaced underneath it?
   *
   * ONE COMPARISON, THREE CALLERS: the heartbeat, which re-drives a restoration
   * it finds stale, and the two commit entry points, which must not report a
   * commit against a container that is gone. A box with no stamp has made no
   * claim about any instance, so it answers `false` rather than `replaced`.
   */
  async #containerWasReplaced(): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    return expected !== undefined && (await this.#readBootId()) !== expected;
  }

  /**
   * Re-attach before committing when the instance underneath was replaced.
   *
   * MEASURED DEFECT THIS REPAIRS. `ensureReady()` accepts this object's
   * in-memory `attached` restoration as proof that THIS container holds the
   * mount, and the platform replaces a container instance without telling
   * anyone — measured at roughly once per workload phase under churn. Every
   * operation between that replacement and the next heartbeat (up to
   * `heartbeatSeconds`) therefore runs on a fresh container with NO mount, and
   * its writes land in the bare `/workspace` directory. Deployed boxes died of
   * it on 2026-08-31 in both shapes it takes: a mount the fresh container
   * refuses because the directory it must cover is no longer empty, and an
   * attach that lays a fresh overlay OVER those bytes, so the wake reports
   * `empty` for a box that had been written to.
   *
   * A COMMIT IS THE RIGHT PLACE TO ASK. It is the moment this box claims bytes
   * are durable, it happens at checkpoint cadence rather than per operation, and
   * one `cat` of the boot marker is the whole cost. The re-attach is the
   * ordinary restoration, so it goes through the same recovery ladder and the
   * same residue handling every attach has.
   */
  async #healReplacedContainer(): Promise<void> {
    await this.#resolveAdoption();
    // BOTH ADMITTING PHASES. A box in `repair` is serving callers over a work
    // directory too, so a commit against a replaced container is exactly as
    // wrong there as it is on a fully restored one.
    const held = this.#restoration;

    if (held.phase !== 'attached' && held.phase !== 'repair') return;

    if (this.ctx.container?.running !== true) return;

    if (!await this.#containerWasReplaced()) return;
    console.error(
      '[devbox] the container was replaced under an attached box; re-attaching before this '
      + 'commit rather than reporting one against a container that is gone',
    );
    this.#invalidateGeneration();
    await this.#drive('request');
  }

  /** The id this container instance is carrying, or undefined when the file is
   *  gone, which is what a replaced instance looks like. */
  async #readBootId(): Promise<string | undefined> {
    const read = await this.#rawExec(`cat ${BOOT_ID_PATH} 2>/dev/null || true`, DEVBOX_RUNTIME_DIR);
    const value = read.stdout.trim();

    return value.length > 0 ? value : undefined;
  }

  /**
   * ONE restore attempt, and it always CLASSIFIES.
   *
   * ON A DELIVERED FRAME, ALWAYS: `#startupAttempt` runs it under the raced
   * budget, where the deadline it races is delivered, and a failure climbs the
   * recovery ladder — classify, record, arm, and if the class says so destroy
   * the identity — because the timers that path waits on are delivered there.
   * The container-start hook never reaches here; it marks and arms, and this
   * is the frame that does the work.
   *
   * IT DOES NOT THROW; IT HANDS THE FAILURE BACK. Every outcome leaves the box
   * in a NAMED state (`attached`, `repair`, or `unattached` with the reason),
   * and the classified cause is RETURNED so a caller whose policy is to raise
   * one raises exactly that value rather than a second wording of it.
   *
   * IT SAYS SO WHILE IT RUNS, which is the other half. The first thing it
   * publishes is `restoring`, before the ladder claim's own await, so no window
   * exists in which an attempt is in flight and this box still reports that none
   * has begun. See {@link Restoration}: that window was measured as a 300 s
   * freeze in which every poll read `unstarted` and decided to wait. `where` is
   * the DOOR that opened it, passed in rather than inferred: a poller reading
   * `restoring` wants to know which door is driving.
   *
   * IT IS TIMED, entry to settle, on the clock every phase stamp reads
   * (`#openClock`): the witness sees `opened`, each landmark as it lands, and
   * `settled` with the wall time — however the attempt ended.
   */
  async #restoreNow(
    generation: number,
    where: RestorationDoor,
    steps: RestoreSteps,
  ): Promise<{ readonly cause: unknown } | undefined> {
    this.#restoration = { phase: 'restoring', where, since: Date.now() };
    const clock = this.#openClock();

    try {
      return await this.#classifiedRestore(generation, steps);
    } finally {
      this.#settleClock(clock);
    }
  }

  /** The attempt under the clock: claim the ladder, walk the restore, and
   *  hand back what the ladder made of a failure. */
  async #classifiedRestore(
    generation: number,
    steps: RestoreSteps,
  ): Promise<{ readonly cause: unknown } | undefined> {
    const claim = await this.#claimRecovery();

    if (!this.#owns(generation)) return undefined;

    if (!claim.admit) {
      // The ladder row did not parse, so there is no evidence to act on and
      // nothing may be destroyed on a guess. The claim has already normalised
      // the row to the terminal stage, so this refusal is readable and finite:
      // `attachNow()` re-attempts, and a success deletes the row.
      const reason = 'the attach-recovery record did not parse [unreadable → refuse]';
      await this.#settle({ phase: 'unattached', reason, retry: false });
      await this.#record('attach', reason);
      // TERMINAL, SO IT TAKES ITS WAKE-UP WITH IT — the same reason `#recover`
      // drops the row for `refuse` and `replace`: the container-start hook armed
      // one for a box with nothing restored, and a row that fires here files this
      // same refusal again every second.
      this.deleteSchedules(STARTUP_CALLBACK);

      return { cause: new Error(reason) };
    }

    try {
      await this.#attachAndRestore(generation, claim, steps);

      return undefined;
    } catch (error) {
      await this.#recover(generation, claim, { cause: error });

      return { cause: error };
    }
  }

  /**
   * The whole restoration under ONE clock, and TWO failure policies for its
 * steps.
   *
   * Every phase draws on the same budget: the attach, the workload restart, each
   * listener proof, each exposure, and the boot stamp. Only `attach()` used to be
   * bounded at all, and the listener proof carried a window PER PORT, so three
   * silent ports added three windows — about ninety seconds — with every caller
   * held in the readiness gate.
   *
   * WHAT EXHAUSTION MEANS DEPENDS ON WHAT IS ABANDONED, and that split is the
   * whole design. The attach is mid-mount: abandoning it leaves work no token
   * here can fence, which a retry would collide with, so it throws
   * {@link ContainerStartOverrun}, and the taxonomy answers that with the
   * recovery its evidence supports — replacing the identity. Every
   * step after it — a process that will not start, a listener that never
   * answers, a port that will not expose, a boot id that will not stamp —
   * mutates no mount, so exhaustion there is REPORTED: the box stays attached,
   * its specs stay, no failed port is exposed, `unready` names what did not come
   * back, and an agent or an explicit `attachNow()` can try again. Replacing a
   * healthy container because a dev server was slow to bind would be the cure
   * that destroys the patient.
   *
   * Nothing re-arms on that path either: an app the box cannot wait for is not a
   * reason to wake the box again on a timer.
   */
  async #attachAndRestore(
    generation: number,
    claim: RecoveryClaim,
    steps: RestoreSteps,
  ): Promise<void> {
    const outcome = await steps.attach(
      async () => await this.#requireStorage().attach(),
      (failure) => {
        console.error(
          '[devbox] the attach overran its budget and was abandoned; it later settled '
          + `with: ${describe({ cause: failure.cause })}`,
        );
      },
    );

    await this.#restorePhases(generation, claim, steps, outcome);
  }

  /** The phases after the attach, in order, each fenced by the attempt's
   *  generation and each drawing an allowance from the one budget. */
  async #restorePhases(
    generation: number,
    claim: RecoveryClaim,
    steps: RestoreSteps,
    outcome: AttachOutcome,
  ): Promise<void> {
    // THE ATTACH IS THE LONG AWAIT, and everything past this line is a write.
    // A generation can turn over entirely underneath it: the container is
    // replaced, the heartbeat spots it and drives a fresh attempt, and this one
    // arrives with an outcome describing a container that no longer exists.
    if (!this.#owns(generation)) return;
    this.#stampPhase('attached');
    await this.#recordAttach(outcome);
    const restored = await this.#restartWorkloads(generation, steps);

    if (!this.#owns(generation)) return;

    // Stamped after the whole walk, so no id exists on an instance whose
    // restoration is still half-done — a stamp taken earlier would make one look
    // healthy. It IS taken when a service failed to come back: the id answers
    // "which container instance is this", which the heartbeat's replacement
    // detection needs whether or not every service returned, and the
    // incompleteness reason is what answers "is this box ready".
    //
    // A STEP LIKE ANY OTHER, so it draws its own allowance and reports rather
    // than throws. A boot id the container will not write leaves the box in
    // `repair`, not replaced.
    const stamped = await steps.run(
      async () => await this.#stampBootId(generation),
      (failure) => {
        console.error(
          '[devbox] the boot-id stamp outran its allowance; it later settled with: '
          + describe({ cause: failure.cause }),
        );
      },
    );

    if (!this.#owns(generation)) return;
    // PUBLISHED, not just held: the durable row is what a post-reset activation
    // adopts, and the stamp above is what it checks the container against.
    await this.#settle(settledRestoration(restored, stamped.kind));
    // A SUCCESSFUL ATTEMPT IS THE ONLY THING THAT CLEARS THE LADDER, and only
    // while the row still names it. Cleared any earlier, a failure in a later
    // step of the same attempt — the boot-id stamp is the last of them — would
    // delete the stage it had just earned, and the ladder could never reach the
    // step that replaces a container failing in exactly that way. A restoration
    // that landed the work directory but not every service still clears it: the
    // box IS attached, and `repair` is what says the rest is not ready.
    await this.#releaseRecovery(claim, generation);
  }

  /**
   * THE ATTACH RECORD, and the one place it is written.
   *
   * It is what `devboxState` reports as `lastAttach`, what `attachNow` answers
   * with, and what the bench driver judges a startup by the moment the phase
   * says `attached` (`scripts/bench-devbox-strategies.ts`,
   * `startupPollVerdict`). So it is written by every drive that reaches
   * `attached` THROUGH AN ATTACH, and by no other: a drive that only re-runs
   * the service half writes none, because the record its own attach wrote for
   * this generation still describes what the box serves.
   *
   * Fenced by the caller: every writer asks `#owns` after its last await and
   * before this put, as every other durable write a restoration makes does.
   */
  async #recordAttach(outcome: AttachOutcome): Promise<void> {
    await this.ctx.storage.put(LAST_ATTACH_KEY, outcome);
    console.log(`[devbox] attach ${outcome.kind}: ${outcome.detail}`);
  }

  /**
   * THE SCHEDULE DOOR: the restoration, driven from the `devboxStartup` row.
   *
   * ONE OF TWO DOORS ONTO ONE RUN. The container-start hook arms this row and
   * marks the restore pending; this row and any readiness request
   * (`ensureReady` → `#drive('request')`) are the delivered frames that do the
   * work. Both join the same single-flight attempt, so whichever arrives first
   * does the work and the other waits on it.
   *
   * IT IS THE ONLY DRIVER FOR A BOX NOBODY IS ASKING ABOUT: a container
   * started and no request followed, the platform replaced a container
   * instance under a live object, or the object was reset mid-restore and the
   * SDK — which by then sees a running, healthy container — never calls the
   * start hook again. The row is durable, so it survives the reset that its
   * own frame died in.
   *
   * PUBLIC BECAUSE IT IS A SCHEDULE CALLBACK: `Container.schedule` rejects a
   * name it cannot call back on this class, and the alarm loop looks it up by
   * name (`@cloudflare/containers`, `container.js:1532`).
   */
  async devboxStartup(): Promise<void> {
    await this.#drive('schedule');
  }

  /**
   * Admit a container, then restore it — or join the attempt already doing so.
   *
   * `where` is the door this drive came through, and it travels no further than
   * the `restoring` phase it publishes: the work is identical either way.
   */
  async #drive(where: RestorationDoor): Promise<void> {
    // ADMISSION IS OBSERVED, NEVER ASSUMED, and it is asked on every attempt.
    //
    // MEASURED DEFECT THIS REPAIRS. The question used to be skipped whenever
    // `ctx.container.running` was true, and that flag says the platform holds an
    // instance — not that anything inside it answers. So the sequence a cold
    // start really produces was: attempt one asks the platform, gives up when
    // the port has not answered inside `portWaitMs`, and records an admission
    // refusal; the platform brings the container up regardless; attempt two sees
    // `running` and goes straight to the attach — against a container whose RPC
    // server may still be starting. Every exec the attach then makes retries
    // inside the SDK for up to two minutes apiece, which is how a restoration
    // consumed a 300 s container-start budget and reported nothing but the
    // overrun. Measured on the deployed benchmark, run 20260831184750.
    //
    // `start` IS the observation: it asks the platform for the instance and
    // proves it answers before returning, and it is idempotent on a container
    // already running — so asking again costs one health probe and buys the
    // guarantee that nothing below runs commands on a container that has never
    // answered one. It waits for the INSTANCE, never for an app port: a port
    // the box has not restored yet answers nothing, so a restore that starts
    // the app cannot wait behind that port — that is a deadlock by
    // construction, measured live on the deployed benchmark (every admission
    // refused on a running container whose port was dark). Each app port is
    // proved inside the restore instead, by its own listener proof under the
    // restoration budget.
    //
    // AND IT MARKS HEALTHY FIRST: the patched SDK sets healthy before the hook
    // in `start()` (see `patches/@cloudflare%2Fcontainers@0.3.7.patch`), the
    // way `startAndWaitForPorts` does after its port wait
    // (`container.js:632-636`) — so the first command the restore issues below
    // routes straight to the container instead of opening a nested start.
    //
    // ONLY A CONTAINER THAT WAS DOWN TURNS THE GENERATION OVER. A probe against
    // a running container observes the instance an in-flight attempt is already
    // restoring, so invalidating here would supersede that attempt and the
    // caller meant to JOIN it would open a second restoration against the same
    // container instead.
    if (this.ctx.container?.running !== true) this.#invalidateGeneration();
    // THE GENERATION THIS ADMISSION SPEAKS FOR, read before its own await. It is
    // a SECOND read from the one below on purpose: a refusal is only this
    // attempt's to report, while a probe that SUCCEEDED across a turnover is
    // still the restoration the live generation needs — so the refusal is fenced
    // and the restoration adopts whatever generation is current.
    const admitting = this.#generation;
    let admissionRefusal: string | null = null;

    try {
      await this.start(undefined, {
        portToCheck: this.defaultPort,
        // THE PROBE LASTS ITS WHOLE WINDOW. `retries: 1` makes the SDK's
        // `totalTries` exactly one, so the first refusal ends the call after
        // one poll and the abort below can never fire. The retry count is the
        // window divided by the interval — the SDK's own default shape — so
        // one call polls the whole window.
        retries: Math.ceil(this.policy.portWaitMs / ADMISSION_POLL_INTERVAL_MS),
        waitInterval: ADMISSION_POLL_INTERVAL_MS,
        // The PORT policy bounds the probe, which is the question it is named
        // for. It is not the container's admission deadline: a container still
        // coming up has not failed, so the answer to a probe that did not land
        // in that window is another probe, not a longer one.
        signal: AbortSignal.timeout(this.policy.portWaitMs),
      });
    } catch (error) {
      // Capacity and a container that has not answered yet are both admission
      // outcomes, not failed attachments. No recovery ladder applies to an
      // identity that was never admitted.
      //
      // AND A SUPERSEDED ADMISSION IS INERT, for the reason `#recover` is.
      // `start` is the longest await on this path — a whole `portWaitMs` — and
      // an attempt parked inside it holds no resource lane, no
      // checkpoint lane and no single-flight entry, so the heartbeat's own busy
      // check cannot see it and a quiesce can land there. Recording then puts a
      // live blocker about a container nobody asked to exist on the one channel
      // trusted, and arming wakes a box that was deliberately stopped, one
      // second after a `quiesce` that arms nothing on purpose.
      if (this.#owns(admitting)) {
        const failure = classifyRecovery({ cause: error });
        admissionRefusal = `[${failure} → retry] ${describe({ cause: error })}`;
        await this.#record('attach', admissionRefusal);

        if (this.#owns(admitting)) {
          // ASK AGAIN ON THE STARTUP CADENCE, not the heartbeat's. The re-arm used
          // to be `heartbeatSeconds`, so a container that needed a few more seconds
          // than one port probe allows was left unattached for a full heartbeat —
          // the dominant term in a 44,189 ms cold attach whose container was up
          // within seconds. This is the same row `kickStartup` arms, so the retry
          // rides machinery that already exists, and it cannot spin: each attempt
          // spends its own port probe before it can fail again.
          await this.#arm(STARTUP_CALLBACK, 1);
        }
      }
    }

    // THE ADMITTED-NOTHING EXIT, keyed on the named outcome the catch
    // classified: the container was never admitted, so there is no restoration
    // to report and no ladder to climb — the incident record and the successor
    // row are the whole answer, and every later caller re-enters through
    // `ensureReady()` → this callback.
    if (admissionRefusal !== null) return;
    // ADOPT, OR RESTORE. The admission above ran the start hook, which marked
    // the restore pending and armed the rows; this is the delivered frame that
    // asks the container which instance it is. A settled box on the same
    // instance is adopted — one durable read plus one `cat` — and a box whose
    // memory names a phase the container refutes turns its generation over.
    await this.#adoptOrTurnOver();

    // A SETTLED PHASE ADMITS, whether adopted just now or held in memory while
    // its durable row lands; only an unsettled box drives the attempt. An
    // adopted REFUSAL is not settled for this purpose: the ladder already
    // spoke, and this drive continues into the attempt the retry owes.
    if (this.#admission() !== undefined) return;
    const generation = this.#generation;
    const pending = this.#startup;

    // JOIN ONLY THIS GENERATION'S ATTEMPT. An entry from a superseded one is
    // work whose result is already discarded, so joining it would hand the
    // caller a restoration that never happened.
    if (pending !== undefined && pending.generation === generation) {
      return await this.#awaitAttempt(pending.run, where);
    }

    const run = this.#startupAttempt(generation, where);
    this.#startup = { generation, run };

    return await this.#awaitAttempt(run, where);
  }

  /**
   * Wait for the attempt the way THIS door is allowed to wait.
   *
   * THE ALARM DOOR DRIVES IT TO COMPLETION. It holds no caller, and a
   * restoration for a box nobody is asking about has to be driven by something.
   *
   * A REQUEST DOOR WAITS ONLY ITS OWN FRAME BUDGET, and then answers from the
   * restoration's state. What waits here is a request racing the one
   * attempt, and its answer is the honest one: `restoring`, for this long,
   * ask again. The box's own
   * readiness gate turns that into the re-askable refusal its callers already
   * classify; nothing is abandoned, because the attempt keeps running under the
   * single-flight entry and the next ask joins or reads it.
   *
   * A LATE FAILURE IS REPORTED, NEVER DROPPED: {@link runRestoreStep} keeps a
   * handler on the work it stopped waiting for, so an attempt that rejects after
   * its budget cannot surface as an unhandled rejection.
   */
  async #awaitAttempt(run: Promise<void>, where: RestorationDoor): Promise<void> {
    if (where === 'schedule') return await run;

    const joined = await runRestoreStep(
      this.policy.requestJoinMs,
      async () => await run,
      (failure) => {
        console.error(
          '[devbox] the restoration this request joined settled after the request had '
          + `answered: ${describe({ cause: failure.cause })}`,
        );
      },
    );

    // A FAILURE STILL TRAVELS. The caller asked for readiness, so a classified
    // refusal is its answer — the same value `#startupAttempt` raised.
    if (joined.kind === 'failed') throw joined.cause;
  }

  /**
   * THE GENERATION'S ONE ATTEMPT, fenced by the generation that owns it.
   *
   * The failure path is the recovery ladder in `lifecycle.ts` — a taxonomy, not
   * one retry policy — and every write it makes is guarded, including the
   * release of the single-flight entry: an attempt that released a successor's
   * entry let the next caller start a second concurrent restoration against the
   * same container.
   *
   * THE THROW IS THIS METHOD'S POLICY, and `#restoreNow` deliberately has none:
   * it classifies and hands the cause back, so the decision to raise belongs
   * here, where the caller is an operation — a commit that must not report
   * against a box with no work directory, or an `attachNow()` repairing on
   * somebody's behalf. The SDK's own error is what that caller sees and what its
   * own classifier reads; a message re-written here would be this class's second
   * opinion on it. A drive from the schedule door discards it: the alarm loop
   * reduces a thrown callback to a console line, and the ladder has already
   * recorded the failure and armed whatever comes next.
   *
   * RAISED EVEN WHEN SUPERSEDED. A superseded attempt publishes nothing, arms
   * nothing and destroys nothing — but it still OWES its caller an answer, and
   * "the work you asked for did not happen" is that answer whoever ended up
   * owning the lifecycle.
   */
  async #startupAttempt(generation: number, where: RestorationDoor): Promise<void> {
    let failed: { readonly cause: unknown } | undefined;

    try {
      failed = await this.#restoreNow(
        generation,
        where,
        racedRestoreSteps(openStartBudget(this.policy.attachBudgetMs)),
      );
    } catch (error) {
      // NOTHING MAY BE LEFT `restoring` FOR EVER. `#restoreNow` classifies every
      // restore failure and RETURNS it, so reaching this catch means something
      // outside the restore threw — this object's own storage, in the ladder
      // claim. Rethrowing alone would leave the phase at `restoring`, which is
      // the one reading `kickStartup` treats as "somebody is working on it": no
      // row would be armed and no poller would ever drive again. So the box is
      // left refusing WITH A REASON and with a successor armed, and the cause
      // still travels to whoever asked.
      if (this.#owns(generation)) {
        const reason = `the restoration could not run: ${describe({ cause: error })}`;
        await this.#settle({ phase: 'unattached', reason, retry: true });
        await this.#record('attach', reason);

        if (this.#owns(generation)) await this.#arm(STARTUP_CALLBACK, this.policy.heartbeatSeconds);
      }

      throw error;
    } finally {
      // OUR OWN ENTRY ONLY. Owning the generation is what proves the entry is
      // ours: a generation holds at most one live attempt, because a second
      // caller joins the first.
      if (this.#owns(generation)) this.#startup = undefined;
    }

    if (failed !== undefined) throw failed.cause;

    // A SETTLED RESTORATION RETIRES THE ROW THAT WOKE IT. The hook arms a
    // startup row for a box with nothing restored yet and the SDK runs that hook
    // on every admission probe, so a row outlives the attempt it asked for —
    // and a row that fires on an attached box costs a wake, a port probe and a
    // boot-id read, once a second, for as long as the box lives. Deleting it
    // here is what makes the chain end where the work ended.
    if (this.#owns(generation)
      && (this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair')) {
      this.deleteSchedules(STARTUP_CALLBACK);
    }
  }

  /**
   * Re-run only the service half of a restoration that settled in `repair`.
   *
   * This uses the startup flight because two explicit repairs must not race
   * process reservations, port exposures, or the boot marker. A caller asked
   * for it, so it runs on a delivered frame under the raced step policy.
   */
  async #repairAttached(generation: number): Promise<void> {
    const pending = this.#startup;

    if (pending !== undefined && pending.generation === generation) return await pending.run;

    return await this.#withStorageMutation(async () => {
      if (!this.#owns(generation)) return;
      const active = this.#startup;

      if (active !== undefined && active.generation === generation) return await active.run;

      const retryBootStamp = this.#restoration.phase === 'repair'
        && this.#restoration.incomplete.includes('the boot id stamp failed');

      const run = (async () => {
        const claim = await this.#claimRecovery();

        if (!claim.admit || !this.#owns(generation)) {
          throw new Error('attached-container repair could not claim recovery');
        }

        try {
          await this.#repairAttachedAttempt(generation, retryBootStamp);

          if (this.#owns(generation)) await this.#releaseRecovery(claim, generation);
        } catch (error) {
          await this.#recover(generation, claim, { cause: error });
          throw error;
        }
      })();

      this.#startup = { generation, run };

      try {
        await run;
      } finally {
        if (this.#owns(generation) && this.#startup?.run === run) this.#startup = undefined;
      }
    });
  }

  /**
   * The same-container half of a drive: prove the instance is the one this box
   * stamped, then re-run the service half alone.
   *
   * NO ATTACH RECORD IS WRITTEN HERE, and that is a claim about what this path
   * did. The attach is what establishes what a box serves, and this path does
   * not re-run it: the record the full attach wrote for this same generation
   * still describes the workspace, so overwriting it from a path that
   * re-established nothing would describe the box by what it did not do.
   */
  async #repairAttachedAttempt(generation: number, retryBootStamp: boolean): Promise<void> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    if (!this.#owns(generation)) return;
    const actual = await this.#readBootId();

    if (!this.#owns(generation)) return;

    if (expected !== undefined && actual !== expected) {
      this.#invalidateGeneration();
      await this.#drive('request');

      return;
    }

    const steps = racedRestoreSteps(openStartBudget(this.policy.attachBudgetMs));
    const restored = await this.#restartWorkloads(generation, steps);

    if (!this.#owns(generation)) return;

    const stamped = expected === undefined && retryBootStamp
      ? await steps.run(async () => await this.#stampBootId(generation), () => undefined)
      : expected === undefined ? { kind: 'pending' as const } : { kind: 'done' as const };

    if (!this.#owns(generation)) return;
    await this.#settle(settledRestoration(restored, stamped.kind));
  }

  /** Does the attempt that started on `generation` still own this lifecycle?
   *  Asked after every await that precedes a state write, an exposure, a
   *  cleanup, or the release of the single-flight entry. */
  #owns(generation: number): boolean {
    return this.#generation === generation;
  }

  /**
   * The container identity this box was restoring is gone, or going.
   *
   * ONE transition for the places that reach it, and every one of them holds
   * EVIDENCE: a container the door found stopped, a boot id that no longer names
   * the instance this box restored (the door and the heartbeat both ask), a
   * graceful quiesce, the activity expiry, and the destruction that follows an
   * attach whose work could not be fenced. Bumping the generation is what makes
   * every attempt still in flight state-inert — it can no longer publish
   * readiness, file an attach failure, release a successor's single-flight entry,
   * or destroy an identity it did not start on.
   *
   * The container-start hook never turns the generation over: the SDK fires
   * it on a container that is already up, so a turnover there would fence the
   * attempt in flight. It marks the restore pending instead, and the delivered
   * frame that resolves the mark holds the evidence — a failed adoption over a
   * settled phase (`#adoptOrTurnOver`).
   */
  #invalidateGeneration(): void {
    this.#generation += 1;
    this.#startup = undefined;
    this.#restoration = { phase: 'unstarted' };
    this.#adoptionPending = false;
    // The settled phase named the identity this turnover just retired. A row
    // left standing would let the next activation adopt a restoration onto a
    // container it never restored, so it goes with the generation. Not awaited:
    // the next adoption reads only after awaits of its own.
    void this.ctx.storage.delete(SETTLED_KEY)
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] settled phase was not cleared: ${describe({ cause })}`);
      });
    // A REPLACEMENT IS A FRESH DISK. Every generation turnover has evidence
    // that the container this box was talking to is gone or going, so the
    // runtime directory this instance established is gone with it and the
    // next command that stands in it must create it again.
    this.#runtimeDirReady = false;
  }

  /**
   * Claim the ladder row for ONE attempt, preserving the stage it already holds.
   *
   * THE CLAIM IS THE ATTEMPT'S IDENTITY, and it is durable because the
   * alternative is not sound: the in-memory generation counter starts again at
   * zero every time the object is rebuilt, so two attempts from two isolates can
   * carry the same number while only one of them still matters. A minted token,
   * written down here and required by every later write to this row, is what
   * makes "am I still the attempt this box is recovering" answerable at all.
   *
   * One critical section, so the read and the claim cannot be split by another
   * attempt's write. This one is a plain claim rather than a compare-and-set:
   * there is no prior token to compare against, and what it must not do is lose
   * a stage, which it cannot — it preserves whatever it read. The two writes
   * that CAN destroy evidence, the stage write and the delete, are both
   * conditional on this claim still standing.
   */
  async #claimRecovery(): Promise<RecoveryClaim> {
    const token = crypto.randomUUID();

    return await this.ctx.blockConcurrencyWhile(async () => {
      const admission = admissionStep(
        parseRecoveryRow(await this.ctx.storage.get(ATTACH_RECOVERY_KEY)),
      );

      await this.ctx.storage.put(ATTACH_RECOVERY_KEY, recoveryRow(token, admission.stage));

      return { token, admit: admission.admit, stage: admission.stage };
    });
  }

  /**
   * Write this attempt's ladder stage, but ONLY while the row still names it.
   *
   * The window this closes: an attempt reads its own ownership, a newer attempt
   * attaches successfully and deletes the row, and the older write then puts a
   * stage back — resurrecting a ladder the success had cleared and arming a
   * replacement of a container that is working. Inside one transaction the row
   * is re-read and compared, so a superseded attempt changes ZERO rows and its
   * caller goes inert.
   */
  async #settleRecovery(
    claim: RecoveryClaim,
    generation: number,
    stage: RecoveryStage | undefined,
  ): Promise<boolean> {
    return await this.#ownedRecoveryWrite(
      claim,
      generation,
      async () => {
        await this.ctx.storage.put(ATTACH_RECOVERY_KEY, recoveryRow(claim.token, stage));
      },
    );
  }

  /** Delete the ladder row, and only for the attempt that owns it. THE ONLY
   *  delete there is: a stage removed by anything other than a success would let
   *  the next eviction restart a destructive ladder. */
  async #releaseRecovery(claim: RecoveryClaim, generation: number): Promise<boolean> {
    return await this.#ownedRecoveryWrite(claim, generation, async () => {
      await this.ctx.storage.delete(ATTACH_RECOVERY_KEY);
    });
  }

  /**
   * One conditional write against the ladder row: it lands only while the row
   * still names this attempt, and `false` means it did not.
   *
   * INDIVISIBLE, and it has to be. The compare and the write are two storage
   * operations, so between them the object can run anything else — including the
   * attempt that just attached successfully and deleted this row. An attempt
   * that compared, yielded, and then wrote would put a stage back on top of that
   * success and arm the replacement of a container that is working.
   * `blockConcurrencyWhile` is the platform's own critical section and the only
   * primitive that closes it — except where one is ALREADY held, which is the
   * whole of `#critical` below. The class header warns against putting SLOW work
   * inside that block, where the platform's cancel window resets the object;
   * this section is one read and one write, orders of magnitude below it.
   *
   * BOTH TOKENS ARE CHECKED, and neither is enough alone. The durable owner
   * catches the attempt whose row a newer one already deleted, across evictions
   * and isolates, where the counter has been reset to zero and proves nothing.
   * The generation catches the attempt this isolate superseded a moment ago,
   * whose row nothing else has touched yet. Checked inside the section, both are
   * still true when the write lands.
   */
  async #ownedRecoveryWrite(
    claim: RecoveryClaim,
    generation: number,
    apply: () => Promise<void>,
  ): Promise<boolean> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const held = parseRecoveryRow(await this.ctx.storage.get(ATTACH_RECOVERY_KEY));

      if (!this.#owns(generation)) return false;

      if (held.kind !== 'row' || held.row.owner !== claim.token) return false;
      await apply();

      return true;
    });
  }

  /**
   * What to do about one failed attempt: classify, decide, act. No count, no
   * timeout, no budget of its own.
   *
   * The decision is a pure function of the failure's class, whether this attempt
   * still owns the lifecycle, and the stage its own claim carries, so the rules
   * can be read as a table instead of traced through this method.
   *
   * NOTHING IS DONE BEFORE THE ROW SAYS SO. Recording, arming and destroying
   * used to happen on an unconditional read: that is how a superseded attempt
   * filed a newer generation's failure, re-armed a startup nobody wanted, and
   * could destroy a container the newer attempt had just restored. The
   * conditional stage write is the one gate all three sit behind.
   */
  async #recover(
    generation: number,
    claim: RecoveryClaim,
    thrown: { readonly cause: unknown },
  ): Promise<void> {
    const failure = classifyRecovery(thrown);

    const decision = recoveryStep({
      owned: this.#owns(generation), failure, stage: claim.stage,
    });

    // A superseded attempt is INERT: it records nothing, arms nothing, destroys
    // nothing, publishes nothing. Its successor owns every one of those.
    if (decision.action === 'inert') return;

    if (!await this.#settleRecovery(claim, generation, decision.stage)) return;

    if (!this.#owns(generation)) return;
    // THE TAG LEADS, and that placement is load-bearing: `recordIncident`
    // truncates a reason at INCIDENT_REASON_MAX_CHARS, and a long cause chain
    // would have eaten a trailing tag. The host's own prose points the agent at
    // the reported cause to learn which recovery was chosen, so the tag has to
    // survive the bound rather than be the first thing past it.
    const reason = `[${failure} → ${decision.action}] ${describe(thrown)}`;
    // THE DECISION TRAVELS WITH THE STATE. The arm below is ONE durable write,
    // made from an isolate the platform may reset at any point after the
    // decision; carrying the answer here is what lets a later caller notice
    // the row is missing and deliver the retry the ladder promised.
    await this.#settle({ phase: 'unattached', reason, retry: decision.action === 'retry' });
    await this.#record('attach', reason);

    if (!this.#owns(generation)) return;

    if (decision.action === 'retry') {
      // A SCHEDULE, not the next operation: retrying per operation would record
      // an incident per operation for one broken box.
      await this.#arm(STARTUP_CALLBACK, this.policy.heartbeatSeconds);

      return;
    }

    // A LADDER THAT IS DONE ASKING TAKES ITS WAKE-UP WITH IT. The container-start
    // hook arms a startup row for a box with no restoration yet (see
    // `#armContainerSchedules`), and the SDK runs that hook on every admission
    // probe — so by the time a failure classifies as `refuse` or `replace`, a row
    // exists that would wake this box a second later and file the same incident
    // again. `kickStartup` refuses to arm a NEW one on a terminal phase; this is
    // the other half, for the one already written. The SDK's own delete, by
    // callback name (`container.js:1492-1494`).
    this.deleteSchedules(STARTUP_CALLBACK);

    if (decision.action === 'replace') await this.#replaceContainer(reason);
  }

  /**
   * Destroy this container identity and prove it gone.
   *
   * THE ONLY CANCELLATION THERE IS for work abandoned at the attach deadline.
   * That work is `exec` calls inside the container, so no token in this object
   * can stop it re-mounting the paths a retry is about to touch; SIGKILL can.
   * The generation is bumped first, so the abandoned continuation is already
   * inert when it settles, and the stop is awaited because `destroy`
   * acknowledges the signal before `container.running` flips — returning in that
   * window is how a retry attached over work that was still running.
   *
   * Nothing is re-armed. A fresh container starts on the next operation through
   * `ensureReady`, whose frame restores it; waking a box no caller is asking
   * for would only bill for the wake.
   */
  async #replaceContainer(reason: string): Promise<void> {
    this.#invalidateGeneration();
    const replacing = this.#generation;

    try {
      await this.destroy();
      await this.#awaitContainerStopped();
    } catch (error) {
      if (!this.#owns(replacing)) throw error;
      // A DESTRUCTION THAT DID NOT LAND CHANGES NOTHING. The abandoned work is
      // still inside that container, so the box must keep refusing rather than
      // offer the fresh start that `#invalidateGeneration` just made it look
      // ready for — attaching over work that is still running is the overlap
      // this whole path exists to prevent.
      await this.#settle({
        phase: 'unattached',
        reason: `${reason}; and the container identity could not be destroyed: `
          + describe({ cause: error }),
        // TERMINAL, whatever the class was. The abandoned work is still inside
        // that container, so nothing may attach over it until a caller asks by
        // name — the retry this refuses is exactly the overlap the destruction
        // was meant to prevent.
        retry: false,
      });
      throw error;
    }

    console.error(
      '[devbox] the container identity was destroyed after a failed attach; a fresh one '
      + 'attaches on the next operation',
    );
  }

  /**
   * Wait for the provider's own state transition. `stop` and `destroy`
   * acknowledge the signal before `container.running` flips, and returning in
   * that window let an immediate wake reuse the old mount, then lose it
   * underneath the next operation.
   *
   * BOUNDED BY A COUNT, and it was not. `while (running) await wait(100)` has no
   * exit but the platform's cooperation, and this runs on the RECOVERY path: a
   * `destroy()` that is acknowledged but never flips the flag pinned the attempt
   * in `#startup` for ever, and because `kickStartup` early-returns on a pinned
   * attempt, nothing re-armed and no further incident was ever filed. That is
   * the exact shape probe `blp1` froze in for 300,771 ms while `/state` kept
   * answering. A container that will not report itself stopped is now a NAMED
   * refusal instead of a silent hang, which the caller above turns into a
   * terminal `unattached` — the honest answer, because work may still be running
   * inside an identity that refused to die.
   */
  async #awaitContainerStopped(): Promise<void> {
    for (let attempt = 0; attempt < CONTAINER_STOP_ATTEMPTS; attempt += 1) {
      if (this.ctx.container?.running !== true) return;
      await scheduler.wait(CONTAINER_STOP_INTERVAL_MS);
    }

    if (this.ctx.container?.running !== true) return;
    throw new Error(
      `the container still reported itself running ${String(CONTAINER_STOP_ATTEMPTS)} probes `
      + `after it acknowledged the stop (${String(CONTAINER_STOP_ATTEMPTS * CONTAINER_STOP_INTERVAL_MS)}ms); `
      + 'refusing to treat the identity as gone',
    );
  }

  /**
   * Bring back what the caller left running, and report what did not come back.
   *
   * NOTHING HERE IS OPTIONAL. This package has no notion of an optional service:
   * a durable process spec and a durable port spec exist because a caller asked
   * for them, so each one that fails is a reason the box is not ready. The two
   * phases are the guard — every process first, then only if every process
   * started, each port's own listener probe followed by that port's re-exposure.
   *
   * The failures used to be recorded and stepped over: a silent probe filed an
   * incident and the walk continued straight into exposing that very port, and
   * the box then reported itself ready over a preview URL that answers 502. Now
   * a port is exposed only after its own listener answered, no port is exposed
   * at all when a process failed to start, and the reason travels back to
   * `ready`.
   *
   * Each failure is still recorded and the rest of the phase still runs: one
   * dead spec must not hide the others from the incident ledger.
   */
  async #restartWorkloads(generation: number, steps: RestoreSteps): Promise<readonly string[]> {
    const [processes, ports] = await Promise.all([this.#procSpecs(), this.#portSpecs()]);
    const plan = restartPlan(processes, ports);
    // EVERY STEP IS DECLARED, and the boot stamp is declared by the caller. The
    // divisor of each allowance is the work still to do, so a port's probe
    // cannot spend what its own exposure and the stamp still need — and a step
    // that finishes early leaves its share to the next one.
    steps.declare(plan.start.length + plan.serve.length * 2);
    // The caller re-checks ownership before it reads any of this, so a
    // superseded walk stops where it is and its answer is discarded.
    const superseded = ['the attempt was superseded'];
    const down: string[] = [];

    for (const spec of plan.start) {
      if (!this.#owns(generation)) return superseded;

      // SUPER, NOT THE PUBLIC OVERRIDE, for the same reason `#rawExec` calls
      // `super.exec`: the restoration is not a caller. A public override waits
      // on `ensureReady()` and claims a per-resource lane, and this code runs
      // INSIDE the restoration that readiness waits for — so going through it
      // makes the restoration wait for itself, and takes a lane a caller already
      // blocked at the gate may hold.
      const started = await steps.run(
        async () => {
          // ALREADY RUNNING IS ALREADY RESTORED. The walk is re-runnable on
          // purpose: an explicit `attachNow()` repairs a restoration that came
          // back incomplete, and a second start under an id the container
          // already holds is how one spec becomes two processes fighting over
          // one port. The container's own answer is the only evidence of that.
          const existing = await super.getProcess(spec.processId);

          if (existing !== null && isProcessLive(existing.status)) return existing;

          return await super.startProcess(spec.command, {
            cwd: spec.cwd ?? DEVBOX_WORKDIR,
            processId: spec.processId,
            autoCleanup: false,
          });
        },
        (failure) => {
          console.error(
            `[devbox] process ${spec.processId} outran its allowance; it later settled with: `
            + describe({ cause: failure.cause }),
          );
        },
      );

      if (started.kind === 'done') continue;
      down.push(`process ${spec.processId} did not restart`);
      // A start that THREW says why; one that outran its allowance says that,
      // and the reservation stays either way so a later attempt can retry it.
      await this.#record(
        'process',
        started.kind === 'failed'
          ? describe({ cause: started.cause })
          : `process ${spec.processId} did not start inside the restoration budget`,
        { processId: spec.processId },
      );
    }

    if (down.length > 0) {
      // Processes serve the ports, so a box missing one of its servers publishes
      // none of its URLs. Said once, after the whole phase, so every dead spec
      // reached the ledger first.
      return [...down, 'no port was exposed'];
    }

    for (const spec of plan.serve) {
      if (!this.#owns(generation)) return superseded;

      if (!await this.#awaitListener(spec.port, steps)) {
        down.push(`port ${spec.port} never answered`);
        await this.#record('port', `nothing listens on port ${spec.port} after restart`, {
          port: spec.port,
        });
        // ITS EXPOSURE'S ALLOWANCE GOES BACK. The exposure this port will not
        // get is work the budget no longer has to cover, so the ports after it
        // are not charged for this one's silence.
        steps.skip();
        continue;
      }

      if (!this.#owns(generation)) return superseded;

      if (!await this.#exposeWithSpec(spec, steps)) {
        down.push(`port ${spec.port} was not exposed`);
      }
    }

    return down;
  }

  /**
   * Wait, bounded, for a restored server to start listening. True once one does.
   *
   * IT REALLY WAITS. The op is called `await-port` and it used to probe exactly
   * once, immediately after the container reported the process STARTED — which
   * is the moment the process was forked, not the moment it bound a socket.
   * `npm run dev` and anything that installs on boot take seconds, so a healthy
   * server was declared silent and the incident that followed reached the agent
   * as a blocker telling it not to hand out a URL that worked moments later.
   * Wrong blockers in the one channel built to be trusted are worse than none.
   *
   * IT WAITS IN THE CONTAINER, IN ONE COMMAND, which is what makes it legal
   * inside the init gate — and cheaper everywhere else. The wait used to be a
   * Durable Object loop around `scheduler.wait`, so a thirty-second window at a
   * two-second cadence cost fifteen DO↔container round trips per port, and
   * inside `blockConcurrencyWhile` its timer would never be delivered at all:
   * the proof would hang, and the platform would answer by RESETTING the object.
   * `awaitListenerCommand` moves the loop and the sleep to the container, where
   * a count bounds them and the object waits on one hop.
   */
  async #awaitListener(port: number, steps: RestoreSteps): Promise<boolean> {
    // WHICHEVER IS SMALLER: this port's own cap, or what is left of the whole
    // restoration's budget. The cap alone was a timer per port, so silence cost
    // the box one window for every port it had and nothing bounded the sum —
    // three silent ports added about ninety seconds while every caller waited in
    // the readiness gate.
    const windowMs = Math.min(this.policy.portWaitMs, steps.remainingMs());
    const interval = this.policy.portProbeIntervalMs;

    const probed = await steps.run(
      async () => await this.#rawExec(
        awaitListenerCommand(port, Math.floor(windowMs / Math.max(1, interval)), interval),
      ),
      (failure) => {
        console.error(
          `[devbox] the listener proof for port ${port} outran its allowance; it later settled `
          + `with: ${describe({ cause: failure.cause })}`,
        );
      },
    );

    // A step that was refused or abandoned proves nothing, and a port whose
    // listener was never proven is never exposed — the same answer silence gets.
    return probed.kind === 'done' && !healthProbeSilent(probed.value.stdout);
  }

  /** True when nothing failed. A box with no preview host configured exposes
   *  nothing and that is not a failure — it declares no previews, which is the
   *  honest answer rather than a URL that cannot resolve. */
  async #exposeWithSpec(spec: PortExposureSpec, steps: RestoreSteps): Promise<boolean> {
    const hostname = this.previewHost;

    if (hostname === undefined || hostname.length === 0) {
      console.log(`[devbox] port ${spec.port} not re-exposed: no preview host configured`);
      // DECLARED BUT NOT RUN, so its share goes back — the caller declared two
      // steps for every port before it knew this box publishes no previews.
      steps.skip();

      return true;
    }

    const options: PortExposeOptions = { hostname, token: spec.token };

    if (spec.name !== undefined) options.name = spec.name;

    const exposed = await steps.run(
      // `super`, for the reason `#restartWorkloads` gives at its own start call:
      // the restoration must not wait on the readiness gate it IS, nor queue
      // behind a caller already waiting at that gate.
      async () => await super.exposePort(spec.port, options),
      (failure) => {
        console.error(
          `[devbox] the exposure of port ${spec.port} outran its allowance; it later settled `
          + `with: ${describe({ cause: failure.cause })}`,
        );
      },
    );

    if (exposed.kind === 'done') return true;
    await this.#record(
      'port',
      exposed.kind === 'failed'
        ? describe({ cause: exposed.cause })
        : `port ${spec.port} was not exposed inside the restoration budget`,
      { port: spec.port },
    );

    return false;
  }

  /**
   * Arm the durable startup callback that restores a box nobody has restored.
   * This is deliberately not an attachment operation: the `devboxStartup` row
   * this arms is the delivered frame that admits the container and restores
   * it — for a box nobody is asking about, the only driver there is.
   *
   * Calling it again is harmless. A running, unstarted generation can occur
   * after an object eviction consumed its one-shot row, so it re-arms that row;
   * an attached or terminal generation is left untouched.
   */
  async kickStartup(): Promise<void> {
    // Scheduling is durable and never waits on container admission. The
    // scheduled startup callback owns raw start, attach, and readiness outside
    // the edge request that asked for this kick.
    //
    // A RETRYABLE UNATTACH IS PENDING WORK TOO. The ladder answered `retry` and
    // armed one row to deliver it; if that write was lost the box holds a
    // promise with nothing keeping it, and for an idle box this poll is the
    // only caller there is. `#arm` is future-only, so a retry that IS scheduled
    // costs one schedule read and writes nothing. A terminal class is left
    // alone: waking a box to repeat work the ladder refused is the incident
    // storm this whole taxonomy exists to avoid.
    if (this.#startup !== undefined) return;
    const held = this.#restoration;

    // An attempt in flight owes nothing: it will settle into a phase, and this
    // poll's job is to notice a box with nobody working on it.
    if (held.phase === 'restoring') return;

    if (held.phase === 'attached' || held.phase === 'repair') return;

    if (held.phase === 'unattached' && !held.retry) return;
    await this.#arm(STARTUP_CALLBACK, 1);
  }

  /**
   * The readiness gate every operation passes through, and WHAT it admits the
   * operation into.
   *
   * THE REQUEST DOOR. On a cold start the first operation is what restores
   * the box: the container-start hook marked the restore pending and armed
   * the rows, and this is the delivered frame that resolves the mark — adopts
   * the instance the rows name, or drives the one attempt and joins it. It
   * covers what no hook can: a container replaced under a live object, which
   * fires no hook at all.
   *
   * IT RETURNS THE ADMISSION rather than resolving `void`. A box in `repair` is
   * admitted deliberately: refusing `exec` would deny the agent the one way it
   * has to fix the service that did not come back. But "admitted into a world
   * where something is missing" and "admitted into the world the caller left"
   * are different facts, and a gate that resolved `void` for both made the
   * difference discoverable only by a separate poll nobody was obliged to make.
   *
   * EVERY OTHER PHASE REFUSES, and that closes a measured hole. The tail of this
   * method used to be a bare `await this.devboxStartup()` with no check after
   * it — and `devboxStartup` RETURNS NORMALLY when the container was never
   * admitted (its admitted-nothing exit). So an operation against a box the
   * platform had no capacity for ran as if ready: measured live in probe `blp1`,
   * `exec` answered success in 62 ms while the box's own state said no
   * restoration had attached anything. For a mount-backed strategy that means
   * the caller's bytes land in a bare `/workspace` nothing will ever checkpoint.
   *
   * The refusal for that case does NOT write `unattached`: nothing was
   * classified, the container was simply not there yet, and `unattached` is
   * terminal to every poller that reads it. The box stays re-armable and this
   * caller is told to ask again.
   */
  async ensureReady(): Promise<RestoreAdmission> {
    await this.#resolveAdoption();

    // A stopped container may still have the previous instance's attached
    // state in memory. Let the startup callback turn that generation over
    // before this method can accept it as ready.
    if (this.ctx.container?.running !== true) {
      await this.#drive('request');
    }

    const settled = this.#admission();

    if (settled !== undefined) return settled;

    if (this.#restoration.phase === 'unattached') {
      // THE RETRY THE TAXONOMY PROMISED, DRIVEN HERE WHEN NOTHING ELSE WILL.
      //
      // MEASURED DEFECT THIS REPAIRS. `stale-owner → retry` is the ordinary
      // answer to platform churn, and the ONE schedule row `#recover` arms is
      // the only thing that can re-drive it: this gate refused every operation
      // on `unattached`, and `kickStartup` no-opped on any phase but
      // `unstarted`. Lose that single write — the isolate can be reset between
      // the decision and the arm — and /create, /wake and every operation are
      // inert for ever on a box the ladder said to try again.
      //
      // So the question asked here is not "how many times have I tried" but "is
      // anything going to try": an attempt in flight, or a future row. When the
      // answer is no, THIS caller drives the attach. The schedule stays the rate
      // limit — a failed attempt arms its own successor before it returns — so
      // one broken box still cannot file an incident per call, and a class the
      // ladder called terminal is never re-attempted here at all.
      if (
        this.#restoration.retry
        && this.#startup === undefined
        && !await this.#pending(STARTUP_CALLBACK)
      ) {
        await this.#drive('request');
        // A drive that failed again leaves a FRESH reason and a fresh arm, and
        // only a box still unattached refuses below.
        const droveTo = this.#admission();

        if (droveTo !== undefined) return droveTo;
      }

      if (this.#restoration.phase === 'unattached') {
        // THE REFUSAL NAMES BOTH HALVES: the taxonomy's own `[class → action]`
        // tag, which the reason already carries, and whether anything is going
        // to try again. A caller told this is terminal is being told to call
        // `attachNow()`; one told a retry is under way is being told to ask
        // again.
        throw new Error(
          `this devbox has no attached work directory: ${this.#restoration.reason}. `
          + (this.#restoration.retry
            ? 'A retry is already under way; operations are refused until it lands.'
            : 'That recovery class is terminal: call attachNow() to attempt the attach again.'),
        );
      }
    }

    await this.#drive('request');
    const drove = this.#admission();

    if (drove !== undefined) return drove;
    // NOTHING ATTACHED, AND NOTHING CLASSIFIED IT. The drive above returned
    // without a work directory: either the platform admitted no container (the
    // admitted-nothing exit, which records an incident and re-arms) or an
    // attempt is still in flight. Both are re-armable, so the box's phase is
    // left exactly as it is and only this operation is refused.
    throw new Error(
      `this devbox is not ready: ${this.#unready() ?? 'the restoration has not settled'}. `
      + 'Nothing has been classified as a failure; a startup is armed, so ask again.',
    );
  }

  /** The admission this box's settled phase grants, or undefined when it has
   *  not settled into one. ONE reader for the three places the gate asks. */
  #admission(): RestoreAdmission | undefined {
    const held = this.#restoration;

    if (held.phase === 'attached') return { kind: 'restored' };

    if (held.phase === 'repair') return { kind: 'repair', incomplete: held.incomplete };

    return undefined;
  }

  // ── operations ───────────────────────────────────────────────────────────

  /**
   * Run a command, gated on readiness, in the work directory by default.
   *
   * The default cwd is the real point: a box whose durable directory is
   * `/workspace` but whose commands land in `/` is a box whose work is not
   * saved. A caller that passes its own `cwd` gets it.
   */
  override async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return await this.#withActiveCaller(async () => {
      await this.ensureReady();

      return await super.exec(command, { cwd: DEVBOX_WORKDIR, ...options });
    });
  }

  /**
   * Force the attach now and report what it did.
   *
   * THE EXPLICIT REPAIR, and the one transition that clears a terminal refusal.
   * The recovery ladder ends by refusing, and it deliberately keeps its
   * `replace` stage: resetting a destructive ladder on the next eviction is how
   * a box would destroy one identity after another. So an ordinary operation
   * keeps refusing, and this call — a caller asking, by name, for the attach to
   * be tried now — is what re-attempts it.
   *
   * IT DESTROYS NOTHING. The stage is preserved, so if this attempt fails too,
   * the ladder is still at `replace` and the answer is another refusal rather
   * than another destruction. A success deletes the row, and the box is back.
   * A fresh container's first delivered frame clears the same refusal for the
   * same reason: a fresh container is a fresh chance to attach, and one that
   * attaches heals itself.
   *
   * IT ALSO RETRIES AN INCOMPLETE RESTORATION, which is the other half of the
   * same affordance. A restored app that outran the restoration's budget leaves
   * the box attached, unready, and with every spec still recorded — so the retry
   * that fixes it is this call, not a timer nobody asked for. The walk is
   * re-runnable: a process the container already holds is left alone rather than
   * started twice.
   */
  async attachNow(): Promise<AttachOutcome> {
    this.stampInteraction();

    if (this.#restoration.phase === 'repair') {
      const generation = this.#generation;
      await this.#repairAttached(generation);
      const outcome = await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY);

      return outcome ?? { kind: 'empty', detail: 'this box has attached nothing' };
    }

    if (this.#unready() !== undefined) await this.#settle({ phase: 'unstarted' });
    await this.ensureReady();
    const outcome = await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY);

    if (outcome === undefined) return { kind: 'empty', detail: 'this box has attached nothing' };

    return outcome;
  }

  /** Commit now and report what it did. */
  async checkpointNow(kind: CheckpointKind): Promise<CheckpointOutcome> {
    this.stampInteraction();
    await this.#healReplacedContainer();

    return await this.#checkpoint(kind);
  }

  /**
   * The one serialization point for every checkpoint this instance can be
   * asked to run: `checkpointNow`, the scheduled tick, the quiesce and
   * activity expiry. See {@link createCheckpointLane} for why two overlapping
   * runs must never interleave inside the storage.
   */
  #checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    return this.#lane.run(kind, async () => await this.#withStorageMutation(async () => {
      const pending = this.#startup;

      if (pending !== undefined && pending.generation === this.#generation) {
        // A CHECKPOINT IS A REQUEST, AND IT WAITS THE REQUEST'S OWN BUDGET.
        //
        // MEASURED DEFECT THIS REPAIRS. This was `await pending.run` — no
        // bound at all — inside both the checkpoint lane and the
        // storage-mutation FIFO, so one long restoration held every later
        // checkpoint behind it. Run 20260903140046 is the shape: its first
        // decisive `npm` checkpoint never settled inside the driver's
        // 1,500,000 ms operation deadline, and every segment after it was
        // answered `a restoration has been running in the request for N ms; a
        // startup is armed, so ask again` — the armed operation row
        // still `pending`, the lane still held, until the runner died.
        //
        // The same law `#awaitAttempt` holds a request door to: join the one
        // attempt, wait `requestJoinMs`, then answer from the restoration's
        // state. NOTHING IS ABANDONED — the attempt keeps running under the
        // single-flight entry and the next ask joins or reads it — and a
        // caller gets the re-askable refusal its own retry already knows how
        // to read instead of a hold with no end.
        const joined = await runRestoreStep(
          this.policy.requestJoinMs,
          async () => await pending.run,
          (failure) => {
            console.error(
              '[devbox] the restoration this checkpoint joined settled after the checkpoint had '
              + `answered: ${describe({ cause: failure.cause })}`,
            );
          },
        );

        if (joined.kind === 'failed') throw joined.cause;

        // STILL RESTORING: this checkpoint has no attached work directory to
        // commit. It answers with the readiness gate's OWN sentence — the one
        // the driver's `isRearmableStartupRefusal` already reads as "ask
        // again" — as a checkpoint OUTCOME rather than a throw, because a
        // caller of `checkpointNow` acts on the outcome and a scheduled
        // operation records it.
        if (joined.kind === 'late') {
          return {
            kind: 'failed',
            reason: `this devbox is not ready: ${this.#unready() ?? 'the restoration has not settled'}. `
              + 'Nothing has been classified as a failure; a startup is armed, so ask again.',
            bytes: undefined,
            movedBytes: undefined,
          };
        }
      }

      return await this.#requireStorage().checkpoint(kind);
    }));
  }

  /**
   * THE ORDER A STOP OWES ITS MOUNT: checkpoint, release the holders, detach,
   * then stop.
   *
   * MEASURED DEFECT THIS REPAIRS. This method used to call
   * `storage.detach()` BEFORE `this.stop('SIGTERM')`, and a detach releases
   * the work directory through the SDK's `unmountBucket` — which refuses with
   * EBUSY while any process holds an fd under the mount. The refusal landed
   * BEFORE `this.stop()` was ever reached, so a box with one open writer was
   * UNSTOPPABLE and UNTEARDOWNABLE: every later stop died the same way, and
   * no teardown could clean the box up.
   *
   * The checkpoint stays first — it is the final commit, and a failed one
   * still refuses to stop rather than lose work. What moves is everything the
   * mount's release depends on:
   *
   *   1. Supervised processes are killed by their own ids first. Their SPECS
   *      stay, so the wake restarts them; killing them here only releases the
   *      fds their cwd and open files hold under the work directory.
   *   2. Every other holder is signalled by ONE bounded container command
   *      (see {@link releaseWorkdirHoldersCommand}): TERM, wait, KILL, with
   *      pid 1 excluded, cwd holders and the scan's own ancestors named rather
   *      than signalled, and STDOUT re-read afterwards so what comes back is
   *      who is still holding rather than who was.
   *   3. Only then does the detach run, wrapped so a refusal that STILL lands
   *      names those holders rather than the bare EBUSY the SDK answers with.
   *
   * AND KILLING HOLDERS WAS NEVER THE WHOLE STORY, which cost two deployed runs
   * to learn. `probe09011530` and `hp0901170218` both refused this stop naming a
   * `bun` pid, and in both the scan had already killed that writer successfully
   * — the name was residue of a pre-signal list, and the real reference was the
   * SESSION the unmount travels through, which the SDK creates with
   * `cwd: "/workspace"`. A shell standing on a mount holds it. So a stop can
   * signal every holder there is and still be refused, which is why the release
   * below is necessary but not sufficient, and why a refusal that still lands
   * names the holders it found rather than the SDK's bare EBUSY.
   */
  async quiesce(): Promise<CheckpointOutcome> {
    // NO CONTAINER, NOTHING TO COMMIT, AND NOTHING TO ASK: a container call
    // STARTS an instance to answer it, so a checkpoint here ran on a fresh
    // instance with no mount (run 20260906072721, 2026-09-06; the ordering is
    // in tests/container-gone.test.ts). The generation turns over instead.
    if (this.ctx.container?.running !== true) {
      this.#invalidateGeneration();

      return {
        kind: 'skipped',
        reason: 'the container is not running: nothing is attached to commit, and no instance is started to ask',
        bytes: undefined,
        movedBytes: undefined,
      };
    }

    // The final commit is the one a wake reads back, so it is the last place a
    // replaced container may go unnoticed: see `#healReplacedContainer`.
    await this.#healReplacedContainer();
    // NOTHING ATTACHED, NOTHING TO COMMIT. A restoration this box classified
    // as failed admitted no caller (`ensureReady` refuses on `unattached`) and
    // restarted no process, so the container holds no work of this box's to
    // lose, and a final checkpoint would run against no work directory. The
    // deployed release of run 20260905075659 hung there: the attach the budget
    // abandoned was still restoring inside the container, the stop's
    // checkpoint waited on that container, and the driver's
    // 120 s release deadline passed with the stop still pending. The stop is
    // the one cancellation abandoned work has, so it goes straight to it.
    const held = this.#restoration;

    if (held.phase === 'unattached') {
      this.#invalidateGeneration();
      await this.stop('SIGTERM');
      await this.#awaitContainerStopped();

      return {
        kind: 'skipped',
        reason: `nothing is attached to commit: ${held.reason}`,
        bytes: undefined,
        movedBytes: undefined,
      };
    }

    const outcome = await this.#checkpoint('quiesce');

    if (outcome.kind === 'failed') {
      await this.#record('checkpoint', `final checkpoint failed: ${outcome.reason ?? 'unknown'}`);

      return outcome;
    }

    await this.#releaseWorkdirHolders();
    await this.#detachStorage();
    this.#invalidateGeneration();
    await this.stop('SIGTERM');
    await this.#awaitContainerStopped();

    return outcome;
  }

  /**
   * Kill the supervised processes by their ids, then signal every other
   * process holding an fd under the work directory.
   *
   * SUPERVISED FIRST, BY ID, and only the live ones: a spec whose process is
   * already gone needs nothing, and `stopSupervised` would drop the spec —
   * which is the opposite of what a stop owes a wake, since the wake's
   * restoration restarts exactly those specs. `killProcess` on the SDK's own
   * process table is what releases the fd without touching the durable row.
   */
  async #releaseWorkdirHolders(): Promise<void> {
    if (this.ctx.container?.running !== true) return;

    for (const live of await this.listProcesses()) {
      if (!isProcessLive(live.status)) continue;

      try {
        await this.killProcess(live.id);
      } catch (error) {
        // A stop must not be held hostage by one id the container cannot kill:
        // the holder scan below still catches whatever the process holds
        // under the work directory by pid, which is the resource that matters.
        console.error(
          `[devbox] supervised process ${live.id} could not be killed before the stop: `
          + describe({ cause: error }),
        );
      }
    }

    const released = await this.#rawExec(
      releaseWorkdirHoldersCommand(DEVBOX_WORKDIR),
      DEVBOX_RUNTIME_DIR,
    );

    if (released.exitCode !== 0) {
      // Refused rather than swallowed: a scan that cannot run says nothing
      // about the holders, and proceeding to the detach would hand the next
      // refusal to a caller with no names to act on. The words travel on
      // stderr — see the command's own contract.
      throw new Error(
        `the holders of ${DEVBOX_WORKDIR} could not be released: `
        + `${released.stderr.trim() || released.stdout.trim() || `exit ${released.exitCode}`}`,
      );
    }

    const holders = parseWorkdirHolders(released.stdout);

    if (holders.length > 0) {
      this.#lastWorkdirHolders = holders;
    } else {
      this.#lastWorkdirHolders = undefined;
    }
  }

  /** Detach the storage, rethrowing a still-busy refusal NAMED for the
   *  holders the release pass found. The bare `fusermount: failed to unmount:
   *  Device or resource busy` the SDK answers with names nothing, and a caller
   * told only that cannot act on the one fact that would fix it. */
  async #detachStorage(): Promise<void> {
    try {
      await this.#requireStorage().detach?.();
    } catch (error) {
      const holders = this.#lastWorkdirHolders;

      if (holders === undefined || holders.length === 0) throw error;
      const named = holders.map(holder => `${holder.pid} (${holder.comm})`).join(', ');
      throw new Error(
        `the work directory could not be detached while these processes were still holding it: `
        + `${named}: ${describe({ cause: error })}`,
        { cause: error },
      );
    } finally {
      this.#lastWorkdirHolders = undefined;
    }
  }

  /** Forget this box's durable bytes. Called when the box itself is deleted;
   *  without it the stored objects outlive the box with nothing left to name
   *  them — see `EXTRACT_TTL_SECONDS` for why no lifecycle rule may sweep
   *  them.
   *
   *  THE GENERATION TURNS OVER FIRST. A discard is the end of what the box
   *  holds, so a restoration still in flight is restoring bytes that are
   *  about to be gone: it must write nothing durable and publish no readiness
   *  once this begins, which is what a superseded attempt already guarantees.
   *  The chain's own discard touches no container at all — R2 objects and the
   *  durable row, nothing else — so a discard on a stopped box never starts an
   *  instance to clean a disk that died with the last one (run 20260906072721,
   *  2026-09-06, the teardown that did). */
  async discardState(): Promise<void> {
    this.#invalidateGeneration();
    await this.#requireStorage().discard();
    // The attach evidence describes bytes that no longer exist, so it goes with
    // them rather than outliving them as a claim about nothing.
    await this.ctx.storage.delete(LAST_ATTACH_KEY);
  }
  /**
   * Every incident reason this box holds, oldest first, for diagnosis. Totals
   * say how many failures were filed; only the reasons say what they were.
   * Bounded by the ledger cap and read-only.
   */
  async devboxIncidentReasons(): Promise<readonly IncidentReasonRow[]> {
    const rows = await this.ctx.storage.list<IncidentRow>({ prefix: INCIDENT_PREFIX });

    return [...rows.values()]
      .map((row) => ({
        stage: row.stage,
        reason: row.reason,
        at: row.at,
        attempts: row.attempts,
        delivered: row.deliveredAt !== undefined || row.rejectedAt !== undefined,
      } satisfies IncidentReasonRow))
      .sort((a, b) => a.at - b.at);
  }

  /**
   * Start a background process AND record a durable spec for it.
   *
   * The only way to run something that should survive a recycle. An arbitrary
   * `nohup … &` child dies with the container and cannot be brought back:
   * nothing captured its identity, so after the container is replaced there is
   * no way to know it should exist.
   *
   * THE SPEC IS THE RESERVATION, and it is durable BEFORE any process exists.
   * The row and the process are two steps inside one call, and there are two
   * ways to lose the second half: the platform resets the object at its own
   * cancel window, and the transport can drop the answer after the container
   * has already forked. Recording the spec AFTER the start made both the same
   * hole — a live process no row named. Any re-issue of the call could only
   * look for a row, found none, and started a second copy: two servers
   * fighting over one port, forever, with the unrecorded one impossible to
   * list, stop or restore. Core stopped retrying this call over exactly that
   * (see `startProcess` in `execution/sandbox.ts`), which narrowed the window
   * without closing it, because a reset needs no retry to open it.
   *
   * So the id is minted here, written down, and only then started under —
   * `#restartWorkloads` already restarts a spec by its own id, so the platform
   * takes one either way. IDEMPOTENT ON (command, cwd): a re-issue finds the
   * reservation and asks the container about that ONE id. A live process is
   * this call's own answer. An absent one is started under the SAME id, so a
   * second row can never exist. A container that cannot answer is neither, and
   * the query throws rather than guessing absence — guessing is how one call
   * becomes two processes.
   *
   * A reservation whose start never landed therefore SURVIVES the failure, and
   * that is the point rather than a leak: the restoration starts it on the next
   * attach, `listSupervised` reports it, and `stopSupervised` on its id is what
   * retires it. Dropping it on a failed start would mean deciding, from an
   * error, that no process exists — the decision this whole method refuses to
   * make.
   */
  async startSupervised(command: string, cwd?: string): Promise<{ processId: string }> {
    return await this.#withActiveCaller(async () => {
      await this.ensureReady();
      const workDir = cwd ?? DEVBOX_WORKDIR;

      const reserved = (await this.#procSpecs())
        .find(spec => spec.command === command && spec.cwd === workDir);

      const spec: SupervisedProcessSpec = reserved ?? {
        processId: crypto.randomUUID(),
        command,
        cwd: workDir,
        createdAt: Date.now(),
      };

      if (reserved === undefined) {
        await this.ctx.storage.put(`${PROC_SPEC_PREFIX}${spec.processId}`, spec);
      } else {
        const existing = await this.getProcess(spec.processId);

        if (existing !== null && isProcessLive(existing.status)) {
          return { processId: spec.processId };
        }
      }

      await this.startProcess(command, {
        cwd: workDir,
        processId: spec.processId,
        autoCleanup: false,
      });

      return { processId: spec.processId };
    });
  }

  /**
   * Stop a supervised process and drop its spec, so it does not come back.
   *
   * THE SPEC OUTLIVES A KILL THAT DID NOT LAND. It is the only thing that names
   * the process, so dropping it on a failed kill left a server the box could no
   * longer list, stop or restart — and, because the restoration walks specs,
   * nothing brought it back after a recycle either. The row therefore goes only
   * on evidence: a kill the container confirmed, or an id the container's own
   * PROCESS_NOT_FOUND says it does not have. The second is the ordinary
   * post-recycle case — the spec was restarted under its own id and the caller
   * is holding the previous one — and it is positive absence, not an unanswered
   * question. Every other failure, and every value that is not one of the SDK's
   * classified errors, keeps the SAME row and files the reason, so a later stop
   * or restoration retries that id instead of leaving a process nothing names.
   */
  async stopSupervised(processId: string): Promise<{ stopped: boolean }> {
    return await this.#resources.run(processScope(processId), () => this.#stopSupervised(processId));
  }

  async #stopSupervised(processId: string): Promise<{ stopped: boolean }> {
    await this.ensureReady();
    let thrown: { readonly cause: unknown } | undefined;

    try {
      await this.killProcess(processId);
    } catch (error) {
      thrown = { cause: error };
    }

    if (thrown === undefined || v.is(ProcessAbsentSchema, thrown.cause)) {
      await this.ctx.storage.delete(`${PROC_SPEC_PREFIX}${processId}`);
    } else {
      await this.#record('process', describe(thrown), { processId });
    }

    this.stampInteraction();

    return { stopped: thrown === undefined };
  }

  /** Every supervised process, live rows merged with durable specs. A spec with
   *  no live row is one the restoration has not started yet, or one whose start
   *  failed and was recorded; either way it is NOT running. */
  async listSupervised(): Promise<readonly SupervisedProcessRow[]> {
    await this.ensureReady();
    const specs = await this.#procSpecs();
    const rows = new Map<string, SupervisedProcessRow>();

    for (const spec of specs) {
      rows.set(spec.processId, {
        processId: spec.processId,
        pid: undefined,
        status: 'starting',
        command: spec.command,
        restartable: true,
      });
    }

    const specIds = new Set(specs.map(spec => spec.processId));

    for (const live of await this.listProcesses()) {
      rows.set(live.id, {
        processId: live.id,
        pid: live.pid,
        status: live.status,
        command: rows.get(live.id)?.command ?? live.command,
        restartable: specIds.has(live.id),
      });
    }

    this.stampInteraction();

    return [...rows.values()];
  }

  /**
   * The durable token this port's preview URL is built on, minted on first ask.
   *
   * ASKED BEFORE THE EXPOSURE. The restart path re-exposes each port with its
   * stored token, which is the only reason a preview URL survives a recycle
   * byte for byte — so the FIRST exposure has to use the same token. This used
   * to be called after the SDK had already minted one of its own and be named
   * for that order: the caller then held a URL on the SDK's token while the
   * manifest held ours, and the first container replacement re-exposed on ours
   * and killed the link the agent had handed out.
   */
  async portToken(port: number, name?: string): Promise<{ urlToken: string }> {
    return await this.#resources.run(portScope(port), () => this.#portToken(port, name));
  }

  /** On the port's own claim and NOT gated on readiness: the token has to be
   *  mintable before the exposure it names, and it touches only this object's
   *  rows. Minting it beside the removal of that same row is the pair that once
   *  shipped a preview URL built on one token next to a manifest holding
   *  another, which is why both are on the claim. */
  async #portToken(port: number, name?: string): Promise<{ urlToken: string }> {
    const key = `${PORT_SPEC_PREFIX}${port}`;
    const existing = await this.ctx.storage.get<PortExposureSpec>(key);

    const spec: PortExposureSpec = existing ?? {
      port,
      name,
      token: generatePortToken(n => crypto.getRandomValues(new Uint8Array(n))),
      createdAt: Date.now(),
    };

    if (existing === undefined || (name !== undefined && name !== existing.name)) {
      await this.ctx.storage.put(key, { ...spec, name: name ?? spec.name });
    }

    this.stampInteraction();

    return { urlToken: spec.token };
  }

  async notePortRemoved(port: number): Promise<void> {
    return await this.#resources.run(portScope(port), async () => {
      await this.ctx.storage.delete(`${PORT_SPEC_PREFIX}${port}`);
      this.stampInteraction();
    });
  }

  /** The one sentence behind `ready: false`, from the same value `ready` is
   *  read off — so the flag and the reason cannot disagree. */
  #unready(): string | undefined {
    const held = this.#restoration;

    if (held.phase === 'unstarted') return 'no restoration has run for this container yet';

    if (held.phase === 'unattached') return held.reason;

    if (held.phase === 'repair') return held.incomplete;

    // AN ATTEMPT IN FLIGHT IS NOT "NOTHING HAS RUN", and saying so was a
    // measured defect: for the whole of a minutes-long attempt this box
    // answered "no restoration has run for this container yet", so a poller
    // read `pending` for ever and never drove. The duration is what makes the
    // answer actionable — a restore that has been running for 300 s is a
    // different fact from one that started a moment ago.
    if (held.phase === 'restoring') {
      return `a restoration has been running in the ${held.where} for `
        + `${String(Math.max(0, Date.now() - held.since))} ms`;
    }

    return undefined;
  }

  /**
   * Everything about this box that can be answered without attaching storage.
   * A poll may reactivate a stopped container so its scheduled startup can run,
   * but it never drives that startup inline.
   */
  async devboxState(): Promise<DevboxReport> {
    await this.kickStartup();
    await this.#resolveAdoption();

    const [supervised, ports, incidents] = await Promise.all([
      this.#procSpecs(),
      this.#portSpecs(),
      this.ctx.storage.list<IncidentRow>({ prefix: INCIDENT_PREFIX }),
    ]);

    return {
      strategy: this.strategy,
      durable: this.store !== undefined,
      running: this.ctx.container?.running === true,
      restoration: this.#restoration.phase,
      ready: this.#restoration.phase === 'attached',
      unready: this.#unready(),
      lastInteractionAt: this.#lastInteraction
        ?? await this.ctx.storage.get<number>(LAST_INTERACTION_KEY),
      quietSince: await this.ctx.storage.get<number>(QUIET_SINCE_KEY),
      chain: normalizeChainState(await this.ctx.storage.get<StoredValue>(STORAGE_KEY)),
      lastAttach: await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY),
      lastTick: await this.ctx.storage.get<HeartbeatTick>(LAST_TICK_KEY),
      bootId: await this.ctx.storage.get<string>(BOOT_ID_KEY),
      replacedCount: await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0,
      supervised,
      ports,
      incidents: incidentTotals(incidents.values()),
    };
  }

  // ── one caller at a time, per resource ───────────────────────────────────
  //
  // Every agent in a workspace shares ONE container, and each of them is a
  // separate Durable Object: a head, a subordinate, an exploration facet. They
  // reach the container through their own clients, and a queue built beside a
  // client orders only that client's calls — so two facets writing one path
  // interleaved, an exposure raced its own un-exposure, and a port token was
  // minted beside the removal of the row it belonged to. This object is the one
  // place all of them meet, so the claim is made here and nowhere else.
  //
  // Each override does the same three things in the same order, and the ORDER is
  // the content:
  //
  //   claim the resources, THEN wait for readiness, THEN call the base method.
  //
  // Claiming first is what makes an operation that queued behind another safe: it
  // re-enters `ensureReady` after the wait, so a container replaced while it
  // waited is attached afresh instead of resumed against a generation that is
  // gone. Nothing below caches a container handle, a generation or a mount
  // reading across its await — a closure here holds a path or a port number and
  // nothing else — so a replacement has no stale state to invalidate. Keep it
  // that way.
  //
  // The two READ overloads are derived from the pinned base declaration rather
  // than restated (see `ReadFileArms`), so the SDK stays the single authority for
  // its own result shapes and an overload change breaks the build here instead of
  // drifting past it.
  //
  // `exec` is deliberately absent. A shell string does not say which paths it
  // touches, so the only key wide enough would be the container itself: one
  // command at a time for a whole workspace, which is a global lock and not this.
  //
  // THE RESTORATION IS NOT A CALLER, and it must never enter a claim. Every
  // internal path that runs inside `#attachAndRestore` uses `super.*` — `#rawExec`,
  // `#restartWorkloads` and `#exposeWithSpec` all do — for the reason `#rawExec`
  // already states about `super.exec`, plus one this section adds: claiming
  // before waiting for readiness makes a claim taken by the restoration a
  // deadlock by construction, because a caller holds the claim while waiting for
  // the restoration, so a restoration waiting for that claim waits for the
  // caller. It is also correct on the merits — while the restoration runs, every
  // laned caller is parked at the readiness gate, so there is nobody to order it
  // against. Measured, not theorised: routing the restart through the public
  // `exposePort` timed out two lifecycle tests at 5000ms.
  //
  // `getExposedPorts` and `listSupervised` are absent for the opposite reason.
  // Both read ONE atomic snapshot of this object's own storage — the SDK's
  // `getCurrentPreviewPorts` reads the preview rows and the runtime id inside a
  // single `storage.transaction`, and `listSupervised` reads the spec table with
  // one `storage.list` — so neither can observe a torn collection, only an
  // older one. Ordering a whole-collection read against every port would be the
  // container-wide lock again, to fix a tear that cannot happen.

  /**
   * Read a file, holding it for as long as the read actually LASTS.
   *
   * The `encoding: 'none'` arm hands back a `ReadableStream` and returns before a
   * byte is consumed, so releasing the claim on return would let a sibling write
   * rewrite the file underneath a reader still pulling from it. The claim is
   * released on the last chunk, on an error and on cancellation — see
   * {@link heldUntilDrained}.
   *
   * The two signatures are DERIVED from the base class's own declaration
   * (`ReadArms` above) rather than restated. The SDK does not export its file
   * result types, and copying their bodies here would put a second, silently
   * drifting copy of somebody else's contract in this tree. Structural derivation
   * keeps the pinned declaration as the one authority: an SDK release that adds,
   * removes or reorders an overload fails `tsc` here instead of leaving an
   * override that still compiles and no longer matches.
   */
  override readFile(...args: ReadArms['stream']['args']): ReadArms['stream']['result'];
  override readFile(...args: ReadArms['value']['args']): ReadArms['value']['result'];
  override async readFile(
    path: string,
    options?: ReadStreamOptions | ReadValueOptions,
  ): Promise<Awaited<ReadArms['stream']['result']> | Awaited<ReadArms['value']['result']>> {
    const scopes = pathScopes({ path });

    if (options !== undefined && options.encoding === 'none') {
      const release = await this.#resources.hold(scopes);

      try {
        await this.ensureReady();
        const result = await super.readFile(path, options);

        return { ...result, content: heldUntilDrained(result.content, release) };
      } catch (failure) {
        release();
        throw failure;
      }
    }

    return await this.#resources.run(scopes, async () => {
      await this.ensureReady();

      return await super.readFile(path, options);
    });
  }

  /** One signature, so the override is plain — but the same stream lifetime: the
   *  file stays claimed until the bytes are done, not until this resolves. */
  override async readFileStream(path: string, options?: { sessionId?: string }) {
    const release = await this.#resources.hold(pathScopes({ path }));

    try {
      await this.ensureReady();

      return heldUntilDrained(await super.readFileStream(path, options), release);
    } catch (failure) {
      release();
      throw failure;
    }
  }

  override async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string; sessionId?: string },
  ) {
    return await this.#resources.run(pathScopes({ path, membership: true }), async () => {
      await this.ensureReady();

      return await super.writeFile(path, content, options);
    });
  }

  /** A removal changes what its directory contains, and a removal of a DIRECTORY
   *  changes everything under it — which nothing here can rule out from a path,
   *  so the subtree is claimed either way. Claiming the subtree of a plain file
   *  costs nothing: no other operation can name a path beneath one. */
  override async deleteFile(path: string, sessionId?: string) {
    return await this.#resources.run(
      pathScopes({ path, membership: true, recursive: true }),
      async () => {
        await this.ensureReady();

        return await super.deleteFile(path, sessionId);
      },
    );
  }

  override async renameFile(oldPath: string, newPath: string, sessionId?: string) {
    return await this.#runMovedResourceOperation(
      oldPath,
      newPath,
      () => super.renameFile(oldPath, newPath, sessionId),
    );
  }

  override async moveFile(sourcePath: string, destinationPath: string, sessionId?: string) {
    return await this.#runMovedResourceOperation(
      sourcePath,
      destinationPath,
      () => super.moveFile(sourcePath, destinationPath, sessionId),
    );
  }

  #runMovedResourceOperation<Result>(
    from: string,
    to: string,
    operation: () => Promise<Result>,
  ) {
    return this.#resources.run(this.#movedScopes(from, to), async () => {
      await this.ensureReady();

      return await operation();
    });
  }

  /** Both ends of a move, both their directories, and both subtrees. Claimed as
   *  ONE set, so a move never holds one end while waiting for the other and
   *  there is no acquisition order for anyone to get wrong. */
  #movedScopes(from: string, to: string) {
    return [
      ...pathScopes({ path: from, membership: true, recursive: true }),
      ...pathScopes({ path: to, membership: true, recursive: true }),
    ];
  }

  override async mkdir(path: string, options?: { recursive?: boolean; sessionId?: string }) {
    // A recursive mkdir really can add an entry to every directory above it, so
    // it is the one operation that claims the whole chain rather than the parent.
    return await this.#resources.run(
      pathScopes({ path, membership: true, ancestors: options?.recursive === true }),
      async () => {
        await this.ensureReady();

        return await super.mkdir(path, options);
      },
    );
  }

  override async listFiles(path: string, options?: ListFilesOptions) {
    return await this.#resources.run(
      pathScopes({ path, recursive: options?.recursive === true }),
      async () => {
        await this.ensureReady();

        return await super.listFiles(path, options);
      },
    );
  }

  override async exists(path: string, sessionId?: string) {
    return await this.#resources.run(pathScopes({ path }), async () => {
      await this.ensureReady();

      return await super.exists(path, sessionId);
    });
  }

  override async exposePort(
    port: number,
    options: { name?: string; hostname: string; token?: string },
  ) {
    return await this.#resources.run(portScope(port), async () => {
      await this.ensureReady();

      return await super.exposePort(port, options);
    });
  }

  /** Revocation touches this object's own preview rows and never the container,
   *  so it claims the port and skips the readiness wait: a port can and must be
   *  revocable on a box that is not attached. */
  override async unexposePort(port: number): Promise<void> {
    return await this.#resources.run(portScope(port), () => super.unexposePort(port));
  }

  // ── schedules ────────────────────────────────────────────────────────────

  /**
   * Run one scheduled callback and arm its successor, whatever it does.
   *
   * TWO FAILURES, ONE GUARD. Schedule rows are one-shot — the alarm loop
   * deletes a row after running its callback — so a self-re-arming callback IS
   * its own chain, and there are exactly two ways to end it by accident. One is
   * to return early down a path that forgot to re-arm; the discipline was hand
   * applied at five sites in the heartbeat alone, and its only guard was a test
   * that counted the occurrences of `#arm` in the source. The other is to
   * throw: the alarm loop reduces a thrown callback to a console line and
   * deletes the row, so a transient container disconnect in the middle of a
   * checkpoint — a class this project's own retry list calls routine — silently
   * stopped every future checkpoint for a container that never restarts.
   *
   * So the body says how long until the successor should run, or `null` to end
   * the chain deliberately, and a throw is a `null` the caller did not choose:
   * the successor is armed at `retrySeconds` and the reason is logged, because
   * nothing downstream will see it.
   */
  async #scheduled(
    callback: string,
    retrySeconds: number,
    body: () => Promise<number | null>,
  ): Promise<void> {
    let nextSeconds: number | null = retrySeconds;

    try {
      nextSeconds = await body();
    } catch (error) {
      console.error(`[devbox] scheduled ${callback} failed: ${describe({ cause: error })}`);
    }

    if (nextSeconds !== null) await this.#arm(callback, nextSeconds);
  }

  /**
   * The periodic commit.
   *
   * Failures land in TWO places on purpose: on the strategy's own record, and
   * in an incident. The alarm loop reduces a thrown scheduled callback to a
   * console line, so neither place alone survives.
   *
   * Not re-armed while the container is down: waking a sleeping container to
   * ask whether it changed would keep it alive forever, and the next container
   * start arms this again.
   */
  async devboxCheckpoint(): Promise<void> {
    // The ambient schedule is the ONLY writer this row has. A box with it
    // disabled (a benchmark during driver-owned measurement) never arms the
    // row, so a call here can only be stray; ending the chain keeps nothing
    // ticking that the host did not ask for.
    if (!this.ambientCheckpoints) return;
    const period = Math.ceil(this.policy.checkpointIntervalMs / 1000);
    await this.#scheduled(CHECKPOINT_CALLBACK, period, async () => {
      if (this.ctx.container?.running !== true) return null;
      const outcome = await this.#checkpoint('tick');

      if (outcome.kind === 'failed') {
        await this.#record('checkpoint', outcome.reason ?? 'unknown');
      }

      return period;
    });
  }

  /**
   * The heartbeat: one control-plane ping, then one quiesce decision.
   *
   * Interaction stamps arrive separately — the public operations call
   * `stampInteraction()`, and nothing in here does, because a box's own
   * maintenance traffic is not use. Quiescing needs all three gates to agree
   * and the quiet to be confirmed across heartbeats; then the graceful stop
   * runs and NO successor is armed, so nothing outlives the stop.
   */
  async devboxHeartbeat(): Promise<void> {
    const beat = this.policy.heartbeatSeconds;
    await this.#scheduled(HEARTBEAT_CALLBACK, beat, async () => {
      // RENEW THE CLOCK THE SDK ACTUALLY READS. `isActivityExpired()` compares
      // `sleepAfterMs`, which only `renewActivityTimeout()` moves. Pinging the
      // container is not enough on its own, and if this clock expires the SDK's
      // alarm chain ends without setting a successor. See `onStart`. This
      // deliberately does NOT stamp an interaction: see `stampInteraction`.
      this.renewActivityTimeout();

      if (this.ctx.container?.running !== true) {
        // A tick is still written, and a successor still armed. An early return
        // that armed nothing would break the chain permanently and hide WHEN
        // the box stopped, which is exactly the distinction a reader needs
        // between "quiesced on purpose" and "slept".
        await this.#tick({ running: false, ping: 'skipped', armedNext: true });

        return beat;
      }

      try {
        // NO PORT ARGUMENT. `containerFetch(request, port)` takes a PORT as its
        // second parameter, not a timeout: passing a millisecond value there
        // pointed every ping at a port nothing serves and waited for it to
        // become ready. Every tick then took the ping-failed path, so the
        // quiesce decision below never ran at all. Omitting it uses the SDK's
        // own `defaultPort`, which is the control plane this box already
        // talks to.
        const ping = await this.containerFetch(new Request('http://127.0.0.1/'));
        await ping.body?.cancel();
      } catch (error) {
        const reason = describe({ cause: error });
        console.error(`[devbox] heartbeat ping failed: ${reason}`);
        await this.#tick({ running: true, ping: `failed: ${reason}`, armedNext: true });

        return beat;
      }

      // REPLACEMENT DETECTION, before any decision is made about an instance
      // that may not be the one that was restored.
      //
      // ONLY ON A SETTLED RESTORATION, the same scope `#healReplacedContainer`
      // keeps. The stamp is the LAST thing a restoration does, so for the whole
      // length of a wake the durable row names the instance the stop took down
      // and the fresh instance carries no marker: exactly the mismatch this
      // detector reads as a replacement. MEASURED, run 20260906072721
      // (2026-09-06, 07:30:14-16Z): the post-ladder wake was mounting its store
      // when this beat fired, read the mismatch, turned the generation over
      // under the wake's own attempt and drove a second restoration beside it —
      // two `mkdir -p /var/tmp/devbox`, two boot-id reads and two mount reads
      // inside one second, and two attempts free to lay one overlay over one
      // work directory twice. An attempt in flight owns the identity it is
      // establishing; the beat asks the question only of a box that has
      // settled on an instance and may have lost it since.
      await this.#resolveAdoption();
      const settled = this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair';

      if (settled && await this.#containerWasReplaced()) {
        console.error(
          '[devbox] the container instance was replaced; re-driving the restoration now '
          + 'rather than waiting for the next operation',
        );
        // Turn the generation over and re-drive immediately. Waiting for the
        // next operation would leave supervised processes and ports down for as
        // long as the box is idle, which is exactly when nobody is watching —
        // and the attempt that was restoring the replaced instance is now inert,
        // so it cannot publish readiness for a container that is gone.
        this.#invalidateGeneration();
        await this.#tick({ running: true, ping: 'ok', armedNext: true, replaced: true });

        try {
          await this.#drive('schedule');
        } catch (error) {
          console.error(
            `[devbox] re-driving after replacement failed: ${describe({ cause: error })}`,
          );
        }

        return beat;
      }

      const now = Date.now();

      // The lanes own their own truth: resource claims include draining streams,
      // checkpoints include queued runs, and a startup entry covers restoration
      // and repair. Shell commands and supervised starts have no resource name,
      // so their full public await owns the remaining counter.
      let backgroundWork = this.#activeCallers !== 0
        || this.#resources.busy()
        || this.#lane.busy()
        || this.#startup !== undefined;

      if (!backgroundWork) {
        // An unreachable host means POSSIBLY busy, so hold. Never stop on a guess.
        backgroundWork = true;

        try {
          backgroundWork = await this.hasBackgroundWork();
        } catch (error) {
          console.error(
            `[devbox] background-work check failed, holding: ${describe({ cause: error })}`,
          );
        }
      }

      const decision = quiesceStep({
        now,
        containerRunning: true,
        lastInteractionAt: this.#lastInteraction
          ?? await this.ctx.storage.get<number>(LAST_INTERACTION_KEY) ?? now,
        quietSince: await this.ctx.storage.get<number>(QUIET_SINCE_KEY),
        backgroundWork,
        idleMs: this.policy.idleMs,
        quietConfirmMs: this.policy.quietConfirmMs,
      });

      if (decision.quietSince === undefined) {
        await this.ctx.storage.delete(QUIET_SINCE_KEY);
      } else {
        await this.ctx.storage.put(QUIET_SINCE_KEY, decision.quietSince);
      }

      await this.#tick({
        running: true,
        ping: 'ok',
        // A quiesce deliberately arms nothing: see `quiesce`.
        armedNext: decision.action !== 'quiesce',
        decision: decision.action,
      });

      if (decision.action !== 'quiesce') return beat;

      // A refused stop must not strand the lease open forever: the next
      // heartbeat retries the whole decision with fresh evidence.
      return (await this.quiesce()).kind === 'failed' ? beat : null;
    });
  }

  /**
   * The SDK's own activity expiry, which means a heartbeat was late enough for
   * `sleepAfterMs` to pass.
   *
   * The base implementation stops the container. That is the right outcome, but
   * not before a final checkpoint: this is the last moment the container's disk
   * is readable. A failed checkpoint does not block the stop here, because the
   * alarm chain is already ending and refusing would only lose the stop as well.
   */
  override async onActivityExpired(): Promise<void> {
    const outcome = await this.#checkpoint('quiesce');
    await this.#tick({
      running: this.ctx.container?.running === true,
      ping: `activity expired, final checkpoint ${outcome.kind}`,
      armedNext: false,
      decision: 'quiesce',
    });

    if (outcome.kind === 'failed') {
      await this.#record('checkpoint', `checkpoint at activity expiry failed: ${outcome.reason ?? 'unknown'}`);
    }

    // The base implementation stops the container, so the identity this box was
    // restoring is going with it.
    this.#invalidateGeneration();
    await super.onActivityExpired();
  }

  /** One durable row per heartbeat, so a box that stopped ticking says when and
   *  why. Without it, three different broken links look identical from outside:
   *  an alarm that never fired, a tick that returned early, and a ping that did
   *  not renew the clock. */
  async #tick(input: Omit<HeartbeatTick, 'at'>): Promise<void> {
    await this.ctx.storage.put(LAST_TICK_KEY, { ...input, at: Date.now() } satisfies HeartbeatTick);
  }

  /** One delivery pass over the ledger; the policy is `incidents.ts`. Public
   *  because `Container.schedule` calls back by name. */
  async devboxIncidents(): Promise<void> {
    const firstRetry = Math.max(1, Math.ceil(incidentRetryDelayMs(0) / 1000));
    await this.#scheduled(INCIDENT_CALLBACK, firstRetry, async () =>
      await deliverIncidents(this.ctx.storage, async (incident, attempt) =>
        await this.onIncident(incident, attempt)));
  }

  /**
   * The SDK's own activity renewal, on every call this object receives.
   *
   * IT RENEWS THE SDK CLOCK AND NOTHING ELSE, and that restraint is the whole
   * lease. `Sandbox`'s control client calls this on every control RPC, so the
   * heartbeat's own container ping, each checkpoint's mount reads and every
   * internal `exec` arrive here indistinguishable from a caller. It used to
   * write the durable interaction stamp too, which meant the heartbeat renewed,
   * on every tick, the very timestamp it then read to decide whether the box was
   * idle. `now - lastInteractionAt` was therefore always milliseconds, the idle
   * gate could never open, and the container ran until the platform reclaimed
   * it — billed the whole time, with `quiesceStep`, `quietSince` and the
   * background-work veto all unreachable in production while their unit tests
   * passed in isolation.
   *
   * A caller's interaction is stamped by {@link Devbox.stampInteraction}, at the
   * operations that are a caller by definition.
   */
  override renewActivityTimeout(): void {
    super.renewActivityTimeout();
  }

  /**
   * A CALLER touched this box: renew the SDK's clock and the durable stamp.
   *
   * Called by the public operations and by nothing else. A scheduled callback
   * must never reach it — the box's own maintenance traffic is not use, and a
   * box that counted it would never be idle.
   *
   * `protected` rather than private so a host can stamp its own caller-facing
   * surface: a preview request served straight off this Durable Object is a
   * caller, and only the host knows which of its entry points are.
   */
  protected stampInteraction(): void {
    this.renewActivityTimeout();
    const now = Date.now();
    this.#lastInteraction = now;

    if (now - this.#lastInteractionPersisted < INTERACTION_PERSIST_INTERVAL_MS) return;
    this.#lastInteractionPersisted = now;
    // Deliberately not awaited: this runs on the hot path of every operation.
    // The in-memory stamp has already renewed this incarnation, so a lost write
    // costs at most one extra heartbeat cycle of lease and never a leak.
    void this.ctx.storage.put(LAST_INTERACTION_KEY, now)
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] lease stamp was not persisted: ${describe({ cause })}`);
      });
  }

  /**
   * Keep externally requested work live from call entry through settlement.
   *
   * A command has no safe resource scope, and a supervised start cannot name its
   * process until it reserves one, so neither can use the resource lane. The
   * counter covers exactly those calls; every other active path exposes its own
   * lane state to the heartbeat.
   */
  async #withActiveCaller<T>(operation: () => Promise<T>): Promise<T> {
    this.#activeCallers += 1;
    this.stampInteraction();

    try {
      return await operation();
    } finally {
      this.#activeCallers -= 1;
      this.stampInteraction();
    }
  }

  // ── incidents ────────────────────────────────────────────────────────────

  /** Durable BEFORE anyone is told. An eviction between recording and
   *  delivering loses nothing, because delivery is itself a schedule row. */
  async #record(
    stage: IncidentStage,
    reason: string,
    extra?: { readonly processId?: string; readonly port?: number },
  ): Promise<string> {
    // THE SHARED WRITER, not a copy of it: `recordIncident` owns the row shape
    // and the reason bound (INCIDENT_REASON_MAX_CHARS), which the inline copy
    // here once hardcoded as a bare 2000 and would have drifted from the host
    // validator's bound. The id is minted here; this side arms delivery.
    const incidentId = crypto.randomUUID();
    await recordIncident(this.ctx.storage, stage, reason, extra);
    await this.#arm(INCIDENT_CALLBACK, Math.ceil(incidentRetryDelayMs(0) / 1000));

    return incidentId;
  }

  // ── storage wiring ───────────────────────────────────────────────────────

  #requireStorage(): DevboxStorage {
    this.#storage ??= this.#buildStorage();

    return this.#storage;
  }

  /**
   * Build the storage from the class's own hooks.
   *
   * An ephemeral box — no store — gets a storage that says so on every call
   * rather than a null that every caller has to check. `attach` reports `empty`,
   * `checkpoint` reports `skipped` with the reason, and `discard` has nothing to
   * do. All three are true statements about a box with nowhere to put bytes.
   */
  #buildStorage(): DevboxStorage {
    const store = this.store;

    if (store === undefined) {
      const reason = 'this devbox has no store configured, so nothing is durable';

      return {
        attach: () => Promise.resolve({ kind: 'empty', detail: reason } as const),
        checkpoint: () => Promise.resolve({
          kind: 'skipped', reason, bytes: undefined, movedBytes: 0,
        } as const),
        discard: () => Promise.resolve(),
      };
    }

    return snapshotChainStorage(this.#chainPorts(store));
  }

  /** This box's own key prefix in the store. The Durable Object's id is the
   *  box's identity and it is already a hex string, so it needs no escaping and

   *  cannot collide with another box's prefix. */
  #boxPrefix(): string {
    return `boxes/${this.ctx.id.toString()}`;
  }

  #chainPorts(store: DevboxStore): SnapshotChainPorts {
    return {
      containerRunning: () => this.ctx.container?.running === true,
      allowExtraction: () => this.allowExtraction,
      archiveExcludes: () => this.archiveExcludes,
      readState: async () => normalizeChainState(await this.ctx.storage.get<StoredValue>(STORAGE_KEY)),
      writeState: async (state, expectedRev) => await this.ctx.storage.transaction(async (transaction) => {
        const stored = normalizeChainState(await transaction.get<StoredValue>(STORAGE_KEY))?.rev ?? null;

        if (stored !== expectedRev) throw new ChainRecordAdvanced(expectedRev, stored);
        await transaction.put(STORAGE_KEY, state);
      }),
      clearState: async () => {
        await this.ctx.storage.delete(STORAGE_KEY);
      },
      checkpointIntervalMs: () => this.policy.checkpointIntervalMs,
      checkChanges: async (dir, since) => {
        const options: CheckChangesOptions = {};

        if (since !== undefined) options.since = since;
        const checked = await this.checkChanges(dir, options);

        // SAFETY: `ChangeStatus` is declared as this package's copy of the SDK's
        // own `CheckChangesResult.status` union, and the two are the same three
        // members. Re-declaring it rather than importing keeps the strategy
        // free of an SDK type it would otherwise need in its port signature.
        return { status: checked.status as ChangeStatus, version: checked.version };
      },
      exec: async (command) => await this.#rawExec(command),
      stamp: (phase) => this.#stampPhase(phase),
      containerGeneration: async () => await this.#readBootId(),
      storeRoot: () => chainStoreRoot(this.#boxPrefix()),
      mountStore: async (at) => {
        // The BOX's prefix, writable, with no credential: `chainStoreRoot` and
        // `SnapshotChainPorts.mountStore` state why.
        await this.mountBucket(store.binding, at, {
          prefix: `/${chainStoreRoot(this.#boxPrefix())}`,
          readOnly: false,
          s3fsOptions: [...STORE_MOUNT_S3FS_OPTIONS],
        });
      },
      unmountStore: async (at) => {
        try {
          await this.unmountBucket(at);
        } catch (error) {
          // A path the SDK's registry never held is the ordinary case on a bare
          // path, and the SDK says so by throwing. A path it DID hold while the
          // container holds no mount there is released by the patched SDK
          // (patches/@cloudflare%2Fsandbox@0.12.8.patch): it used to rethrow
          // with the entry standing, and every attach after a container swap
          // refused with "already in use". Anything else is worth knowing about
          // but must not fail the mount that follows; `SnapshotChainPorts.unmountStore`
          // states why no publication relies on this release to flush.
          console.log(`[devbox] store mount at ${at} was not released: ${describe({ cause: error })}`);
        }
      },
      readSeedStamp: async () => {
        const read = await this.#rawExec(
          `cat '${CHAIN_SEED_STAMP_PATH}' 2>/dev/null || true`, DEVBOX_RUNTIME_DIR,
        );

        const stamp = read.stdout.trim();

        return stamp.length > 0 ? stamp : undefined;
      },
      writeSeedStamp: async (stamp) => {
        // ONE COMMAND, and a temp-plus-rename: a stamp read half-written would
        // claim an upper holds a delta it does not, which is the one way this
        // marker could cost data rather than time.
        const written = await this.#rawExec(
          `printf %s ${JSON.stringify(stamp)} > '${CHAIN_SEED_STAMP_PATH}.tmp' && `
          + `mv '${CHAIN_SEED_STAMP_PATH}.tmp' '${CHAIN_SEED_STAMP_PATH}'`,
          DEVBOX_RUNTIME_DIR,
        );

        if (written.exitCode !== 0) {
          throw new Error(
            `the seed stamp could not be written at ${CHAIN_SEED_STAMP_PATH}: `
            + `${written.stderr.trim() || written.stdout.trim() || `exit ${written.exitCode}`}`,
          );
        }
      },
      objectFacts: async (key) => {
        // ONE metadata read, the only thing this side learns about a layer.
        // `digest` is R2's own checksum and exists only where R2 was given one;
        // an s3fs upload carries no checksum header the egress handler
        // forwards, and the Workers multipart API accepts none either, so a
        // chain layer's digest is normally absent. `objectVersion` is always
        // there. `layerIntegrityFailure` in `snapshot-chain.ts` states how the
        // two are compared.
        const head = await store.bucket.head(key);

        if (head === null) return undefined;
        const sha256 = head.checksums.sha256;

        return {
          bytes: head.size,
          digest: sha256 === undefined ? undefined : [...new Uint8Array(sha256)]
            .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
          objectVersion: head.version,
        };
      },
      deleteObjects: async (keys) => {
        await store.bucket.delete([...keys]);
      },
      countEntries: async (dir) => (await this.listFiles(dir)).files.length,
      restoreExtract: async (backup) => await this.restoreBackup(backup),
      createExtractSnapshot: async (options) =>
        await this.createBackup(mutableBackupOptions(options)),
      now: () => Date.now(),
      log: (message) => {
        console.log(`[devbox] ${message}`);
      },
    };
  }

  /** Container exec that does NOT pass the readiness gate.
   *
   *  Every internal probe, mount and archive command uses this — the strategy's
   *  own `exec` port included. The public `exec` waits for the restoration to
   *  finish, and the restoration itself runs commands, so routing internal work
   *  through the public method would make it wait for itself.
   *
   *  CALLED INSIDE THE PLATFORM'S GATE, by the container-start restore: the box
   *  is admitted through `start()`, which the patched SDK marks healthy before
   *  the hook, so a command issued here routes straight to the container (see
   *  `onStart` for the line numbers).
   */
  async #rawExec(
    command: string,
    cwd = DEVBOX_WORKDIR,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // THE CWD MUST EXIST BEFORE A COMMAND CAN STAND IN IT, and only the work
    // directory is the image's. `DEVBOX_RUNTIME_DIR` is the devbox's own path:
    // the session shell chdirs before it runs anything, so a command issued
    // from a runtime directory nothing has created yet never runs at all — and
    // every `mkdir -p` that would have created it is issued FROM that same
    // directory, so a box in that state can never dig itself out.
    //
    // MEASURED. A deployed box died of exactly this on both launches of
    // 2026-09-03: `create failed: cold attach refused: /workspace could not be
    // emptied for a mount: Failed to change directory to '/var/tmp/devbox'`.
    // Nothing had created the runtime directory on that container, and every
    // command that would have was issued FROM it — which is why the repair
    // belongs to this seam rather than to the storage's ports.
    //
    // One command per container per runtime-directory cwd, and idempotent:
    // `mkdir -p` from the work directory, which always exists.
    if (cwd === DEVBOX_RUNTIME_DIR && !this.#runtimeDirReady) {
      const made = await super.exec(`mkdir -p '${DEVBOX_RUNTIME_DIR}'`, { cwd: DEVBOX_WORKDIR });
      this.#stampPhase('containerStart');

      if (made.exitCode !== 0) {
        return { stdout: made.stdout, stderr: made.stderr, exitCode: made.exitCode };
      }

      this.#runtimeDirReady = true;
    }

    const result = await super.exec(command, { cwd });
    this.#stampPhase('containerStart');

    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  /** Whether THIS instance has established the runtime directory on the
   *  container it is talking to. Reset with the generation, because a
   *  replacement is a fresh container whose disk holds none of ours. */
  #runtimeDirReady = false;

  /** One reader for the durable spec tables; the two names below are the
   *  domain concepts seven call sites use in lockstep. */
  async #specs<T>(prefix: string): Promise<readonly T[]> {
    const rows = await this.ctx.storage.list<T>({ prefix });

    return [...rows.values()];
  }

  async #procSpecs(): Promise<readonly SupervisedProcessSpec[]> {
    return this.#specs<SupervisedProcessSpec>(PROC_SPEC_PREFIX);
  }

  async #portSpecs(): Promise<readonly PortExposureSpec[]> {
    return this.#specs<PortExposureSpec>(PORT_SPEC_PREFIX);
  }

  /**
   * Arm a schedule row unless a FUTURE one is already pending.
   *
   * Idempotent because `onStart` fires at least once per container start and a
   * restart must not double every period. Future-only because the row currently
   * being dispatched is still in the table while its callback runs, so a
   * self-re-arming callback that counted every row would see itself, skip, and
   * be deleted a moment later with the chain dead. See `needsArming`.
   */
  async #arm(callback: string, delaySeconds: number): Promise<void> {
    if (await this.#pending(callback)) return;
    await this.schedule(delaySeconds, callback, null);
  }

  /** Is a row for this callback already scheduled in the FUTURE? The question
   *  `#arm` asks before writing one, and the question `ensureReady` asks before
   *  driving a retry the schedule already owes. */
  async #pending(callback: string): Promise<boolean> {
    return !needsArming(await this.listSchedules(callback), Date.now() / 1000);
  }
}

/** The SDK's `BackupOptions` takes a mutable `excludes`; a shared constant must
 *  be readonly. One copy at the boundary rather than a mutable shared array. */
function mutableBackupOptions(options: BackupOptions): BackupOptions {
  return { ...options, excludes: options.excludes === undefined ? undefined : [...options.excludes] };
}
