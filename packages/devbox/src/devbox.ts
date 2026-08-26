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

import { Sandbox } from '@cloudflare/sandbox';
import type {
  BackupOptions, CheckChangesOptions, ExecOptions, ExecResult,
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
  quiesceStep,
  restartPlan,
  type DevboxIncident,
  type DevboxPolicy,
  type IncidentDisposition,
  type IncidentStage,
  type PortExposureSpec,
  type QuiesceAction,
  type SupervisedProcessSpec,
  withContainerStartDeadline, CONTAINER_START_BUDGET_MS,
} from './lifecycle';
import { r2fsStorage, type R2fsPorts } from './r2fs';
import { deletePrefix, prefixInventory, putStream } from './object-store';
import { emptyCounters, type CasPutMeta } from './cas';
import {
  CAS_TREE_MOUNT, normalizeOverlayCasState, overlayCasStorage, type OverlayCasPorts,
} from './overlay-cas';
import {
  deliverIncidents, INCIDENT_PREFIX, incidentTotals, recordIncident,
  type IncidentRow,
} from './incidents';
import {
  CHAIN_EXCLUDES,
  CHAIN_STORE_MOUNT,
  assertChainId,
  normalizeChainState,
  snapshotChainStorage,
  type ChainState,
  type ChangeStatus,
  type SnapshotChainPorts,
} from './snapshot-chain';
import {
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type DevboxStore,
  type DevboxStrategyName,
  type StoredValue,
} from './storage';

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
const LAST_TICK_KEY = 'devbox:last-tick';
const BOOT_ID_KEY = 'devbox:boot-id';
const REPLACED_COUNT_KEY = 'devbox:replaced-count';

/** Scheduled-callback names. Each MUST name a public method on the class:
 *  `Container.schedule` rejects anything it cannot call back. */
const STARTUP_CALLBACK = 'devboxStartup';
const CHECKPOINT_CALLBACK = 'devboxCheckpoint';
const HEARTBEAT_CALLBACK = 'devboxHeartbeat';
const INCIDENT_CALLBACK = 'devboxIncidents';

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
  readonly ready: boolean;
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

