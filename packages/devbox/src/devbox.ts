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
 *   The start, fast. `onStart` runs inside `blockConcurrencyWhile`, where a
 *   container cold start and anything else it awaits share ONE platform cancel
 *   window, and the runtime resets the object when that window closes. So this
 *   hook does nothing slow: it resets the per-container flags and arms the
 *   schedule rows.
 *
 *   The restoration, scheduled and bounded. The attach, the supervised
 *   processes and the port manifest all run from a `Container.schedule` row, so
 *   they survive eviction, block nobody, and carry a budget that can actually
 *   fire.
 *
 *   The readiness gate. Every operation goes through `ensureReady()`, so a
 *   caller that arrives before the scheduled restoration finished waits for it
 *   instead of seeing a half-restored box.
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

import { Sandbox, streamFile } from '@cloudflare/sandbox';
import type {
  BackupOptions, CheckChangesOptions, ExecOptions, ExecResult, ListFilesOptions,
} from '@cloudflare/sandbox';
import * as v from 'valibot';

import {
  DEFAULT_DEVBOX_POLICY,
  generatePortToken,
  healthProbeCommand,
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
  findMount, withContainerStartDeadline, runRestoreStep, openStartBudget,
  type StartBudget,
} from './lifecycle';
import { r2fsStorage, type R2fsPorts } from './r2fs';
import { deletePrefix, prefixInventory, putStream } from './object-store';
import {
  CAS_RUNNER_PATH,
  CAS_STORE_MOUNT,
  CAS_TREE_MOUNT,
  CAS_UPPER_DIR,
  CAS_WORK_DIR,
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
import { journalDaemonArgv } from './capture/journal/command';
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
  CHAIN_STORE_MOUNT,
  assertChainId,
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
/** The journal daemon must present its mount and control socket before a
 *  workload can write through it; a wake is not complete until it does. */
const JOURNAL_READY_ATTEMPTS = 40;
const JOURNAL_READY_INTERVAL_MS = 50;
/** Runner status is polled instead of opening Sandbox's long-lived log SSE.
 *  Separate from cli-backend's LOCK_POLL_MS: same round number, unrelated
 *  decisions — this paces a container process poll, that one a config lock. */
const RUNNER_EXIT_POLL_INTERVAL_MS = 50;

/** The durable control record for one candidate arm; an absent row is no history. */
function readCandidateControl(stored: StoredValue | undefined): CandidateControlStateV1 {
  return stored === undefined
    ? { version: 1, head: null, operation: null }
    : v.parse(CandidateControlStateV1Schema, stored);
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

/** The do-init gate's marker for a container-start hook whose returned work
 * touches nothing but this object's own storage. Referenced (as `void`) by
 * `onStart` so the gate can key its plainly-bounded rule on the method body;
 * a value only because an undeclared identifier would throw at runtime. */
const BOUNDED_STORAGE_ONLY = true;

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
  /** The restoration attempt this isolate has observed for the current
   * container generation. `unattached` is terminal until an explicit repair;
   * a driver polls this instead of inferring lifecycle state from a stale
   * attach record. */
  readonly restoration: 'unstarted' | 'attached' | 'unattached';
  /** Attached AND fully restored: every supervised process back, every exposed
   *  port's listener answering, every port re-exposed. Never true on a box that
   *  is only half of that — a box that advertised readiness over a failed
   *  service handed callers a URL that answers 502. */
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
 * What THIS container generation's restoration established, as ONE value.
 *
 * It replaces a pair of flags that could disagree. Readiness and the attach
 * failure were separate fields, and a superseded attempt could set the failure
 * string while readiness stayed true from the attempt that had already
 * succeeded — or publish readiness for a generation that no longer existed. One
 * value cannot hold both halves of a contradiction.
 *
 * The split between `attached` and its `incomplete` reason is the other half:
 * operations are permitted the moment the WORK DIRECTORY is there, because a box
 * that refused `exec` could not be repaired by the agent whose service failed,
 * while `ready` stays false until the whole restoration landed.
 */
type Restoration =
  /** Nothing has attempted a restoration for this container yet. */
  | { readonly phase: 'unstarted' }
  /** The work directory is attached. `incomplete` names what did not come back,
   *  or is undefined when everything did. */
  | { readonly phase: 'attached'; readonly incomplete: string | undefined }
  /** There is no attached work directory, so operations refuse. */
  | { readonly phase: 'unattached'; readonly reason: string };

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

  /** Arm periodic callbacks. The startup callback owns admission and attachment.
   *
   *  Run PLAINLY, with no deadline wrapper: these are three writes to this
   *  object's own storage — the one I/O a Durable Object is built to do, with
   *  no container admission and nothing external to be stranded by — and the
   *  wrapper's own timer cannot fire inside `blockConcurrencyWhile`, which is
   *  exactly where this hook runs. A budget that cannot fire is not a bound;
   *  it is a paper bound, and the platform's cancel is the real backstop for
   *  the storage either way. The genuinely external container admission is
   *  bounded where it runs, outside the gate, by the scheduled startup
   *  callback below. */
  override onStart(): Promise<void> {
    // BOUNDED_STORAGE_ONLY is the marker the do-init gate reads: nothing this
    // hook returns reaches off-object, so the gate holds it to the plainly
    // bounded rule instead of demanding a deadline whose timer cannot fire
    // here anyway.
    void BOUNDED_STORAGE_ONLY;
    return this.#armContainerSchedules();
  }

  async #armContainerSchedules(): Promise<void> {
    await this.#arm(STARTUP_CALLBACK, 1);
    if (this.ambientCheckpoints) {
      await this.#arm(CHECKPOINT_CALLBACK, Math.ceil(this.policy.checkpointIntervalMs / 1000));
    }
    await this.#arm(HEARTBEAT_CALLBACK, this.policy.heartbeatSeconds);
  }

  /** Attach, then restore. Both bounded, both outside the concurrency gate.
   *
   *  The attach carries its own budget, which can now actually fire: a timer
   *  set inside `blockConcurrencyWhile` is not delivered until the block
   *  releases, so the bound that used to wrap this was unreachable. */
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
    if (this.#restoration.phase !== 'attached') return;
    if (this.ctx.container?.running !== true) return;
    if (!await this.#containerWasReplaced()) return;
    console.error(
      '[devbox] the container was replaced under an attached box; re-attaching before this '
      + 'commit rather than reporting one against a container that is gone',
    );
    this.#invalidateGeneration();
    await this.devboxStartup();
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
   * The whole restoration under ONE clock, and TWO failure policies.
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
   * {@link ContainerStartOverrun} and the taxonomy replaces the container
   * identity. Every step after it — a process that will not start, a listener
   * that never answers, a port that will not expose, a boot id that will not
   * stamp — mutates no mount, so exhaustion there is REPORTED: the box stays
   * attached, its specs stay, no failed port is exposed, `unready` names what did
   * not come back, and an agent or an explicit `attachNow()` can try again.
   * Replacing a healthy container because a dev server was slow to bind would be
   * the cure that destroys the patient.
   *
   * Nothing re-arms on that path either: an app the box cannot wait for is not a
   * reason to wake the box again on a timer.
   */
  async #attachAndRestore(generation: number, claim: RecoveryClaim): Promise<void> {
    const budget = openStartBudget(this.policy.attachBudgetMs);
    const outcome = await withContainerStartDeadline(
      'Devbox.attach',
      budget,
      () => this.#requireStorage().attach(),
      (failure) => {
        console.error(
          '[devbox] the attach overran its budget and was abandoned; it later settled '
          + `with: ${describe({ cause: failure.cause })}`,
        );
      },
    );
    await this.#restorePhases(generation, claim, budget, outcome);
  }

  /** The phases after the attach, in order, each fenced by the attempt's
   *  generation and each drawing an allowance from the one budget. */
  async #restorePhases(
    generation: number,
    claim: RecoveryClaim,
    budget: StartBudget,
    outcome: AttachOutcome,
  ): Promise<void> {
    // THE ATTACH IS THE LONG AWAIT, and everything past this line is a write.
    // A generation can turn over entirely underneath it: the container is
    // replaced, the heartbeat spots it and drives a fresh attempt, and this one
    // arrives with an outcome describing a container that no longer exists.
    if (!this.#owns(generation)) return;
    await this.ctx.storage.put(LAST_ATTACH_KEY, outcome);
    console.log(`[devbox] attach ${outcome.kind}: ${outcome.detail}`);
    const restored = await this.#restartWorkloads(generation, budget);
    if (!this.#owns(generation)) return;
    // Stamped after the whole walk, so no id exists on an instance whose
    // restoration is still half-done — a stamp taken earlier would make one look
    // healthy. It IS taken when a service failed to come back: the id answers
    // "which container instance is this", which the heartbeat's replacement
    // detection needs whether or not every service returned, and the
    // incompleteness reason is what answers "is this box ready".
    //
    // A STEP LIKE ANY OTHER, so it draws its own allowance and reports rather
    // than throws. A boot id the container will not write leaves the box
    // attached and unready, not replaced.
    const stamped = await runRestoreStep(
      budget.nextAllowanceMs(),
      async () => await this.#stampBootId(generation),
      (failure) => {
        console.error(
          '[devbox] the boot-id stamp outran its allowance; it later settled with: '
          + describe({ cause: failure.cause }),
        );
      },
    );
    if (!this.#owns(generation)) return;
    const incomplete = stamped.kind === 'done'
      ? restored.join('; ')
      : [...restored, stamped.kind === 'late' ? 'the boot id stamp is still pending' : 'the boot id stamp failed'].join('; ');
    this.#restoration = {
      phase: 'attached',
      incomplete: incomplete.length === 0 ? undefined : incomplete,
    };
    // A SUCCESSFUL ATTEMPT IS THE ONLY THING THAT CLEARS THE LADDER, and only
    // while the row still names it. Cleared any earlier, a failure in a later
    // step of the same attempt — the boot-id stamp is the last of them — would
    // delete the stage it had just earned, and the ladder could never reach the
    // step that replaces a container failing in exactly that way. A restoration
    // that landed the work directory but not every service still clears it: the
    // box IS attached, and `incomplete` is what says the rest is not ready.
    await this.#releaseRecovery(claim, generation);
  }

  /**
   * THE WHOLE RESTORATION: filesystem attach, then supervised processes, then
   * port forwarding.
   *
   * Runs from a schedule row, so it survives eviction and holds no gate.
   *
   * The attach used to live in `onStart`, and that was wrong on the platform
   * rather than merely slow. `onStart` is awaited inside
   * `blockConcurrencyWhile`; a container cold start and the attach then share
   * ONE platform cancel window, and when it expires the runtime resets the
   * object. Measured on a deployed Worker: the first operation after a stop
   * answered 500 with "A call to blockConcurrencyWhile() in a Durable Object
   * waited for too long. The call was canceled and the Durable Object was
   * reset." A bound inside that window cannot help either, because a timer set
   * inside the block is not delivered until the block releases.
   *
   * Nothing observes a half-attached box, because every operation awaits
   * `ensureReady()` and this is what `ensureReady()` waits for. The difference
   * is that a failure now refuses operations and records an incident instead of
   * resetting the object.
   */
  async devboxStartup(): Promise<void> {
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
        retries: 1,
        waitInterval: 100,
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
    const generation = this.#generation;
    if (this.#restoration.phase === 'attached') return;
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
    if (pending !== undefined && pending.generation === generation) return await pending.run;
    const run = this.#startupAttempt(generation);
    this.#startup = { generation, run };
    return await run;
  }

  /**
   * ONE startup attempt, fenced by the generation that owns it.
   *
   * The failure path is the recovery ladder in `lifecycle.ts` — a taxonomy, not
   * one retry policy — and every write it makes is guarded, including the
   * release of the single-flight entry: an attempt that released a successor's
   * entry let the next caller start a second concurrent restoration against the
   * same container.
   */
  async #startupAttempt(generation: number): Promise<void> {
    const claim = await this.#claimRecovery();
    if (!this.#owns(generation)) return;
    if (!claim.admit) {
      // The ladder row did not parse, so there is no evidence to act on and
      // nothing may be destroyed on a guess. The claim has already normalised
      // the row to the terminal stage, so this refusal is readable and finite:
      // `attachNow()` re-attempts, and a success deletes the row.
      const reason = `the attach-recovery record did not parse [unreadable → refuse]`;
      this.#restoration = { phase: 'unattached', reason };
      await this.#record('attach', reason);
      throw new Error(reason);
    }
    try {
      await this.#attachAndRestore(generation, claim);
    } catch (error) {
      await this.#recover(generation, claim, { cause: error });
      throw error;
    } finally {
      // OUR OWN ENTRY ONLY. Owning the generation is what proves the entry is
      // ours: a generation holds at most one live attempt, because a second
      // caller joins the first.
      if (this.#owns(generation)) this.#startup = undefined;
    }
  }

  /**
   * Re-run only the service half of an incomplete attached restoration.
   *
   * This uses the startup flight because two explicit repairs must not race
   * process reservations, port exposures, or the boot marker.
   */
  async #repairAttached(generation: number): Promise<void> {
    const pending = this.#startup;
    if (pending !== undefined && pending.generation === generation) return await pending.run;
    return await this.#withStorageMutation(async () => {
      if (!this.#owns(generation)) return;
      const active = this.#startup;
      if (active !== undefined && active.generation === generation) return await active.run;
      const retryBootStamp = this.#restoration.phase === 'attached'
        && this.#restoration.incomplete?.includes('the boot id stamp failed') === true;
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

  async #repairAttachedAttempt(generation: number, retryBootStamp: boolean): Promise<void> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);
    if (!this.#owns(generation)) return;
    const actual = await this.#readBootId();
    if (!this.#owns(generation)) return;
    if (expected !== undefined && actual !== expected) {
      this.#invalidateGeneration();
      await this.devboxStartup();
      return;
    }
    const budget = openStartBudget(this.policy.attachBudgetMs);
    const repair = this.#requireStorage().repairAttached;
    if (repair !== undefined) {
      await withContainerStartDeadline(
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
    }
    if (!this.#owns(generation)) return;
    if (expected !== undefined && (await this.#readBootId()) !== expected) {
      this.#invalidateGeneration();
      await this.devboxStartup();
      return;
    }
    const restored = await this.#restartWorkloads(generation, budget);
    if (!this.#owns(generation)) return;
    const stamped = expected === undefined && retryBootStamp
      ? await runRestoreStep(budget.nextAllowanceMs(), async () => await this.#stampBootId(generation), () => undefined)
      : expected === undefined ? { kind: 'pending' as const } : { kind: 'done' as const };
    if (!this.#owns(generation)) return;
    const incomplete = stamped.kind === 'done'
      ? restored.join('; ')
      : [...restored, stamped.kind === 'late' ? 'the boot id stamp is still pending' : 'the boot id stamp failed'].join('; ');
    this.#restoration = {
      phase: 'attached',
      incomplete: incomplete.length === 0 ? undefined : incomplete,
    };
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
   * ONE transition for the four places that reach it: a container start, a
   * replacement the heartbeat spotted, a graceful quiesce, and the destruction
   * that follows an attach whose work could not be fenced. Bumping the
   * generation is what makes every attempt still in flight state-inert — it can
   * no longer publish readiness, file an attach failure, release a successor's
   * single-flight entry, or destroy an identity it did not start on.
   */
  #invalidateGeneration(): void {
    this.#generation += 1;
    this.#startup = undefined;
    this.#restoration = { phase: 'unstarted' };
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
   * primitive that closes it. The class header warns against putting SLOW work
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
    this.#restoration = { phase: 'unattached', reason };
    await this.#record('attach', reason);
    if (!this.#owns(generation)) return;
    if (decision.action === 'retry') {
      // A SCHEDULE, not the next operation: retrying per operation would record
      // an incident per operation for one broken box.
      await this.#arm(STARTUP_CALLBACK, this.policy.heartbeatSeconds);
      return;
    }
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
      };
      throw error;
    }
    console.error(
      '[devbox] the container identity was destroyed after a failed attach; a fresh one '
      + 'attaches on the next operation',
    );
  }

  /** Wait for the provider's own state transition. `stop` and `destroy`
   *  acknowledge the signal before `container.running` flips, and returning in
   *  that window let an immediate wake reuse the old mount, then lose it
   *  underneath the next operation. */
  async #awaitContainerStopped(): Promise<void> {
    while (this.ctx.container?.running === true) await scheduler.wait(100);
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
  async #restartWorkloads(generation: number, budget: StartBudget): Promise<readonly string[]> {
    const [processes, ports] = await Promise.all([this.#procSpecs(), this.#portSpecs()]);
    const plan = restartPlan(processes, ports);
    // EVERY STEP IS DECLARED, and the boot stamp is declared by the caller. The
    // divisor of each allowance is the work still to do, so a port's probe
    // cannot spend what its own exposure and the stamp still need — and a step
    // that finishes early leaves its share to the next one.
    budget.declare(plan.start.length + plan.serve.length * 2);
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
      const started = await runRestoreStep(
        budget.nextAllowanceMs(),
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
      if (!await this.#awaitListener(spec.port, budget.nextAllowanceMs())) {
        down.push(`port ${spec.port} never answered`);
        await this.#record('port', `nothing listens on port ${spec.port} after restart`, {
          port: spec.port,
        });
        // ITS ALLOWANCE GOES BACK. The exposure this port will not get is work
        // the budget no longer has to cover, so the ports after it are not
        // charged for this one's silence.
        budget.nextAllowanceMs();
        continue;
      }
      if (!this.#owns(generation)) return superseded;
      if (!await this.#exposeWithSpec(spec, budget.nextAllowanceMs())) {
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
   */
  async #awaitListener(port: number, shareMs: number): Promise<boolean> {
    // WHICHEVER IS SMALLER: this port's own cap, or the share of the
    // restoration's remaining budget it was given. The cap alone was a timer per
    // port, so silence cost the box one window for every port it had and nothing
    // bounded the sum — three silent ports added about ninety seconds while
    // every caller waited in the readiness gate.
    const deadline = Date.now() + Math.min(this.policy.portWaitMs, shareMs);
    for (;;) {
      const probe = await this.#rawExec(healthProbeCommand(port));
      if (!healthProbeSilent(probe.stdout)) return true;
      if (Date.now() >= deadline) return false;
      await scheduler.wait(this.policy.portProbeIntervalMs);
    }
  }

  /** True when nothing failed. A box with no preview host configured exposes
   *  nothing and that is not a failure — it declares no previews, which is the
   *  honest answer rather than a URL that cannot resolve. */
  async #exposeWithSpec(spec: PortExposureSpec, allowanceMs: number): Promise<boolean> {
    const hostname = this.previewHost;
    if (hostname === undefined || hostname.length === 0) {
      console.log(`[devbox] port ${spec.port} not re-exposed: no preview host configured`);
      return true;
    }
    const options: PortExposeOptions = { hostname, token: spec.token };
    if (spec.name !== undefined) options.name = spec.name;
    const exposed = await runRestoreStep(
      allowanceMs,
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
    if (this.#restoration.phase === 'unstarted' && this.#startup === undefined) {
      await this.#arm(STARTUP_CALLBACK, 1);
    }
  }

  /**
   * The readiness gate every operation passes through.
   *
   * Resolves immediately once this container generation's restoration settled.
   * Otherwise it waits on the in-flight restoration, or drives it now for an
   * operation that raced ahead of the scheduled tick — which is the common case
   * on a cold start, because the schedule fires a second later and a caller is
   * usually already waiting.
   */
  async ensureReady(): Promise<void> {
    // A stopped container may still have the previous instance's attached
    // state in memory. Let the startup callback turn that generation over
    // before this method can accept it as ready.
    if (this.ctx.container?.running !== true) {
      await this.devboxStartup();
    }
    // ATTACHMENT, NOT READINESS. A restoration that landed the work directory
    // and failed to bring one service back leaves the box operable on purpose:
    // refusing `exec` would deny the agent the one way it has to repair that
    // service. `ready` is what stays false, and `devboxState()` says why.
    if (this.#restoration.phase === 'attached') return;
    if (this.#restoration.phase === 'unattached') {
      // Refuse fast, with the reason and the recovery the taxonomy chose.
      // Re-attaching here would turn one broken box into an incident per call,
      // and a class the ladder refused would repeat the work it refused.
      throw new Error(
        `this devbox has no attached work directory: ${this.#restoration.reason}. `
        + 'Operations are refused until an attach succeeds.',
      );
    }
    await this.devboxStartup();
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
    if (this.#restoration.phase === 'attached' && this.#restoration.incomplete !== undefined) {
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
        await pending.run;
      }
      return await this.#requireStorage().checkpoint(kind);
    }));
  }

  /**
   * Stop the container the graceful way: final checkpoint, then SIGTERM.
   * A failed checkpoint refuses to stop because stopping would lose work.
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
    await this.#requireStorage().detach?.();
    this.#invalidateGeneration();
    await this.stop('SIGTERM');
    await this.#awaitContainerStopped();
    return outcome;
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
    return held.incomplete;
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
      ready: this.#restoration.phase === 'attached' && this.#restoration.incomplete === undefined,
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
          await this.devboxStartup();
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
      readMounts: async () => (await this.#rawExec('cat /proc/mounts')).stdout,
      exec: async (command) => await this.#rawExec(command),
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
        // and on a fresh prefix nothing has folded yet. Created THROUGH the
        // mount, so the directory the runner writes `tree/` into and the one
        // the lower serves are the same object.
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
          // says so by throwing. Released THROUGH the SDK, never a raw
          // fusermount3: the SDK keeps its own registry of the mounts it made
          // and a kernel-level release leaves it claiming the path forever.
          console.log(`[devbox] cas store mount was not released: ${describe({ cause: error })}`);
        }
      },
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
      unmountOverlay: async () => {
        await this.#rawExec(`fusermount3 -u '${DEVBOX_WORKDIR}' || true`);
      },
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
        + `--store '${CAS_STORE_MOUNT}'`,
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
    const controlKey = `${CANDIDATE_CONTROL_PREFIX}${strategy}`;
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
        await this.#rawExec(`mkdir -p '${CANDIDATE_STORE_MOUNT}'`, DEVBOX_RUNTIME_DIR);
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
        for (let attempt = 0; attempt < JOURNAL_READY_ATTEMPTS; attempt += 1) {
          const ready = await this.#rawExec(
            `test -S '${CANDIDATE_JOURNAL_SOCKET}' `
            + `&& grep -qs ' ${CANDIDATE_JOURNAL_MOUNT} fuse' /proc/mounts && echo yes || echo no`,
            DEVBOX_RUNTIME_DIR,
          );
          if (ready.stdout.trim() === 'yes') return;
          await scheduler.wait(JOURNAL_READY_INTERVAL_MS);
        }
        const logs = await this.getProcessLogs(started.id);
        await this.killProcess(started.id);
        throw new Error(
          `candidate journal daemon did not mount ${CANDIDATE_JOURNAL_MOUNT}: `
          + `${logs.stderr.trim() || logs.stdout.trim() || 'no daemon output'}`,
        );
      },
      stopJournal: async () => {
        for (const row of await this.listProcesses()) {
          if (row.command.includes(CANDIDATE_JOURNAL_BINARY)) await this.killProcess(row.id);
        }
        await this.#rawExec(`fusermount3 -u '${CANDIDATE_JOURNAL_MOUNT}' 2>/dev/null || true`, DEVBOX_RUNTIME_DIR);
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
      writeState: async (state) => {
        await this.ctx.storage.put(STORAGE_KEY, state);
      },
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
      mountStore: async (chainId) => {
        await this.mountBucket(store.binding, CHAIN_STORE_MOUNT, {
          prefix: `/backups/${assertChainId(chainId)}`,
          readOnly: true,
        });
      },
      unmountStore: async () => {
        try {
          await this.unmountBucket(CHAIN_STORE_MOUNT);
        } catch (error) {
          // Not mounted is the ordinary case on a fresh container, and the SDK
          // says so by throwing. Anything else is worth knowing about but must
          // not fail an attach that has not started yet.
          console.log(`[devbox] store mount was not released: ${describe({ cause: error })}`);
        }
      },
      readFileStream: async (path) => {
        // INTERNAL STORAGE WORK, not a caller. The public override claims the
        // resource lane and requires the SDK RPC transport for binary reads;
        // this port runs inside the checkpoint/restoration that readiness and
        // that lane may already be waiting on. Going through it either deadlocks
        // that work or answers the real container with "encoding none requires
        // rpc".
        //
        // The direct SDK stream is the real container seam. `streamFile` decodes
        // its SSE frames incrementally, and the wrapper below refuses text chunks
        // — a squashfs archive is bytes, so text would prove a protocol mismatch
        // rather than a file worth archiving. Size comes from the same container
        // through `stat`, before `putStream` chooses single vs multipart: no
        // whole archive is buffered just to learn its size.
        const sizeResult = await this.#rawExec(`stat -c %s -- ${JSON.stringify(path)}`);
        const size = Number.parseInt(sizeResult.stdout.trim(), 10);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new Error(`could not read the size of staged archive ${path}: ${sizeResult.stdout}`);
        }
        const chunks = streamFile(await super.readFileStream(path));
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await chunks.next();
            if (next.done) {
              controller.close();
              return;
            }
            if (!(next.value instanceof Uint8Array)) {
              controller.error(new Error(`staged archive ${path} streamed text instead of bytes`));
              return;
            }
            controller.enqueue(next.value);
          },
          async cancel() {
            // The generator's return value is metadata. It is never consumed on
            // cancellation; this concrete value only satisfies the generator's
            // declared completion contract while telling it to release the
            // underlying SSE reader.
            await chunks.return({
              mimeType: 'application/octet-stream',
              size,
              isBinary: true,
              encoding: 'base64',
            });
          },
        });
        return { stream, size };
      },
      putObject: async (key, stream, size) => await putStream(store.bucket, key, stream, size),
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
        // ONE metadata read, exactly what the byte count always cost, and it
        // carries TWO identities because neither covers every object. `digest`
        // is R2's own checksum and exists only where R2 was given one, which
        // `putStream` does on the single-PUT route; the Workers multipart API
        // accepts no checksum, so a large archive has none. `objectVersion` is
        // R2's own name for the upload that wrote the object and is always
        // there, which is what lets the chain refuse a same-length replacement
        // of a multipart archive that has no checksum to compare.
        //
        // The chain records both when a layer is written. When BOTH sides
        // have a digest, the digest decides: equal content is sound even when a
        // retry wrote it under R2's new version. Only when no digest can decide
        // — the multipart route — does the store version decide. A same-length
        // replacement is refused either way, the refusal recovers from the
        // retained fallback generation, and an identity absent on either side is
        // UNKNOWN rather than sound.
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
   *  Every internal probe, mount and archive command uses this. The public
   *  `exec` waits for the restoration to finish, and the restoration itself
   *  runs commands, so routing internal work through the public method would
   *  make it wait for itself. */
  async #rawExec(
    command: string,
    cwd = DEVBOX_WORKDIR,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await super.exec(command, { cwd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
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
    const rows = await this.listSchedules(callback);
    if (!needsArming(rows, Date.now() / 1000)) return;
    await this.schedule(delaySeconds, callback, null);
  }
}

/** The SDK's `BackupOptions` takes a mutable `excludes`; a shared constant must
 *  be readonly. One copy at the boundary rather than a mutable shared array. */
function mutableBackupOptions(options: BackupOptions): BackupOptions {
  return { ...options, excludes: options.excludes === undefined ? undefined : [...options.excludes] };
}
