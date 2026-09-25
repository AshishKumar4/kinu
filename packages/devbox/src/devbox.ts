/** One ephemeral container presented as a durable workspace; admission is port-proven (D1).
 *  onStart restores inside the SDK's start block under one raced budget (D19, D26); requests only adopt or refuse. */

import { Sandbox } from '@cloudflare/sandbox';
import type {
  CheckChangesOptions, ExecOptions, ExecResult, ListFilesOptions,
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
  type ResourceScope,
  type SupervisedProcessSpec,
  openStartBudget, awaitListenerCommand,
  LAST_INTERACTION_KEY,
  QUIET_SINCE_KEY,
  racedRestoreSteps, runRestoreStep, ContainerStartOverrun, ContainerStartInterrupted, type RestoreSteps,
  REAL_START_CLOCK, type StartClock,
} from './lifecycle';
import { shellPath } from './chunked-delta';
import type { RestorePhase, RestorePhaseStamps } from './durability/contracts';
import {
  admissionOf, isSettledRestoration, recoveryRow, settledRestoration, unreadyOf,
  type RecoveryClaim, type RestoreAdmission, type RestoreClockPhase, type RestoreReadiness,
  type Restoration, type SettledRestoration, type StampOutcome,
} from './restoration';
import type { DevboxReport, HeartbeatTick, IncidentReasonRow, SupervisedProcessRow } from './report';
import {
  deliverIncidents, INCIDENT_PREFIX, incidentTotals, recordIncident,
  type IncidentRow,
} from './incidents';
import {
  CHAIN_EXCLUDES,
  ChainRecordAdvanced,
  chainStoreRoot,
  normalizeChainState,
  seedStampPorts,
  snapshotChainStorage,
  storeObjectUrl,
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
import {
  BOOT_ID_PATH,
  DEVBOX_SYNC_HANDLER,
  DEVBOX_SYNC_HOST,
  DEVBOX_SYNC_SESSION,
  SYNC_ALIVE_PROBE,
  parseSyncOutcome,
  serveSync,
  syncFlushCommand,
  syncStartCommand,
  syncStopCommand,
  type SyncAnswer,
  type SyncConfig,
} from './sync';

/** Bounded wait for `running` to clear after an acknowledged stop: an unbounded wait pins the
 *  attempt, and `kickStartup` early-returns on a pinned attempt, so nothing re-arms. */
const CONTAINER_STOP_ATTEMPTS = 50;

const CONTAINER_STOP_INTERVAL_MS = 100;

/** The SDK's default poll interval; the retry count derives from it. */
const ADMISSION_POLL_INTERVAL_MS = 100;

/** All durable keys share the `devbox:` prefix so a host's own keys cannot collide with them. */
const STORAGE_KEY = 'devbox:storage-state';

const PROC_SPEC_PREFIX = 'devbox:proc:';

const PORT_SPEC_PREFIX = 'devbox:port:';

const LAST_ATTACH_KEY = 'devbox:last-attach';

/** Recovery progress for one container identity: written only by the recovery ladder, deleted
 *  on the first landed attach; durable because a fresh object often runs the scheduled retry. */
const ATTACH_RECOVERY_KEY = 'devbox:attach-recovery';

const LAST_TICK_KEY = 'devbox:last-tick';

const BOOT_ID_KEY = 'devbox:boot-id';

/** Persisted so a mid-restore object reset is survivable; a stored `restoring` phase needs recovery.
 *  Generation turnover clears the row, so a stale phase cannot admit a different container. */
const SETTLED_KEY = 'devbox:restoration';

const REPLACED_COUNT_KEY = 'devbox:replaced-count';

/** Scheduled-callback names. Each MUST name a public method on the class:
 *  `Container.schedule` rejects anything it cannot call back. */
const STARTUP_CALLBACK = 'devboxStartup';

const CHECKPOINT_CALLBACK = 'devboxCheckpoint';

const HEARTBEAT_CALLBACK = 'devboxHeartbeat';

const INCIDENT_CALLBACK = 'devboxIncidents';

/** A classified recovery obligation; executed outside the SDK start block. */
const RECOVERY_ACTION_KEY = 'devbox:recovery-action';

/** s3fs defaults (300 s connect, 120 s idle, 5 retries) outlive the `attachBudgetMs` attach;
 *  a dead connection then runs beside the retry; each request is an egress hop, not a WAN. */
const STORE_MOUNT_S3FS_OPTIONS: readonly string[] = [
  'connect_timeout=10',
  'readwrite_timeout=30',
  'retries=3',
];

/** Every call already renews the SDK's in-memory timer; the durable stamp only has to
 *  survive an eviction, so writes are throttled rather than one per call. */
const INTERACTION_PERSIST_INTERVAL_MS = 30_000;

/** Twin of `LIVE_PROCESS_STATES` in `packages/cf-backend/src/sandbox-exec-lane.ts`. */
function isProcessLive(status: string): boolean {
  return status === 'starting' || status === 'running';
}

/** A restore step's `onLate`: the race already answered `late`, so its eventual outcome is only logged. */
function logLate(step: string): (failure: LateStartFailure) => void {
  return (failure) => {
    console.error(`[devbox] ${step} outran its allowance; it later settled with: ${describe({ cause: failure.cause })}`);
  };
}

/** Absence is the SDK's `PROCESS_NOT_FOUND` code, not message text: prose like `not found`
 *  or `unknown` also appears in unrelated failures. A value with no SDK code is not absence. */
const ProcessAbsentSchema = v.object({ code: v.literal('PROCESS_NOT_FOUND') });

/** The SDK declares `exposePort`'s options inline; this names them so a caller can build
 *  them in steps instead of spreading a conditional. */
interface PortExposeOptions {
  hostname: string;
  token: string;
  name?: string;
}

interface RestoreClock {
  readonly openedAt: number;
  stamps: RestorePhaseStamps;
}

/** Infers both `readFile` arms from the SDK's declaration, so a changed one fails to compile. */
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

/** One attempt in flight and when it opened, so a report can say how long a
 *  box has been waiting on it rather than only that it is. */
interface Flight {
  readonly generation: number;
  readonly run: Promise<void>;
  readonly since: number;
}

export class Devbox<Env = unknown> extends Sandbox<Env> {
  #storage: DevboxStorage | undefined;
  #gateRestore: Flight | undefined;
  /** Fences every write below: an abandoned startup continuation keeps running, and must
   *  re-check this token after every await or it can clear its successor's single-flight entry. */
  #generation = 0;
  /** A caller joins the attempt only while its generation still matches: a superseded
   *  attempt's result is already discarded. */
  #startup: Flight | undefined;
  #disarmAdmission: (() => void) | undefined;
  /** Opened by the attempt on its hook; every phase stamp reads it until the attempt settles.
   *  Memory only: a witness needing stamps past a reset keeps them via `onRestorePhase`. */
  #phaseClock: RestoreClock | undefined;
  #restoration: Restoration = { phase: 'unstarted' };
  /** Activation defers identity comparison until the control listener is reachable. */
  #adoptionPending = false;
  /** Holders the last release pass signalled, kept only so a refused detach can name them.
   *  Cleared on every detach attempt so a later refusal cannot blame a stale list. */
  #lastWorkdirHolders: readonly { readonly pid: string; readonly comm: string }[] | undefined;
  #lastInteraction: number | undefined;
  #lastInteractionPersisted = 0;
  /** Every strategy checkpoint on this instance runs through one gate, so two
   *  overlapping entry points can never interleave inside a strategy. */
  readonly #lane = createCheckpointLane();
  /** Public work with no resource name: shell commands and supervised starts.
   *  Resource and checkpoint work reports directly through their own lanes. */
  #activeCallers = 0;
  /** Repair recreates storage mounts while a checkpoint may start a runner; one FIFO owns that
   *  graph from admission to finalization so neither mutates beneath work the other admitted. */
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

  /** One caller at a time per container resource, shared by every facet of this workspace
   *  because they all reach this object. */
  readonly #resources = createResourceLane();

  /** Sweeps dead schedule rows at activation: the SDK alarm loop re-arms from a non-empty table,
   *  and `onStart` never runs on a wake whose container is asleep. Issues no `deleteAlarm`. */
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Unawaited: the gate holds every event until activation settles, and a storage failure
    // here is the object's own SQLite failing, which the first request reports itself.
    void ctx.blockConcurrencyWhile(() => this.#activate())
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] activation failed: ${describe({ cause })}`);
      });
  }

  /** Constructor work is storage-only; it does not yet have control-port proof. */
  async #activate(): Promise<void> {
    await this.#sweepUnknownSchedules();

    if (this.ctx.container?.running === true) {
      this.#adoptionPending = (await this.#durableClaim()) !== undefined;
      const settled = await this.ctx.storage.get<SettledRestoration>(SETTLED_KEY);

      if (settled?.phase === 'unattached' && isSettledRestoration(settled)) {
        // Refusal is safe to retain even when identity stamping failed.
        this.#restoration = settled;
      }
    }
  }

  async #durableClaim(): Promise<{ readonly expected: string; readonly settled: SettledRestoration } | undefined> {
    const [expected, settled] = await Promise.all([
      this.ctx.storage.get<string>(BOOT_ID_KEY),
      this.ctx.storage.get<SettledRestoration>(SETTLED_KEY),
    ]);

    if (expected === undefined || !isSettledRestoration(settled)) return undefined;

    return { expected, settled };
  }

  /** Memory can name `attached` for a replaced container, so every reader settles adoption first. */
  async #resolveAdoption(): Promise<void> {
    if (this.#gateRestore !== undefined) return;

    if (this.#adoptionPending) await this.#adoptOrTurnOver();
  }

  /** Turnover needs a container answer that refutes the stamped boot id; absent rows prove nothing
   *  (`#settle` sets memory before writing). Not timed: a clock here would overwrite the restore's row. */
  async #adoptOrTurnOver(): Promise<void> {
    const generation = this.#generation;
    this.#adoptionPending = false;
    const claim = await this.#durableClaim();

    if (claim === undefined || !this.#owns(generation)) return;
    const actual = await this.#readBootId();

    if (!this.#owns(generation)) return;

    if (actual === claim.expected) {
      this.#restoration = claim.settled;

      return;
    }

    const held = this.#restoration;

    if (held.phase === 'unstarted' || held.phase === 'restoring') return;
    console.error(
      '[devbox] the box claims a restoration the container does not carry; restoring it '
      + 'rather than serving callers a world that is gone',
    );
    this.#invalidateGeneration();
  }

  /** A subclass supplies it because only it knows its `Env`; the binding is named twice:
   *  `mountBucket` resolves it by name in the container, the snapshot chain uses it directly. */
  protected get store(): DevboxStore | undefined {
    return undefined;
  }

  /** Fixed per class: a box that already holds bytes cannot switch strategy, since
   *  the strategies write different things. */
  protected get strategy(): DevboxStrategyName {
    return DEFAULT_DEVBOX_STRATEGY;
  }

  protected get policy(): DevboxPolicy {
    return DEFAULT_DEVBOX_POLICY;
  }

  /** Must stay false in production: a deployed box would archive one base and never capture
   *  more, since a plain directory has no overlay upper. Only local `wrangler dev` overrides. */
  protected get allowExtraction(): boolean {
    return false;
  }

  /** Override to keep `target/` or `dist/` when they are the work; a larger base costs attach
   *  nothing because layers mount lazily. */
  protected get archiveExcludes(): readonly string[] {
    return CHAIN_EXCLUDES;
  }

  /** Undefined means previews are unavailable: port forwarding is not re-activated and the box
   *  reports that rather than returning a URL that cannot resolve. */
  protected get previewHost(): string | undefined {
    return undefined;
  }

  /** Veto on quiescing. A host that queues work must override: a box stopped under a running
   *  job costs that job an attach and possibly its progress. */
  protected hasBackgroundWork(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** The incident is already durable, so a throw is transient and retried by schedule;
   *  return `rejected` only for a malformed incident, which is a defect and never retried. */
  protected onIncident(incident: DevboxIncident, attempt: number): Promise<IncidentDisposition> {
    console.error(
      `[devbox] incident ${incident.incidentId} at ${incident.stage} `
      + `(delivery attempt ${attempt}): ${incident.reason}`,
    );

    return Promise.resolve('queued');
  }

  /** Hook for restore progress; `atMs` counts from when the attempt opened inside the hook.
   *  Synchronous, because the attempt waits for nothing of the witness's. */
  protected onRestorePhase(_phase: RestoreClockPhase, _atMs: number): void {
    void _phase;
    void _atMs;
  }

  #stampPhase(phase: RestorePhase): void {
    const clock = this.#phaseClock;

    if (clock === undefined || clock.stamps[phase] !== undefined) return;
    const atMs = Date.now() - clock.openedAt;
    clock.stamps = { ...clock.stamps, [phase]: atMs };
    this.onRestorePhase(phase, atMs);
  }

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

  /** A benchmark box overrides to `false`: an ambient tick would commit its pending change and
   *  reset the interval stamp, so the driver's measured tick would skip. The gate still applies. */
  protected get ambientCheckpoints(): boolean {
    return true;
  }

  protected get startClock(): StartClock {
    return REAL_START_CLOCK;
  }

  /** Plain SDK starts must also prove the control listener before our hook. */
  override start(...args: Parameters<Sandbox<Env>['start']>): Promise<void> {
    return this.startAndWaitForPorts({
      ports: this.defaultPort,
      startOptions: args[0],
      cancellationOptions: {
        abort: args[1]?.signal,
        waitInterval: args[1]?.waitInterval,
        instanceGetTimeoutMS: this.policy.portWaitMs,
        portReadyTimeoutMS: this.policy.portWaitMs,
      },
    });
  }

  /** Runs inside the SDK's start block (D26): nothing else reaches the object until it settles.
   *  A timer set before the block holds every timer the hook sets, so the admission window goes. */
  override onStart(): Promise<void> {
    this.#disarmAdmission?.();

    return this.#restoreInStartGate();
  }

  /** Joins a re-entered hook; adopts a settled boot without re-attaching. */
  async #restoreInStartGate(): Promise<void> {
    const pending = this.#gateRestore;

    if (pending?.generation === this.#generation) {
      this.#trace('startup.hook.join', { generation: pending.generation, sinceMs: Date.now() - pending.since });

      return await pending.run;
    }

    const since = Date.now();
    const generation = this.#generation;
    this.#trace('startup.hook.enter', { generation, phase: this.#restoration.phase });
    const run = this.#runStartHook();
    this.#gateRestore = { generation, run, since };
    let settled = false;

    try {
      await run;
      settled = true;
    } finally {
      if (this.#gateRestore?.run === run) this.#gateRestore = undefined;
      this.#trace('startup.hook.exit', { generation, ms: Date.now() - since, settled, phase: this.#restoration.phase });
    }
  }

  /** One structured line per lifecycle edge, on the console the platform
   *  tails. Primitives only: a reader who wants the object asks `/state`. */
  #trace(event: string, fields: Record<string, string | number | boolean | undefined>): void {
    console.log(JSON.stringify({ event: `devbox.${event}`, at: Date.now(), ...fields }));
  }

  /** One budget includes adoption, restore, resumption and durable settlement. */
  async #runStartHook(): Promise<void> {
    const budgetMs = Math.min(this.policy.attachBudgetMs, DEFAULT_DEVBOX_POLICY.attachBudgetMs);
    const budget = openStartBudget(budgetMs, this.startClock);
    let generation = this.#generation;

    const result = await runRestoreStep(
      budget.remainingMs(),
      async () => {
        const previous = await this.ctx.storage.get<Restoration>(SETTLED_KEY);

        if (!this.#owns(generation)) return;

        if (previous?.phase === 'restoring') {
          const claim = await this.#claimRecovery();
          await this.#recover(generation, claim, { cause: new ContainerStartInterrupted() });

          return;
        }

        await this.#adoptOrTurnOver();

        if (this.#restoration.phase !== 'unstarted') return;
        generation = this.#generation;
        const failure = await this.#restoreNow(generation, racedRestoreSteps(budget));

        if (failure !== undefined) console.error(`[devbox] start refused: ${describe(failure)}`);
      },
      (failure) => console.error(`[devbox] abandoned start hook failed: ${describe(failure)}`),
      this.startClock,
    );

    if (!this.#owns(generation)) return;

    if (result.kind !== 'done') {
      const clock = this.#phaseClock;
      const attached = clock?.stamps.attached !== undefined;

      const cause = result.kind === 'late'
        ? new ContainerStartOverrun('Devbox.onStart', budgetMs)
        : result.cause;

      if (clock !== undefined) this.#settleClock(clock);
      this.#invalidateGeneration();

      if (attached) {
        const reason = `[deadline → repair] restoration did not settle inside the ${budgetMs}ms hook budget`;
        await this.#settle({ phase: 'repair', incomplete: reason });
        await this.#record('process', reason);
      } else {
        const recoveryGeneration = this.#generation;
        const claim = await this.#claimRecovery();
        await this.#recover(recoveryGeneration, claim, { cause });
      }
    }

    await this.#armContainerSchedules();

    if (this.#restoration.phase === 'attached') await this.#restartSync();

    if (this.#admission() !== undefined) this.deleteSchedules(STARTUP_CALLBACK);
  }

  /** Every settle writes the durable row a post-reset activation adopts, never memory alone.
   *  `restoring` admits nobody and marks interrupted work; `unstarted` deletes the row. */
  async #settle(restoration: Restoration): Promise<void> {
    const generation = this.#generation;

    if (restoration.phase !== 'unstarted') {
      await this.ctx.storage.put(SETTLED_KEY, restoration);
    } else {
      await this.ctx.storage.delete(SETTLED_KEY);
    }

    if (this.#owns(generation)) this.#restoration = restoration;
  }

  /** The startup row goes through `kickStartup`, not a bare `#arm`: a box with nothing restored
   *  would otherwise arm a successor every second; `#arm` is future-only for periodic rows. */
  async #armContainerSchedules(): Promise<void> {
    await this.kickStartup();

    if (this.ambientCheckpoints && !this.#syncsInContainer()) {
      await this.#arm(CHECKPOINT_CALLBACK, Math.ceil(this.policy.checkpointIntervalMs / 1000));
    }

    await this.#arm(HEARTBEAT_CALLBACK, this.policy.heartbeatSeconds);
  }

  /** The SDK alarm loop logs and skips a row whose callback is missing but never deletes it.
   *  Runs at activation, not `onStart`: a wake with an asleep container never reaches onStart. */
  async #sweepUnknownSchedules(): Promise<void> {
    // The SDK constructor creates `container_schedules` synchronously before this runs,
    // so the read needs no guard.
    const rows = this.ctx.storage.sql
      .exec<{ callback: string }>('SELECT DISTINCT callback FROM container_schedules')
      .toArray();

    for (const { callback } of rows) {
      // `in` walks the prototype chain, so SDK-inherited and subclass callbacks never get swept.
      // `in`, not a callability check: arming sites name methods; `no-reflect-get` forbids reads.
      if (callback in this) continue;
      console.error(
        `[devbox] dropping the schedule row for \`${callback}\`: this class carries no such `
        + 'member, so the alarm loop can only log it and keep the row for ever',
      );
      this.deleteSchedules(callback);
    }
  }

  /** A container/stored boot-id mismatch is the only reliable replacement signal; the platform
   *  swaps instances silently. Fence every read, count and write: stale ones corrupt the successor. */
  async #stampBootId(generation: number): Promise<void> {
    // Count replacements here: every restoration passes through this method, whatever drove it.
    // Counting only in the heartbeat misses replacements handled by startup or readiness paths.
    const previous = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    if (previous !== undefined && await this.#readBootId() === previous) {
      if (this.#owns(generation)) this.#stampPhase('bootId');

      return;
    }

    if (this.#owns(generation) && previous !== undefined && (await this.#readBootId()) !== previous) {
      const replaced = (await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0) + 1;

      if (!this.#owns(generation)) return;
      await this.ctx.storage.put(REPLACED_COUNT_KEY, replaced);

      if (this.#owns(generation)) {
        console.error(`[devbox] the container instance was replaced (${replaced} so far)`);
      }
    }

    // Ownership is re-checked before writing: a stale boot-id write makes a healthy container
    // read as replaced until repaired, so a heartbeat re-drives restoration and miscounts it.
    if (!this.#owns(generation)) return;
    const bootId = crypto.randomUUID();
    await this.#rawExec(`printf %s ${bootId} > ${BOOT_ID_PATH}`);

    // A stale attempt can park inside the exec and overwrite a successor's stamp, so re-check
    // ownership after it and rewrite the file to the durable row's id, the identity of record.
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

  /** The heartbeat re-drives a stale restoration; commit paths must not commit to a gone container.
   *  No stamp means no claim about any instance, so the answer is `false`, not replaced. */
  async #containerWasReplaced(observed?: { readonly bootId: string | undefined }): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    if (expected === undefined) return false;

    return (observed === undefined ? await this.#readBootId() : observed.bootId) !== expected;
  }

  /** A checkpoint must refuse a replaced workspace until the startup hook restores it. */
  async #healReplacedContainer(): Promise<void> {
    await this.#resolveAdoption();
    // A box in `repair` also serves callers over a work directory, so a replaced container
    // must refuse the commit there just as on an `attached` one.
    const held = this.#restoration;

    if (held.phase !== 'attached' && held.phase !== 'repair') return;

    if (this.ctx.container?.running !== true) return;

    if (!await this.#containerWasReplaced()) return;
    console.error(
      '[devbox] the restored container was replaced; refusing this commit until the start hook restores it',
    );
    this.#invalidateGeneration();
    await this.kickStartup();
    throw new Error('this devbox is not ready: the restored container was replaced; a startup is armed');
  }

  /** Undefined when the boot-id file is gone, which is what a replaced container instance
   *  looks like. */
  async #readBootId(): Promise<string | undefined> {
    const read = await this.#rawExec(`cat ${BOOT_ID_PATH} 2>/dev/null || true`, DEVBOX_RUNTIME_DIR);
    const value = read.stdout.trim();

    return value.length > 0 ? value : undefined;
  }

  /** One container call, one line per field: the server drops NUL bytes (P6). */
  async #readBeat(): Promise<{ readonly bootId: string | undefined; readonly syncAlive: boolean }> {
    const read = await this.#rawExec(
      `# devbox-beat-v1\nprintf '%s\\n' "$(cat ${BOOT_ID_PATH} 2>/dev/null)"; ${SYNC_ALIVE_PROBE}`,
      DEVBOX_RUNTIME_DIR,
    );

    const [bootId = '', sync = ''] = read.stdout.split('\n');

    return { bootId: bootId.trim() || undefined, syncAlive: !this.#syncRuns() || sync === 'alive' };
  }

  /** A box that may extract runs in local `wrangler dev`, whose container cannot reach it. */
  #syncsInContainer(): boolean {
    return this.store !== undefined && !this.allowExtraction;
  }

  #syncRuns(): boolean {
    return this.#syncsInContainer() && this.ambientCheckpoints;
  }

  #syncConfig(store: DevboxStore): SyncConfig {
    return {
      storeRoot: chainStoreRoot(this.#boxPrefix()),
      binding: store.binding,
      excludes: [...this.archiveExcludes],
      periodMs: this.policy.checkpointIntervalMs,
    };
  }

  /** A failure is an incident, not a failed restore: the stop's flush still commits. */
  async #restartSync(): Promise<void> {
    const store = this.store;

    if (store === undefined || !this.#syncsInContainer()) return;

    try {
      // Every stop's flush reaches the box through this host.
      await this.setOutboundByHost(DEVBOX_SYNC_HOST, DEVBOX_SYNC_HANDLER);

      if (!this.#syncRuns()) return;
      const started = await this.#rawExec(syncStartCommand(this.#syncConfig(store)), DEVBOX_RUNTIME_DIR);

      if (started.exitCode !== 0) throw new Error(started.stderr.trim() || started.stdout.trim() || `exit ${String(started.exitCode)}`);
      this.#trace('sync.start', { generation: this.#generation });
    } catch (error) {
      await this.#record('checkpoint', `the container's sync did not start: ${describe({ cause: error })}`);
    }
  }

  async #stopSync(): Promise<void> {
    if (!this.#syncsInContainer() || this.ctx.container?.running !== true) return;

    try {
      const stopped = await (await this.getSession(DEVBOX_SYNC_SESSION)).exec(syncStopCommand(), { cwd: DEVBOX_RUNTIME_DIR });

      if (stopped.exitCode !== 0) throw new Error(stopped.stderr.trim() || `exit ${String(stopped.exitCode)}`);
    } catch (error) {
      await this.#record('checkpoint', `the container's sync did not stop before the detach: ${describe({ cause: error })}`);
    }
  }

  async #runCheckpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    const store = this.store;

    if (store === undefined || !this.#syncsInContainer()) return await this.#requireStorage().checkpoint(kind);

    if (this.ctx.container?.running !== true) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }

    // A quiesce may reseat the base, unmounting the work directory the idle default shell holds (D10).
    const parked = kind === 'quiesce';

    if (parked) await this.#moveDefaultShell(DEVBOX_RUNTIME_DIR);

    try {
      // The flush calls back through `devboxSync`, so this checkpoint's lane must not gate it: the
      // record's fenced write is that path's concurrency control.
      const command = syncFlushCommand(this.#syncConfig(store), kind);
      const session = await this.getSession(DEVBOX_SYNC_SESSION);
      const flushed = await session.exec(command, { cwd: DEVBOX_RUNTIME_DIR });
      this.#meter(command, flushed.stdout, flushed.stderr);

      return parseSyncOutcome(flushed.stdout, flushed.stderr, flushed.exitCode);
    } finally {
      if (parked && this.ctx.container?.running === true) await this.#moveDefaultShell(DEVBOX_WORKDIR);
    }
  }

  /** Only a bare `cd` moves a session's shell; a command given a `cwd` returns after. */
  async #moveDefaultShell(dir: string): Promise<void> {
    const command = `cd ${shellPath(dir)}`;
    const moved = await super.exec(command);
    this.#meter(command, moved.stdout, moved.stderr);

    if (moved.exitCode !== 0) {
      throw new Error(`the default session's shell did not move to ${dir}: ${moved.stderr.trim() || `exit ${String(moved.exitCode)}`}`);
    }
  }

  async devboxSync(body: string): Promise<SyncAnswer> {
    const store = this.store;

    if (store === undefined) return { status: 403, body: JSON.stringify({ ok: false, error: 'refused', reason: 'this devbox has no store' }) };

    const reply = await serveSync({
      ports: this.#chainPorts(store),
      generation: async () => await this.ctx.storage.get<string>(BOOT_ID_KEY),
    }, body);

    this.#meter(reply.body, body);

    return reply;
  }

  async #restoreNow(
    generation: number,
    steps: RestoreSteps,
  ): Promise<{ readonly cause: unknown } | undefined> {
    await this.#settle({ phase: 'restoring', where: 'start', since: Date.now() });

    if (!this.#owns(generation)) return undefined;
    const clock = this.#openClock();

    try {
      return await this.#classifiedRestore(generation, steps);
    } finally {
      this.#settleClock(clock);
    }
  }

  async #classifiedRestore(
    generation: number,
    steps: RestoreSteps,
  ): Promise<{ readonly cause: unknown } | undefined> {
    const claim = await this.#claimRecovery();

    if (!this.#owns(generation)) return undefined;

    if (!claim.admit) {
      // An unparsed ladder row gives no evidence, so nothing is destroyed on a guess; the claim
      // already normalised it to terminal, so `attachNow()` re-attempts and a success deletes it.
      const reason = 'the attach-recovery record did not parse [unreadable → refuse]';
      await this.#settle({ phase: 'unattached', reason, retry: false });
      await this.#record('attach', reason);
      // Terminal refusal drops the startup wake-up the start hook armed, as `#recover` does for
      // `refuse` and `replace`; a firing row would file this refusal again every second.
      this.deleteSchedules(STARTUP_CALLBACK);

      return { cause: new Error(reason) };
    }

    try {
      await this.#stampBootId(generation);

      if (!this.#owns(generation)) return undefined;
      await this.#attachAndRestore(generation, claim, steps);

      return undefined;
    } catch (error) {
      await this.#recover(generation, claim, { cause: error });

      return { cause: error };
    }
  }

  /** All phases share one budget (D19). An attach overrun throws `ContainerStartOverrun` (identity is
   *  replaced); later steps mutate no mount, so exhaustion is reported in `unready` and never re-arms. */
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

    // The attach is the long await and everything after is a write: the generation may have
    // turned over, leaving an outcome for a container that no longer exists.
    if (!this.#owns(generation)) return;
    this.#stampPhase('attached');
    // Written only by a drive that reaches `attached` through an attach; a service-only rerun
    // keeps its generation's record.
    await this.ctx.storage.put(LAST_ATTACH_KEY, outcome);
    console.log(`[devbox] attach ${outcome.kind}: ${outcome.detail}`);
    // Boot proof and durable settlement still need their shares after services.
    steps.declare(2);
    const restored = await this.#restartWorkloads(generation, steps);

    if (!this.#owns(generation)) return;

    // Re-prove the early instance stamp before publishing its settled phase.
    const stamped = await steps.run(
      async () => await this.#stampBootId(generation),
      logLate('the boot-id stamp'),
    );

    if (!this.#owns(generation)) return;
    // PUBLISHED, not just held: the durable row is what a post-reset activation
    // adopts, and the stamp above is what it checks the container against.
    await this.#settle(settledRestoration(restored, stamped.kind));
    // Only a successful attempt clears the ladder, and only while the row still names it: a
    // partial restore (work dir but not every service) still clears it; `repair` reports the rest.
    await this.#releaseRecovery(claim, generation);
  }

  /** Only the start coordinator opens restoration; recovery first retires unsafe work. */
  async devboxStartup(): Promise<void> {
    const since = Date.now();
    this.#trace('startup.callback.enter', {
      generation: this.#generation, running: this.ctx.container?.running === true, phase: this.#restoration.phase,
    });

    try {
      await this.#dispatch(STARTUP_CALLBACK, async () => {
        // A stale buffered startup row cannot reopen a settled running generation (D12).
        if (this.ctx.container?.running === true && this.#admission() !== undefined) return;
        await this.#startContainer();

        if (this.#restoration.phase === 'unattached') throw new Error(this.#restoration.reason);
      });
    } finally {
      this.#trace('startup.callback.exit', { generation: this.#generation, ms: Date.now() - since, phase: this.#restoration.phase });
    }
  }

  /** All delivered startup doors share admission and destructive recovery. */
  async #startContainer(): Promise<void> {
    if (this.ctx.container?.running !== true
      && (this.#restoration.phase !== 'unstarted' || this.#gateRestore !== undefined)) {
      this.#invalidateGeneration();
    }

    const pending = this.#startup;

    if (pending?.generation === this.#generation) {
      this.#trace('startup.flight.join', { generation: pending.generation, sinceMs: Date.now() - pending.since });

      return await pending.run;
    }

    const since = Date.now();
    const generation = this.#generation;
    this.#trace('startup.flight.open', { generation, running: this.ctx.container?.running === true, phase: this.#restoration.phase });
    const run = this.#recoverAndStart();
    this.#startup = { generation, run, since };
    let settled = false;

    try {
      await run;
      settled = true;
    } finally {
      if (this.#startup?.run === run) this.#startup = undefined;
      this.#trace('startup.flight.exit', { generation, ms: Date.now() - since, settled, phase: this.#restoration.phase });
    }
  }

  async #recoverAndStart(): Promise<void> {
    const recovery = await this.ctx.storage.get<{
      readonly owner: string;
      readonly action: 'retry' | 'replace';
      readonly reason: string;
    }>(RECOVERY_ACTION_KEY);

    if (recovery !== undefined) {
      const claim = parseRecoveryRow(await this.ctx.storage.get(ATTACH_RECOVERY_KEY));

      if (claim.kind === 'row' && claim.row.owner === recovery.owner) {
        if (recovery.action === 'replace') {
          this.deleteSchedules(STARTUP_CALLBACK);
          await this.#replaceContainer(recovery.reason);
        } else {
          this.#invalidateGeneration(this.#startup);
          await this.stop('SIGTERM');
          await this.#awaitContainerStopped();
        }

        await this.ctx.storage.delete(RECOVERY_ACTION_KEY);

        if (recovery.action === 'replace') return;
      } else {
        // A successful successor retired the old recovery claim.
        await this.ctx.storage.delete(RECOVERY_ACTION_KEY);
      }
    }

    await this.#admitControlListener();
  }

  /** Instance allocation and control-listener proof are outside the hook budget. The window's timer
   *  is set outside the start block, so the hook disarms it first (D26). */
  async #admitControlListener(): Promise<void> {
    const generation = this.#generation;
    const since = Date.now();
    this.#trace('startup.admit.enter', { generation, running: this.ctx.container?.running === true });
    const window = new AbortController();
    const timer = setTimeout(() => { window.abort(); }, this.policy.portWaitMs);
    const disarm = (): void => { clearTimeout(timer); };

    this.#disarmAdmission = disarm;

    try {
      await this.startAndWaitForPorts({
        ports: this.defaultPort,
        cancellationOptions: {
          instanceGetTimeoutMS: this.policy.portWaitMs,
          portReadyTimeoutMS: this.policy.portWaitMs,
          waitInterval: ADMISSION_POLL_INTERVAL_MS,
          abort: window.signal,
        },
      });
      this.#trace('startup.admit.exit', { generation, ms: Date.now() - since, admitted: true, owned: this.#owns(generation) });
    } catch (cause) {
      const reason = describe({ cause });
      this.#trace('startup.admit.exit', {
        generation, ms: Date.now() - since, admitted: false, owned: this.#owns(generation),
        running: this.ctx.container?.running === true, reason,
      });

      // A superseded admission is a newer claim on this generation, not a failure to tolerate;
      // this branch only logs it and falls off the end.
      if (this.#owns(generation)) {
        const failure = classifyRecovery({ cause });
        await this.#record('attach', `[${failure} → retry] ${reason}`);

        if (this.#owns(generation)) await this.#arm(STARTUP_CALLBACK, 1);
      } else {
        console.error(`[devbox] superseded admission refused: ${reason}`);
      }
    } finally {
      disarm();

      if (this.#disarmAdmission === disarm) this.#disarmAdmission = undefined;
    }
  }

  /** Re-runs only the service half of a restoration that settled in `repair`, on the startup
   *  flight so two repairs cannot race process reservations, port exposures or the boot marker. */
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

      this.#startup = { generation, run, since: Date.now() };

      try {
        await run;
      } finally {
        if (this.#owns(generation) && this.#startup?.run === run) this.#startup = undefined;
      }
    });
  }

  /** Same-container repair: verify the boot stamp, then re-run only the service half.
   *  Writes no attach record: the full attach's record for this generation still applies. */
  async #repairAttachedAttempt(generation: number, retryBootStamp: boolean): Promise<void> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    if (!this.#owns(generation)) return;
    const actual = await this.#readBootId();

    if (!this.#owns(generation)) return;

    if (expected !== undefined && actual !== expected) {
      this.#invalidateGeneration();
      await this.#startContainer();

      return;
    }

    const steps = racedRestoreSteps(openStartBudget(this.policy.attachBudgetMs, this.startClock));
    steps.declare(2);
    const restored = await this.#restartWorkloads(generation, steps);

    if (!this.#owns(generation)) return;

    let stamped: StampOutcome = expected === undefined ? 'pending' : 'done';

    if (expected === undefined && retryBootStamp) {
      stamped = (await steps.run(async () => await this.#stampBootId(generation), () => undefined)).kind;
    }

    if (!this.#owns(generation)) return;
    await this.#settle(settledRestoration(restored, stamped));
  }

  /** Checked after every await that precedes a state write, an exposure, a cleanup,
   *  or the release of the single-flight entry. */
  #owns(generation: number): boolean {
    return this.#generation === generation;
  }

  /** Called only on evidence the container identity is gone or going. The bump makes every
   *  in-flight attempt state-inert: no readiness, attach failure, release or destroy. */
  #invalidateGeneration(recoveryFlight?: Flight): void {
    this.#generation += 1;
    this.#startup = recoveryFlight === undefined
      ? undefined
      : { generation: this.#generation, run: recoveryFlight.run, since: recoveryFlight.since };
    this.#restoration = { phase: 'unstarted' };
    this.#adoptionPending = false;
    // A standing settled row would let the next activation adopt a restoration it never ran.
    // Not awaited: the next adoption reads only after awaits of its own.
    void this.ctx.storage.delete(SETTLED_KEY)
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] settled phase was not cleared: ${describe({ cause })}`);
      });
    // A generation turnover means the container is gone or going, so its runtime directory is too;
    // the next command that stands in it must create it again.
    this.#runtimeDirReady = false;
  }

  /** A durable minted token identifies the attempt: the in-memory generation restarts at zero
   *  per isolate. Stage writes and the delete require this claim; the claim preserves the stage. */
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

  /** Writes the stage only while the row still names this attempt, re-read in one transaction;
   *  a stale write would resurrect a cleared ladder and replace a working container. */
  async #settleRecovery(
    claim: RecoveryClaim,
    generation: number,
    decision: ReturnType<typeof recoveryStep>,
    restoration: Extract<Restoration, { readonly phase: 'unattached' }>,
  ): Promise<boolean> {
    return await this.#ownedRecoveryWrite(
      claim,
      generation,
      async () => {
        await this.ctx.storage.transaction(async (transaction) => {
          await transaction.put(ATTACH_RECOVERY_KEY, recoveryRow(claim.token, decision.stage));
          await transaction.put(SETTLED_KEY, restoration);

          if (decision.action === 'retry' || decision.action === 'replace') {
            await transaction.put(RECOVERY_ACTION_KEY, {
              owner: claim.token, action: decision.action, reason: restoration.reason,
            });
          } else {
            await transaction.delete(RECOVERY_ACTION_KEY);
          }
        });
      },
    );
  }

  /** The only delete of the ladder row, and only by the owning attempt: a stage removed
   *  other than by success would let the next eviction restart a destructive ladder. */
  async #releaseRecovery(claim: RecoveryClaim, generation: number): Promise<boolean> {
    return await this.#ownedRecoveryWrite(claim, generation, async () => {
      await this.ctx.storage.delete(ATTACH_RECOVERY_KEY);
    });
  }

  /** Compare and write run inside `blockConcurrencyWhile` so a yield cannot re-stage a row a
   *  successful attempt deleted; owner token catches cross-isolate, generation same-isolate. */
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

  /** Recording, arming and destroying all wait on the conditional stage write, so a
   *  superseded attempt cannot file, re-arm or destroy on a newer generation's behalf. */
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

    // The tag leads: `recordIncident` truncates at INCIDENT_REASON_MAX_CHARS, and a long cause
    // chain would cut a trailing tag that the host's prose tells the agent to read.
    const reason = `[${failure} → ${decision.action}] ${describe(thrown)}`;
    const restoration = { phase: 'unattached', reason, retry: decision.action === 'retry' } as const;

    if (!await this.#settleRecovery(claim, generation, decision, restoration)) return;

    if (!this.#owns(generation)) return;
    // The arm below is one durable write from an isolate that may reset after the decision;
    // carrying the decision in `restoration` lets a later caller see a missing row and retry.
    this.#restoration = restoration;
    await this.#record('attach', reason);

    if (!this.#owns(generation)) return;

    if (decision.action === 'retry' || decision.action === 'replace') {
      await this.#arm(STARTUP_CALLBACK, this.policy.heartbeatSeconds);

      return;
    }

    this.deleteSchedules(STARTUP_CALLBACK);
  }

  /** Cancels exec work abandoned at the attach deadline; `destroy` acks before `running` flips. */
  async #replaceContainer(reason: string): Promise<void> {
    this.#invalidateGeneration(this.#startup);
    const replacing = this.#generation;

    try {
      await this.destroy();
      await this.#awaitContainerStopped();
    } catch (error) {
      if (!this.#owns(replacing)) throw error;
      // A failed destroy leaves the abandoned work running, so keep refusing even though
      // `#invalidateGeneration` made the box look ready; attaching over it is the overlap.
      await this.#settle({
        phase: 'unattached',
        reason: `${reason}; and the container identity could not be destroyed: `
          + describe({ cause: error }),
        // Terminal whatever the class: the abandoned work still runs in that container, so no retry;
        // only a caller asking by name may attach, else it overlaps the work destruction guarded.
        retry: false,
      });
      throw error;
    }

    console.error(
      '[devbox] the container identity was destroyed after a failed attach; a fresh one '
      + 'attaches on the next operation',
    );
  }

  /** `stop`/`destroy` ack before `container.running` flips; returning early lets a wake reuse
   *  the old mount. Count-bounded: a stop that never flips must refuse, not pin `#startup`. */
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

  /** Every durable process and port spec is required: a port is exposed only after its listener
   *  answers, none if a process failed; each failure is still recorded and the phase continues. */
  async #restartWorkloads(generation: number, steps: RestoreSteps): Promise<readonly string[]> {
    const [processes, ports] = await Promise.all([this.#procSpecs(), this.#portSpecs()]);
    const plan = restartPlan(processes, ports);
    // Every step is declared; the caller declares the boot stamp. Each allowance divides by the
    // work still to do, so a probe cannot spend its exposure's and the stamp's share.
    steps.declare(plan.start.length + plan.serve.length * 2);
    // The caller re-checks ownership before it reads any of this, so a
    // superseded walk stops where it is and its answer is discarded.
    const superseded = ['the attempt was superseded'];
    const down: string[] = [];

    for (const spec of plan.start) {
      if (!this.#owns(generation)) return superseded;

      // `super`, not the public override: that waits on `ensureReady()` and claims a lane, so the
      // restoration would wait for itself and could take a lane a gate-blocked caller holds.
      const started = await steps.run(
        async () => {
          // The walk is re-runnable (`attachNow()` repairs an incomplete restore), so a live process
          // under the id is reused: a second start would put two processes on one port.
          const existing = await super.getProcess(spec.processId);

          if (existing !== null && isProcessLive(existing.status)) return existing;

          return await super.startProcess(spec.command, {
            cwd: spec.cwd ?? DEVBOX_WORKDIR,
            processId: spec.processId,
            autoCleanup: false,
          });
        },
        logLate(`process ${spec.processId}`),
      );

      if (started.kind === 'done') continue;
      down.push(`process ${spec.processId} did not restart`);
      // The reservation stays whether the start threw or outran its allowance, so a later
      // attempt can retry it.
      await this.#record(
        'process',
        started.kind === 'failed'
          ? describe({ cause: started.cause })
          : `process ${spec.processId} did not start inside the restoration budget`,
        { processId: spec.processId },
      );
    }

    if (down.length > 0) {
      // A box missing any server publishes none of its URLs; this returns only after the whole
      // phase so every dead spec reaches the ledger first.
      return [...down, 'no port was exposed'];
    }

    for (const spec of plan.serve) {
      if (!this.#owns(generation)) return superseded;

      if (!await this.#awaitListener(spec.port, steps)) {
        down.push(`port ${spec.port} never answered`);
        await this.#record('port', `nothing listens on port ${spec.port} after restart`, {
          port: spec.port,
        });
        // A port that never answers skips its exposure and returns that allowance to the budget,
        // so later ports are not charged for its silence.
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

  async #awaitListener(port: number, steps: RestoreSteps): Promise<boolean> {
    // Bound each port's wait by the remaining restore budget as well as its own cap: per-port
    // caps alone let silent ports sum unbounded while callers wait in the readiness gate.
    const windowMs = Math.min(this.policy.portWaitMs, steps.remainingMs());
    const interval = this.policy.portProbeIntervalMs;

    const probed = await steps.run(
      async () => await this.#rawExec(
        awaitListenerCommand(port, Math.floor(windowMs / Math.max(1, interval)), interval),
      ),
      logLate(`the listener proof for port ${port}`),
    );

    // A step that was refused or abandoned proves nothing, and a port whose
    // listener was never proven is never exposed — the same answer silence gets.
    return probed.kind === 'done' && !healthProbeSilent(probed.value.stdout);
  }

  /** No preview host configured is not a failure: the box declares no previews rather than
   *  a URL that cannot resolve. */
  async #exposeWithSpec(spec: PortExposureSpec, steps: RestoreSteps): Promise<boolean> {
    const hostname = this.previewHost;

    if (hostname === undefined || hostname.length === 0) {
      console.log(`[devbox] port ${spec.port} not re-exposed: no preview host configured`);
      // The caller declared two steps per port before knowing no previews are published;
      // `skip` returns this declared-but-unrun share.
      steps.skip();

      return true;
    }

    const options: PortExposeOptions = { hostname, token: spec.token };

    if (spec.name !== undefined) options.name = spec.name;

    const exposed = await steps.run(
      // `super`: the restoration is the readiness gate, so it must not wait on that gate
      // nor queue behind a caller already waiting at it (see `#restartWorkloads`).
      async () => await super.exposePort(spec.port, options),
      logLate(`the exposure of port ${spec.port}`),
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

  /** Arm the only start coordinator. This method never touches the container. */
  async kickStartup(): Promise<void> {
    // A retryable unattach is pending work; an idle box has only this poll to re-arm a lost row.
    // Terminal classes stay unarmed: repeating refused work would storm the incident ledger.
    if (this.#startup !== undefined || this.#gateRestore !== undefined) return;
    const held = this.#restoration;

    // An attempt in flight owes nothing: it will settle into a phase, and this
    // poll's job is to notice a box with nobody working on it.
    if (held.phase === 'restoring') return;

    if (held.phase === 'attached' || held.phase === 'repair') return;

    if (held.phase === 'unattached' && !held.retry
      && await this.ctx.storage.get(RECOVERY_ACTION_KEY) === undefined) return;
    await this.#arm(STARTUP_CALLBACK, 1);
  }

  /** Requests may start a stopped box, then adopt the hook's settled generation (D26). */
  async resolveReadiness(): Promise<RestoreReadiness> {
    const wasRunning = this.ctx.container?.running === true;
    this.#trace('readiness.enter', { generation: this.#generation, running: wasRunning, phase: this.#restoration.phase });

    if (!wasRunning) await this.#startContainer();
    await this.#resolveAdoption();

    // Allocation can report running before the SDK opens onStart. The same
    // generation-owned coordinator covers that gap and still proves the port.
    if (wasRunning && this.#restoration.phase === 'unstarted') await this.#startContainer();
    const admission = this.#admission();

    if (admission !== undefined) return admission;

    await this.kickStartup();

    if (this.#restoration.phase === 'unattached' && !this.#restoration.retry) {
      throw new Error(
        `this devbox has no attached work directory: ${this.#restoration.reason}. `
        + 'That recovery class is terminal: call attachNow() to attempt the attach again.',
      );
    }

    return {
      kind: 'pending',
      reason: `this devbox is not ready: ${this.#unready() ?? 'the restoration has not settled'}. `
        + 'A startup is armed, so ask again.',
    };
  }

  /** Strict {@link resolveReadiness}: `pending` is a refusal, never permission. */
  async ensureReady(): Promise<RestoreAdmission> {
    const readiness = await this.resolveReadiness();

    if (readiness.kind === 'pending') throw new Error(readiness.reason);
    // Every operation route and only callers pass here (maintenance uses `#rawExec` and
    // scheduled callbacks), so file, port and process routes stamp the lease too (D18).
    this.stampInteraction();

    return readiness;
  }

  /** Stamps the lease for a caller on a lane it cannot see, e.g. a terminal; the host calls
   *  this only from its caller entry points. Refuses while unready, like every operation. */
  async noteTerminalActivity(): Promise<void> {
    await this.ensureReady();
    this.stampInteraction();
  }

  #admission(): RestoreAdmission | undefined {
    return admissionOf(this.#restoration);
  }

  /** Defaults cwd to `DEVBOX_WORKDIR`: commands landing outside the durable directory are
   *  not saved. A caller-supplied `cwd` overrides it. */
  override async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return await this.#withActiveCaller(async () => {
      await this.ensureReady();

      return await super.exec(command, { cwd: DEVBOX_WORKDIR, ...options });
    });
  }

  /** The only transition that clears a terminal refusal; keeps the `replace` stage, so a failed
   *  retry refuses again instead of destroying. Also re-runs an incomplete restoration. */
  async attachNow(): Promise<AttachOutcome> {
    this.stampInteraction();

    if (this.#restoration.phase === 'repair') {
      await this.#repairAttached(this.#generation);
    } else {
      if (this.#unready() !== undefined) {
        await this.#settle({ phase: 'unstarted' });
        await this.#startContainer();

        if (this.#admission() === undefined) {
          throw new Error(`this devbox is not ready: ${this.#unready() ?? 'the restoration has not settled'}`);
        }
      }

      await this.ensureReady();
    }

    return await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY)
      ?? { kind: 'empty', detail: 'this box has attached nothing' };
  }

  async checkpointNow(kind: CheckpointKind): Promise<CheckpointOutcome> {
    this.stampInteraction();
    await this.#healReplacedContainer();

    return await this.#checkpoint(kind);
  }

  /** Every checkpoint runs through here, so none interleave in storage (`createCheckpointLane`). */
  #checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    return this.#lane.run(kind, async () => await this.#withStorageMutation(async () => {
      const pending = this.#startup;

      // Waits for the startup to settle rather than racing it against a timer: a timer set here
      // would outlive into the start block and hold every timer its hook sets (D26).
      if (pending !== undefined && pending.generation === this.#generation) await pending.run;

      if (this.ctx.container?.running === true && this.#admission() === undefined) {
        return {
          kind: 'failed', reason: `this devbox is not ready: ${this.#unready()}`,
          bytes: undefined, movedBytes: undefined,
        };
      }

      const { sent, received } = this.#containerCommandBytes;
      const outcome = await this.#runCheckpoint(kind);

      this.#trace('checkpoint.bytes', {
        kind, outcome: outcome.kind, movedBytes: outcome.movedBytes,
        sentBytes: this.#containerCommandBytes.sent - sent, receivedBytes: this.#containerCommandBytes.received - received,
      });

      return outcome;
    }));
  }

  /** Stop order: checkpoint (a failed one refuses the stop), kill holders, detach, then stop;
   *  detach before stop fails EBUSY on any open fd, and the SDK session's cwd also holds it. */
  async quiesce(): Promise<CheckpointOutcome> {
    // A container call starts an instance to answer it, so a checkpoint here would run on a
    // fresh instance with no mount; the generation turns over instead.
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
    // A failed restoration admitted no caller and started no process, so nothing is lost; a final
    // checkpoint could wait on an abandoned restore, and the stop is the only way to cancel it.
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

    const decidedAt = Date.now();
    const outcome = await this.#checkpoint('quiesce');

    if (outcome.kind === 'failed') {
      await this.#record('checkpoint', `final checkpoint failed: ${outcome.reason ?? 'unknown'}`);

      return outcome;
    }

    // A caller admitted during the final checkpoint runs on the container this stop would kill;
    // refuse the stop, keep the checkpoint, let the next heartbeat decide (D18).
    const caller = this.#callerSince(decidedAt);

    if (caller !== undefined) {
      return {
        kind: 'failed',
        reason: `the stop is refused: ${caller}`,
        bytes: outcome.bytes,
        movedBytes: outcome.movedBytes,
      };
    }

    await this.#stopSync();
    await this.#releaseWorkdirHolders();
    await this.#detachStorage();
    this.#invalidateGeneration();
    await this.stop('SIGTERM');
    await this.#awaitContainerStopped();

    return outcome;
  }

  #callerSince(since: number): string | undefined {
    if (this.#activeCallers !== 0) return `${String(this.#activeCallers)} command(s) are executing`;

    if (this.#resources.busy()) return 'a resource lane is still claimed';
    const stamped = this.#lastInteraction;

    if (stamped !== undefined && stamped > since) return `a caller interacted ${String(Date.now() - stamped)} ms ago`;

    return undefined;
  }

  /** Kill live supervised processes via `killProcess`, not `stopSupervised`: that drops the spec,
   *  and the wake's restoration restarts exactly those specs. */
  async #releaseWorkdirHolders(): Promise<void> {
    if (this.ctx.container?.running !== true) return;

    for (const live of await this.listProcesses()) {
      if (!isProcessLive(live.status)) continue;

      try {
        await this.killProcess(live.id);
      } catch (error) {
        // A failed kill does not abort the stop: the holder scan below still catches, by pid,
        // whatever the process holds under the work directory.
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
      // A failed holder scan says nothing about the holders; proceeding to the detach would leave
      // the caller's later refusal with no names to act on. The error text arrives on stderr.
      throw new Error(
        `the holders of ${DEVBOX_WORKDIR} could not be released: `
        + `${released.stderr.trim() || released.stdout.trim() || `exit ${released.exitCode}`}`,
      );
    }

    this.#lastWorkdirHolders = parseWorkdirHolders(released.stdout);
  }

  /** Rethrows a still-busy refusal naming the holders the release pass found; the SDK's bare
   *  `fusermount` busy error names nothing a caller could act on. */
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

  /** An in-flight restore writes nothing durable after this, and no tick publishes after the
   *  discard; a stopped box never starts an instance to clean. */
  async discardState(): Promise<void> {
    this.#invalidateGeneration();
    await this.#stopSync();
    await this.#requireStorage().discard();
    // The attach evidence describes the discarded bytes, so it is deleted with them.
    await this.ctx.storage.delete(LAST_ATTACH_KEY);
  }
  /** Totals say how many failures were filed; only these reasons say what they were.
   *  Bounded by the ledger cap. */
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

  /** Durable spec row is written before the process starts and is idempotent on (command, cwd):
   *  a re-issue restarts under the same id; a failed start keeps the row for `stopSupervised`. */
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

  /** The spec goes only on a confirmed kill or PROCESS_NOT_FOUND; any other failure keeps it,
   *  since it alone names the process and restoration walks specs to retry that id. */
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

  /** A spec with no live row is not running: restoration has not started it yet, or its start
   *  failed and was recorded. */
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

  /** Must be asked before the first exposure: restarts re-expose each port with its stored
   *  token, so the first exposure must use the same token for the preview URL to survive. */
  async portToken(port: number, name?: string): Promise<{ urlToken: string }> {
    return await this.#resources.run(portScope(port), () => this.#portToken(port, name));
  }

  /** Runs on the port's claim, not gated on readiness: the token must be mintable before the
   *  exposure it names; minting and removing the same row share the claim so URL and manifest agree. */
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

  #unready(): string | undefined {
    return unreadyOf(this.#restoration, this.#gateRestore !== undefined);
  }

  /** Answers without attaching storage. A poll may reactivate a stopped container so its
   *  scheduled startup can run, but never drives that startup inline. */
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
      ready: this.#restoration.phase === 'attached' && this.#gateRestore === undefined,
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
      flights: {
        startupMs: this.#startup === undefined ? null : Date.now() - this.#startup.since,
        hookMs: this.#gateRestore === undefined ? null : Date.now() - this.#gateRestore.since,
      },
      wire: { ...this.#containerCommandBytes },
    };
  }

  // Overrides claim resources, THEN await `ensureReady`, THEN call super; hold no handle across
  // awaits. Restoration never claims (uses `super.*`): a claim there deadlocks against callers.

  /** The `encoding: 'none'` stream returns before a byte is read; the claim lasts until drain,
   *  error or cancel. Overloads derive from `ReadArms` so an SDK overload change fails `tsc`. */
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

    return await this.#claimed(scopes, () => super.readFile(path, options));
  }

  /** The file stays claimed until the stream's bytes are drained, not until this resolves. */
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
    return await this.#claimed(
      pathScopes({ path, membership: true }),
      () => super.writeFile(path, content, options),
    );
  }

  /** `deleteFile` claims the subtree: a path can't reveal it is a directory, and a
   *  plain file's subtree costs nothing since no operation can name a path beneath one. */
  override async deleteFile(path: string, sessionId?: string) {
    return await this.#claimed(
      pathScopes({ path, membership: true, recursive: true }),
      () => super.deleteFile(path, sessionId),
    );
  }

  override async renameFile(oldPath: string, newPath: string, sessionId?: string) {
    return await this.#claimed(
      this.#movedScopes(oldPath, newPath),
      () => super.renameFile(oldPath, newPath, sessionId),
    );
  }

  override async moveFile(sourcePath: string, destinationPath: string, sessionId?: string) {
    return await this.#claimed(
      this.#movedScopes(sourcePath, destinationPath),
      () => super.moveFile(sourcePath, destinationPath, sessionId),
    );
  }

  #claimed<Result>(scopes: readonly ResourceScope[], operation: () => Promise<Result>): Promise<Result> {
    return this.#resources.run(scopes, async () => {
      await this.ensureReady();

      return await operation();
    });
  }

  /** Both ends of a move are claimed as ONE set, so a move never holds one end while
   *  waiting for the other and no acquisition order exists to get wrong. */
  #movedScopes(from: string, to: string) {
    return [
      ...pathScopes({ path: from, membership: true, recursive: true }),
      ...pathScopes({ path: to, membership: true, recursive: true }),
    ];
  }

  override async mkdir(path: string, options?: { recursive?: boolean; sessionId?: string }) {
    // A recursive mkdir really can add an entry to every directory above it, so
    // it is the one operation that claims the whole chain rather than the parent.
    return await this.#claimed(
      pathScopes({ path, membership: true, ancestors: options?.recursive === true }),
      () => super.mkdir(path, options),
    );
  }

  override async listFiles(path: string, options?: ListFilesOptions) {
    return await this.#claimed(
      pathScopes({ path, recursive: options?.recursive === true }),
      () => super.listFiles(path, options),
    );
  }

  override async exists(path: string, sessionId?: string) {
    return await this.#claimed(pathScopes({ path }), () => super.exists(path, sessionId));
  }

  override async exposePort(
    port: number,
    options: { name?: string; hostname: string; token?: string },
  ) {
    return await this.#claimed(portScope(port), () => super.exposePort(port, options));
  }

  /** Revocation touches only this object's preview rows, never the container, so it skips
   *  readiness: a port must stay revocable on a box that is not attached. */
  override async unexposePort(port: number): Promise<void> {
    return await this.#resources.run(portScope(port), () => super.unexposePort(port));
  }

  /** Schedule rows are one-shot and the alarm loop deletes a row whose callback throws, so a
   *  throw re-arms at `retrySeconds`; only a `null` from `body` ends the chain. */
  async #scheduled(
    callback: string,
    retrySeconds: number,
    body: () => Promise<number | null>,
  ): Promise<void> {
    let nextSeconds: number | null = retrySeconds;
    const since = Date.now();
    this.#trace('schedule.enter', { callback, running: this.ctx.container?.running === true });

    await this.#dispatch(callback, async () => {
      try {
        nextSeconds = await body();
      } catch (error) {
        console.error(`[devbox] scheduled ${callback} failed: ${describe({ cause: error })}`);
      }

      this.#trace('schedule.exit', { callback, ms: Date.now() - since, nextSeconds: nextSeconds ?? undefined });

      if (nextSeconds !== null) await this.#arm(callback, nextSeconds);
    });
  }

  /** The SDK's alarm loop, traced at its edges: a loop that stops firing is
   *  otherwise indistinguishable from one whose callbacks never became due. */
  override async alarm(alarmProps?: AlarmInvocationInfo): Promise<void> {
    const since = Date.now();
    this.#trace('alarm.enter', { running: this.ctx.container?.running === true, retry: alarmProps?.isRetry === true });

    try {
      await super.alarm(alarmProps);
    } finally {
      this.#trace('alarm.exit', { ms: Date.now() - since, running: this.ctx.container?.running === true });
    }
  }

  /** Failures go to both the strategy record and an incident: the alarm loop reduces a thrown
   *  callback to a console line. Not re-armed while down; waking a container would keep it alive. */
  async devboxCheckpoint(): Promise<void> {
    // The ambient schedule is this row's only writer; with it disabled the row is never armed,
    // so a call here is stray and ending the chain keeps nothing ticking the host didn't ask for.
    if (!this.ambientCheckpoints || this.#syncsInContainer()) return;
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

  /** Never calls `stampInteraction()`: a box's own maintenance traffic is not use.
   *  Quiesce needs all three gates and quiet confirmed across heartbeats; a stopped container
   *  arms no successor, its next start does. */
  async devboxHeartbeat(): Promise<void> {
    const beat = this.policy.heartbeatSeconds;
    await this.#scheduled(HEARTBEAT_CALLBACK, beat, async () => {
      // `isActivityExpired()` reads `sleepAfterMs`, which only `renewActivityTimeout()` moves;
      // a ping alone lets it expire and end the SDK alarm chain. No interaction stamp here.
      this.renewActivityTimeout();

      if (this.ctx.container?.running !== true) {
        // The last tick records when the stop was noticed.
        await this.#tick({ running: false, ping: 'skipped', armedNext: false });

        return null;
      }

      await this.#resolveAdoption();
      const settled = this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair';

      if (!settled) {
        await this.#tick({ running: true, ping: 'unready', armedNext: true });
        await this.kickStartup();

        return beat;
      }

      let observed: string | undefined;
      let syncAlive: boolean;

      try {
        // The boot-id read is the liveness ping too: one container call, not two (D28).
        ({ bootId: observed, syncAlive } = await this.#readBeat());
      } catch (error) {
        const reason = describe({ cause: error });
        console.error(`[devbox] heartbeat ping failed: ${reason}`);
        await this.#tick({ running: true, ping: `failed: ${reason}`, armedNext: true });

        return beat;
      }

      // Replacement check runs only on a settled restoration: the stamp is a restoration's last step,
      // so mid-wake the row and fresh instance always mismatch; an in-flight attempt owns its identity.
      if (await this.#containerWasReplaced({ bootId: observed })) {
        this.#invalidateGeneration();
        await this.#tick({ running: true, ping: 'ok', armedNext: true, replaced: true });
        await this.kickStartup();

        return beat;
      }

      if (!syncAlive && this.#restoration.phase === 'attached') {
        // Nothing commits while it is down, so its death is an incident, not only a restart.
        await this.#record('checkpoint', 'the container\'s sync had stopped, so nothing was committed since; restarting it');
        await this.#restartSync();
      }

      const now = Date.now();

      // Each busy lane covers its own tail: claims include draining streams, checkpoints queued runs,
      // startup restore/repair; shell commands and supervised starts count only via `#activeCallers`.
      let backgroundWork = this.#activeCallers !== 0
        || this.#resources.busy()
        || this.#lane.busy()
        || this.#startup !== undefined
        || this.#gateRestore !== undefined;

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

  /** SDK activity expiry: checkpoint first, since the disk is readable only until the base stop.
   *  A failed checkpoint does not block the stop; the alarm chain is ending, so refusing loses both. */
  override async onActivityExpired(): Promise<void> {
    const outcome = await this.#checkpoint('quiesce');
    await this.#stopSync();
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

  /** One durable row per heartbeat, so a stopped box shows when and why: it tells apart an
   *  alarm that never fired, a tick that returned early, and a ping that did not renew. */
  async #tick(input: Omit<HeartbeatTick, 'at'>): Promise<void> {
    await this.ctx.storage.put(LAST_TICK_KEY, { ...input, at: Date.now() } satisfies HeartbeatTick);
  }

  /** Public because `Container.schedule` calls back by name; the delivery policy is `incidents.ts`. */
  async devboxIncidents(): Promise<void> {
    const firstRetry = Math.max(1, Math.ceil(incidentRetryDelayMs(0) / 1000));
    await this.#scheduled(INCIDENT_CALLBACK, firstRetry, async () =>
      await deliverIncidents(this.ctx.storage, async (incident, attempt) =>
        await this.onIncident(incident, attempt)));
  }

  /** Caller-facing operations only: a scheduled callback stamping it would keep the box awake.
   *  `Sandbox` renews its own clock on every control RPC, internal traffic included, so the
   *  durable stamp lives here and never in `renewActivityTimeout`, or the idle gate never opens. */
  protected stampInteraction(): void {
    this.renewActivityTimeout();
    const now = Date.now();
    this.#lastInteraction = now;

    if (now - this.#lastInteractionPersisted < INTERACTION_PERSIST_INTERVAL_MS) return;
    this.#lastInteractionPersisted = now;
    // Not awaited on this hot path: the in-memory stamp already renewed this incarnation,
    // so a lost write costs at most one extra heartbeat cycle of lease, never a leak.
    void this.ctx.storage.put(LAST_INTERACTION_KEY, now)
      .catch((cause: LateStartFailure['cause']) => {
        console.error(`[devbox] lease stamp was not persisted: ${describe({ cause })}`);
      });
  }

  /** Commands and supervised starts have no resource lane (no safe scope / no process yet),
   *  so this counter keeps them live to the heartbeat from call entry through settlement. */
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

  /** Files the incident, then arms its delivery (`recordIncident`). */
  async #record(
    stage: IncidentStage,
    reason: string,
    extra?: { readonly processId?: string; readonly port?: number },
  ): Promise<void> {
    await recordIncident(this.ctx.storage, stage, reason, extra);
    await this.#arm(INCIDENT_CALLBACK, Math.ceil(incidentRetryDelayMs(0) / 1000));
  }

  #requireStorage(): DevboxStorage {
    this.#storage ??= this.#buildStorage();

    return this.#storage;
  }

  /** An ephemeral box (no store) gets a storage that reports empty/skipped on every call,
   *  so callers never null-check it. */
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

  /** The Durable Object id is already hex and unique per box, so the prefix needs no escaping
   *  and cannot collide with another box's prefix. */
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

        return { status: checked.status, version: checked.version };
      },
      exec: async (command) => await this.#rawExec(command, DEVBOX_RUNTIME_DIR),
      stamp: (phase) => this.#stampPhase(phase),
      containerGeneration: async () => await this.#readBootId(),
      storeRoot: () => chainStoreRoot(this.#boxPrefix()),
      storeObjectUrl: (key) => storeObjectUrl(chainStoreRoot(this.#boxPrefix()), store.binding, key),
      mountStore: async (at) => {
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
          // The SDK throws for a path its registry never held, the ordinary case; the patched SDK
          // releases a held path with no mount. Nothing here may fail the next mount.
          console.log(`[devbox] store mount at ${at} was not released: ${describe({ cause: error })}`);
        }
      },
      ...seedStampPorts(async (command) => await this.#rawExec(command, DEVBOX_RUNTIME_DIR)),
      objectFacts: async (key) => {
        // R2 `digest` exists only when R2 was given a checksum (s3fs and multipart supply none),
        // so a chain layer's digest is normally absent; `objectVersion` is always present.
        const head = await store.bucket.head(key);

        if (head === null) return undefined;
        const sha256 = head.checksums.sha256;

        return {
          bytes: head.size,
          digest: sha256 === undefined ? undefined : Buffer.from(sha256).toString('hex'),
          objectVersion: head.version,
        };
      },
      deleteObjects: async (keys) => {
        await store.bucket.delete([...keys]);
      },
      // Calls `super.listFiles`, not the public override: that waits on `ensureReady`, which stamps
      // the lease, so a checkpoint would count as a caller and refuse its own stop (D18).
      countEntries: async (dir) => (await super.listFiles(dir)).files.length,
      restoreExtract: async (backup) => await this.restoreBackup(backup),
      // The SDK's `BackupOptions` takes a mutable `excludes`; a shared constant must stay readonly.
      createExtractSnapshot: async (options) => await this.createBackup({
        ...options, excludes: options.excludes === undefined ? undefined : [...options.excludes],
      }),
      now: () => Date.now(),
      log: (message) => {
        console.log(`[devbox] ${message}`);
      },
    };
  }

  /** Internal commands bypass public readiness; startup has already proved the control listener. */
  async #rawExec(
    command: string,
    cwd = DEVBOX_WORKDIR,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // The session shell chdirs before running, so a command from an uncreated `DEVBOX_RUNTIME_DIR`
    // never runs; create it once per container with `mkdir -p` from the work directory.
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
    this.#meter(command, result.stdout, result.stderr);

    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  /** Per-instance and reset with the generation: a replacement container's disk
   *  holds none of our runtime directory (P1). */
  #runtimeDirReady = false;

  readonly #containerCommandBytes = { sent: 0, received: 0 };

  #meter(sent: string, ...received: readonly string[]): void {
    this.#containerCommandBytes.sent += Buffer.byteLength(sent);

    for (const text of received) this.#containerCommandBytes.received += Buffer.byteLength(text);
  }

  async #procSpecs(): Promise<readonly SupervisedProcessSpec[]> {
    return [...(await this.ctx.storage.list<SupervisedProcessSpec>({ prefix: PROC_SPEC_PREFIX })).values()];
  }

  async #portSpecs(): Promise<readonly PortExposureSpec[]> {
    return [...(await this.ctx.storage.list<PortExposureSpec>({ prefix: PORT_SPEC_PREFIX })).values()];
  }

  /** Idempotent: `onStart` fires at least once per container start (D14). A callback dispatching
   *  its own row looks past it; any other caller counts a due row, because it is still owed and
   *  arming beside it moves the alarm away (D14). */
  async #arm(callback: string, delaySeconds: number): Promise<void> {
    if (!needsArming(await this.listSchedules(callback), Date.now() / 1000, this.#dispatching.has(callback))) return;
    await this.schedule(delaySeconds, callback, null);
  }

  readonly #dispatching = new Set<string>();

  /** Run one scheduled callback's body with its name marked as dispatching,
   *  so the row still in the table under it is read as its own. */
  async #dispatch<T>(callback: string, body: () => Promise<T>): Promise<T> {
    this.#dispatching.add(callback);

    try {
      return await body();
    } finally {
      this.#dispatching.delete(callback);
    }
  }
}

/** A concrete class spreads this into its `outboundHandlers`: the registry is keyed by class name,
 *  and the handler finds the box from `ctx.containerId`. */
export function devboxSyncHandlers<E>(namespaceOf: (env: E) => DurableObjectNamespace<Devbox<E>>) {
  return {
    [DEVBOX_SYNC_HANDLER]: async (request: Request, env: E, ctx: { readonly containerId: string }): Promise<Response> => {
      if (request.method !== 'POST') return new Response(`POST only on ${DEVBOX_SYNC_HOST}`, { status: 405 });
      const namespace = namespaceOf(env);
      const reply = await namespace.get(namespace.idFromString(ctx.containerId)).devboxSync(await request.text());

      return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
  };
}