export class Devbox<Env = unknown> extends Sandbox<Env> {
  #storage: DevboxStorage | undefined;
  #startup: Promise<void> | undefined;
  #ready = false;
  /** Why the last attach failed, or undefined. Set here rather than read from
   *  storage because it is a fact about THIS container generation. */
  #attachFailure: string | undefined;
  #lastInteraction: number | undefined;
  #lastInteractionPersisted = 0;
  /** Every strategy checkpoint on this instance runs through one gate, so two
   *  overlapping entry points can never interleave inside a strategy. */
  #lane = createCheckpointLane();

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
  protected onIncident(incident: DevboxIncident): Promise<IncidentDisposition> {
    console.error(
      `[devbox] incident ${incident.incidentId} at ${incident.stage}: ${incident.reason}`,
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
   * The filesystem attach, and nothing else, under a hard budget.
   *
   * See the class header for why the other three phases are not here.
   */
  override onStart(): Promise<void> {
    // READINESS IS PER CONTAINER, NOT PER OBJECT, and this line is what makes
    // that true. A Durable Object outlives the containers it drives: the
    // container can be recycled while this object stays in memory with
    // `#ready` still set from the previous one. `ensureReady()` would then
    // return immediately, no attach would run, and every operation would go to
    // a blank disk while the object believed it was restored.
    //
    // Measured on a deployed probe: an attach landed, the container was
    // replaced, and the next checkpoint correctly refused with "/workspace is
    // not an overlay mount" — the guard caught it, but the missing re-attach is
    // what put the box there. This hook is the one thing that fires per
    // container start, so it is where the flags reset.
    this.#ready = false;
    this.#attachFailure = undefined;
    this.#startup = undefined;
    // NO setKeepAlive(true). AUDITED IN THE SDK SOURCE, and it is worse than
    // useless here.
    //
    // `@cloudflare/containers` drives everything from ONE alarm chain: each
    // `alarm()` ends by setting the next alarm. Its activity branch does not
    // (container.js, the `isActivityExpired()` arm): it calls
    // `onActivityExpired()`, renews the timeout, and RETURNS WITHOUT SETTING AN
    // ALARM. `Sandbox.onActivityExpired` then checks `keepAliveEnabled`, and
    // when it is true it only LOGS "container will stay alive".
    //
    // So keepAlive does not keep anything alive. It converts "stop the
    // container cleanly" into "kill the alarm chain and let the platform
    // reclaim the container anyway", which loses the final checkpoint AND every
    // future tick, silently. Measured live by probe P5: the container slept
    // after 11 minutes of true idle with keepAlive on and a heartbeat row
    // sitting in the schedule table that nothing could ever reach.
    //
    // The lease is held the way the SDK actually measures it instead: the
    // heartbeat renews the activity timeout on every tick, so the expiry branch
    // is never entered and the chain keeps setting its own next alarm. If a tick
    // is ever late enough for expiry, `onActivityExpired` below takes a final
    // checkpoint and lets the container stop, which is a bounded loss instead of
    // an unbounded one.
    //
    // All three self-re-arming rows are armed here because `onStart` is the one
    // hook that fires per container start. The heartbeat especially: it re-arms
    // itself, so this is the chain's only first link, and without it the lease
    // never ticks and quiesce never runs (probe P5: /heartbeatSchedules
    // answered []).
    // The awaited work — the SDK's own start plus three schedule writes — runs
    // under the container-start budget (see withContainerStartDeadline): an
    // overrun fails THIS start as a retryable 503 instead of letting the
    // platform reset the object at its own cancel window. The flag resets above
    // stay synchronous: they must happen per start even if the budget fires.
    return withContainerStartDeadline(
      'Devbox.onStart',
      CONTAINER_START_BUDGET_MS,
      async () => {
        await super.onStart();
        await this.#arm(STARTUP_CALLBACK, 1);
        if (this.ambientCheckpoints) {
          await this.#arm(CHECKPOINT_CALLBACK, Math.ceil(this.policy.checkpointIntervalMs / 1000));
        }
        await this.#arm(HEARTBEAT_CALLBACK, this.policy.heartbeatSeconds);
      },
      (failure) => {
        // The abandoned work settled late; its error is the diagnostic.
        console.error(
          `[devbox] Devbox.onStart overran its start budget; abandoned work settled with: `
          + describe(failure),
        );
      },
    );
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
   */
  async #stampBootId(): Promise<string> {
    // COUNT THE REPLACEMENT HERE, where the evidence is, not where it happens to
    // be noticed. Every restoration passes through this method, whether it was
    // driven by the container-start hook or by a heartbeat that spotted the
    // mismatch itself. Counting in the heartbeat alone under-reported exactly the
    // case worth measuring: a replacement handled through `onStart` incremented
    // nothing, so a box could be replaced repeatedly and report zero.
    const previous = await this.ctx.storage.get<string>(BOOT_ID_KEY);
    if (previous !== undefined && (await this.#readBootId()) !== previous) {
      const replaced = (await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0) + 1;
      await this.ctx.storage.put(REPLACED_COUNT_KEY, replaced);
      console.error(`[devbox] the container instance was replaced (${replaced} so far)`);
    }
    const bootId = crypto.randomUUID();
    await this.#rawExec(`printf %s ${bootId} > ${BOOT_ID_PATH}`);
    await this.ctx.storage.put(BOOT_ID_KEY, bootId);
    return bootId;
  }

  /** The id this container instance is carrying, or undefined when the file is
   *  gone, which is what a replaced instance looks like. */
  async #readBootId(): Promise<string | undefined> {
    const read = await this.#rawExec(`cat ${BOOT_ID_PATH} 2>/dev/null || true`);
    const value = read.stdout.trim();
    return value.length > 0 ? value : undefined;
  }

  async #attachAndRestore(): Promise<void> {
    const outcome = await withContainerStartDeadline(
      'Devbox.attach',
      this.policy.attachBudgetMs,
      () => this.#requireStorage().attach(),
      (failure) => {
        console.error(
          '[devbox] the attach overran its budget and was abandoned; it later settled '
          + `with: ${describe({ cause: failure.cause })}`,
        );
      },
    );
    await this.ctx.storage.put(LAST_ATTACH_KEY, outcome);
    console.log(`[devbox] attach ${outcome.kind}: ${outcome.detail}`);
    await this.#restartWorkloads();
    // Last, so the id only exists on an instance that is fully restored. An id
    // stamped before the restoration would make a half-restored instance look
    // like a healthy one.
    await this.#stampBootId();
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
    if (this.ctx.container?.running !== true) return;
    const pending = this.#startup;
    if (pending !== undefined) return await pending;
    const run = (async () => {
      try {
        await this.#attachAndRestore();
        this.#attachFailure = undefined;
        this.#ready = true;
      } catch (error) {
        // The work directory the caller expects is not there, so operations
        // must refuse rather than run against whatever the container has. The
        // retry is a SCHEDULE, not the next operation: retrying per operation
        // would record an incident per operation for one broken box.
        this.#attachFailure = describe({ cause: error });
        await this.#record('attach', this.#attachFailure);
        await this.#arm(STARTUP_CALLBACK, this.policy.heartbeatSeconds);
        throw error;
      } finally {
        this.#startup = undefined;
      }
    })();
    this.#startup = run;
    return await run;
  }

  /** Processes first (they serve the ports), then each port's listener probe,
   *  then that port's re-exposure with its persisted token. One dead spec must
   *  not strand the rest of the box, so each failure is recorded and the walk
   *  continues. */
  async #restartWorkloads(): Promise<void> {
    const [processes, ports] = await Promise.all([this.#procSpecs(), this.#portSpecs()]);
    for (const op of restartPlan(processes, ports)) {
      if (op.kind === 'start-process') {
        try {
          await this.startProcess(op.spec.command, {
            ...(op.spec.cwd === undefined ? { cwd: DEVBOX_WORKDIR } : { cwd: op.spec.cwd }),
            processId: op.spec.processId,
            autoCleanup: false,
          });
        } catch (error) {
          await this.#record('process', describe({ cause: error }), { processId: op.spec.processId });
        }
        continue;
      }
      if (op.kind === 'await-port') {
        if (!await this.#awaitListener(op.port)) {
          await this.#record('port', `nothing listens on port ${op.port} after restart`, {
            port: op.port,
          });
        }
        continue;
      }
      await this.#exposeWithSpec(op.spec);
    }
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
  async #awaitListener(port: number): Promise<boolean> {
    const deadline = Date.now() + this.policy.portWaitMs;
    for (;;) {
      const probe = await this.#rawExec(healthProbeCommand(port));
      if (!healthProbeSilent(probe.stdout)) return true;
      if (Date.now() >= deadline) return false;
      await scheduler.wait(this.policy.portProbeIntervalMs);
    }
  }

