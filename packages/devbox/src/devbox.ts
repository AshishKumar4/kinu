/** Native container owner: start, restore and admission share one generation. */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { Files, SandboxFileError } from '@cloudflare/sandbox';
import { Processes, CONTAINER_TRUST_ENV } from "./processes";
import { nativeStartClock } from './native-clock';
import type { DevboxExecOptions, ExecResult, ReadOptions, FileResult, ListFilesOptions, ListedFile, GatewayBindings } from './contracts';
import { NativeArchives } from './native-archives';
import { ContainerRoutes, type OutboundPolicy } from './gateway';
import { terminalSocket, resetTerminal } from './terminal';
import { Effect, Result } from 'effect';

import {
  DEFAULT_DEVBOX_POLICY,
  generatePortToken,
  healthProbeSilent,
  describeThrown as describe,
  type LateStartFailure,
  incidentRetryDelayMs,
  createCheckpointLane,
  createResourceLane,
  heldUntilDrained,
  pathScopes,
  portScope,
  processScope,
  admissionStep,
  classifyRecovery,
  isTerminalRecovery,
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
  racedRestoreSteps, runRestoreStep, type RestoreSteps,
  type StartClock,
} from './lifecycle';
import { DevboxError, attempt, attemptSync, settle, settleSync, startOverrun, startInterrupted, chainAdvanced, type DevboxErrorCode } from './errors';
import { BOX_SIZE_ORDER, BoxSizeSchema, DEFAULT_BOX_SIZE, instanceOf, type BoxSize, type ResizeOutcome } from './sizes';
import type { RestorePhase, RestorePhaseStamps } from './durability/contracts';
import {
  admissionOf, isSettledRestoration, recoveryRow, refusedStart, settledRestoration, terminalRefusal, unreadyOf,
  type RecoveryClaim, type RestoreAdmission, type RestoreClockPhase, type RestoreReadiness, type RestoreStatus,
  type Restoration, type SettledRestoration, type StampOutcome, type StartInputs,
} from './restoration';
import type { DevboxReport, HeartbeatTick, IncidentReasonRow, SupervisedProcessRow } from './report';
import {
  deliverIncidents, INCIDENT_PREFIX, incidentTotals, recordIncident,
  type IncidentRow,
} from './incidents';
import {
  CHAIN_EXCLUDES,
  upperFingerprintCommand,
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
 *  attempt, and `#armStartup` early-returns on a pinned attempt, so nothing re-arms. */
const CONTAINER_STOP_ATTEMPTS = 50;

interface UntimedExecution {
  cancelled: boolean;
  started?: Promise<ExecProcess>;
}

/** The SDK's `killCommand` (D37). */
const KILL_TREE = `
tree() { for c in $(cat /proc/$1/task/$1/children 2>/dev/null); do tree "$c"; done; [ -d /proc/$1 ] && echo "$1"; }
alive() { for p in $1; do [ -d /proc/$p ] && ! grep -q '^State:[[:space:]]*Z' /proc/$p/status 2>/dev/null && return 0; done; return 1; }
first=$(tree "$1")
alive "$first" || exit 3
kill -TERM $first 2>/dev/null
i=0
while [ $i -lt 50 ] && alive "$first"; do sleep 0.1; i=$((i + 1)); done
alive "$first" || exit 0
kill -KILL $first $(tree "$1") 2>/dev/null
exit 0
`;

const KILL_TREE_GONE = 3;

/** `port-listeners STAMP [PORT...]`: `port pid stamp command` per socket holder; /proc, as the image has no `ss`. */
const PORT_LISTENERS = `
stamp=$1; shift
socks=$(for f in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$f" ] || continue
  while read -r _ local _ st _ _ _ _ _ inode _; do
    [ "$st" = 0A ] || continue
    port=$((0x\${local##*:}))
    if [ $# -eq 0 ]; then echo "$inode $port"; else for want in "$@"; do [ "$port" = "$want" ] && echo "$inode $port"; done; fi
  done < "$f"
done)
[ -n "$socks" ] || exit 0
holders=$(ls -l /proc/[0-9]*/fd 2>/dev/null | awk '/^\\/proc\\/[0-9]+\\/fd:$/ { split($0, p, "/"); pid = p[3]; next } /-> socket:\\[/ { s = $NF; gsub(/socket:\\[|\\]/, "", s); print s, pid }')
stampof() {
  p=$1
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    v=$(tr '\\000' '\\n' < "/proc/$p/environ" 2>/dev/null | grep -m1 "^$stamp=")
    [ -n "$v" ] && { printf '%s' "\${v#*=}"; return; }
    p=$(awk '/^PPid:/ { print $2 }' "/proc/$p/status" 2>/dev/null)
  done
}
echo "$socks" | while read -r inode port; do
  echo "$holders" | awk -v i="$inode" '$1 == i { print $2 }' | sort -un | while read -r pid; do
    printf '%s\\t%s\\t%s\\t%s\\n' "$port" "$pid" "$(stampof "$pid")" "$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  done
done
`;

export interface PortListener {
  readonly port: number;
  readonly pid: number;
  readonly stamp: string | null;
  readonly command: string;
}

const ListenerLineSchema = v.pipe(v.string(), v.transform((line) => line.split('\t')), v.tuple([
  v.pipe(v.string(), v.toNumber(), v.integer()),
  v.pipe(v.string(), v.toNumber(), v.integer()),
  v.string(),
  v.string(),
]));

function parsePortListeners(output: string): PortListener[] {
  return output.split('\n').filter((line) => line !== '').map((line) => {
    const [port, pid, stamp, command] = v.parse(ListenerLineSchema, line);

    return { port, pid, stamp: stamp === '' ? null : stamp, command: command.trimEnd() };
  });
}

const CONTAINER_STOP_INTERVAL_MS = 100;


/** All durable keys share the `devbox:` prefix so a host's own keys cannot collide with them. */
const STORAGE_KEY = 'devbox:storage-state';

const PROC_SPEC_PREFIX = 'devbox:proc:';

const PORT_SPEC_PREFIX = 'devbox:port:';

const LAST_ATTACH_KEY = 'devbox:last-attach';

/** Recovery progress for one container identity: written only by the recovery ladder, deleted
 *  on the first landed attach; durable because a fresh object often runs the scheduled retry. */
const ATTACH_RECOVERY_KEY = 'devbox:attach-recovery';

const LAST_TICK_KEY = 'devbox:last-tick';

const UNREADABLE_PROCESS_BEATS_KEY = 'devbox:unreadable-process-beats';

const BOOT_ID_KEY = 'devbox:boot-id';

/** Persisted so a mid-restore object reset is survivable; a stored `restoring` phase needs recovery.
 *  Generation turnover clears the row, so a stale phase cannot admit a different container. */
const SETTLED_KEY = 'devbox:restoration';

const REPLACED_COUNT_KEY = 'devbox:replaced-count';

/** Idle origin for a box no caller has used. */
const STARTED_AT_KEY = 'devbox:started-at';

const SIZE_KEY = 'devbox:size';

const DEFAULT_SIZE_KEY = 'devbox:default-size';

const RUNNING_SIZE_KEY = 'devbox:running-size';

const START_REFUSED_KEY = 'devbox:start-refused';

const NO_START_IMAGE = 'no image to start: name it `devbox` in the container `images` map';

/** Scheduled-callback names. Each MUST name a public method on the class:
 *  `Container.schedule` rejects anything it cannot call back. */
const STARTUP_CALLBACK = 'devboxStartup';

const CHECKPOINT_CALLBACK = 'devboxCheckpoint';

const HEARTBEAT_CALLBACK = 'devboxHeartbeat';

const INCIDENT_CALLBACK = 'devboxIncidents';

/** Rows a destroyed box neither keeps nor arms. */
const CONTAINER_CALLBACKS: readonly string[] = [STARTUP_CALLBACK, HEARTBEAT_CALLBACK, CHECKPOINT_CALLBACK];

/** A classified recovery obligation; executed outside the restore block. */
const RECOVERY_ACTION_KEY = 'devbox:recovery-action';


/** The in-memory interaction stamp serves this activation; throttled writes preserve it
 *  across eviction without a durable write per call. */
const INTERACTION_PERSIST_INTERVAL_MS = 30_000;

function isProcessLive(status: string): boolean {
  return status === 'starting' || status === 'running';
}

/** A restore step's `onLate`: the race already answered `late`, so its eventual outcome is only logged. */
function logLate(step: string): (failure: LateStartFailure) => void {
  return (failure) => {
    console.error(`[devbox] ${step} outran its allowance; it later settled with: ${describe({ cause: failure.cause })}`);
  };
}

interface PortExposeOptions {
  hostname: string;
  token: string;
  name?: string;
}

interface RestoreClock {
  readonly openedAt: number;
  stamps: RestorePhaseStamps;
}


/** One attempt in flight and when it opened, so a report can say how long a
 *  box has been waiting on it rather than only that it is. */
interface Flight {
  readonly generation: number;
  readonly run: Promise<void>;
  readonly since: number;
}

function unawaited(work: Promise<unknown>, lost: string): void {
  void work.catch((cause: LateStartFailure['cause']) => {
    console.error(`[devbox] ${lost}: ${describe({ cause })}`);
  });
}

function fileFault(failure: DevboxError): DevboxError {
  const error = failure.cause;

  if (!SandboxFileError.is(error)) return failure;
  failure.cause = { kind: 'devbox.file', code: error.code, path: error.path, operation: error.operation, cause: error };

  return failure;
}

const DESTROYED_START = 'this devbox was destroyed; only a caller or a host starts it again';

const DESTROYED_AFTER_ARRIVAL = 'this devbox was destroyed after this request arrived, so the request did not run';

const QUIESCING = 'this devbox is quiescing; this request was not admitted';

export interface DevboxState extends DurableObjectState {
  readonly exports: DurableObjectState['exports'] & GatewayBindings;
}

const SCHEDULE_PREFIX = 'devbox:schedule:';

const EXPOSED_PREFIX = 'devbox:exposed:';


export class Devbox<Env = unknown> extends DurableObject<Env> {
  readonly #gateways: GatewayBindings;
  #storage: DevboxStorage | undefined;
  #gateRestore: Flight | undefined;
  /** Fences every write below: an abandoned startup continuation keeps running, and must
   *  re-check this token after every await or it can clear its successor's single-flight entry. */
  #generation = 0;
  /** A caller joins the attempt only while its generation still matches: a superseded
   *  attempt's result is already discarded. */
  #startup: Flight | undefined;
  /** `destroy` cancels and awaits these. */
  readonly #admissions = new Set<{ readonly abort: () => void; readonly settled: Promise<void> }>();
  #refused: { readonly generation: number; readonly reason: string } | undefined;
  /** Set by `destroy`, cleared by a caller or a host (D36). */
  #closed = false;
  #teardowns = 0;
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
  #callersDrained: { promise: Promise<void>; resolve: () => void } | undefined;
  #quiescing: Promise<CheckpointOutcome> | undefined;
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

  constructor(ctx: DevboxState, env: Env) {
    super(ctx, env);
    this.#gateways = ctx.exports;
    this.#activate();
  }

  /** Constructor work is two synchronous storage reads, so no event waits on it; it does not yet
   *  have control-port proof. */
  #activate(): void {
    if (this.ctx.container?.running !== true) return;
    this.#adoptionPending = this.#durableClaim() !== undefined;
    const settled = this.ctx.storage.kv.get<SettledRestoration>(SETTLED_KEY);

    if (settled?.phase === 'unattached' && isSettledRestoration(settled)) {
      // Refusal is safe to retain even when identity stamping failed.
      this.#restoration = settled;
    }
  }

  #durableClaim(): { readonly expected: string; readonly settled: SettledRestoration } | undefined {
    const expected = this.ctx.storage.kv.get<string>(BOOT_ID_KEY);
    const settled = this.ctx.storage.kv.get<SettledRestoration>(SETTLED_KEY);

    if (expected === undefined || !isSettledRestoration(settled)) return undefined;

    return { expected, settled };
  }

  /** Memory can name `attached` for a replaced container, so every reader settles adoption first. */
  async #resolveAdoption(): Promise<void> {
    if (this.#gateRestore !== undefined) return;

    if (this.#adoptionPending) await this.#startContainer();
  }

  /** Turnover needs a container answer that refutes the stamped boot id; absent rows prove nothing
   *  (`#settle` sets memory before writing). Not timed: a clock here would overwrite the restore's row. */
  async #adoptOrTurnOver(): Promise<void> {
    const generation = this.#generation;
    this.#adoptionPending = false;
    const claim = this.#durableClaim();

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

  /** The incident is already durable, so a throw is transient and retried by schedule;
   *  return `rejected` only for a malformed incident, which is a defect and never retried. */
  protected onIncident(incident: DevboxIncident, delivery: number): Promise<IncidentDisposition> {
    console.error(
      `[devbox] incident ${incident.incidentId} at ${incident.stage} `
      + `(delivery attempt ${delivery}): ${incident.reason}`,
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
    return nativeStartClock(this.#container());
  }

  start(): Promise<void> {
    return settle(this.#reopening(async () => {
      this.ctx.storage.kv.delete(START_REFUSED_KEY);
      await this.#startContainer();
    }));
  }

  /** A caller asking reopens a destroyed box once a quiesce in flight has settled. */
  #reopening(work: () => Promise<void>): Effect.Effect<void, DevboxError> {
    const arrived = this.#teardowns;

    return Effect.gen({ self: this }, function* () {
      yield* this.#afterQuiesce(arrived, 'io');
      this.#closed = false;
      yield* attempt('io', work);
    });
  }

  /** Waits out a quiesce in flight; a teardown while it waited refuses the ask, which arrived
   *  before that teardown (D36). */
  #afterQuiesce(arrived: number, code: DevboxErrorCode): Effect.Effect<void, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const quiescing = this.#quiescing;

      if (quiescing !== undefined) yield* attempt(code, () => quiescing);

      if (arrived !== this.#teardowns) return yield* Effect.fail(new DevboxError('io', DESTROYED_AFTER_ARRIVAL));
    });
  }

  async #startNative(inputs: StartInputs): Promise<void> {
    if (this.#closed) throw new DevboxError("io", DESTROYED_START);
    const container = this.#container();
    const generation = this.#generation;
    // No await separates teardown admission from the platform start. Native exec never starts one.
    const wasRunning = container.running;

    if (!wasRunning) {
      // D50: the one start boundary.
      this.ctx.storage.kv.put(RUNNING_SIZE_KEY, inputs.size);
      container.start({ image: inputs.image, instance: instanceOf(inputs.size), enableInternet: this.enableInternet });
      this.#routes().started();
    }

    const cancel = new AbortController();

    const run = (async () => {
      const ready = await container.exec(['/bin/true'], { signal: cancel.signal });
      const result = await ready.output();

      if (result.exitCode !== 0) throw new DevboxError("io", `native container admission exited ${result.exitCode}`);

      if (!this.#owns(generation) || this.#closed) return;
      await this.configureContainer(wasRunning && (this.#adoptionPending || this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair'));

      if (!this.#owns(generation) || this.#closed) return;
      await this.ctx.blockConcurrencyWhile(() => this.#restoreInStartGate());
    })();

    const admission = { abort: () => cancel.abort(), settled: run };
    this.#admissions.add(admission);

    try {
      await run;
    } finally {
      this.#admissions.delete(admission);
    }
  }

  /** Joins a re-entered hook; adopts a settled boot without re-attaching. */
  async #restoreInStartGate(): Promise<void> {
    if (this.#closed) {
      this.#trace('startup.hook.closed', { generation: this.#generation });

      return;
    }

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
          await this.#recover(generation, claim, { cause: startInterrupted() });

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
        ? startOverrun('Devbox.onStart', budgetMs)
        : result.cause;

      if (clock !== undefined) this.#settleClock(clock);
      this.#invalidateGeneration();

      if (attached) {
        const reason = `[deadline -> repair] restoration did not settle inside the ${budgetMs}ms hook budget`;
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

    if (this.#admission() !== undefined) {
      this.#deleteSchedule(STARTUP_CALLBACK);
      await this.ctx.storage.put(STARTED_AT_KEY, Date.now());
    }
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

  /** The startup row goes through `#armStartup`, not a bare `#arm`: a box with nothing restored
   *  would otherwise arm a successor every second; `#arm` is future-only for periodic rows. */
  async #armContainerSchedules(): Promise<void> {
    await this.#armStartup();

    if (this.ambientCheckpoints && !this.#syncsInContainer()) {
      await this.armAlarm(CHECKPOINT_CALLBACK, Math.ceil(this.policy.checkpointIntervalMs / 1000));
    }

    await this.armAlarm(HEARTBEAT_CALLBACK, this.policy.heartbeatSeconds);
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
    await this.#armStartup();
    throw new DevboxError("io", 'this devbox is not ready: the restored container was replaced; a startup is armed');
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

    if (store === undefined || !this.#syncRuns()) return;
    let reason: string | undefined;

    try {
      const started = await this.#rawExec(syncStartCommand(this.#syncConfig(store)), DEVBOX_RUNTIME_DIR);

      if (started.exitCode === 0) this.#trace('sync.start', { generation: this.#generation });
      else reason = started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`;
    } catch (cause) { reason = describe({ cause }); }

    if (reason !== undefined) await this.#record('checkpoint', `the container's sync did not start: ${reason}`);
  }

  async #stopSync(): Promise<void> {
    if (!this.#syncsInContainer() || this.ctx.container?.running !== true) return;
    let reason: string | undefined;

    try {
      const stopped = await this.#execute(syncStopCommand(), { cwd: DEVBOX_RUNTIME_DIR });

      if (stopped.exitCode !== 0) reason = stopped.stderr.trim() || `exit ${stopped.exitCode}`;
    } catch (cause) { reason = describe({ cause }); }

    if (reason !== undefined) await this.#record('checkpoint', `the container's sync did not stop before the detach: ${reason}`);
  }

  async #runCheckpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    const store = this.store;

    if (store === undefined || !this.#syncsInContainer()) return await this.#requireStorage().checkpoint(kind);

    if (this.ctx.container?.running !== true) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }

    const command = syncFlushCommand(this.#syncConfig(store), kind);
    const flushed = await this.#execute(command, { cwd: DEVBOX_RUNTIME_DIR });
    this.#meter(command, flushed.stdout, flushed.stderr);

    return parseSyncOutcome(flushed.stdout, flushed.stderr, flushed.exitCode);
  }


  devboxSync(body: string): Promise<SyncAnswer> {
    return settle(attempt('io', async () => {
      const store = this.store;

      if (store === undefined) return { status: 403, body: JSON.stringify({ ok: false, error: 'refused', reason: 'this devbox has no store' }) };

      const reply = await serveSync({
        ports: this.#chainPorts(store),
        generation: async () => await this.ctx.storage.get<string>(BOOT_ID_KEY),
      }, body);

      this.#meter(reply.body, body);

      return reply;
    }));
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
      const reason = 'the attach-recovery record did not parse [unreadable -> refuse]';
      await this.#settle({ phase: 'unattached', reason, retry: false });
      await this.#record('attach', reason);
      // Terminal refusal drops the startup wake-up the start hook armed, as `#recover` does for
      // `refuse` and `replace`; a firing row would file this refusal again every second.
      this.#deleteSchedule(STARTUP_CALLBACK);

      return { cause: new DevboxError("io", reason) };
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
  devboxStartup(): Promise<void> {
    return settle(attempt('io', async () => {
      const since = Date.now();
      this.#trace('startup.callback.enter', {
        generation: this.#generation, running: this.ctx.container?.running === true, phase: this.#restoration.phase,
      });

      try {
        await this.#dispatch(STARTUP_CALLBACK, async () => {
          if (this.#closed || this.#quiescing !== undefined) return;

          // A stale buffered startup row cannot reopen a settled running generation (D12).
          if (this.ctx.container?.running === true && this.#admission() !== undefined) return;
          await this.#startContainer();

          if (this.#restoration.phase === 'unattached') throw new DevboxError("io", this.#restoration.reason);
        });
      } finally {
        this.#trace('startup.callback.exit', { generation: this.#generation, ms: Date.now() - since, phase: this.#restoration.phase });
      }
    }));
  }

  /** All delivered startup doors share admission and destructive recovery. */
  async #startContainer(): Promise<void> {
    const refused = this.#refusedStart();

    if (refused !== undefined) {
      await this.#settle({ phase: 'unattached', reason: refused, retry: false });

      return;
    }

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
          this.#deleteSchedule(STARTUP_CALLBACK);
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

    await this.#admitExecution();
  }

  #startInputs(): StartInputs {
    return { image: this.containerImage ?? '', size: this.#size(), internet: this.enableInternet };
  }

  #refusedStart(): string | undefined {
    return this.ctx.container?.running === true ? undefined : refusedStart(this.ctx.storage.kv.get(START_REFUSED_KEY), this.#startInputs());
  }

  async #admitExecution(): Promise<void> {
    const generation = this.#generation;
    const since = Date.now();
    const inputs = this.#startInputs();
    const startsContainer = this.ctx.container?.running !== true;
    this.#trace('startup.admit.enter', { generation, running: !startsContainer });

    try {
      await this.#startNative(inputs);

      this.#refused = undefined;
      this.ctx.storage.kv.delete(START_REFUSED_KEY);
      this.#trace('startup.admit.exit', { generation, ms: Date.now() - since, admitted: true, owned: this.#owns(generation) });
    } catch (thrown) {
      const cause = this.containerImage === undefined ? new DevboxError('configuration', NO_START_IMAGE, { cause: thrown }) : thrown;
      const reason = describe({ cause });
      this.#trace('startup.admit.exit', {
        generation, ms: Date.now() - since, admitted: false, owned: this.#owns(generation),
        running: this.ctx.container?.running === true, reason,
      });

      if (this.#owns(generation)) {
        const failure = classifyRecovery({ cause });

        // Classified first, as the ladder does: a start that fails the same way every time (an
        // S3Mount marker this box cannot route, D40) is refused once, not re-armed each second (D47).
        if (isTerminalRecovery(failure)) {
          const refusal = `[${failure} -> refuse] ${reason}`;
          this.#adoptionPending = false;

          if (startsContainer) this.ctx.storage.kv.put(START_REFUSED_KEY, { reason: refusal, ...inputs });
          await this.#settle({ phase: 'unattached', reason: refusal, retry: false });

          if (this.#owns(generation)) {
            await this.#record('attach', refusal);
            this.#deleteSchedule(STARTUP_CALLBACK);
          }
        } else {
          this.#refused = { generation, reason };
          await this.#record('attach', `[${failure} -> retry] ${reason}`);

          if (this.#owns(generation)) await this.armAlarm(STARTUP_CALLBACK, 1);
        }
      } else {
        console.error(`[devbox] superseded admission refused: ${reason}`);
      }
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
          throw new DevboxError("io", 'attached-container repair could not claim recovery');
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
    unawaited(this.ctx.storage.delete(SETTLED_KEY), 'settled phase was not cleared');
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
    const reason = `[${failure} -> ${decision.action}] ${describe(thrown)}`;
    const restoration = { phase: 'unattached', reason, retry: decision.action === 'retry' } as const;

    if (!await this.#settleRecovery(claim, generation, decision, restoration)) return;

    if (!this.#owns(generation)) return;
    // The arm below is one durable write from an isolate that may reset after the decision;
    // carrying the decision in `restoration` lets a later caller see a missing row and retry.
    this.#restoration = restoration;
    await this.#record('attach', reason);

    if (!this.#owns(generation)) return;

    if (decision.action === 'retry' || decision.action === 'replace') {
      await this.armAlarm(STARTUP_CALLBACK, this.policy.heartbeatSeconds);

      return;
    }

    this.#deleteSchedule(STARTUP_CALLBACK);
  }

  /** Cancels exec work abandoned at the attach deadline; `destroy` acks before `running` flips.
   *  `super`: a replaced identity is restarted, not closed. */
  async #replaceContainer(reason: string): Promise<void> {
    this.#invalidateGeneration(this.#startup);
    const replacing = this.#generation;

    try {
      await this.#destroyContainer();
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
    for (let poll = 0; poll < CONTAINER_STOP_ATTEMPTS; poll += 1) {
      if (this.ctx.container?.running !== true) return;
      await scheduler.wait(CONTAINER_STOP_INTERVAL_MS);
    }

    if (this.ctx.container?.running !== true) return;
    throw new DevboxError("io", `the container still reported itself running ${String(CONTAINER_STOP_ATTEMPTS)} probes `
    + `after it acknowledged the stop (${String(CONTAINER_STOP_ATTEMPTS * CONTAINER_STOP_INTERVAL_MS)}ms); `
    + 'refusing to treat the identity as gone', );
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
          const existing = await this.#processes().get(spec.processId);

          if (existing !== null && isProcessLive(existing.status)) return existing;

          return await this.#processes().start(spec.command, {
            cwd: spec.cwd ?? DEVBOX_WORKDIR,
            processId: spec.processId,
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
      async () => await this.#expose(spec.port, options),
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

  /** A host asking: reopens a destroyed box and arms the only start coordinator. */
  kickStartup(): Promise<void> {
    return settle(this.#reopening(() => this.#armStartup()));
  }

  async #armStartup(): Promise<void> {
    // A retryable unattach re-arms a lost row; a terminal one stays unarmed, or refused work
    // would storm the incident ledger.
    if (this.#quiescing !== undefined || this.#startup !== undefined || this.#gateRestore !== undefined) return;
    const held = this.#restoration;

    // An attempt in flight settles into a phase on its own.
    if (held.phase === 'restoring') return;

    if (held.phase === 'attached' || held.phase === 'repair') return;

    if (held.phase === 'unattached' && !held.retry
      && await this.ctx.storage.get(RECOVERY_ACTION_KEY) === undefined) return;

    if (this.#refusedStart() !== undefined) return;
    await this.armAlarm(STARTUP_CALLBACK, 1);
  }

  protected get containerImage(): string | undefined {
    return this.ctx.container?.images['devbox'];
  }

  protected get defaultSize(): BoxSize {
    return DEFAULT_BOX_SIZE;
  }

  #stored(key: string): BoxSize | undefined {
    const stored = v.safeParse(BoxSizeSchema, this.ctx.storage.kv.get(key));

    return stored.success ? stored.output : undefined;
  }

  #size(): BoxSize {
    return this.#stored(SIZE_KEY) ?? this.#stored(DEFAULT_SIZE_KEY) ?? this.defaultSize;
  }

  #runningSize(): BoxSize | undefined {
    return this.ctx.container?.running === true ? this.#stored(RUNNING_SIZE_KEY) : undefined;
  }

  #parseSize(size: string): Effect.Effect<BoxSize, DevboxError> {
    const parsed = v.safeParse(BoxSizeSchema, size);

    return parsed.success
      ? Effect.succeed(parsed.output)
      : Effect.fail(new DevboxError('invalid-input', `no box size ${size}; the sizes are ${BOX_SIZE_ORDER.join(', ')}`));
  }

  boxSize(): Promise<{
    readonly size: BoxSize; readonly chosen: BoxSize | undefined; readonly running: BoxSize | undefined; readonly startRefused: string | undefined;
  }> {
    return settle(Effect.sync(() => ({
      size: this.#size(), chosen: this.#stored(SIZE_KEY), running: this.#runningSize(), startRefused: this.#refusedStart(),
    })));
  }

  useDefaultSize(size: string | null): Promise<BoxSize> {
    return settle(Effect.gen({ self: this }, function* () {
      if (size === null) this.ctx.storage.kv.delete(DEFAULT_SIZE_KEY);
      else this.ctx.storage.kv.put(DEFAULT_SIZE_KEY, yield* this.#parseSize(size));

      return this.#size();
    }));
  }

  resize(size: string | null): Promise<ResizeOutcome> {
    return settle(Effect.gen({ self: this }, function* () {
      if (size === null) this.ctx.storage.kv.delete(SIZE_KEY);
      else this.ctx.storage.kv.put(SIZE_KEY, yield* this.#parseSize(size));
      const target = this.#size();
      const running = this.ctx.container?.running === true;
      const previous = this.#runningSize();

      if (!running) return { kind: 'recorded', size: target, previous: undefined } as const;

      if (previous === target) return { kind: 'unchanged', size: target, previous } as const;
      const endedCommands = this.#untimed.size;
      const committed = yield* attempt('io', () => this.#quiesce(true));

      if (committed.kind === 'failed') {
        return { kind: 'failed', size: target, previous, reason: committed.reason ?? 'the final checkpoint failed' } as const;
      }

      yield* attempt('io', () => this.start());

      return { kind: 'restarted', size: target, previous, endedCommands, checkpoint: committed } as const;
    }));
  }

  /** Requests may start a stopped box, then adopt the hook's settled generation (D26). */
  resolveReadiness(): Promise<RestoreReadiness> {
    return settle(attempt('io', async () => {
      return await this.#resolveReadiness(this.#teardowns);
    }));
  }

  async #resolveReadiness(arrived: number): Promise<RestoreReadiness> {
    if (this.#quiescing !== undefined) return { kind: 'pending', reason: QUIESCING };

    if (arrived !== this.#teardowns) return { kind: 'pending', reason: DESTROYED_AFTER_ARRIVAL };
    this.#closed = false;
    const wasRunning = this.ctx.container?.running === true;
    this.#trace('readiness.enter', { generation: this.#generation, running: wasRunning, phase: this.#restoration.phase });

    if (!wasRunning) await this.#startContainer();
    await this.#resolveAdoption();

    // Native allocation can report running before restoration starts.
    if (wasRunning && this.#restoration.phase === 'unstarted') await this.#startContainer();

    if (this.#quiescing !== undefined) return { kind: 'pending', reason: QUIESCING };

    if (arrived !== this.#teardowns) return { kind: 'pending', reason: DESTROYED_AFTER_ARRIVAL };
    const admission = this.#admission();

    if (admission !== undefined) return admission;

    await this.#armStartup();

    if (this.#restoration.phase === 'unattached' && !this.#restoration.retry) {
      throw new DevboxError('refused', terminalRefusal(this.#restoration.reason));
    }

    return {
      kind: 'pending',
      reason: `this devbox is not ready: ${this.#unready() ?? 'the restoration has not settled'}. `
        + 'A startup is armed, so ask again.',
    };
  }

  restoreStatus(): Promise<RestoreStatus> {
    return settle(attempt('io', async () => {
      const held = this.#restoration;

      return {
        restoring: held.phase === 'restoring',
        refused: held.phase === 'unattached' && !held.retry ? terminalRefusal(held.reason) : undefined,
      };
    }));
  }

  /** Strict {@link resolveReadiness}: `pending` is a refusal, never permission. */
  ensureReady(): Promise<RestoreAdmission> {
    return settle(attempt('io', async () => {
      return (await this.#ensureReady(this.#teardowns)).admission;
    }));
  }

  async #ensureReady(arrived: number): Promise<{ readonly admission: RestoreAdmission; readonly container: Container }> {
    const readiness = await this.#resolveReadiness(arrived);
    const container = this.ctx.container;

    if (readiness.kind === 'pending' || container?.running !== true) {
      throw new DevboxError("io", readiness.kind === 'pending' ? readiness.reason : 'this devbox is not ready: its container stopped after it was admitted');
    }

    // Every operation route and only callers pass here (maintenance uses `#rawExec` and
    // scheduled callbacks), so file, port and process routes stamp the lease too (D18).
    this.stampInteraction();

    return { admission: readiness, container };
  }

  /** Stamps the lease for a caller on a lane it cannot see, e.g. a terminal; the host calls
   *  this only from its caller entry points. Refuses while unready, like every operation. */
  noteTerminalActivity(): Promise<void> {
    return settle(attempt('io', async () => {
      await this.ensureReady();
      this.stampInteraction();
    }));
  }

  #admission(): RestoreAdmission | undefined {
    return admissionOf(this.#restoration);
  }

  /** Defaults cwd to `DEVBOX_WORKDIR`: commands landing outside the durable directory are
   *  not saved. A caller-supplied `cwd` overrides it. */
  async exec(command: string, options?: DevboxExecOptions): Promise<ExecResult> {
    return await settle(this.#withActiveCaller(attempt("io", async () => {
      await this.ensureReady();

      return await this.#execute(command, { cwd: DEVBOX_WORKDIR, ...options });
    })));
  }

  /** No deadline; the SDK's process lane lost output (D37). */
  execUntimed(command: string, options: { readonly cwd?: string; readonly execId: string; readonly env?: Readonly<Record<string, string>> }): Promise<ExecResult> {
    const pending: UntimedExecution = { cancelled: false };
    this.#untimed.set(options.execId, pending);

    return settle(this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      const { container } = yield* attempt('not-ready', () => this.#ensureReady(this.#teardowns));

      if (pending.cancelled) return yield* Effect.fail(new DevboxError('cancelled', 'sandbox exec cancelled before admission'));
      const started = yield* attemptSync('process', () => container.exec(['bash', '-c', command], { cwd: options.cwd ?? DEVBOX_WORKDIR, env: { ...options.env, ...CONTAINER_TRUST_ENV } }));
      pending.started = started;
      const process = yield* attempt('process', () => started);
      const output = yield* attempt('process', () => process.output());
      const text = new TextDecoder();

      return { stdout: text.decode(output.stdout), stderr: text.decode(output.stderr), exitCode: output.exitCode };
    })).pipe(Effect.ensuring(Effect.sync(() => { this.#untimed.delete(options.execId); }))));
  }

  portListeners(stamp: string, ports?: readonly number[]): Promise<readonly PortListener[] | null> {
    return settle(attempt('io', async () => {
      const container = this.ctx.container;

      if (container?.running !== true) return null;

      if (ports?.length === 0) return [];
      const read = await (await container.exec(['sh', '-c', PORT_LISTENERS, 'port-listeners', stamp, ...(ports ?? []).map(String)])).output();

      return parsePortListeners(new TextDecoder().decode(read.stdout));
    }));
  }

  /** False when the command had already exited. */
  killUntimed(execId: string): Promise<boolean> {
    return settle(attempt('io', () => this.#endUntimed(execId)));
  }

  async #endUntimed(execId: string): Promise<boolean> {
    const pending = this.#untimed.get(execId);

    if (pending === undefined) return false;
    pending.cancelled = true;

    if (pending.started === undefined) return true;
    const container = this.ctx.container;

    if (container?.running !== true) return false;
    const { pid } = await pending.started;
    const ended = await (await container.exec(['sh', '-c', KILL_TREE, 'kill-tree', String(pid)])).output();

    return ended.exitCode !== KILL_TREE_GONE;
  }

  readonly #untimed = new Map<string, UntimedExecution>();

  /** The only transition that clears a terminal refusal; keeps the `replace` stage, so a failed
   *  retry refuses again instead of destroying. Also re-runs an incomplete restoration. */
  attachNow(): Promise<AttachOutcome> {
    const arrived = this.#teardowns;

    return settle(Effect.gen({ self: this }, function* () {
      yield* this.#afterQuiesce(arrived, 'not-ready');

      return yield* attempt('not-ready', async (): Promise<AttachOutcome> => {
        this.#closed = false;
        this.stampInteraction();

        if (this.#restoration.phase === 'repair') {
          await this.#repairAttached(this.#generation);
        } else {
          if (this.#unready() !== undefined) {
            this.ctx.storage.kv.delete(START_REFUSED_KEY);
            await this.#settle({ phase: 'unstarted' });
            await this.#startContainer();

            if (this.#admission() === undefined) {
              throw new DevboxError("io", `this devbox is not ready: ${this.#unready() ?? 'the restoration has not settled'}`);
            }
          }

          await this.#ensureReady(arrived);
        }

        return await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY)
          ?? { kind: 'empty', detail: 'this box has attached nothing' };
      });
    }));
  }

  checkpointNow(kind: CheckpointKind): Promise<CheckpointOutcome> {
    return settle(attempt('io', async (): Promise<CheckpointOutcome> => {
      if (this.#quiescing !== undefined) return { kind: 'failed', reason: QUIESCING, bytes: undefined, movedBytes: undefined };
      this.stampInteraction();
      await this.#healReplacedContainer();

      return await this.#checkpoint(kind);
    }));
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

  /** Fence admissions, drain owned work, release resident holders, then commit and detach. */
  quiesce(): Promise<CheckpointOutcome> {
    return settle(attempt('io', () => this.#quiesce(false)));
  }

  #quiesce(ending: boolean): Promise<CheckpointOutcome> {
    return this.#quiescing ??= Promise.resolve().then(async () => {
      try {
        return await this.#quiesceAdmitted(ending);
      } finally {
        this.#quiescing = undefined;

        if (this.ctx.container?.running === true) await this.#armContainerSchedules();
      }
    });
  }

  async #quiesceAdmitted(ending: boolean): Promise<CheckpointOutcome> {
    const starting = this.#startup;

    if (starting !== undefined) await Promise.allSettled([starting.run]);

    if (ending) await Promise.allSettled([...this.#untimed.keys()].map((execId) => this.#endUntimed(execId)));

    if (this.#activeCallers !== 0) {
      this.#callersDrained = Promise.withResolvers<void>();
      await this.#callersDrained.promise;
    }

    await this.#resources.drain();
    await this.#lane.drain();
    await this.#storageMutationTail;

    if (this.ctx.container?.running !== true) {
      this.#invalidateGeneration();
      await this.onStop();

      return { kind: 'skipped', reason: 'the container is not running: nothing is attached to commit', bytes: undefined, movedBytes: undefined };
    }

    await this.#healReplacedContainer();
    const held = this.#restoration;

    if (held.phase === 'unattached') {
      this.#invalidateGeneration();
      await this.#stopContainer();
      await this.#awaitContainerStopped();

      return { kind: 'skipped', reason: `nothing is attached to commit: ${held.reason}`, bytes: undefined, movedBytes: undefined };
    }

    let listed: Awaited<ReturnType<Processes["list"]>>;
    let warning: string | undefined;

    try {
      listed = await this.#processes().list();
      const residents = new Set((await this.#procSpecs()).map(spec => spec.processId));

      if (!ending && listed.some(process => isProcessLive(process.status) && !residents.has(process.id))) {
        return { kind: 'failed', reason: 'the stop is refused: unmanaged commands are still running', bytes: undefined, movedBytes: undefined };
      }
    } catch (cause) {
      const reason = describe({ cause });
      const beats = await this.ctx.storage.get<number>(UNREADABLE_PROCESS_BEATS_KEY) ?? 0;

      if (!ending && beats < this.#processListGraceBeats) {
        return { kind: 'failed', reason: 'the stop is held while the process list is unreadable: ' + reason, bytes: undefined, movedBytes: undefined };
      }

      warning = 'D35: the process list stayed unreadable past the quiet-confirm window; an unobservable detached command may be stopped: ' + reason;
      this.#trace('quiesce.processes.unreadable', { reason, beats });
      await this.#record('quiesce', warning);
      listed = [];
    }

    const generation = this.#generation;
    let resumeResidents = true;

    try {
      await this.#stopSync();
      await this.#releaseWorkdirHolders(listed);
      const committed = await this.#checkpoint('quiesce');
      const outcome = warning === undefined ? committed : { ...committed, reason: warning + (committed.reason === undefined ? '' : '; ' + committed.reason) };

      if (outcome.kind === 'failed') {
        await this.#record('checkpoint', `final checkpoint failed: ${outcome.reason ?? 'unknown'}`);

        return outcome;
      }

      resumeResidents = false;
      await this.#detachStorage();
      this.#invalidateGeneration();
      await this.#stopContainer();
      await this.#awaitContainerStopped();

      return outcome;
    } finally {
      if (resumeResidents && this.#owns(generation) && this.ctx.container?.running === true) {
        await this.#repairAttached(generation);
        await this.#restartSync();
      }
    }
  }


  /** Kill live supervised processes via `killProcess`, not `stopSupervised`: that drops the spec,
   *  and the wake's restoration restarts exactly those specs. */
  async #releaseWorkdirHolders(listed: Awaited<ReturnType<Processes['list']>>): Promise<void> {
    if (this.ctx.container?.running !== true) return;

    for (const live of listed) {
      if (!isProcessLive(live.status)) continue;

      try {
        await this.#processes().kill(live.id);
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
      throw new DevboxError("io", `the holders of ${DEVBOX_WORKDIR} could not be released: `
      + `${released.stderr.trim() || released.stdout.trim() || `exit ${released.exitCode}`}`, );
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

      throw holders === undefined || holders.length === 0 ? error : new DevboxError('io',
        `the work directory could not be detached while these processes were still holding it: ${holders.map(holder => `${holder.pid} (${holder.comm})`).join(', ')}: ${describe({ cause: error })}`, { cause: error });
    } finally {
      this.#lastWorkdirHolders = undefined;
    }
  }

  /** An in-flight restore writes nothing durable after this, and no tick publishes after the
   *  discard; a stopped box never starts an instance to clean. */
  discardState(): Promise<void> {
    return settle(attempt('io', async () => {
      this.#invalidateGeneration();
      await this.#stopSync();
      await this.#requireStorage().discard();
      // The attach evidence describes the discarded bytes, so it is deleted with them.
      await this.ctx.storage.delete(LAST_ATTACH_KEY);
    }));
  }

  /** Also ends the box's own starts (D36). */
  destroy(): Promise<void> {
    return settle(attempt('io', async () => {
      this.#closed = true;
      this.#teardowns += 1;
      this.#invalidateGeneration();
      const admissions = [...this.#admissions];

      for (const admission of admissions) admission.abort();
      await Promise.allSettled(admissions.map((admission) => admission.settled));

      for (const callback of CONTAINER_CALLBACKS) this.#deleteSchedule(callback);
      await this.#destroyContainer();
    }));
  }

  /** Totals say how many failures were filed; only these reasons say what they were.
   *  Bounded by the ledger cap. */
  devboxIncidentReasons(): Promise<readonly IncidentReasonRow[]> {
    return settle(attempt('io', async () => {
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
    }));
  }

  /** Durable spec row is written before the process starts and is idempotent on (command, cwd):
   *  a re-issue restarts under the same id; a failed start keeps the row for `stopSupervised`. */
  async startSupervised(command: string, cwd?: string): Promise<{ processId: string }> {
    return await settle(this.#withActiveCaller(attempt("io", async () => {
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
        const existing = await this.#processes().get(spec.processId);

        if (existing !== null && isProcessLive(existing.status)) {
          return { processId: spec.processId };
        }
      }

      await this.#processes().start(command, {
        cwd: workDir,
        processId: spec.processId,
      });

      return { processId: spec.processId };
    })));
  }

  /** Native kill acknowledges both termination and absence; a failure keeps the launch record. */
  stopSupervised(processId: string): Promise<{ stopped: boolean }> {
    return settle(attempt('io', async () => {
      const arrived = this.#teardowns;

      return await this.#resources.run(processScope(processId), () => this.#stopSupervised(processId, arrived));
    }));
  }

  async #stopSupervised(processId: string, arrived: number): Promise<{ stopped: boolean }> {
    await this.#ensureReady(arrived);
    let thrown: { readonly cause: unknown } | undefined;

    try {
      await this.#processes().kill(processId);
    } catch (error) {
      thrown = { cause: error };
    }

    if (thrown === undefined) {
      await this.ctx.storage.delete(`${PROC_SPEC_PREFIX}${processId}`);
    } else {
      await this.#record('process', describe(thrown), { processId });
    }

    this.stampInteraction();

    return { stopped: thrown === undefined };
  }

  /** A spec with no live row is not running: restoration has not started it yet, or its start
   *  failed and was recorded. */
  listSupervised(): Promise<readonly SupervisedProcessRow[]> {
    return settle(attempt('io', async () => {
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

      for (const live of await this.#processes().list()) {
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
    }));
  }

  /** Must be asked before the first exposure: restarts re-expose each port with its stored
   *  token, so the first exposure must use the same token for the preview URL to survive. */
  portToken(port: number, name?: string): Promise<{ urlToken: string }> {
    return settle(attempt('io', async () => {
      return await this.#resources.run(portScope(port), () => this.#portToken(port, name));
    }));
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

  notePortRemoved(port: number): Promise<void> {
    return settle(attempt('io', async () => {
      this.ctx.storage.kv.delete(EXPOSED_PREFIX + port);

      return await this.#resources.run(portScope(port), async () => {
        await this.ctx.storage.delete(`${PORT_SPEC_PREFIX}${port}`);
        this.stampInteraction();
      });
    }));
  }

  #unready(): string | undefined {
    const refused = this.#refused;

    if (this.#restoration.phase === 'unstarted' && refused?.generation === this.#generation) {
      return `the platform refused this box a container: ${refused.reason}`;
    }

    return unreadyOf(this.#restoration, this.#gateRestore !== undefined);
  }

  /** Answers without attaching storage. A poll may reactivate a stopped container so its
   *  scheduled startup can run, but never drives that startup inline. */
  devboxState(): Promise<DevboxReport> {
    return settle(attempt('io', async () => {
      await this.#armStartup();
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
        ready: this.#quiescing === undefined && this.#restoration.phase === 'attached' && this.#gateRestore === undefined,
        unready: this.#quiescing === undefined ? this.#unready() : QUIESCING,
        lastInteractionAt: this.#lastInteraction
          ?? await this.ctx.storage.get<number>(LAST_INTERACTION_KEY),
        quietSince: await this.ctx.storage.get<number>(QUIET_SINCE_KEY),
        chain: normalizeChainState(await this.ctx.storage.get<StoredValue>(STORAGE_KEY)),
        lastAttach: await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY),
        lastTick: await this.ctx.storage.get<HeartbeatTick>(LAST_TICK_KEY),
        bootId: await this.ctx.storage.get<string>(BOOT_ID_KEY),
        replacedCount: await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0,
        size: this.#size(),
        runningSize: this.#runningSize(),
        supervised,
        ports,
        incidents: incidentTotals(incidents.values()),
        flights: {
          startupMs: this.#startup === undefined ? null : Date.now() - this.#startup.since,
          hookMs: this.#gateRestore === undefined ? null : Date.now() - this.#gateRestore.since,
        },
        wire: { ...this.#containerCommandBytes },
      };
    }));
  }

  // Claims span readiness and the operation. Restore bypasses them: a claim there would
  // deadlock against a caller already waiting for the restore.

  async readFile(path: string, options?: ReadOptions): Promise<FileResult> {
    return await settle(this.#claimed(pathScopes({ path }), attempt("file", () => this.#readFile(path, options))).pipe(Effect.mapError(fileFault)));
  }

  /** The file stays claimed until the stream's bytes are drained, not until this resolves. */
  readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const arrived = this.#teardowns;

    return settle(Effect.gen({ self: this }, function* () {
      const release = yield* attempt('io', () => this.#resources.hold(pathScopes({ path })));

      const opened = yield* Effect.result(Effect.gen({ self: this }, function* () {
        yield* attempt('not-ready', () => this.#ensureReady(arrived));
        const stream = yield* this.#readFileStream(path);

        return heldUntilDrained(stream, release);
      }));

      if (Result.isFailure(opened)) { release();

 return yield* Effect.fail(opened.failure); }

      return opened.success;
    }).pipe(Effect.mapError(fileFault)));
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: string },
  ) {
    return await settle(this.#claimed(pathScopes({ path, membership: true }), attempt("file", () => this.#writeFile(path, content, options))).pipe(Effect.mapError(fileFault)));
  }

  /** `deleteFile` claims the subtree: a path can't reveal it is a directory, and a
   *  plain file's subtree costs nothing since no operation can name a path beneath one. */
  async deleteFile(path: string) {
    return await settle(this.#claimed(pathScopes({ path, membership: true, recursive: true }), attempt("file", () => this.#files().remove(path, { recursive: true }))).pipe(Effect.mapError(fileFault)));
  }

  #claimed<T>(scopes: readonly ResourceScope[], operation: Effect.Effect<T, DevboxError>): Effect.Effect<T, DevboxError> {
    const arrived = this.#teardowns;

    return Effect.gen({ self: this }, function* () {
      const release = yield* attempt('io', () => this.#resources.hold(scopes));

      return yield* Effect.gen({ self: this }, function* () {
        yield* attempt('not-ready', () => this.#ensureReady(arrived));

        return yield* operation;
      }).pipe(Effect.ensuring(Effect.sync(release)));
    });
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    // A recursive mkdir really can add an entry to every directory above it, so
    // it is the one operation that claims the whole chain rather than the parent.
    return await settle(this.#claimed(pathScopes({ path, membership: true, ancestors: options?.recursive === true }), attempt("file", () => this.#files().mkdir(path, options))).pipe(Effect.mapError(fileFault)));
  }

  async listFiles(path: string, options?: ListFilesOptions) {
    return await settle(this.#claimed(pathScopes({ path, recursive: options?.recursive === true }), attempt("file", () => this.#listFiles(path, options))).pipe(Effect.mapError(fileFault)));
  }

  exists(path: string): Promise<{ exists: boolean }> {
    return settle(this.#claimed(pathScopes({ path }), Effect.gen({ self: this }, function* () {
      const result = yield* Effect.result(attempt('file', () => this.#files().stat(path)));

      if (Result.isSuccess(result)) return { exists: true };
      const error = result.failure.cause;

      if (SandboxFileError.is(error) && error.code === 'ENOENT') return { exists: false };

      return yield* Effect.fail(result.failure);
    })).pipe(Effect.mapError(fileFault)));
  }

  async exposePort(
    port: number,
    options: { name?: string; hostname: string; token?: string },
  ) {
    return await settle(this.#claimed(portScope(port), attempt("file", () => this.#expose(port, options))).pipe(Effect.mapError(fileFault)));
  }

  /** Revocation touches only this object's preview rows, never the container, so it skips
   *  readiness: a port must stay revocable on a box that is not attached. */
  unexposePort(port: number): Promise<void> {
    return settle(attempt('io', async () => {
      return await this.notePortRemoved(port);
    }));
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

      if (nextSeconds !== null) await this.armAlarm(callback, nextSeconds);
    });
  }

  override alarm(): Promise<void> {
    return settle(attempt('io', async () => {
      const now = Date.now();

      for (const [key, at] of Array.from(this.ctx.storage.kv.list<number>({ prefix: SCHEDULE_PREFIX }))) {
        if (at > now) continue;
        const callback = key.slice(SCHEDULE_PREFIX.length);

        if (this.ctx.storage.kv.get<number>(key) !== at) continue;
        await this.#dispatch(callback, () => this.dispatchAlarm(callback));

        if (this.ctx.storage.kv.get<number>(key) === at) this.ctx.storage.kv.delete(key);
      }

      await this.#scheduleAlarm();
    }));
  }
  protected async dispatchAlarm(callback: string): Promise<void> {
    switch (callback) {
      case STARTUP_CALLBACK: await this.devboxStartup(); break;
      case HEARTBEAT_CALLBACK: await this.devboxHeartbeat(); break;
      case CHECKPOINT_CALLBACK: await this.devboxCheckpoint(); break;
      case INCIDENT_CALLBACK: await this.devboxIncidents(); break;
      default: throw new DevboxError("io", `unknown devbox alarm: ${callback}`);
    }
  }
  /** Failures go to both the strategy record and an incident: the alarm loop reduces a thrown
   *  callback to a console line. Not re-armed while down; waking a container would keep it alive. */
  devboxCheckpoint(): Promise<void> {
    return settle(attempt('io', async () => {
      // The ambient schedule is this row's only writer; with it disabled the row is never armed,
      // so a call here is stray and ending the chain keeps nothing ticking the host didn't ask for.
      if (this.#quiescing !== undefined || !this.ambientCheckpoints || this.#syncsInContainer()) return;
      const period = Math.ceil(this.policy.checkpointIntervalMs / 1000);
      await this.#scheduled(CHECKPOINT_CALLBACK, period, async () => {
        if (this.ctx.container?.running !== true) return null;
        const outcome = await this.#checkpoint('tick');

        if (outcome.kind === 'failed') {
          await this.#record('checkpoint', outcome.reason ?? 'unknown');
        }

        return period;
      });
    }));
  }

  /** Never stamps interaction: maintenance traffic is not use. A quiesce needs all three gates and
   *  confirmed quiet; a stopped container arms no successor (D34). */
  devboxHeartbeat(): Promise<void> {
    return settle(attempt('io', async () => {
      const beat = this.policy.heartbeatSeconds;
      await this.#scheduled(HEARTBEAT_CALLBACK, beat, async () => {
        this.#renewContainer();

        if (this.ctx.container?.running !== true) {
          await this.#tick({ running: false, ping: 'skipped', armedNext: false });

          return null;
        }

        await this.#resolveAdoption();
        const settled = this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair';

        if (!settled) {
          await this.#tick({ running: true, ping: 'unready', armedNext: true });
          await this.#armStartup();

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
          await this.#armStartup();

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
        let backgroundWork = this.#quiescing !== undefined || this.#activeCallers !== 0
          || this.#resources.busy()
          || this.#lane.busy()
          || this.#startup !== undefined
          || this.#gateRestore !== undefined
          || await this.isKeptAlive();

        let note: string | undefined;

        if (!backgroundWork) ({ running: backgroundWork, note } = await this.#commandRunning());

        const decision = quiesceStep({
          now,
          containerRunning: true,
          lastInteractionAt: this.#lastInteraction
            ?? await this.ctx.storage.get<number>(LAST_INTERACTION_KEY)
            ?? await this.ctx.storage.get<number>(STARTED_AT_KEY) ?? now,
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
          ...(note !== undefined && { note }),
        });

        if (decision.action !== 'quiesce') return beat;

        // The next beat retries a refused stop with fresh evidence.
        return (await this.quiesce()).kind === 'failed' ? beat : null;
      });
    }));
  }

  get #processListGraceBeats(): number {
    return Math.ceil(this.policy.quietConfirmMs / (this.policy.heartbeatSeconds * 1000));
  }

  /** See D35. */
  async #commandRunning(): Promise<{ readonly running: boolean; readonly note?: string }> {
    let running: boolean;

    try {
      const supervised = new Set((await this.#procSpecs()).map((spec) => spec.processId));
      running = (await this.#processes().list()).some((live) => isProcessLive(live.status) && !supervised.has(live.id));
    } catch (error) {
      const beats = (await this.ctx.storage.get<number>(UNREADABLE_PROCESS_BEATS_KEY) ?? 0) + 1;
      await this.ctx.storage.put(UNREADABLE_PROCESS_BEATS_KEY, beats);
      const reason = describe({ cause: error });
      const cap = this.#processListGraceBeats;

      if (beats === 1) await this.#record('quiesce', `process list unreadable; holding up to ${String(cap)} beats: ${reason}`);

      if (beats < cap) return { running: true };
      const note = `process list unreadable for ${String(beats)} beats; the idle gate decides: ${reason}`;

      if (beats === cap) await this.#record('quiesce', note);

      return { running: false, note };
    }

    await this.ctx.storage.delete(UNREADABLE_PROCESS_BEATS_KEY);

    return { running };
  }

  /** One durable row per heartbeat, so a stopped box shows when and why: it tells apart an
   *  alarm that never fired, a tick that returned early, and a ping that did not renew. */
  async #tick(input: Omit<HeartbeatTick, 'at'>): Promise<void> {
    await this.ctx.storage.put(LAST_TICK_KEY, { ...input, at: Date.now() } satisfies HeartbeatTick);
  }

  /** Named schedule callback; the delivery policy lives in `incidents.ts`. */
  devboxIncidents(): Promise<void> {
    return settle(attempt('io', async () => {
      const firstRetry = Math.max(1, Math.ceil(incidentRetryDelayMs(0) / 1000));
      await this.#scheduled(INCIDENT_CALLBACK, firstRetry, async () =>
        await deliverIncidents(this.ctx.storage, async (incident, delivery) =>
          await this.onIncident(incident, delivery)));
    }));
  }

  /** Maintenance renews native inactivity but is not caller use; only callers stamp idle time. */
  protected stampInteraction(): void {
    this.#renewContainer();
    const now = Date.now();
    this.#lastInteraction = now;

    if (now - this.#lastInteractionPersisted < INTERACTION_PERSIST_INTERVAL_MS) return;
    this.#lastInteractionPersisted = now;
    // Not awaited on this hot path: the in-memory stamp already renewed this incarnation,
    // so a lost write costs at most one extra heartbeat cycle of lease, never a leak.
    unawaited(this.ctx.storage.put(LAST_INTERACTION_KEY, now), 'lease stamp was not persisted');
  }

  /** Commands and supervised starts have no resource lane (no safe scope / no process yet),
   *  so this counter keeps them live to the heartbeat from call entry through settlement. */
  #withActiveCaller<T>(operation: Effect.Effect<T, DevboxError>): Effect.Effect<T, DevboxError> {
    return Effect.suspend(() => {
      this.#activeCallers += 1;
      this.stampInteraction();

      return operation.pipe(Effect.ensuring(Effect.sync(() => {
        this.#activeCallers -= 1;

        if (this.#activeCallers === 0) { this.#callersDrained?.resolve(); this.#callersDrained = undefined; }

        this.stampInteraction();
      })));
    });
  }

  async #record(
    stage: IncidentStage,
    reason: string,
    extra?: { readonly processId?: string; readonly port?: number },
  ): Promise<void> {
    await recordIncident(this.ctx.storage, stage, reason, extra);
    await this.armAlarm(INCIDENT_CALLBACK, Math.ceil(incidentRetryDelayMs(0) / 1000));
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
      writeState: async (state, expectedRev) => this.ctx.storage.transactionSync(() => settleSync(Effect.gen({ self: this }, function* () {
        const stored = normalizeChainState(yield* attemptSync('io', () => this.ctx.storage.kv.get<StoredValue>(STORAGE_KEY)))?.rev ?? null;

        if (stored !== expectedRev) return yield* Effect.fail(chainAdvanced(expectedRev, stored));
        yield* attemptSync('io', () => this.ctx.storage.kv.put(STORAGE_KEY, state));
      }))),
      clearState: async () => {
        await this.ctx.storage.delete(STORAGE_KEY);
      },
      checkpointIntervalMs: () => this.policy.checkpointIntervalMs,
      checkChanges: async (dir, since) => {
        const checked = await this.#rawExec(upperFingerprintCommand(dir), DEVBOX_RUNTIME_DIR);

        if (checked.exitCode !== 0) throw new DevboxError("io", `checking filesystem changes failed: ${checked.stderr}`);
        const version = checked.stdout.trim();

        return { status: since === version ? 'unchanged' : 'changed', version };
      },
      exec: async (command) => await this.#rawExec(command, DEVBOX_RUNTIME_DIR),
      stamp: (phase) => this.#stampPhase(phase),
      containerGeneration: async () => await this.#readBootId(),
      storeRoot: () => chainStoreRoot(this.#boxPrefix()),
      storeObjectUrl: (key) => storeObjectUrl(chainStoreRoot(this.#boxPrefix()), store.binding, key),
      mountStore: (at) => this.#routes().mount(at),
      unmountStore: (at) => this.#routes().unmount(at),
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
      countEntries: async (dir) => (await this.#files().readDirectory(dir)).length,
      restoreExtract: (backup) => this.#archives(store).restore(backup),
      createExtractSnapshot: (options) => this.#archives(store).create(options),
      now: () => Date.now(),
      log: (message) => {
        console.log(`[devbox] ${message}`);
      },
    };
  }

  /** Internal commands bypass readiness; native admission has already succeeded. */
  async #rawExec(
    command: string,
    cwd = DEVBOX_WORKDIR,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Native exec chdirs before running; create the runtime directory from an existing cwd.
    if (cwd === DEVBOX_RUNTIME_DIR && !this.#runtimeDirReady) {
      const made = await this.#execute(`mkdir -p '${DEVBOX_RUNTIME_DIR}'`, { cwd: DEVBOX_WORKDIR });
      this.#stampPhase('containerStart');

      if (made.exitCode !== 0) {
        return { stdout: made.stdout, stderr: made.stderr, exitCode: made.exitCode };
      }

      this.#runtimeDirReady = true;
    }

    const result = await this.#execute(command, { cwd });
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

  #routeClient: ContainerRoutes | undefined;

  #routes(): ContainerRoutes {
    return this.#routeClient ??= new ContainerRoutes({
      container: this.#container(), bindings: this.#gateways, files: this.#files(), prefix: chainStoreRoot(this.#boxPrefix()) + '/',
      owner: { binding: this.namespaceBinding, id: this.ctx.id.toString() }, internet: this.enableInternet,
    });
  }

  protected async outboundPolicy(): Promise<OutboundPolicy> { return { routes: {} }; }
  protected get namespaceBinding(): string { return this.constructor.name; }

  protected async configureContainer(reused = this.#adoptionPending || this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair'): Promise<void> {
    await this.#routes().configure(await this.outboundPolicy(), this.allowExtraction ? undefined : this.store, reused);
    this.#renewContainer();
  }

  getExposedPorts(hostname: string) {
    return settle(attempt('io', async () => {
      if (this.ctx.container?.running !== true) return [];
      const rows = await this.#portSpecs();
      const result: { port: number; name: string | undefined; url: string }[] = [];

      for (const spec of rows) {
        if (this.ctx.storage.kv.get(EXPOSED_PREFIX + spec.port) !== spec.token) continue;
        result.push({ port: spec.port, name: spec.name, url: `https://${spec.port}-${this.previewName}-${spec.token}.${hostname}` });
      }

      return result;
    }));
  }

  #preview(request: Request, port: number, token: string): Effect.Effect<Response, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const spec = yield* attempt('io', () => this.ctx.storage.get<PortExposureSpec>(`${PORT_SPEC_PREFIX}${port}`));

      if (spec === undefined || spec.token !== token) return new Response('Preview not exposed', { status: 404 });

      return yield* this.#withActiveCaller(attempt('io', async () => {
        await this.ensureReady();

        if (this.ctx.storage.kv.get(EXPOSED_PREFIX + port) !== token) return new Response('Preview not ready', { status: 503 });
        const target = new URL(request.url);
        target.protocol = 'http:';

        return this.#container().getTcpPort(port).fetch(new Request(target.toString(), request));
      }));
    });
  }

  #archiveClient: NativeArchives | undefined;
  #archives(store: DevboxStore): NativeArchives {
    return this.#archiveClient ??= new NativeArchives({
      container: this.#container(), files: this.#files(), store, root: chainStoreRoot(this.#boxPrefix()), exec: (command, cwd) => this.#rawExec(command, cwd),
    });
  }

  #fileClient: Files | undefined;
  #processClient: Processes | undefined;
  enableInternet = true;

  #container(): Container {
    const container = this.ctx.container;

    if (container === undefined) throw new DevboxError("io", 'this devbox has no container binding');

    return container;
  }

  #files(): Files { return this.#fileClient ??= new Files(this.#container()); }
  #processes(): Processes { return this.#processClient ??= new Processes(this.#container()); }

  async #execute(command: string, options: DevboxExecOptions = {}): Promise<ExecResult> {
    const output = await (await this.#container().exec(['/bin/bash', '-c', command], {
      cwd: options.cwd ?? DEVBOX_WORKDIR,
      env: options.env === undefined ? CONTAINER_TRUST_ENV : { ...CONTAINER_TRUST_ENV, ...options.env },
      signal: options.signal,
    })).output();

    const decoder = new TextDecoder();

    return { stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr), exitCode: output.exitCode };
  }

  #renewContainer(): void {
    if (this.ctx.container?.running) unawaited(this.ctx.container.setInactivityTimeout(this.policy.idleMs + this.policy.quietConfirmMs + 60_000), 'setting container inactivity timeout');
  }

  async #destroyContainer(): Promise<void> {
    await this.#container().destroy();
    await this.onStop();
  }

  async #stopContainer(): Promise<void> {
    const container = this.#container();

    if (!container.running) return;
    const ending = container.monitor();
    container.signal(15);

    try { await ending; }
    catch (cause) { if (container.running) throw cause; }

    await this.onStop();
  }
  override fetch(request: Request): Promise<Response> {
    return settle(Effect.gen({ self: this }, function* () {
      const url = yield* attemptSync('invalid-input', () => new URL(request.url));
      const preview = /^\/_devbox\/preview\/(\d+)\/([^/]+)(\/.*)$/.exec(url.pathname);

      if (preview !== null) {
        url.pathname = preview[3];
        const token = yield* attemptSync('invalid-input', () => decodeURIComponent(preview[2]));
        const forwarded = yield* attemptSync('invalid-input', () => new Request(url.toString(), request));

        return yield* this.#preview(forwarded, Number(preview[1]), token);
      }

      if (url.pathname !== '/_devbox/terminal') return new Response('Not found', { status: 404 });

      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });

      return yield* this.#withActiveCaller(attempt('io', async () => {
        const { container } = await this.#ensureReady(this.#teardowns);

        return terminalSocket(container, url.searchParams);
      }));
    }));
  }

  async resetShell(): Promise<void> {
    return settle(this.#withActiveCaller(attempt("io", async () => {
      const { container } = await this.#ensureReady(this.#teardowns);

      return resetTerminal(container);
    })));
  }

  setKeepAlive(enabled: boolean): Promise<void> {
    return settle(attempt('io', async () => {
      await this.ctx.storage.put('devbox:keep-alive', enabled);
    }));
  }

  isKeptAlive(): Promise<boolean> {
    return settle(attempt('io', async () => {
      return await this.ctx.storage.get('devbox:keep-alive') === true;
    }));
  }


  stop(_signal?: 'SIGTERM'): Promise<void> {
    return settle(attempt('io', async () => {
      await this.#stopContainer();
    }));
  }

  onStop(): Promise<void> {
    return settle(attempt('io', async () => {
      for (const callback of CONTAINER_CALLBACKS) this.#deleteSchedule(callback);

      for (const [key] of this.ctx.storage.kv.list({ prefix: EXPOSED_PREFIX })) this.ctx.storage.kv.delete(key);
      await this.#scheduleAlarm();
    }));
  }

  async startProcess(command: string, options: { cwd?: string; processId?: string } = {}) {
    return settle(this.#withActiveCaller(attempt("io", async () => {
      await this.ensureReady();

      return this.#processes().start(command, { cwd: options.cwd, processId: options.processId ?? crypto.randomUUID() });
    })));
  }

  async getProcess(id: string) { return settle(this.#withActiveCaller(attempt("io", async () => { await this.ensureReady();

 return this.#processes().get(id); }))); }
  async listProcesses() { return settle(this.#withActiveCaller(attempt("io", async () => { await this.ensureReady();

 return this.#processes().list(); }))); }
  async killProcess(id: string): Promise<void> { return settle(this.#withActiveCaller(attempt("io", async () => { await this.ensureReady(); await this.#processes().kill(id); }))); }

  async #readFile(path: string, options: ReadOptions = {}): Promise<FileResult> {
    const response = await this.#files().readFile(path);
    const encoding = options.encoding ?? 'utf-8';
    const content = encoding === 'base64' ? Buffer.from(await response.arrayBuffer()).toString('base64') : await response.text();

    return { content, encoding };
  }

  #readFileStream(path: string): Effect.Effect<ReadableStream<Uint8Array>, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* attempt('file', () => this.#files().readFile(path));

      if (result.body === null) return yield* Effect.fail(new DevboxError('io', 'file response has no body'));

      return result.body;
    });
  }

  async #writeFile(path: string, content: string | ReadableStream<Uint8Array>, options?: { encoding?: string }): Promise<void> {
    await this.#files().mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
    const bytes = options?.encoding === 'base64' && !(content instanceof ReadableStream) ? Buffer.from(content, 'base64') : content;
    await this.#files().writeFile(path, bytes);
  }

  async #listFiles(path: string, options: ListFilesOptions = {}): Promise<{ files: ListedFile[] }> {
    const files: ListedFile[] = [];

    const visit = async (directory: string): Promise<void> => {
      for (const entry of await this.#files().readDirectory(directory)) {
        const absolutePath = directory.replace(/\/$/, '') + '/' + entry.name;
        const stat = await this.#files().lstat(absolutePath);
        files.push({ name: entry.name, path: absolutePath, absolutePath, type: stat.type, size: Number(stat.size), isDirectory: stat.type === 'directory' });

        if (options.recursive && stat.type === 'directory') await visit(absolutePath);
      }
    };

    await visit(path);

    return { files };
  }

  protected get previewName(): string { return this.ctx.id.toString(); }

  async #expose(port: number, options: { hostname: string; token?: string; name?: string }) {
    const token = options.token ?? (await this.#portToken(port, options.name)).urlToken;
    this.ctx.storage.kv.put(EXPOSED_PREFIX + port, token);

    return { port, name: options.name, url: `https://${port}-${this.previewName}-${token}.${options.hostname}` };
  }

  protected async armAlarm(callback: string, delaySeconds: number): Promise<void> {
    if (this.#closed && CONTAINER_CALLBACKS.includes(callback)) return;
    const key = SCHEDULE_PREFIX + callback;

    if (this.ctx.storage.kv.get(key) !== undefined && !this.#dispatching.has(callback)) return;
    this.ctx.storage.kv.put(key, Date.now() + delaySeconds * 1000);
    await this.#scheduleAlarm();
  }

  #deleteSchedule(callback: string): void {
    this.ctx.storage.kv.delete(SCHEDULE_PREFIX + callback);
  }

  async #scheduleAlarm(): Promise<void> {
    let next: number | undefined;

    for (const [, at] of this.ctx.storage.kv.list<number>({ prefix: SCHEDULE_PREFIX })) {
      next = next === undefined ? at : Math.min(next, at);
    }

    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
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

