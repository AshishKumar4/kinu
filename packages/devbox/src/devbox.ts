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
 *   The restoration, with ONE driver and TWO doors onto it. The driver is the
 *   generation's single-flight startup attempt; the doors are the
 *   `devboxStartup` schedule row a container start arms, and any readiness
 *   request that arrives before that frame. Whichever arrives first does the
 *   work and the other joins it, so a caller can never open a second
 *   restoration against one container.
 *
 *   NOT inside the container-start hook, and that is a refuted design rather
 *   than an untried one: the hook is awaited inside `blockConcurrencyWhile`, and
 *   the first container command issued there never returns — reaching the
 *   container asks the SDK for a nested `blockConcurrencyWhile` the runtime
 *   cannot grant while the outer one is held, so the activation ran to the cap
 *   `do.block_concurrency.cancel_ms` names and the object was reset — then the
 *   armed row woke it into the same gate again, for ever. Measured on deployed
 *   probe `gp0902011918`; `onStart` carries the log. What the hook does now is
 *   arm the three durable chains and nothing else.
 *
 *   The readiness gate, as one of the two doors. `ensureReady()` guards every
 *   operation, joins or opens the one attempt, and returns what it admitted the
 *   caller INTO — restored, or repair with a reason — refusing everything else.
 *
 *   The activity lease. The disk is ephemeral, so an idle expiry costs an
 *   attach. One durable timestamp plus one heartbeat holds the container while
 *   it is being used and stops it, after a final checkpoint, when three
 *   independent gates agree it is not. The heartbeat renews the SDK's own
 *   activity clock, because that clock is what its alarm chain ends on.
 *
 *   Supervised processes and ports. A process started through `startSupervised`
 *   has a durable spec, so it comes back after a recycle. A port exposed
 *   through `notePortExposed` keeps its token, so its preview URL comes back
 *   byte for byte.
 *
 *   The incident ledger. A lifecycle failure is written down BEFORE anyone is
 *   told, and delivery retries by schedule until the host accepts it.
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
  findMount, withContainerStartDeadline, openStartBudget, awaitListenerCommand,
  racedRestoreSteps, runRestoreStep, type RestoreSteps,
} from './lifecycle';
import { r2fsStorage, type R2fsPorts } from './r2fs';
import { deletePrefix, prefixInventory } from './object-store';
import {
  CAS_RUNNER_PATH,
  CAS_STORE_MOUNT,
  CAS_TREE_MOUNT,
  CAS_UPPER_DIR,
  CAS_WORK_DIR,
  casStoreUrl,
  normalizeOverlayCasState,
  overlayCasStorage,
  type OverlayCasPorts,
} from './overlay-cas';
import {
  CANDIDATE_JOURNAL_BINARY,
  CANDIDATE_JOURNAL_MOUNT,
  CANDIDATE_JOURNAL_ROOT,
  CANDIDATE_JOURNAL_SOCKET,
  CANDIDATE_JOURNAL_STATE,
  CANDIDATE_RUNNER_RESULT_DIR,
  CANDIDATE_STORE_MOUNT,
  candidateCheckpointRunnerPaths,
  candidateContainerStorage,
  candidateStorePaths,
  type CandidateContainerFormat,
  type CandidateContainerPorts,
} from './candidates/container';
import {
  JOURNAL_READY_WAIT_SECONDS,
  journalDaemonArgv,
  journalReadyCommand,
  readJournalReady,
} from './capture/journal/command';
import {
  beginCandidateOperation,
  candidateRunControl,
  finalizeCandidateOperation,
  redriveCandidateOperation,
  settleCandidateNoChange,
  type CandidateControlStore,
  type CandidateEnvelopeStore,
} from './candidates/control';
import { envelopeBytes, parseEnvelopeBytes } from './candidates/publication';
import {
  CandidateControlStateV1Schema,
  type CandidateControlStateV1,
  type ImmutableObjectRef,
} from './durability/contracts';
import {
  deliverIncidents, INCIDENT_PREFIX, incidentTotals, recordIncident,
  type IncidentRow,
} from './incidents';
import {
  CHAIN_EXCLUDES,
  ChainRecordAdvanced,
  chainStoreRoot,
  isOverlayMounted,
  normalizeChainState,
  snapshotChainStorage,
  type ChainState,
  type ChangeStatus,
  type SnapshotChainPorts,
} from './snapshot-chain';
import {
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

const CANDIDATE_CONTROL_PREFIX = 'devbox:candidate-control:';
/**
 * The one spelling of the candidate control key. The publish path and the
 * wake path both derive it here, so a key the write uses and a key the read
 * uses cannot drift apart unnoticed.
 */
function candidateControlKey(strategy: CandidateContainerFormat): string {
  return `${CANDIDATE_CONTROL_PREFIX}${strategy}`;
}

/** Runner status is polled instead of opening Sandbox's long-lived log SSE.
 *  Separate from cli-backend's LOCK_POLL_MS: same round number, unrelated
 *  decisions — this paces a container process poll, that one a config lock. */
const RUNNER_EXIT_POLL_INTERVAL_MS = 50;
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

/** The durable control record for one candidate arm; an absent row is no history. */
function readCandidateControl(stored: StoredValue | undefined): CandidateControlStateV1 {
  return stored === undefined
    ? { version: 1, head: null, operation: null }
    : v.parse(CandidateControlStateV1Schema, stored);
}
/**
 * The raw candidate control fact, for diagnosis, never for serving. `found`
 * tells an absent row apart from a row that holds a null head. `key` and
 * `boxId` travel so a dump taken at publish and a dump taken at wake compare
 * byte for byte. Read-only: reporting it changes no stored row.
 */
export interface CandidateControlDump {
  readonly strategy: DevboxStrategyName;
  readonly boxId: string;
  readonly key: string | null;
  readonly found: boolean;
  readonly head: string | null;
  readonly operation: string | null;
}

/** Durable keys. One namespace, so a host's own keys cannot collide with these
 *  and a reader can tell at a glance which rows belong to the box machinery. */
const STORAGE_KEY = 'devbox:storage-state';
/** The overlay-cas record. Deliberately NOT `STORAGE_KEY`: a box must never
 *  read a snapshot-chain record as a CAS record, and a distinct key makes
 *  that unrepresentable rather than merely unlikely. */
const OVERLAY_CAS_STATE_KEY = 'devbox:overlay-cas-state';
const LAST_INTERACTION_KEY = 'devbox:last-interaction';
const QUIET_SINCE_KEY = 'devbox:quiet-since';
const PROC_SPEC_PREFIX = 'devbox:proc:';
const PORT_SPEC_PREFIX = 'devbox:port:';
const MULTIPART_UPLOAD_PREFIX = 'devbox:multipart-upload:';
const MultipartUploadSchema = v.object({
  key: v.string(),
  uploadId: v.string(),
});

const LAST_ATTACH_KEY = 'devbox:last-attach';
/** How far this box has gone recovering one container identity from a failed
 *  attach. Written only by the recovery ladder, deleted by the first attach that
 *  lands. Durable because the retry is a schedule row and the object that runs
 *  it is often a fresh one — see {@link RECOVERY_STAGES}. */
const ATTACH_RECOVERY_KEY = 'devbox:attach-recovery';
const LAST_TICK_KEY = 'devbox:last-tick';
const BOOT_ID_KEY = 'devbox:boot-id';
const REPLACED_COUNT_KEY = 'devbox:replaced-count';

/** Scheduled-callback names. Each MUST name a public method on the class:
 *  `Container.schedule` rejects anything it cannot call back. */
const STARTUP_CALLBACK = 'devboxStartup';
const CHECKPOINT_CALLBACK = 'devboxCheckpoint';
const HEARTBEAT_CALLBACK = 'devboxHeartbeat';
const INCIDENT_CALLBACK = 'devboxIncidents';



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
 *
 * Two, and they join the same single-flight run: the `devboxStartup` schedule
 * row a container start arms, and a readiness request that arrives before that
 * frame. Both are ordinary delivered frames — there is no unobservable home any
 * more — so this is not a claim about whether the value can be seen, it is the
 * answer to "who is driving this" for whoever is polling.
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
  #restoration: Restoration = { phase: 'unstarted' };
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
   * Storage only, which is what may run inside this gate: one sync SELECT
   * plus sync deletes, no container I/O and no R2 — the same rule `onStart`
   * keeps.
   */
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Not awaited: a constructor cannot be. The gate holds every event until
    // the sweep settles, and a storage failure here is the object's own SQLite
    // failing, which the first request will report on its own terms.
    void ctx.blockConcurrencyWhile(() => this.#sweepUnknownSchedules())
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] schedule sweep failed at activation: ${describe({ cause })}`);
      });
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
    return 'snapshot-chain';
  }

  /**
   * The fixture bundles the candidate runner from package source into the
   * container. Production has no implicit fallback: a candidate box without a
   * bundled runner refuses instead of measuring another strategy under its name.
   */
  protected get candidateRunnerPath(): string | undefined {
    return undefined;
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
   * THE CONTAINER-START HOOK ARMS THE BOX AND TOUCHES NOTHING ELSE.
   *
   * `Container.onStart` is awaited inside `blockConcurrencyWhile`
   * (`@cloudflare/containers`, `container.js:583` for `start()` and `:632-636`
   * for `startAndWaitForPorts`), so this is the one method on this class that
   * runs while the platform's own critical section is held. Everything it does
   * is a write to this object's own storage.
   *
   * A RESTORE HERE WAS A REFUTED DESIGN, and it is worth saying why rather than
   * quietly not doing it, because the arithmetic that argued for it was sound
   * and the conclusion was still wrong. The claim was: the platform holds every
   * request behind this hook, so a restore that runs here cannot be observed
   * half-done, and gate occupancy is "the polled budget plus one command".
   * Measured on deployed probe `gp0902011918` (three cycles, `attachBudgetMs`
   * cut to 5 s), the first container command inside the block never returned at
   * all:
   *
   *   01:29:51.520  onStart entry gen=1
   *   01:29:51.574  the three schedule rows written (+54 ms)
   *   01:29:51.574  exec issued: `cat /proc/mounts`
   *   01:29:51.611  onStart entry gen=2      <- the SDK re-entered this hook
   *   ...no exec ever returned...  then: blockConcurrencyWhile canceled, the
   *                                     Durable Object was reset
   *
   * The command cannot come back: `super.exec` reaches the container through the
   * SDK's control connection, and establishing that connection calls
   * `startContainerForRPC` -> `startAndWaitForPorts` (`@cloudflare/sandbox`,
   * `dist/sandbox-CPj2jsbz.js:3556, 8831`), which asks for a NESTED
   * `ctx.blockConcurrencyWhile` — one that cannot be granted while this hook
   * holds the outer one. `containerFetch` does the same whenever the SDK's
   * durable status is not yet `healthy` (`:8688-8702`), and plain `start()`
   * never sets `healthy`. So the budget was never the binding constraint: the
   * gate ran to the cap `do.block_concurrency.cancel_ms` names on its first hop,
   * the object was reset, the armed startup row survived (the SDK deletes a
   * schedule row only after its callback returns, `container.js:1549`) and the
   * next alarm re-entered the same gate — one reset per cap window, plus the
   * row's own one-second delay, for as long as the box existed.
   *
   * SO THE INVARIANT IS NOW THE OPPOSITE ONE: no container I/O and no R2 in
   * this hook, ever. Restoration has one driver — the single-flight startup
   * attempt — reached from two doors that join the same run: the
   * `devboxStartup` row armed here, and any readiness request that arrives
   * first. `scripts/do-init-gate.ts` pins the await, and
   * `packages/devbox/tests/restore-out-of-gate.test.ts` counts what happens
   * inside the block.
   *
   * NO GENERATION TURNOVER HERE EITHER, and that is the same evidence read
   * again: this hook is NOT "once per container start". The SDK calls it from
   * its own control paths on a container that is already up — the second
   * `onStart entry` line above is one such call, 37 ms into the first exec — so
   * a turnover here would fence the very restoration that triggered it, and an
   * unconditional turnover beside an unconditional arm is a full restore every
   * second for ever. The turnover belongs to whoever can read the evidence: the
   * doors, which ask whether the container is down and whether the boot id
   * still names the instance this box restored.
   */
  override async onStart(): Promise<void> {
    await this.#armContainerSchedules();
  }

  /**
   * The three durable chains this box rides, armed from the one hook that fires
   * per container start. Dead rows are swept at activation, not here: see the
   * constructor.
   *
   * THE STARTUP ROW GOES THROUGH `kickStartup`, not through a bare `#arm`, and
   * the difference is a loop. Every readiness drive calls `start()`, which
   * re-enters `onStart` (`container.js:583`) whether or not it started anything,
   * so a hook that armed the startup row unconditionally armed a successor one
   * second after every drive — including the drive that row itself woke. That is
   * a restore attempt per second for as long as the box exists. `kickStartup`
   * already owns the only question worth asking — is anything going to try —
   * and answers it from the box's own phase, so a settled box arms nothing and
   * the chain ends where it should.
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
    // be noticed. Every restoration passes through this method, whether it was
    // driven by the container-start hook or by a heartbeat that spotted the
    // mismatch itself. Counting in the heartbeat alone under-reported exactly the
    // case worth measuring: a replacement handled through `onStart` incremented
    // nothing, so a box could be replaced repeatedly and report zero.
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
   * its writes land in the bare `/workspace` directory. Both deployed control
   * arms died of it on 2026-08-31, in the two shapes their strategies give it:
   *
   *   `r2fs` — s3fs refuses a non-empty mountpoint, and the refusal is
   *     terminal, so the box never attached again.
   *   `overlay-cas` — the next attach mounted the overlay OVER those bytes,
   *     the upper it scans was therefore empty, nothing was ever journalled,
   *     and the wake reported `empty` for a box that had been written to.
   *
   * A COMMIT IS THE RIGHT PLACE TO ASK. It is the moment this box claims bytes
   * are durable, it happens at checkpoint cadence rather than per operation, and
   * one `cat` of the boot marker is the whole cost. The re-attach is the
   * ordinary restoration, so it goes through the same recovery ladder and the
   * same residue handling every attach has.
   */
  async #healReplacedContainer(): Promise<void> {
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

  /** True only when durable and container-local identity prove this instance
   * already has an attached workspace after an isolate reconstruction. */
  async #hasAttachedContainer(generation: number): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);
    if (expected === undefined || !this.#owns(generation)) return false;
    return this.#owns(generation) && (await this.#readBootId()) === expected;
  }

  /**
   * ONE restore attempt, and it always CLASSIFIES.
   *
   * ONE CALLER, `#startupAttempt`, and one step policy. There used to be two of
   * each: an in-gate home with a polled budget and a scheduled home with a raced
   * one. The in-gate home is gone — see `onStart` for the probe that refuted it
   * — so the walk has a single bound again, the raced allowance, whose timer is
   * delivered because nothing here runs inside `blockConcurrencyWhile`.
   *
   * IT DOES NOT THROW; IT HANDS THE FAILURE BACK. Every outcome leaves the box
   * in a NAMED state (`attached`, `repair`, or `unattached` with the ladder's
   * reason), and the classified cause is RETURNED so a caller whose policy is to
   * raise one raises exactly that value rather than a second wording of it.
   *
   * IT SAYS SO WHILE IT RUNS, which is the other half. The first thing it
   * publishes is `restoring`, before the ladder claim's own await, so no window
   * exists in which an attempt is in flight and this box still reports that none
   * has begun. See {@link Restoration}: that window was measured as a 300 s
   * freeze in which every poll read `unstarted` and decided to wait. `where` is
   * the DOOR that opened it, passed in rather than inferred: a poller reading
   * `restoring` wants to know whether a schedule or a caller is driving.
   */
  async #restoreNow(
    generation: number,
    where: RestorationDoor,
    steps: RestoreSteps,
  ): Promise<{ readonly cause: unknown } | undefined> {
    this.#restoration = { phase: 'restoring', where, since: Date.now() };
    const claim = await this.#claimRecovery();
    if (!this.#owns(generation)) return undefined;
    if (!claim.admit) {
      // The ladder row did not parse, so there is no evidence to act on and
      // nothing may be destroyed on a guess. The claim has already normalised
      // the row to the terminal stage, so this refusal is readable and finite:
      // `attachNow()` re-attempts, and a success deletes the row.
      const reason = 'the attach-recovery record did not parse [unreadable → refuse]';
      this.#restoration = { phase: 'unattached', reason, retry: false };
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
    this.#restoration = settledRestoration(restored, stamped.kind);
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
   * `startupPollVerdict`). So it is written by EVERY drive that reaches
   * `attached`: the full restoration, and the same-container repair a wake
   * takes when the instance survived. The repair used to settle without it,
   * and the deployed merkle-pack wake of run 20260902154130 was refused as
   * `wake restored empty, expected attached` on a row the cold attach had
   * written — against a head three quiesces had published since.
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
   * ONE OF TWO DOORS ONTO ONE RUN. A container start arms this row for one
   * second later (`#armContainerSchedules`), and a readiness request that
   * arrives before that frame comes through the other door
   * (`ensureReady` → `#drive('request')`). Both call `#drive`, which opens the
   * generation's single-flight attempt or joins the one already in flight — so
   * whichever arrives first does the work and the other waits on it.
   *
   * IT IS ALSO THE ONLY DRIVER FOR A BOX NOBODY IS ASKING ABOUT: the platform
   * replaces a container instance under a live object, or the object is reset
   * mid-restore and the SDK — which by then sees a running, healthy container —
   * never calls the start hook again. The row is durable, so it survives the
   * reset that its own frame died in, and this is the frame that restores.
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
    // proves the default port answers before returning, and it is idempotent on
    // a container already running — so asking again costs one health probe and
    // buys the guarantee that nothing below runs commands on a container that
    // has never answered one.
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
        // THE PROBE REALLY LASTS ITS WINDOW, and it did not. `retries: 1` makes
        // the SDK's `totalTries` exactly one (`container.js`: `totalTries =
        // waitOptions.retries`, and the loop throws NO_CONTAINER_INSTANCE_ERROR
        // when `totalTries === tries + 1`), so the first refusal ended the call
        // after ONE ~100 ms poll and the abort signal below could never fire —
        // the comment claiming `portWaitMs` bounded this probe was describing
        // something the code did not do. Every one of those instant refusals
        // cost a durable incident row plus a re-arm at one-second granularity:
        // measured live on a contended account, 21 incidents in 15 s, all
        // "[unclassified → retry] there is no container instance...", before the
        // same box attached at ~20 s. The retry count is now the window divided
        // by the interval — the SDK's own default shape — so ONE call polls the
        // whole window and a container that appears inside it is admitted with
        // no incident at all.
        retries: Math.ceil(this.policy.portWaitMs / ADMISSION_POLL_INTERVAL_MS),
        waitInterval: ADMISSION_POLL_INTERVAL_MS,
        // The PORT policy bounds the port probe, which is the question it is
        // named for. It is not the container's admission deadline: a container
        // still coming up has not failed, so the answer to a probe that did not
        // land in that window is another probe, not a longer one.
        signal: AbortSignal.timeout(this.policy.portWaitMs),
      });
    } catch (error) {
      // Capacity and a container that has not answered yet are both admission
      // outcomes, not failed attachments. No recovery ladder applies to an
      // identity that was never admitted.
      //
      // AND A SUPERSEDED ADMISSION IS INERT, for the reason `#recover` is.
      // `start()` is the longest await on this path — a whole `portWaitMs` — and
      // an attempt parked inside it holds no resource lane, no checkpoint lane
      // and no single-flight entry, so the heartbeat's own busy check cannot see
      // it and a quiesce can land there. Recording then puts a live blocker
      // about a container nobody asked to exist on the one channel built to be
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
    let generation = this.#generation;
    // ALREADY SETTLED — FOR THE CONTAINER THIS BOX IS LOOKING AT.
    //
    // THE SECOND HALF IS WHY THIS IS NOT JUST A PHASE CHECK. The start hook no
    // longer turns the generation over (see `onStart`: the SDK re-enters it on a
    // container that is already up, so a turnover there fences live work and
    // loops), which means a box can reach this line claiming `attached` while
    // the instance underneath is a fresh one. The boot id is the only reliable
    // signal there is — the container carries an id that dies with it and this
    // object keeps a copy — so the door ASKS before it accepts its own memory.
    // One `cat` per drive, and drives happen once per container start plus once
    // per retry, never per operation.
    if (this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair') {
      if (!await this.#containerWasReplaced()) return;
      console.error(
        '[devbox] the boot id says this box is looking at a container instance it never '
        + 'restored; restoring it now rather than serving callers a world that is gone',
      );
      this.#invalidateGeneration();
      generation = this.#generation;
    }
    // Only candidates can prove and repair their live mount graph. Every other
    // strategy takes the ordinary attach path instead of treating a boot marker
    // as a durable attachment fact.
    const storage = this.#requireStorage();
    if (storage.repairAttached !== undefined && await this.#hasAttachedContainer(generation)) {
      await this.#repairAttached(generation);
      return;
    }
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
   * restoration's state. That is the same law the container-start hook is held
   * to — no frame is held hostage to restore duration — and the answer a caller
   * gets is the honest one: `restoring`, for this long, ask again. The box's own
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
        this.#restoration = { phase: 'unattached', reason, retry: true };
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
   * process reservations, port exposures, or the boot marker. It runs OUTSIDE
   * the init gate — a caller asked for it — so it takes the raced step policy
   * whose timer is delivered.
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
      if (this.#requireStorage().repairAttached !== undefined) {
        this.#restoration = { phase: 'unstarted' };
      }
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
   * The same-container half of a drive: prove the instance is the one this
   * box stamped, let the storage re-establish what it serves, and settle.
   *
   * THE STORAGE'S ANSWER IS WRITTEN DOWN, the way the full attach's is. This
   * is the path a wake takes whenever the instance survived the stop with its
   * boot marker (`src/snapshot-chain.ts` records that the platform does bring
   * one back), and it used to settle `attached` with no attach record of its
   * own — so the durable row still described the COLD attach, and the driver,
   * which reads that row the moment the phase says `attached`, refused the
   * deployed merkle-pack wake of run 20260902154130 as `wake restored empty,
   * expected attached` against a head three quiesces had published.
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
    const budget = openStartBudget(this.policy.attachBudgetMs);
    const repair = this.#requireStorage().repairAttached;
    const served = repair === undefined
      ? undefined
      : await withContainerStartDeadline(
        'Devbox.repairAttached',
        budget,
        repair,
        (failure) => {
          console.error(
            `[devbox] attached-container repair overran its budget; abandoned work settled with: `
            + describe({ cause: failure.cause }),
          );
        },
      );
    if (!this.#owns(generation)) return;
    if (expected !== undefined && (await this.#readBootId()) !== expected) {
      this.#invalidateGeneration();
      await this.#drive('request');
      return;
    }
    if (!this.#owns(generation)) return;
    // Only a storage that repaired its attachment has a fresh answer. A
    // strategy without a repair re-runs the service half alone, and the record
    // its full attach wrote for this same generation still stands.
    if (served !== undefined) await this.#recordAttach(served);
    const steps = racedRestoreSteps(budget);
    const restored = await this.#restartWorkloads(generation, steps);
    if (!this.#owns(generation)) return;
    const stamped = expected === undefined && retryBootStamp
      ? await steps.run(async () => await this.#stampBootId(generation), () => undefined)
      : expected === undefined ? { kind: 'pending' as const } : { kind: 'done' as const };
    if (!this.#owns(generation)) return;
    this.#restoration = settledRestoration(restored, stamped.kind);
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
   * THE CONTAINER-START HOOK IS DELIBERATELY NOT ON THAT LIST. It has no
   * evidence: the SDK calls it from its own control paths on a container that is
   * already up (measured in probe `gp0902011918`, 37 ms into the first exec of a
   * restore), so a turnover there fences the restoration that triggered it. See
   * `onStart`.
   */
  #invalidateGeneration(): void {
    this.#generation += 1;
    this.#startup = undefined;
    this.#restoration = { phase: 'unstarted' };
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
    this.#restoration = { phase: 'unattached', reason, retry: decision.action === 'retry' };
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
   * `ensureReady`, and its own start hook opens the next generation; waking a
   * box no caller is asking for would only bill for the wake.
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
      this.#restoration = {
        phase: 'unattached',
        reason: `${reason}; and the container identity could not be destroyed: `
          + describe({ cause: error }),
        // TERMINAL, whatever the class was. The abandoned work is still inside
        // that container, so nothing may attach over it until a caller asks by
        // name — the retry this refuses is exactly the overlap the destruction
        // was meant to prevent.
        retry: false,
      };
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
   * Start a stopped container and leave its durable startup callback to restore
   * it. This is deliberately not an attachment operation: `onStart` arms
   * `devboxStartup`, while that callback owns every storage mutation and can
   * finish after this RPC returns.
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
   * THE FALLBACK, NOT THE PRIMARY PATH. On a cold start the restore already
   * happened: it ran inside the container-start gate, where the platform held
   * every request behind it, so the first operation arrives at a box that is
   * already settled and this method resolves on its first branch. What it exists
   * for is the case the gate cannot cover — a container replaced under a live
   * object — where it joins the in-flight fallback attempt or drives one.
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
   * The container-start hook clears the same refusal for the same reason: a
   * fresh container is a fresh chance to attach, and one that attaches heals
   * itself.
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
    if (this.#unready() !== undefined) this.#restoration = { phase: 'unstarted' };
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
   * The one serialization point for every strategy checkpoint this instance
   * can be asked to run: `checkpointNow`, the scheduled tick, the quiesce and
   * activity expiry. See {@link createCheckpointLane} for why two overlapping
   * runs must never interleave inside a strategy.
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
        // checkpoint behind it. Run 20260903140046's overlay-cas arm is the
        // shape: its first decisive `npm` checkpoint never settled inside the
        // driver's 1,500,000 ms operation deadline, and every segment after it
        // was answered `a restoration has been running in the request for N
        // ms; a startup is armed, so ask again` — the armed operation row
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
   * `storage.detach()` BEFORE `this.stop('SIGTERM')`, and the r2fs detach
   * unmounts through the SDK's `unmountBucket` — which refuses with EBUSY
   * while any process holds an fd on the s3fs mount. The refusal landed
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
   * below is necessary but not sufficient and the r2fs detach parks the session
   * before it asks. See {@link R2fsPorts.parkSession}.
   */
  async quiesce(): Promise<CheckpointOutcome> {
    // The final commit is the one a wake reads back, so it is the last place a
    // replaced container may go unnoticed: see `#healReplacedContainer`.
    await this.#healReplacedContainer();
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
   *  them. */
  async discardState(): Promise<void> {
    await this.#requireStorage().discard();
    // The attach evidence describes bytes that no longer exist, so it goes with
    // them rather than outliving them as a claim about nothing.
    await this.ctx.storage.delete(LAST_ATTACH_KEY);
  }
  /**
   * The raw candidate control fact this box holds, for diagnosis. A wake that
   * finds no head can come from three places: the row is absent, the row
   * holds a null head, or the read looked where the write never wrote. This
   * answers which one by reporting the key it read, the identity it ran
   * against, and whether the row was there. Read-only.
   */
  async candidateControlState(): Promise<CandidateControlDump> {
    const strategy = this.strategy;
    const boxId = this.ctx.id.toString();
    if (strategy !== 'bounded-layers' && strategy !== 'merkle-pack') {
      return { strategy, boxId, key: null, found: false, head: null, operation: null };
    }
    const key = candidateControlKey(strategy);
    const stored = await this.ctx.storage.get<StoredValue>(key);
    if (stored === undefined) {
      return { strategy, boxId, key, found: false, head: null, operation: null };
    }
    const parsed = readCandidateControl(stored);
    return {
      strategy,
      boxId,
      key,
      found: true,
      head: parsed.head?.rootEnvelopeId ?? null,
      operation: parsed.operation?.phase ?? null,
    };
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
      if (await this.#containerWasReplaced()) {
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
   * Build the strategy from the class's own hooks.
   *
   * An ephemeral box — no store — gets a strategy that says so on every call
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
    // EXHAUSTIVE, AND IT REFUSES. The last arm used to be `snapshot-chain` by
    // fallthrough, which meant a strategy nobody had wired here still produced
    // a working box — the CHAIN, wearing the other strategy's name. A bench arm
    // in that state reports a full column of numbers that are the chain
    // measured twice, and nothing anywhere looks wrong. A box that refuses to
    // build says which name it did not recognise and stops.
    if (this.strategy === 'r2fs') return r2fsStorage(this.#r2fsPorts(store));
    if (this.strategy === 'overlay-cas') return overlayCasStorage(this.#overlayCasPorts(store));
    if (this.strategy === 'snapshot-chain') return snapshotChainStorage(this.#chainPorts(store));
    if (this.strategy === 'bounded-layers' || this.strategy === 'merkle-pack') {
      return candidateContainerStorage(this.#candidatePorts(store, this.strategy));
    }
    throw new Error(
      `this devbox is configured for the "${String(this.strategy)}" durability strategy, which `
      + 'nothing here builds. Refusing to serve a box with a storage strategy other than the '
      + 'one it was asked for.',
    );
  }

  /** This box's own key prefix in the store. The Durable Object's id is the
   *  box's identity and it is already a hex string, so it needs no escaping and

   *  cannot collide with another box's prefix. */
  #boxPrefix(): string {
    return `boxes/${this.ctx.id.toString()}`;
  }
  /** Abort multipart uploads whose initiating isolate did not survive. The
   * upload id is durable before the first part, then removed after complete or
   * abort. A stale row is safe to retry and is always consumed. */
  async #abortPendingMultipartUploads(store: DevboxStore): Promise<void> {
    const rows = await this.ctx.storage.list<unknown>({ prefix: MULTIPART_UPLOAD_PREFIX });
    for (const [storageKey, raw] of rows) {
      const parsed = v.safeParse(MultipartUploadSchema, raw);
      if (!parsed.success) {
        console.error(`[devbox] unreadable multipart upload row ${storageKey} removed`);
        await this.ctx.storage.delete(storageKey);
        continue;
      }
      try {
        await store.bucket
          .resumeMultipartUpload(parsed.output.key, parsed.output.uploadId)
          .abort();
      } catch (error) {
        console.log(
          `[devbox] multipart ${parsed.output.uploadId} was already settled or could not abort: `
          + describe({ cause: error }),
        );
      } finally {
        await this.ctx.storage.delete(storageKey);
      }
    }
  }

  #r2fsPorts(store: DevboxStore): R2fsPorts {
    const prefix = this.#boxPrefix();
    return {
      containerRunning: () => this.ctx.container?.running === true,
      // BOTH OF THESE RUN FROM THE RUNTIME DIRECTORY, NOT THE WORK DIRECTORY,
      // for the reason `quarantineMountpoint` below already does: `#rawExec`
      // defaults its cwd to `DEVBOX_WORKDIR`, and these are the two commands
      // the detach issues immediately before releasing that very mount. Reading
      // `/proc/mounts` and flushing a path do not require standing in it, and
      // standing in it is what refuses the unmount that follows.
      readMounts: async () => (await this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR)).stdout,
      exec: async (command) => await this.#rawExec(command, DEVBOX_RUNTIME_DIR),
      pathExists: async (path) => await this.#pathExists(path),
      mount: async (s3fsOptions) => {
        await this.mountBucket(store.binding, DEVBOX_WORKDIR, {
          prefix: `/${prefix}`,
          readOnly: false,
          s3fsOptions: [...s3fsOptions],
        });
      },
      unmount: async () => {
        await this.unmountBucket(DEVBOX_WORKDIR);
      },
      // BOTH DELEGATE TO THE ONE SEAM, `#parkSessionOutside` / `#lazyUnmount`,
      // because every strategy that mounts at the work directory needs exactly
      // this and a second copy would eventually disagree with the first.
      parkSession: async () => await this.#parkSessionOutside(DEVBOX_WORKDIR),
      lazyUnmount: async () => await this.#lazyUnmount(DEVBOX_WORKDIR),
      // ONE COMMAND, so a container replaced between two RPCs cannot leave the
      // residue directory made and the move undone. `find -exec … +` runs
      // nothing when the mountpoint is already empty, which is the ordinary
      // case, and the count is read from the residue directory the move filled.
      quarantineMountpoint: async () => {
        const residue = `${DEVBOX_RUNTIME_DIR}/r2fs-mountpoint-residue`;
        const swept = await this.#rawExec(
          `d='${residue}/'$(date +%s%N) && mkdir -p "$d" && `
          + `find '${DEVBOX_WORKDIR}' -mindepth 1 -maxdepth 1 -exec mv -t "$d" -- {} + && `
          + `find "$d" -mindepth 1 -maxdepth 1 | wc -l`,
          DEVBOX_RUNTIME_DIR,
        );
        if (swept.exitCode !== 0) {
          throw new Error(
            `${DEVBOX_WORKDIR} could not be emptied for a mount: `
            + `${swept.stderr.trim() || swept.stdout.trim() || `exit ${swept.exitCode}`}`,
          );
        }
        const moved = Number.parseInt(swept.stdout.trim(), 10);
        return Number.isSafeInteger(moved) && moved >= 0 ? moved : 0;
      },
      inventory: async () => await prefixInventory(store.bucket, `${prefix}/`),
      clearPrefix: async () => await deletePrefix(store.bucket, `${prefix}/`),
      log: (message) => {
        console.log(`[devbox] ${message}`);
      },
    };
  }

  /**
   * The overlay-cas ports.
   *
   * Mounts, one runner invocation, and the durable row. Every byte this
   * strategy moves is moved by the runner beside the mounted prefix, so there
   * are no command templates here to keep correct and no chunk ever crosses
   * this isolate. What a receipt means belongs to the strategy that acts on it,
   * which is why `invokeRunner` hands back exactly what the runner printed.
   */
  #overlayCasPorts(store: DevboxStore): OverlayCasPorts {
    const prefix = this.#boxPrefix();
    return {
      containerRunning: () => this.ctx.container?.running === true,
      mountStore: async () => {
        // The exit code is CHECKED. It used to be discarded, so a failed setup
        // ran on to the mount and surfaced two RPCs later as "cas-upper does
        // not exist" — a refusal naming the symptom while the container's own
        // words about the cause were thrown away.
        const prepared = await this.#rawExec(
          `mkdir -p '${CAS_STORE_MOUNT}' '${CAS_UPPER_DIR}' '${CAS_WORK_DIR}' '${DEVBOX_WORKDIR}'`,
        );
        if (prepared.exitCode !== 0) {
          throw new Error(
            `overlay-cas could not create its runtime directories under ${DEVBOX_RUNTIME_DIR}: `
            + `${prepared.stderr.trim() || prepared.stdout.trim() || `exit ${prepared.exitCode}`}`,
          );
        }
        await this.#abortPendingMultipartUploads(store);
        await this.mountBucket(store.binding, CAS_STORE_MOUNT, {
          prefix: `/${prefix}`, readOnly: false,
        });
        // The overlay's lower has to exist before fuse-overlayfs is handed it,
        // and on a fresh prefix nothing has folded yet.
        const lower = await this.#rawExec(`mkdir -p '${CAS_TREE_MOUNT}'`);
        if (lower.exitCode !== 0) {
          throw new Error(
            `overlay-cas tree/ could not be created at ${CAS_TREE_MOUNT}: `
            + `${lower.stderr.trim() || lower.stdout.trim() || `exit ${lower.exitCode}`}`,
          );
        }
      },
      unmountStore: async () => {
        try {
          await this.unmountBucket(CAS_STORE_MOUNT);
        } catch (error) {
          // Not mounted is the ordinary case on a fresh container, and the SDK
          // says so by throwing. Released THROUGH the SDK: see the port's doc.
          console.log(`[devbox] cas store mount was not released: ${describe({ cause: error })}`);
        }
      },
      storeMounted: async () => findMount(
        (await this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR)).stdout, CAS_STORE_MOUNT,
      )?.fstype.includes('s3fs') === true,
      mountOverlay: async () => {
        const mounted = await this.#rawExec(
          `/usr/bin/fuse-overlayfs -o lowerdir='${CAS_TREE_MOUNT}'`
          + `,upperdir='${CAS_UPPER_DIR}',workdir='${CAS_WORK_DIR}' '${DEVBOX_WORKDIR}'`,
        );
        if (mounted.exitCode !== 0) {
          throw new Error(
            `fuse-overlayfs attach of ${DEVBOX_WORKDIR} failed: `
            + `${mounted.stderr.trim() || mounted.stdout.trim() || `exit ${mounted.exitCode}`}`,
          );
        }
      },
      // THROUGH THE ONE SEAM, which is the same defect measured on the r2fs arm
      // with only the mount differing: this used to ask a shell standing in
      // `/workspace` (the `#rawExec` default) to unmount `/workspace`, refused
      // EBUSY by the very session issuing it, and `|| true` then hid the
      // refusal.
      //
      // A SWALLOWED EBUSY HERE IS NOT COSMETIC. `detach` goes on to release the
      // store mount while fuse-overlayfs still holds its read-only lower, and
      // `attach` early-returns `already-attached` whenever the overlay is
      // mounted, deliberately WITHOUT replaying the journal, on the premise that
      // a mounted overlay means the replay finished. A silently-failed unmount
      // is exactly the state that falsifies that premise: the next attach
      // reports success over a workspace missing its journalled changes. So the
      // release now really happens (parked, and lazily if it must), and a
      // refusal that still lands is spoken aloud rather than dropped.
      unmountOverlay: async () =>
        await this.#releaseFuseMount(DEVBOX_WORKDIR, 'the workspace overlay'),
      // ONE COMMAND, so a container replaced between two RPCs cannot leave the
      // move half done. `cp -a src/. dst` MERGES into the directories the replay
      // already wrote and preserves symlinks rather than following them, which
      // is what keeps a hostile tree inside the upper; the copy runs before the
      // delete so a failure loses nothing. `find … -exec … +` runs nothing when
      // the work directory is empty, which is the ordinary case.
      salvageWorkdirResidue: async () => {
        const salvaged = await this.#rawExec(
          `n=$(find '${DEVBOX_WORKDIR}' -mindepth 1 -maxdepth 1 | wc -l) && `
          + `if [ "$n" -gt 0 ]; then mkdir -p '${CAS_UPPER_DIR}' && `
          + `cp -a '${DEVBOX_WORKDIR}/.' '${CAS_UPPER_DIR}/' && `
          + `find '${DEVBOX_WORKDIR}' -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi && `
          + 'printf %s "$n"',
          DEVBOX_RUNTIME_DIR,
        );
        if (salvaged.exitCode !== 0) {
          throw new Error(
            `${DEVBOX_WORKDIR} held entries written with no overlay mounted and they could not `
            + `be moved into ${CAS_UPPER_DIR}: `
            + `${salvaged.stderr.trim() || salvaged.stdout.trim() || `exit ${salvaged.exitCode}`}`,
          );
        }
        const moved = Number.parseInt(salvaged.stdout.trim(), 10);
        return Number.isSafeInteger(moved) && moved >= 0 ? moved : 0;
      },
      overlayMounted: async () =>
        isOverlayMounted((await this.#rawExec('cat /proc/mounts')).stdout, DEVBOX_WORKDIR),
      invokeRunner: async (operation) => await this.#rawExec(
        `bun '${CAS_RUNNER_PATH}' --operation '${operation}' --upper '${CAS_UPPER_DIR}' `
        + `--store '${casStoreUrl(store.binding)}'`,
      ),
      inventory: async () => await prefixInventory(store.bucket, `${prefix}/`),
      clearPrefix: async () => {
        await this.#abortPendingMultipartUploads(store);
        return await deletePrefix(store.bucket, `${prefix}/`);
      },
      // PARSED, never cast. A durable row was written by some release of this
      // package and the reader has to establish what it is: a row this code did
      // not write reads as ABSENT, which makes a fresh box, rather than as a
      // state the box would attach from having never written it.
      readState: async () =>
        normalizeOverlayCasState(await this.ctx.storage.get<StoredValue>(OVERLAY_CAS_STATE_KEY)),

      writeState: async (next) => {
        await this.ctx.storage.put(OVERLAY_CAS_STATE_KEY, next);
      },
      clearState: async () => {
        await this.ctx.storage.delete(OVERLAY_CAS_STATE_KEY);
      },
      checkpointIntervalMs: () => this.policy.checkpointIntervalMs,
      now: () => Date.now(),
      log: (message) => {
        console.log(`[devbox] ${message}`);
      },
    };
  }

  #candidatePorts(store: DevboxStore, strategy: CandidateContainerFormat): CandidateContainerPorts {
    const runnerPath = this.candidateRunnerPath;
    if (runnerPath === undefined) {
      throw new Error(`candidate ${strategy} requires a bundled container runner`);
    }
    const paths = candidateStorePaths(this.#boxPrefix(), strategy);
    const controlKey = candidateControlKey(strategy);
    const envelopeKey = (rootEnvelopeId: string): string => `${paths.envelopePrefix}/${rootEnvelopeId}.json`;
    const control: CandidateControlStore = {
      read: async () => readCandidateControl(await this.ctx.storage.get<StoredValue>(controlKey)),
      update: async (apply) => await this.ctx.storage.transaction(async (transaction) => {
        const update = apply(readCandidateControl(await transaction.get<StoredValue>(controlKey)));
        if (update.next !== null) {
          await transaction.put(controlKey, v.parse(CandidateControlStateV1Schema, update.next));
        }
        return update.result;
      }),
      clear: async () => {
        await this.ctx.storage.delete(controlKey);
      },
    };
    const envelopes: CandidateEnvelopeStore = {
      write: async (envelope, rootEnvelopeId) => {
        const key = envelopeKey(rootEnvelopeId);
        const existing = await store.bucket.get(key);
        if (existing !== null) {
          parseEnvelopeBytes(new Uint8Array(await existing.arrayBuffer()), rootEnvelopeId);
          return;
        }
        await store.bucket.put(key, envelopeBytes(envelope));
        const committed = await store.bucket.get(key);
        if (committed === null) throw new Error(`candidate envelope write did not verify: ${rootEnvelopeId}`);
        parseEnvelopeBytes(new Uint8Array(await committed.arrayBuffer()), rootEnvelopeId);
      },
      read: async (rootEnvelopeId) => {
        const object = await store.bucket.get(envelopeKey(rootEnvelopeId));
        if (object === null) throw new Error(`candidate envelope is absent: ${rootEnvelopeId}`);
        return parseEnvelopeBytes(new Uint8Array(await object.arrayBuffer()), rootEnvelopeId);
      },
    };
    const verifyObject = async (ref: ImmutableObjectRef) => {
      const key = `${paths.payloadPrefix}/${ref.key}`;
      const object = await store.bucket.head(key);
      if (object === null) throw new Error(`candidate object is absent: ${ref.key}`);
      const sha256 = object.checksums.sha256;
      const checksum = sha256 === undefined
        ? undefined
        : [...new Uint8Array(sha256)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (
        object.key !== key
        || String(object.size) !== ref.byteLength
        || (checksum !== undefined && checksum !== ref.sha256)
        || object.version.length === 0
      ) {
        throw new Error(`candidate object metadata does not match immutable ref: ${ref.key}`);
      }
    };
    return {
      format: strategy,
      runnerPath,
      mountStore: async () => {
        // The runner slots' directory too: a fresh container's first runner
        // start reads its control file from there before anything else runs.
        await this.#rawExec(`mkdir -p '${CANDIDATE_STORE_MOUNT}' '${CANDIDATE_RUNNER_RESULT_DIR}'`, DEVBOX_RUNTIME_DIR);
        const before = await this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR);
        if (findMount(before.stdout, CANDIDATE_STORE_MOUNT) !== undefined) {
          await this.unmountBucket(CANDIDATE_STORE_MOUNT);
        }
        await this.mountBucket(store.binding, CANDIDATE_STORE_MOUNT, {
          prefix: paths.mountPrefix,
          readOnly: false,
        });
        const after = await this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR);
        const mount = findMount(after.stdout, CANDIDATE_STORE_MOUNT);
        if (mount === undefined || !mount.fstype.includes('s3fs')) {
          throw new Error(
            `candidate store is not an R2 mount at ${CANDIDATE_STORE_MOUNT} for prefix ${paths.payloadPrefix}`,
          );
        }
      },
      unmountStore: async () => {
        try {
          await this.unmountBucket(CANDIDATE_STORE_MOUNT);
        } catch (error) {
          console.log(`[devbox] candidate store mount was not released: ${describe({ cause: error })}`);
        }
      },
      clearStore: async () => {
        await Promise.all([
          deletePrefix(store.bucket, `${paths.payloadPrefix}/`),
          deletePrefix(store.bucket, `${paths.envelopePrefix}/`),
        ]);
      },
      attachmentHealth: async () => {
        const [mounts, storeAccess, socket, processes] = await Promise.all([
          this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR),
          this.#rawExec(`stat -c %d:%i '${CANDIDATE_STORE_MOUNT}' >/dev/null`, DEVBOX_RUNTIME_DIR),
          this.#rawExec(`test -S '${CANDIDATE_JOURNAL_SOCKET}' && echo yes || echo no`, DEVBOX_RUNTIME_DIR),
          this.listProcesses(),
        ]);
        const storeMount = findMount(mounts.stdout, CANDIDATE_STORE_MOUNT);
        const journalMount = findMount(mounts.stdout, CANDIDATE_JOURNAL_MOUNT);
        return {
          storeMounted: storeMount?.fstype.includes('s3fs') === true,
          storeAccessible: storeAccess.exitCode === 0,
          journalProcess: processes.some(
            (process) => process.command.includes(CANDIDATE_JOURNAL_BINARY) && isProcessLive(process.status),
          ),
          journalSocket: socket.exitCode === 0,
          journalMounted: journalMount?.fstype.includes('fuse') === true,
        };
      },
      begin: async (kind) => {
        const bootId = await this.ctx.storage.get<string>(BOOT_ID_KEY);
        if (bootId === undefined) throw new Error('candidate checkpoint requires a stamped container boot id');
        return await beginCandidateOperation({
          kind: kind === 'tick' ? 'tick' : 'barrier',
          bootId,
          store: control,
          envelopes,
          verifyObject,
        });
      },
      finalize: async (draft) => await finalizeCandidateOperation({
        draft,
        boxId: this.ctx.id.toString(),
        store: control,
        envelopes,
        verifyObject,
      }),
      settleNoChange: async (run) => {
        const active = run.operation;
        if (active?.phase !== 'transferring') {
          throw new Error('candidate no-change reply has no transferring operation to settle');
        }
        return await settleCandidateNoChange({ active, store: control });
      },
      restoreState: async () => await candidateRunControl(control, envelopes, verifyObject),
      bootId: async () => await this.ctx.storage.get<string>(BOOT_ID_KEY),
      redrive: async (run) => {
        const active = run.operation;
        if (active?.phase !== 'transferring') {
          throw new Error('candidate runner failure has no transferring operation to redrive');
        }
        return await redriveCandidateOperation({ active, store: control, envelopes });
      },
      clearControl: control.clear,
      clearRunnerResults: async () => {
        await this.#rawExec(`rm -rf '${CANDIDATE_RUNNER_RESULT_DIR}'`, DEVBOX_RUNTIME_DIR);
      },
      clearRunnerAttempt: async (resultPath) => {
        await this.#rawExec(`rm -f '${resultPath}'`, DEVBOX_RUNTIME_DIR);
      },
      startJournal: async () => {
        await this.#rawExec(
          `mkdir -p '${CANDIDATE_JOURNAL_ROOT}' '${CANDIDATE_JOURNAL_STATE}'`,
          DEVBOX_RUNTIME_DIR,
        );
        const command = journalDaemonArgv({
          binary: CANDIDATE_JOURNAL_BINARY,
          root: CANDIDATE_JOURNAL_ROOT,
          mount: CANDIDATE_JOURNAL_MOUNT,
          state: CANDIDATE_JOURNAL_STATE,
          socket: CANDIDATE_JOURNAL_SOCKET,
        }).map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
        const started = await this.startProcess(command, {
          cwd: DEVBOX_RUNTIME_DIR,
          processId: 'candidate-journal',
          autoCleanup: false,
        });
        // ONE HOP. The wait lives in the container — see `journalReadyCommand`
        // for the forty round trips it replaces and the deployed attach that
        // never returned through them.
        const probe = await this.#rawExec(
          journalReadyCommand({
            mount: CANDIDATE_JOURNAL_MOUNT,
            socket: CANDIDATE_JOURNAL_SOCKET,
          }),
          DEVBOX_RUNTIME_DIR,
        );
        const reading = readJournalReady(probe.stdout);
        if (reading?.socket === true && reading.mount === true) return;
        const logs = await this.getProcessLogs(started.id);
        await this.killProcess(started.id);
        throw new Error(
          `candidate journal daemon did not serve ${CANDIDATE_JOURNAL_MOUNT} within `
          + `${String(JOURNAL_READY_WAIT_SECONDS)}s (`
          + `${reading === undefined
            ? `the readiness probe answered ${JSON.stringify(probe.stdout.trim() || probe.stderr.trim())}`
            : `control socket ${reading.socket ? 'present' : 'absent'}, `
              + `mount ${reading.mount ? 'present' : 'absent'}`}): `
          + `${logs.stderr.trim() || logs.stdout.trim() || 'no daemon output'}`,
        );
      },
      // THROUGH THE ONE SEAM, because `CANDIDATE_JOURNAL_MOUNT` IS
      // `DEVBOX_WORKDIR`: this releases a FUSE mount at the very directory the
      // shared session is created in, so it has the same disease the r2fs arm
      // was measured with. The explicit `DEVBOX_RUNTIME_DIR` here was already
      // right, but `2>/dev/null || true` meant a refusal was unobservable — and
      // an unreleased journal mount is how a wake starts a SECOND daemon over a
      // mount the first still owns, which is the one hazard this daemon's own
      // comments say must never happen. Now it is parked, taken lazily if it
      // must be, and said aloud if it still refuses.
      stopJournal: async () => {
        for (const row of await this.listProcesses()) {
          if (row.command.includes(CANDIDATE_JOURNAL_BINARY)) await this.killProcess(row.id);
        }
        // Only when there is something to release: this runs on paths where no
        // daemon ever mounted, and a refusal reported for an absent mount would
        // be noise that trains a reader to ignore the real one.
        const mounts = await this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR);
        if (findMount(mounts.stdout, CANDIDATE_JOURNAL_MOUNT) === undefined) return;
        await this.#releaseFuseMount(CANDIDATE_JOURNAL_MOUNT, 'the candidate journal mount');
      },
      getRunnerProcess: async (processId) => await super.getProcess(processId),
      waitForRunnerExit: async (processId) => {
        for (;;) {
          const process = await super.getProcess(processId);
          if (process === null) throw new Error(`candidate runner ${processId} disappeared before it exited`);
          if (!isProcessLive(process.status)) {
            if (process.exitCode === undefined) {
              throw new Error(`candidate runner ${processId} exited without an exit code`);
            }
            return { exitCode: process.exitCode };
          }
          // A RUNNER CANNOT OUTLIVE ITS CONTAINER, and this loop is the one
          // place that used to believe it could. The process table is answered
          // from THIS side, so an instance the platform reclaimed leaves its
          // rows saying `running` with nothing left to ever move them — and a
          // poll whose only exits are "gone" and "exited" then waits for an
          // event that has no reporter.
          //
          // Asked AFTER the status, so a process that really exited is still
          // reported by its exit code even if the container went afterwards:
          // the contradiction being caught here is a LIVE record with no
          // container behind it, which is never a fact about the runner.
          //
          // MEASURED. This is the whole distance between a slow attach and an
          // unattachable box: `#storage` is built once per isolate and
          // `attach()` parks its in-flight promise in `attaching`, released
          // only when that promise settles — so one wait that never ends is
          // handed to every later attach in the isolate. In
          // `e2ecal0901002202`, run against a 900,000 ms wall, `bounded-layers`
          // cold-attach and `merkle-pack` wake-attach each recorded 900,001 ms
          // — the wall, not a duration — and the platform's own sentence for
          // the arms beside them was "The sandbox container stopped while the
          // operation was pending".
          if (this.ctx.container?.running !== true) {
            throw new Error(`candidate runner ${processId} lost its container before it exited`);
          }
          await scheduler.wait(RUNNER_EXIT_POLL_INTERVAL_MS);
        }
      },
      activeCheckpoint: async () => {
        const operation = (await control.read()).operation;
        if (operation?.phase !== 'transferring') return null;
        const paths = candidateCheckpointRunnerPaths();
        const process = await super.getProcess(paths.processId);
        return process !== null && isProcessLive(process.status) ? process : null;
      },
      writeRunnerControl: async (path, content) => {
        await super.writeFile(path, content);
      },
      startRunnerProcess: async (command, processId) => await super.startProcess(command, {
        cwd: DEVBOX_RUNTIME_DIR,
        processId,
        autoCleanup: false,
      }),
      readRunnerResult: async (path) => (await super.readFile(path)).content,
      boxId: () => this.ctx.id.toString(),
      recordFailure: async (reason) => {
        await this.#record('checkpoint', reason);
      },
    };
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
      containerGeneration: async () => await this.#readBootId(),
      storeRoot: () => chainStoreRoot(this.#boxPrefix()),
      mountStore: async (at) => {
        // The BOX's prefix, writable, with no credential: `chainStoreRoot` and
        // `SnapshotChainPorts.mountStore` state why.
        await this.mountBucket(store.binding, at, {
          prefix: `/${chainStoreRoot(this.#boxPrefix())}`,
          readOnly: false,
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
   *  NEVER CALLED INSIDE A PLATFORM CRITICAL SECTION, and that is now a property
   *  of the class rather than a budget this seam polls. This used to hold the
   *  init gate's bound: a deadline was checked here before issuing, so gate
   *  occupancy would be "the budget plus one command". Deployed probe
   *  `gp0902011918` refuted the premise — the first command issued inside
   *  `blockConcurrencyWhile` never returns at all, because reaching the
   *  container asks the SDK for a nested `blockConcurrencyWhile` that cannot be
   *  granted while the outer one is held (see `onStart`). So there is nothing to
   *  poll for: no caller of this method runs inside the platform's block, and
   *  `scripts/do-init-gate.ts` plus the restore-out-of-gate suite are what keep
   *  it that way. */
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
    // MEASURED. The deployed r2fs arm died of exactly this on both launches of
    // 2026-09-03: `create failed: cold attach refused: /workspace could not be
    // emptied for a mount: Failed to change directory to '/var/tmp/devbox'`.
    // Every arm gets its own worker and container, so no sibling strategy's
    // mountStore had ever created the directory there. The candidate arms
    // carry the same latent defect — their `mountStore` reads `/proc/mounts`
    // from the runtime directory too — which is why the repair belongs to this
    // seam rather than to one strategy's ports.
    //
    // One command per container per runtime-directory cwd, and idempotent:
    // `mkdir -p` from the work directory, which always exists.
    if (cwd === DEVBOX_RUNTIME_DIR && !this.#runtimeDirReady) {
      const made = await super.exec(`mkdir -p '${DEVBOX_RUNTIME_DIR}'`, { cwd: DEVBOX_WORKDIR });
      if (made.exitCode !== 0) {
        return { stdout: made.stdout, stderr: made.stderr, exitCode: made.exitCode };
      }
      this.#runtimeDirReady = true;
    }
    const result = await super.exec(command, { cwd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  /** Whether THIS instance has established the runtime directory on the
   *  container it is talking to. Reset with the generation, because a
   *  replacement is a fresh container whose disk holds none of ours. */
  #runtimeDirReady = false;

  // ── the one seam every container mount is released through ────────────────
  //
  // MEASURED DEFECT THIS REPAIRS, AND WHY IT IS A SEAM RATHER THAN A PATCH.
  // `#rawExec` above defaults its cwd to `DEVBOX_WORKDIR`, and the SDK creates
  // its default session with `cwd: "/workspace"` too — so unless a caller says
  // otherwise, the shared session shell is standing ON the work directory. A
  // shell standing on a mount holds a reference to that mount, so a
  // `fusermount -u` issued from it is refused EBUSY by the session issuing it,
  // no matter how many holders were killed first.
  //
  // Proven by controlled experiment on a live deployed container
  // (probe `hp0901171035`, `scripts/devbox-holder-probe.ts`): the SAME
  // `fusermount -u /workspace`, adjacent in time, against the same live mount,
  // with zero fd holders in either arm —
  //
  //   session cwd INSIDE the mount   -> rc=1, "Device or resource busy"
  //   session cwd parked OUTSIDE it  -> rc=0, mount released
  //
  // EVERY strategy that mounts at the work directory has this disease, which is
  // why the repair lives here and not in one strategy: r2fs mounts s3fs there,
  // overlay-cas mounts fuse-overlayfs there, and the candidate arms mount the
  // journal daemon there (`CANDIDATE_JOURNAL_MOUNT` IS `DEVBOX_WORKDIR`). A
  // per-strategy fix leaves the next mount point to rediscover it deployed.

  /**
   * Move the shared session shell OUT of `mountPath`, and answer where it
   * stands now.
   *
   * The runtime directory normally, `/` when the mount CONTAINS the runtime
   * directory — parking inside the very mount being released would be the bug
   * this method exists to prevent, so the choice is computed rather than
   * assumed. `pwd` travels back so a caller reports where it parked instead of
   * asserting that it worked.
   */
  async #parkSessionOutside(mountPath: string): Promise<string> {
    const outside = DEVBOX_RUNTIME_DIR === mountPath
      || DEVBOX_RUNTIME_DIR.startsWith(`${mountPath}/`)
      ? '/'
      : DEVBOX_RUNTIME_DIR;
    const parked = await this.#rawExec('cd . && pwd', outside);
    return parked.stdout.trim() || outside;
  }

  /** `fusermount -z` IS `MNT_DETACH`. Tried under both binary names the image
   *  may carry, then answered from `/proc/mounts` rather than from an exit code:
   *  the question is whether the mount is gone, and only the mount table can
   *  answer that. */
  async #lazyUnmount(mountPath: string): Promise<boolean> {
    await this.#rawExec(
      `fusermount -uz '${mountPath}' 2>/dev/null `
      + `|| fusermount3 -uz '${mountPath}' 2>/dev/null || true`,
      await this.#parkSessionOutside(mountPath),
    );
    const mounts = await this.#rawExec('cat /proc/mounts', DEVBOX_RUNTIME_DIR);
    return findMount(mounts.stdout, mountPath) === undefined;
  }

  /**
   * Release one container mount: park the session outside it, ask, and fall back
   * to a lazy detach if it still refuses.
   *
   * THE LAZY FALLBACK IS THE LAST RESORT, and it is what makes a box stoppable
   * at all. A reference this class may not revoke — an ancestor of the holder
   * scan's own shell, or one of the container server's own children sitting at
   * `cwd=/workspace` — leaves an ordinary unmount permanently refused, and a box
   * that can never release its mount can never stop and can never attach again.
   * `MNT_DETACH` removes the mount from the namespace immediately and lets the
   * kernel free it when the last reference drops.
   *
   * IT IS NOT A WAY TO SKIP A FLUSH, and this is a PRECONDITION ON THE CALLER,
   * not a detail of one strategy. `MNT_DETACH` returns as soon as the mount
   * leaves the namespace; it does not wait for anything and cannot flush. Bytes
   * an open writer left in the page cache reach the store only through the
   * caller's own `sync`, so a caller releasing a mount it may have WRITTEN to
   * must flush and check that flush BEFORE calling this. r2fs's detach does
   * exactly that, and says so.
   *
   * WHICH MOUNTS THAT BINDS TODAY. Of the callers that come through here, only
   * r2fs's work directory is writable, and it flushes. The overlay and the
   * candidate journal are released on teardown paths whose bytes are already
   * published elsewhere.
   *
   * THE CHAIN'S PUBLICATION MOUNT IS WRITABLE AND DOES NOT COME THROUGH HERE,
   * and it owes the same precondition where it does run. A chain archive used
   * to cross this isolate as base64 frames and go back out through the R2
   * binding; the instrument measured that relay at 3.34 MiB/s against 23.22
   * container-direct at 64 MiB, and 3.64 against 39.00 at 256 MiB (2026-09-01).
   * The container now writes the archive onto its own writable, prefix-scoped
   * mount at a SEPARATE path, and `snapshot-chain.ts` pays the precondition in
   * the command that writes it: `conv=fsync` inside the copy whose exit code is
   * checked, the final key written directly — a write-temp-then-rename on s3fs
   * is a server-side COPY that scales with the object — and the release through
   * the SDK afterwards. So no lazy detach can beat that flush, and losing the
   * tail of an archive the record already names is unrepresentable rather than
   * remembered.
   */
  async #releaseMount(
    mountPath: string,
    unmount: () => Promise<void>,
  ): Promise<{ readonly lazily: boolean; readonly parkedAt: string }> {
    const parkedAt = await this.#parkSessionOutside(mountPath);
    try {
      await unmount();
      return { lazily: false, parkedAt };
    } catch (cause) {
      if (!(await this.#lazyUnmount(mountPath))) throw cause;
      console.error(
        `[devbox] ${mountPath} refused an ordinary unmount with the session parked at `
        + `${parkedAt}, so it was detached lazily (MNT_DETACH): ${describe({ cause })}`,
      );
      return { lazily: true, parkedAt };
    }
  }

  /**
   * Release a `fusermount3` mount this class made, and report a refusal that
   * still lands WITHOUT throwing.
   *
   * The two callers — the workspace overlay and the candidate journal daemon —
   * both sit at `DEVBOX_WORKDIR` and both must keep their existing
   * non-throwing contract: `unmountOverlay` runs inside a detach that goes on to
   * release the store mount, and `stopJournal` runs on teardown paths that must
   * not be blocked by one mount. What they may NOT keep is silence. `|| true`
   * used to make a refusal here unobservable, and both silences are load
   * bearing: an unreleased overlay makes the next `attach` report
   * `already-attached` without replaying the journal, and an unreleased journal
   * mount lets a wake start a SECOND daemon over a mount the first still owns.
   *
   * ONE BODY, because the duplication gate is right that two copies of it are
   * two things to keep in agreement; `what` is the only thing that differed.
   */
  async #releaseFuseMount(mountPath: string, what: string): Promise<void> {
    try {
      await this.#releaseMount(mountPath, async () => {
        const released = await this.#rawExec(
          `fusermount3 -u '${mountPath}'`,
          await this.#parkSessionOutside(mountPath),
        );
        if (released.exitCode !== 0) {
          throw new Error(
            released.stderr.trim() || released.stdout.trim() || `exit ${released.exitCode}`,
          );
        }
      });
    } catch (error) {
      console.error(
        `[devbox] ${what} at ${mountPath} was NOT released: ${describe({ cause: error })}`,
      );
    }
  }

  async #pathExists(path: string): Promise<boolean> {
    return (await this.#rawExec(`test -e '${path}' && echo yes || echo no`)).stdout.trim() === 'yes';
  }

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