  async #exposeWithSpec(spec: PortExposureSpec): Promise<void> {
    const hostname = this.previewHost;
    if (hostname === undefined || hostname.length === 0) {
      console.log(`[devbox] port ${spec.port} not re-exposed: no preview host configured`);
      return;
    }
    try {
      const options: PortExposeOptions = { hostname, token: spec.token };
      if (spec.name !== undefined) options.name = spec.name;
      await this.exposePort(spec.port, options);
    } catch (error) {
      await this.#record('port', describe({ cause: error }), { port: spec.port });
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
    if (this.#ready) return;
    // START THE CONTAINER HERE, not as a side effect of the operation.
    //
    // Returning early on a stopped container looks harmless and is not: the
    // operation then starts the container itself, AFTER passing the gate, so the
    // first call on a cold box runs before anything has attached. Measured: a
    // wake reported `attach: empty` on a box that held a chain, because its one
    // operation started the container and the attach only landed on the
    // scheduled tick a second later.
    if (this.ctx.container?.running !== true) {
      await this.startAndWaitForPorts();
    }
    if (this.#attachFailure !== undefined) {
      // Refuse fast, with the reason. The scheduled retry is what clears this;
      // re-attaching here would turn one broken box into an incident per call.
      throw new Error(
        `this devbox has no attached work directory: ${this.#attachFailure}. A scheduled `
        + 'retry is armed; operations are refused until it succeeds.',
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
    await this.ensureReady();
    this.stampInteraction();
    return await super.exec(command, { cwd: DEVBOX_WORKDIR, ...options });
  }

  /** Force the attach now and report what it did. The container-start hook does
   *  this on every start; this is for a caller that needs the answer, such as a
   *  benchmark driver measuring a cold wake. */
  async attachNow(): Promise<AttachOutcome> {
    this.stampInteraction();
    await this.ensureReady();
    const outcome = await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY);
    if (outcome === undefined) {
      // `ensureReady` starts a stopped container and drives the attach, so it
      // has written this row by the time it returns — unless a host with no
      // store configured attached nothing at all, which is a real and ordinary
      // state rather than an error.
      return { kind: 'empty', detail: 'this box has attached nothing' };
    }
    return outcome;
  }

  /** Commit now and report what it did. */
  async checkpointNow(kind: CheckpointKind): Promise<CheckpointOutcome> {
    this.stampInteraction();
    return await this.#checkpoint(kind);
  }

  /**
   * The one serialization point for every strategy checkpoint this instance
   * can be asked to run: `checkpointNow`, the scheduled tick, the quiesce and
   * activity expiry. See {@link createCheckpointLane} for why two overlapping
   * runs must never interleave inside a strategy.
   */
  #checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    return this.#lane.run(kind, () => this.#requireStorage().checkpoint(kind));
  }

  /**
   * Stop the container the graceful way: final checkpoint, then SIGTERM.
   *
   * The order is the whole content. Sending SIGTERM before the checkpoint means
   * the bytes are gone. A failed checkpoint refuses to stop and returns its
   * reason, because stopping anyway is how a box loses work.
   *
   * There is no keepAlive step, deliberately: `onStart` explains at length why
   * enabling it converts a clean stop into a dead alarm chain and a container
   * the platform reclaims anyway.
   */
  async quiesce(): Promise<CheckpointOutcome> {
    const outcome = await this.#checkpoint('quiesce');
    if (outcome.kind === 'failed') {
      await this.#record('checkpoint', `final checkpoint failed: ${outcome.reason ?? 'unknown'}`);
      return outcome;
    }
    this.#ready = false;
    this.#attachFailure = undefined;
    await this.stop('SIGTERM');
    // Sandbox.stop acknowledges the signal before the platform flips
    // `container.running`. Returning in that window let an immediate wake reuse
    // the old mount, then lose it underneath the next operation. Completion of
    // quiesce means stopped, so wait on the provider's own state transition.
    while (this.ctx.container?.running === true) await scheduler.wait(100);
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
   * IDEMPOTENT ON (command, cwd), because its caller retries. Core wraps this
   * in a transient-error retry, and the transients it retries on — "network
   * connection lost", a mid-request disconnect — are failures where this method
   * may have run to completion and only the answer was lost. Starting a second
   * copy would leave TWO durable specs, so every future wake would restart two
   * servers fighting over one port, permanently, with nothing to distinguish
   * them. So an existing spec for the same command in the same directory is
   * answered rather than duplicated: if its process is still live the caller
   * gets that one back, and if it is not, the dead spec is replaced.
   */
  async startSupervised(command: string, cwd?: string): Promise<{ processId: string }> {
    await this.ensureReady();
    const workDir = cwd ?? DEVBOX_WORKDIR;
    const previous = (await this.#procSpecs())
      .find(spec => spec.command === command && spec.cwd === workDir);
    if (previous !== undefined) {
      const live = (await this.listProcesses())
        .some(row => row.id === previous.processId && isProcessLive(row.status));
      if (live) {
        this.stampInteraction();
        return { processId: previous.processId };
      }
      await this.ctx.storage.delete(`${PROC_SPEC_PREFIX}${previous.processId}`);
    }
    const started = await this.startProcess(command, { cwd: workDir, autoCleanup: false });
    await this.ctx.storage.put(`${PROC_SPEC_PREFIX}${started.id}`, {
      processId: started.id,
      command,
      cwd: workDir,
      createdAt: Date.now(),
    } satisfies SupervisedProcessSpec);
    this.stampInteraction();
    return { processId: started.id };
  }

  /** Stop a supervised process and drop its spec, so it does not come back. */
  async stopSupervised(processId: string): Promise<{ stopped: boolean }> {
    await this.ensureReady();
    let stopped = true;
    try {
      await this.killProcess(processId);
    } catch (error) {
      // An unknown id on a NEW container generation is the ordinary
      // post-recycle case: the spec was restarted under its own id and the
      // caller is holding the previous one. Anything else is worth recording.
      if (!/not found|unknown/i.test(describe({ cause: error }))) {
        await this.#record('process', describe({ cause: error }), { processId });
      }
      stopped = false;
    }
    await this.ctx.storage.delete(`${PROC_SPEC_PREFIX}${processId}`);
    this.stampInteraction();
    return { stopped };
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
    await this.ctx.storage.delete(`${PORT_SPEC_PREFIX}${port}`);
    this.stampInteraction();
  }

  /** Everything about this box that can be answered without touching the
   *  container, plus the two facts that need it. */
  async devboxState(): Promise<DevboxReport> {
    const [supervised, ports, incidents] = await Promise.all([
      this.#procSpecs(),
      this.#portSpecs(),
      this.ctx.storage.list<IncidentRow>({ prefix: INCIDENT_PREFIX }),
    ]);
    return {
      strategy: this.strategy,
      durable: this.store !== undefined,
      running: this.ctx.container?.running === true,
      ready: this.#ready,
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
      const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);
      if (expected !== undefined && (await this.#readBootId()) !== expected) {
        console.error(
          '[devbox] the container instance was replaced; re-driving the restoration now '
          + 'rather than waiting for the next operation',
        );
        // Clear readiness and re-drive immediately. Waiting for the next
        // operation would leave supervised processes and ports down for as long
        // as the box is idle, which is exactly when nobody is watching.
        this.#ready = false;
        this.#startup = undefined;
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
      // An unreachable host means POSSIBLY busy, so hold. Never stop on a guess.
      let backgroundWork = true;
      try {
        backgroundWork = await this.hasBackgroundWork();
      } catch (error) {
        console.error(
          `[devbox] background-work check failed, holding: ${describe({ cause: error })}`,
        );
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
    this.#ready = false;
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
      await deliverIncidents(this.ctx.storage, async (incident) =>
        await this.onIncident(incident)));
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
   * Shaped like the other two: this host supplies the ability to run a command,
   * move bytes and reach the store, and decides nothing. The upper walk, the
   * whiteout form and the chunk read are the strategy's own vocabulary and live
   * in its own shell, so there are no command templates here to keep correct.
   *
   * The op counters are created PER ADAPTER, so one box's tally is its own and
   * a bench arm cannot read another arm's traffic as its cost.
   */
  #overlayCasPorts(store: DevboxStore): OverlayCasPorts {
    const prefix = this.#boxPrefix();
    const counters = emptyCounters();
    const key = (relative: string): string => `${prefix}/${relative}`;
    const objectOptions = (meta: CasPutMeta | undefined): R2PutOptions | undefined =>
      meta === undefined ? undefined : {
        customMetadata: {
          mode: String(meta.mode),
          uid: '0',
          gid: '0',
          mtime: String(Math.floor((meta.mtimeMs ?? Date.now()) / 1000)),
        },
      };
    const multipartLifecycle = {
      started: async (objectKey: string, uploadId: string): Promise<void> => {
        await this.ctx.storage.put(
          `${MULTIPART_UPLOAD_PREFIX}${uploadId}`,
          { key: objectKey, uploadId },
        );
      },
      finished: async (_objectKey: string, uploadId: string): Promise<void> => {
        await this.ctx.storage.delete(`${MULTIPART_UPLOAD_PREFIX}${uploadId}`);
      },
    };
    return {
      containerRunning: () => this.ctx.container?.running === true,
      exec: async (command) => await this.#rawExec(command),
      writeFileBase64: async (path, base64) => {
        await this.writeFile(path, base64, { encoding: 'base64' });
      },
      writeFileStream: async (path, stream) => {
        await this.writeFile(path, stream);
      },
      mountTree: async () => {
        await this.#abortPendingMultipartUploads(store);
        await this.mountBucket(store.binding, CAS_TREE_MOUNT, {
          prefix: `/${prefix}/tree`, readOnly: true,
        });
      },
      unmountTree: async () => {
        try {
          await this.unmountBucket(CAS_TREE_MOUNT);
        } catch (error) {
          // Not mounted is the ordinary case on a fresh container, and the SDK
          // says so by throwing. Released THROUGH the SDK, never a raw
          // fusermount3: the SDK keeps its own registry of the mounts it made
          // and a kernel-level release leaves it claiming the path forever.
          console.log(`[devbox] cas tree mount was not released: ${describe({ cause: error })}`);
        }
      },
      store: () => ({
        counters,
        put: async (relative, bytes, meta) => {
          counters.putCalls += 1;
          counters.bytesPut += bytes.byteLength;
          await store.bucket.put(key(relative), bytes, objectOptions(meta));
        },
        putStream: async (relative, stream, size, meta) => {
          counters.putCalls += 1;
          const landed = await putStream(
            store.bucket,
            key(relative),
            stream,
            size,
            objectOptions(meta),
            multipartLifecycle,
          );
          counters.bytesPut += landed;
          if (landed !== size) {
            throw new Error(`${relative} streamed ${landed} bytes, expected ${size}`);
          }
        },
        get: async (relative) => {
          counters.getCalls += 1;
          const object = await store.bucket.get(key(relative));
          if (object === null) return null;
          const bytes = new Uint8Array(await object.arrayBuffer());
          counters.bytesGot += bytes.byteLength;
          return bytes;
        },
        head: async (relative) => {
          counters.headCalls += 1;
          const object = await store.bucket.head(key(relative));
          return object === null ? null : { size: object.size };
        },
        delete: async (relative) => {
          counters.deleteCalls += 1;
          await store.bucket.delete(key(relative));
        },
        list: async (relativePrefix) => {
          counters.listCalls += 1;
          const found: string[] = [];
          let cursor: string | undefined;
          do {
            const options: R2ListOptions = { prefix: key(relativePrefix) };
            if (cursor !== undefined) options.cursor = cursor;
            const page = await store.bucket.list(options);
            for (const object of page.objects) found.push(object.key.slice(prefix.length + 1));
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor !== undefined);
          return found;
        },
      }),
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
        const result = await this.readFile(path, { encoding: 'none' });
        return { stream: result.content, size: result.size };
      },
      putObject: async (key, stream, size) => await putStream(store.bucket, key, stream, size),
      objectBytes: async (key) => (await store.bucket.head(key))?.size,
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
  async #rawExec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await super.exec(command, { cwd: DEVBOX_WORKDIR });
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
