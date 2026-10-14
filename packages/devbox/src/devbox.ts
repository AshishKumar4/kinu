/** Native container owner: start, restore and admission share one generation. */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { Files, SandboxFileError } from '@cloudflare/sandbox';
import { Processes, isProcessLive, nameBox, CONTAINER_ENV, END_TREE } from "./processes";
import { nativeStartClock } from './native-clock';
import type { DevboxExecOptions, ExecResult, ReadOptions, FileResult, ListFilesOptions, FileMetadata, GatewayBindings } from './contracts';
import { listFiles as readDirectory } from './file-listing';
import { writeFileIfDigest as writeFileIfDigestInGuest, type DigestWriteRequest } from './file-digest-write';
import { DEFAULT_EXCLUDES, DiskChainStateSchema, DiskChainStorage, UnboundStorage, diskChain, recoveryNotice, type DiskChain, type DiskChainPorts } from './disk-chain';
import { STORE_MOUNT, chainStoreRoot, storeObjectUrl } from './store-gateway';
import { snapshotRegistry, type SnapshotRegistry } from './snapshot-registry';
import { Snapshots } from './snapshots';
import {
  GOLDEN_BASE, GOLDEN_ENTRYPOINT, GOLDEN_NAME, GOLDEN_REFRESH_MS, GoldenStateSchema, buildGolden, goldenFor, pipeParts, refreshTools,
  type GoldenAnswer, type GoldenPorts,
} from './golden';
import artifact from '../block-lower/upstream.json';
import { ContainerRoutes, type OutboundPolicy } from './gateway';
import { terminalSocket, resetTerminal } from './terminal';
import {
  FIRST_SESSION, SESSIONS_KEY, SESSIONS_READ, SESSIONS_SAVE, SessionNameSchema, SessionRecordsSchema, jobSessionId, jobSessionName, mergeSessions, newSessionId, newSessionName,
  parseSessionsRead, type SessionRecord, type TerminalSession,
} from './sessions';
import { bridgeSockets } from './socket-bridge';
import { DESKTOP_CHECK, DESKTOP_PORT } from './desktop';
import {
  DesktopLease, DesktopRequestSchema, LET_UP_PY, SCREENSHOT, offScreen, pngSize, watchArgv, xdotoolOf,
  type DesktopAction, type DesktopAnswer, type DesktopRequest, type DesktopScreen,
} from './desktop-input';
import { LABEL_LIMIT, LABEL_NAME, ZoneSchema, previewAddress, type PreviewAddress } from './preview';
import { Deferred, Effect, Exit, Result, Semaphore } from 'effect';

import {
  DEFAULT_DEVBOX_POLICY,
  PORT_TOKEN_LENGTH,
  generatePortToken,
  healthProbeCommand,
  healthProbeSilent,
  describeThrown as describe,
  type LateStartFailure,
  incidentRetryDelayMs,
  admissionStep,
  classifyRecovery,
  isCapacityRefusal,
  parseRecoveryRow,
  quiesceStep,
  recoveryStep,
  restartPlan,
  waitingCanChange,
  type DevboxIncident,
  type DevboxPolicy,
  type IncidentDisposition,
  type IncidentStage,
  type PortExposureSpec,
  type SupervisedProcessSpec,
  openStartBudget, awaitListenerCommand,
  LAST_INTERACTION_KEY,
  QUIET_SINCE_KEY,
  racedRestoreSteps, runRestoreStep, type RestoreSteps,
  type StartClock,
  restAskText,
  type RestAnswer,
  type RestAnswered,
  type RestDetail,
  type RestProcess,
  type RunningForRest,
} from './lifecycle';
import { createCheckpointLane, createResourceLane, heldUntilDrained, pathScopes, portScope, type ResourceScope } from './operation-lanes';
import { SupervisedProcesses } from './supervised-processes';
import { DevboxError, attempt, attemptSync, settle, settleSync, startOverrun, startInterrupted, chainAdvanced, type DevboxErrorCode } from './errors';
import { execRecords } from './exec-stream';
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
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  type AttachOutcome,
  type CheckpointKind,
  type CheckpointOutcome,
  type DevboxStorage,
  type StoredValue,
} from './storage';

/** Bounded wait for `running` to clear after an acknowledged stop: an unbounded wait pins the
 *  attempt, and `#armStartup` early-returns on a pinned attempt, so nothing re-arms. */
const CONTAINER_STOP_ATTEMPTS = 50;

interface RunningExec {
  cancelled: boolean;
  started?: Promise<ExecProcess>;
  /** Aborted with `killExec`, for a call that waits before its process starts. */
  readonly cancel?: AbortController;
}

/** The desktop check in flight: its run's id, which `killExec` ends, and its outcome, which its waiters share. */
interface DesktopCheck {
  readonly id: string;
  readonly done: Deferred.Deferred<DesktopScreen, DevboxError>;
}

/** A stopped call's failure: its process ended, or it never started. */
function stopped(doing: string): DevboxError {
  return new DevboxError('cancelled', `${doing} was stopped`);
}

/** `work`, which a stop of `signal` ends where it waits: an uninterruptible part of it runs to its end first. */
function untilStopped<A>(work: Effect.Effect<A, DevboxError>, signal: AbortSignal | undefined, doing: string): Effect.Effect<A, DevboxError> {
  if (signal === undefined) return work;

  return Effect.raceFirst(work, Effect.callback<never, DevboxError>((resume) => {
    const stop = (): void => { resume(Effect.fail(stopped(doing))); };

    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });

    return Effect.sync(() => { signal.removeEventListener('abort', stop); });
  }));
}

/** An `execId` makes a command once per id (D48). */
interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly execId?: string;
}

function launchUnknown(execId: string): DevboxError {
  return new DevboxError('indeterminate', `exec ${execId} was launched before, and its outcome cannot be read here; it was not launched again`);
}

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

const PORT_SPEC_PREFIX = 'devbox:port:';

const LAST_ATTACH_KEY = 'devbox:last-attach';

/** One container identity's recovery progress, written only by the ladder, deleted on the first attach. */
const ATTACH_RECOVERY_KEY = 'devbox:attach-recovery';

const LAST_TICK_KEY = 'devbox:last-tick';

const REST_ASK_KEY = 'devbox:rest-ask';

const BOOT_ID_KEY = 'devbox:boot-id';

/** Survives a mid-restore object reset; turnover clears it, so no stale phase admits another container. */
const SETTLED_KEY = 'devbox:restoration';

const EXEC_CLAIM_PREFIX = 'devbox:exec:';

const REPLACED_COUNT_KEY = 'devbox:replaced-count';

/** Idle origin for a box no caller has used. */
const STARTED_AT_KEY = 'devbox:started-at';

const SIZE_KEY = 'devbox:size';

const DEFAULT_SIZE_KEY = 'devbox:default-size';

const RUNNING_SIZE_KEY = 'devbox:running-size';

const START_REFUSED_KEY = 'devbox:start-refused';

const DISK_STATE_KEY = 'devbox:disk-chain';

/** Where the box stamps the container's identity: on the disk a replacement does not keep (P1). */
const BOOT_ID_PATH = '/tmp/devbox-boot-id';

/** A loopback Durable Object namespace's tag in `ctx.exports`; an entrypoint's stub answers any property as an RPC (D85). */
const NAMESPACE_TAG = '[object LoopbackDurableObjectNamespace]';

const NO_NAMESPACE = 'no Durable Object namespace among the Worker\'s exports accepts this box\'s id: export its class from the Worker';

const NO_CONTAINER = 'this server runs no containers, as a local dev server never does: a box runs on a deployment';

/** Scheduled-callback names. Each MUST name a public method on the class:
 *  `Container.schedule` rejects anything it cannot call back. */
const STARTUP_CALLBACK = 'devboxStartup';

const CHECKPOINT_CALLBACK = 'devboxCheckpoint';

const HEARTBEAT_CALLBACK = 'devboxHeartbeat';

const INCIDENT_CALLBACK = 'devboxIncidents';

/** Rows a destroyed box neither keeps nor arms. */
const CONTAINER_CALLBACKS: readonly string[] = [STARTUP_CALLBACK, HEARTBEAT_CALLBACK, CHECKPOINT_CALLBACK];

const GOLDEN_BUILD_CALLBACK = 'golden-build';

const GOLDEN_REFRESH_CALLBACK = 'golden-refresh';

const GOLDEN_KEY = 'devbox:golden';

const AWAITING_GOLDEN_KEY = 'devbox:awaiting-golden';

/** A snapshot a box starts from, and the namespace that gave it, which a failed wake asks for the next one. */
type StartSource = { readonly kind: 'own' | 'golden'; readonly id: string; readonly boxes: Siblings };

/** What a box reaches on the boxes of its own namespace: the golden builder, and a box it tells (D65). */
interface Siblings {
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): { goldenReady(answer: GoldenAnswer): Promise<void> };
  getByName(name: string): { goldenFor(box: string, lost?: string): Promise<GoldenAnswer> };
}

/** By the tag alone: a namespace's members are the platform's, and an entrypoint is told apart only by its tag (M2). */
const NamespaceSchema = v.custom<Siblings>((entry) => Object.prototype.toString.call(entry) === NAMESPACE_TAG);

/** A Worker's exports or env, read by name. */
const BindingsSchema = v.record(v.string(), v.unknown());

/** An R2 binding as the store reads it. */
const BucketSchema = v.custom<R2Bucket>((bound) => v.is(v.looseObject({ get: v.function(), list: v.function() }), bound));

/** The registry credentials a host's env supplies (D65): a Containers token and the account it is scoped to. */
const RegistryEnvSchema = v.object({ DEVBOX_REGISTRY_TOKEN: v.pipe(v.string(), v.minLength(1)), CLOUDFLARE_ACCOUNT_ID: v.pipe(v.string(), v.minLength(1)) });

/** A box with nothing to start from waits on the golden object, and is ready as its answer says (D65, D79). */
type BaseWait = Extract<GoldenAnswer, { readonly kind: 'pending' }>;

const BaseWaitSchema = v.object({
  kind: v.literal('pending'),
  reason: v.string(),
  building: v.optional(v.object({ step: v.nullable(v.string()) })),
});

/** A classified recovery obligation; executed outside the restore block. */
const RECOVERY_ACTION_KEY = 'devbox:recovery-action';


/** The in-memory interaction stamp serves this activation; throttled writes preserve it
 *  across eviction without a durable write per call. */
const INTERACTION_PERSIST_INTERVAL_MS = 30_000;


/** A restore step's `onLate`: the race already answered `late`, so its eventual outcome is only logged. */
function logLate(step: string): (failure: LateStartFailure) => void {
  return (failure) => {
    console.error(`[devbox] ${step} outran its allowance; it later settled with: ${describe({ cause: failure.cause })}`);
  };
}

interface PreviewSite {
  readonly host: string;
  readonly name: string;
}

function previewUrl(port: number, site: PreviewSite, token: string): string {
  return `https://${String(port)}-${site.name}-${token}.${site.host}`;
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

/** The name the box was reached by, kept because a box woken by its id alone has none (D86). */
const NAME_KEY = 'devbox:name';

/** Constant-time: answer time says nothing of the token. */
function sameToken(held: string | undefined, given: string): boolean {
  if (held === undefined || held.length !== given.length) return false;
  let diff = 0;

  for (let at = 0; at < held.length; at += 1) diff |= held.charCodeAt(at) ^ given.charCodeAt(at);

  return diff === 0;
}

export class Devbox<Env = unknown> extends DurableObject<Env> {
  readonly #gateways: GatewayBindings;
  #storage: DevboxStorage | undefined;

  /** What this object last started the container from; undefined until it starts one (an adopted container). */
  #started: StartSource | undefined;
  #siblings: Siblings | undefined;
  #snapshotOwner: Snapshots | undefined;
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
  /** The desktop check in progress, which the owner's pane and every agent action await (D89): one run at a time. */
  #desktopCheck: DesktopCheck | undefined;
  /** Agents' desktop actions run one at a time, in arrival order. */
  readonly #desktopTurns = Semaphore.makeUnsafe(1);
  readonly #desktopLease = new DesktopLease();
  /** Opened by the attempt on its hook; every phase stamp reads it until the attempt settles.
   *  Memory only: a witness needing stamps past a reset keeps them via `onRestorePhase`. */
  #phaseClock: RestoreClock | undefined;
  #restoration: Restoration = { phase: 'unstarted' };
  /** Activation defers identity comparison until the control listener is reachable. */
  #adoptionPending = false;
  #lastInteraction: number | undefined;
  #lastInteractionPersisted = 0;
  /** One checkpoint at a time on this instance. */
  readonly #lane = createCheckpointLane();
  /** Public work with no resource name: shell commands and supervised starts.
   *  Resource and checkpoint work reports directly through their own lanes. */
  #activeCallers = 0;
  #openSockets = 0;
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
    const name: unknown = ctx.id.name;

    if (typeof name === 'string' && name.length > 0 && ctx.storage.kv.get(NAME_KEY) !== name) ctx.storage.kv.put(NAME_KEY, name);
    this.#activate();
  }

  /** Constructor work is synchronous storage, so no event waits on it; it does not yet
   *  have control-port proof. */
  #activate(): void {
    if (this.ctx.container?.running !== true) return;
    const parked = this.ctx.storage.kv.get<SettledRestoration>(SETTLED_KEY);

    // A park made under another deploy is lifted: that deploy may be the change its refusal waits on (D94).
    if (parked?.phase === 'unattached' && !parked.retry && parked.version !== this.#version()) this.ctx.storage.kv.delete(SETTLED_KEY);
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

  /** Turnover needs a container answer that refutes the stamped boot id; absent rows prove nothing. */
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

  /** The name of the R2 binding the box keeps its disk and the pinned tools in. The box reads `env[store]`, and the
   *  gateway resolves the same name, which a store mount records as its bucket (D41). */
  protected get store(): string {
    return 'DEVBOX_STORE';
  }

  /** The bucket bound as `store`; undefined where the Worker binds none. */
  #bucket(): R2Bucket | undefined {
    const env = v.safeParse(BindingsSchema, this.env);
    const bound = env.success ? v.safeParse(BucketSchema, env.output[this.store]) : undefined;

    return bound?.success === true ? bound.output : undefined;
  }

  /**
   * The boxes of this object's own namespace. The platform names no object's namespace: no member of `ctx` or of the
   * id says which export it is, and the class name is not the export name, since a bundler renames classes. So it is
   * the namespace export that accepts this object's id, every other refusing it (D85; armada 20261013160711-ee86dcc5).
   */
  #ownNamespace(): Siblings | undefined {
    if (this.#siblings !== undefined) return this.#siblings;
    const own = this.ctx.id.toString();
    const exported = v.safeParse(BindingsSchema, this.ctx.exports);

    for (const entry of exported.success ? Object.values(exported.output) : []) {
      const namespace = v.safeParse(NamespaceSchema, entry);

      if (namespace.success && Result.isSuccess(Result.try(() => namespace.output.idFromString(own)))) return this.#siblings = namespace.output;
    }

    return undefined;
  }

  /** What a start needs before the platform is asked: the store the golden's tools come from, and this box's own
   *  namespace. Either missing is a refusal naming what to add, not a wait (D85). */
  #startable(): Siblings | DevboxError {
    if (this.#bucket() === undefined) return new DevboxError('configuration', this.#unboundStore());

    return this.#ownNamespace() ?? new DevboxError('configuration', NO_NAMESPACE);
  }

  protected get toolsPin(): string {
    return artifact.tools.sha256;
  }

  /** `lost`: a golden the platform refused the asking box. */
  goldenFor(box: string, lost?: string): Promise<GoldenAnswer> {
    return settle(goldenFor(this.#goldenPorts(), box, lost));
  }

  /** Returns once the golden for the pinned tools is verified. */
  ensureGolden(): Promise<string> {
    return settle(this.#buildGolden(false).pipe(Effect.map(state => state.current?.id ?? '')));
  }

  devboxGolden(keepAlive: boolean): Promise<void> {
    return settle(this.#buildGolden(keepAlive).pipe(Effect.asVoid));
  }

  #buildGolden(keepAlive: boolean) {
    return Effect.gen({ self: this }, function* () {
      const state = yield* buildGolden(this.#goldenPorts(), keepAlive);
      const next = state.current === undefined ? undefined : state.current.takenAt + GOLDEN_REFRESH_MS - Date.now();

      if (next !== undefined) yield* attempt('io', () => this.armAlarm(GOLDEN_REFRESH_CALLBACK, Math.max(0, next / 1000)));

      return state;
    });
  }

  #refreshTools(): Effect.Effect<void, DevboxError> {
    return refreshTools({ pin: this.toolsPin, exec: (command) => this.#rawExec(command, DEVBOX_RUNTIME_DIR), pipe: (key, path) => this.#pipeParts(key, path) });
  }

  #pipeParts(key: string, path: string): Effect.Effect<void, DevboxError> {
    const bucket = this.#bucket();

    if (bucket === undefined) return Effect.fail(new DevboxError('configuration', this.#unboundStore()));

    return pipeParts({ get: async (wanted) => await bucket.get(wanted), container: this.#container() }, key, path);
  }

  #unboundStore(): string {
    return `bind an R2 bucket as \`${this.store}\`, or override \`store\``;
  }

  #goldenPorts(): GoldenPorts {
    const container = () => this.#container();

    return {
      tools: this.toolsPin,
      read: () => {
        const held = v.safeParse(GoldenStateSchema, this.ctx.storage.kv.get(GOLDEN_KEY));

        return held.success ? held.output : { waiting: [], retiring: [] };
      },
      write: (state) => { this.ctx.storage.kv.put(GOLDEN_KEY, state); },
      start: async (from) => {
        if (container().running) await this.#destroyGoldenContainer();
        const options = { instance: instanceOf(this.defaultSize), enableInternet: false, entrypoint: ['sleep', 'infinity'] };
        container().start('image' in from ? { ...options, image: from.image } : { ...options, containerSnapshot: { id: from.snapshot } });
        keepStartRefusal(container());
        await firstExec(container(), AbortSignal.timeout(120_000));
      },
      exec: async (command) => decoded(await (await container().exec(['/bin/bash', '-c', command])).output()),
      pipe: (key, path) => this.#pipeParts(key, path),
      snapshot: async (name) => (await container().snapshotContainer({ name })).id,
      destroy: () => this.#destroyGoldenContainer(),
      build: () => this.armAlarm(GOLDEN_BUILD_CALLBACK, 0),
      tell: (box, answer) => {
        const boxes = this.#ownNamespace();

        return boxes === undefined ? Effect.fail(new DevboxError('configuration', NO_NAMESPACE)) : attempt('io', () => boxes.get(boxes.idFromString(box)).goldenReady(answer));
      },
      delete: (ref, owe) => this.snapshotRegistry?.delete(ref, owe),
      now: () => Date.now(),
    };
  }

  async #destroyGoldenContainer(): Promise<void> {
    if (this.#container().running) await this.#container().destroy();
    await this.#awaitContainerStopped();
  }

  /** The golden object's last answer while this box has nothing to start from. */
  get #awaitingGolden(): BaseWait | undefined {
    return parsedOrNull(BaseWaitSchema, this.ctx.storage.kv.get<StoredValue>(AWAITING_GOLDEN_KEY)) ?? undefined;
  }

  set #awaitingGolden(wait: BaseWait | undefined) {
    if (wait === undefined) this.ctx.storage.kv.delete(AWAITING_GOLDEN_KEY);
    else this.ctx.storage.kv.put(AWAITING_GOLDEN_KEY, wait);
  }

  async goldenReady(answer: GoldenAnswer): Promise<void> {
    if (this.#awaitingGolden === undefined) return;

    if (answer.kind === 'pending') {
      this.#awaitingGolden = answer;

      return;
    }

    this.#awaitingGolden = undefined;
    await this.devboxStartup();
  }

  /** The registry dead snapshots are deleted from (D65): a Containers token (Account > Containers > Edit) and its
   *  account, read from the env as `DEVBOX_REGISTRY_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Without both, they wait. */
  protected get registry(): { readonly token: string; readonly account: string } | undefined {
    const supplied = v.safeParse(RegistryEnvSchema, this.env);

    return supplied.success ? { token: supplied.output.DEVBOX_REGISTRY_TOKEN, account: supplied.output.CLOUDFLARE_ACCOUNT_ID } : undefined;
  }

  protected get snapshotRegistry(): SnapshotRegistry | undefined {
    const registry = this.registry;

    return registry === undefined ? undefined : snapshotRegistry({ ...registry, fetch: (input, init) => fetch(input, init) });
  }

  protected get snapshotWakeCutoverMs(): number {
    return 10_000;
  }

  protected get policy(): DevboxPolicy {
    return DEFAULT_DEVBOX_POLICY;
  }

  /** Override to keep `target/` or `dist/` when they are the work; a larger base costs attach
   *  nothing because layers mount lazily. */
  protected get archiveExcludes(): readonly string[] {
    return DEFAULT_EXCLUDES;
  }

  /** The zone preview hosts are served under, `DEVBOX_PREVIEW_HOST` by default. Without one, exposing a port is
   *  refused and a restart re-exposes none. */
  protected get previewHost(): string | undefined {
    const zone = v.safeParse(ZoneSchema, this.env);

    return zone.success ? zone.output.DEVBOX_PREVIEW_HOST : undefined;
  }

  /** The name the box was reached by (`getByName`); a box only ever reached by its id has none, so no host names it. */
  protected get previewName(): string | undefined {
    return this.ctx.storage.kv.get<string>(NAME_KEY);
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

  /** A benchmark box turns them off, so no ambient tick pre-empts the driver's own. */
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

  async #startNative(inputs: StartInputs, source: StartSource | undefined): Promise<void> {
    if (this.#closed) throw new DevboxError("io", DESTROYED_START);
    const container = this.#container();
    const generation = this.#generation;
    // No await separates teardown admission from the platform start. Native exec never starts one.
    const wasRunning = container.running;

    if (!wasRunning && source !== undefined) {
      // D50: the one start boundary.
      this.ctx.storage.kv.put(RUNNING_SIZE_KEY, inputs.size);
      this.#startFrom(container, inputs, source);
    }

    const cancel = new AbortController();

    const run = (async () => {
      if (!await this.#admit(container, cancel.signal, inputs)) return;

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

  get #snapshots(): Snapshots {
    return this.#snapshotOwner ??= new Snapshots({
      kv: this.ctx.storage.kv,
      base: () => GOLDEN_BASE,
      chainRev: () => {
        const chain = v.safeParse(DiskChainStateSchema, this.ctx.storage.kv.get(DISK_STATE_KEY));

        return chain.success ? chain.output.rev : undefined;
      },
      take: () => this.#container().snapshotContainer({ name: `${this.ctx.id.toString()}-${String(Date.now())}` }),
      registry: () => this.snapshotRegistry,
    });
  }

  /** Its own snapshot, else the golden, else wait to be told (D65). */
  async #startSource(boxes: Siblings, lost?: string): Promise<StartSource | BaseWait> {
    const own = lost === undefined ? this.#snapshots.wake() : undefined;

    if (own !== undefined) return { kind: 'own', id: own, boxes };
    const answer = await boxes.getByName(GOLDEN_NAME).goldenFor(this.ctx.id.toString(), lost);

    return answer.kind === 'ready' ? { kind: 'golden', id: answer.id, boxes } : answer;
  }

  #startFrom(container: Container, inputs: StartInputs, source: StartSource): void {
    this.#started = source;
    this.#awaitingGolden = undefined;
    this.#snapshots.started(source.kind === 'own' ? source.id : undefined);
    container.start({ containerSnapshot: { id: source.id }, entrypoint: GOLDEN_ENTRYPOINT, instance: instanceOf(inputs.size), enableInternet: this.enableInternet });
    keepStartRefusal(container);
  }

  /** A snapshot start that fails or misses the cutover falls back to the next source and the chain. */
  async #admit(container: Container, signal: AbortSignal, inputs: StartInputs): Promise<boolean> {
    const started = this.#started;

    if (started !== undefined) {
      // Cleared once settled: a later abort killed the image's container (D64).
      const cutover = new AbortController();
      const timer = setTimeout(() => { cutover.abort(new DevboxError('io', 'the snapshot start was not admitted within the cutover')); }, this.snapshotWakeCutoverMs);
      const [woke] = await Promise.allSettled([firstExec(container, AbortSignal.any([signal, cutover.signal]))]);
      clearTimeout(timer);

      if (woke.status === 'fulfilled') return true;

      // No room is no verdict on the snapshot: it stays the source, and the exec below fails in the platform's words, so
      // the admission retries (staging, 2026-10-08).
      if (!isCapacityRefusal({ cause: woke.reason }) && !await this.#cutOver(container, inputs, woke.reason, started)) return false;
    }

    await firstExec(container, signal);

    return true;
  }

  /** Leaves a snapshot that failed to wake for the next source; false while the golden that replaces it is pending. */
  async #cutOver(container: Container, inputs: StartInputs, failed: LateStartFailure['cause'], started: StartSource): Promise<boolean> {
    this.#trace('startup.snapshot.cutover', { from: started.kind, reason: describe({ cause: failed }) });
    const golden = started.kind === 'golden' ? started.id : undefined;
    await container.destroy();
    await this.#awaitContainerStopped();

    if (golden === undefined) {
      this.#snapshots.supersede();
      unawaited(this.#snapshots.sweep(), 'sweeping dead snapshots');
    }

    const next = await this.#startSource(started.boxes, golden);

    if (next.kind === 'pending') {
      this.#awaitingGolden = next;

      return false;
    }

    this.#startFrom(container, inputs, next);

    return true;
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
        await this.#settle(settledRestoration([reason], 'pending'));
        await this.#record('process', reason);
      } else {
        const recoveryGeneration = this.#generation;
        const claim = await this.#claimRecovery();
        await this.#recover(recoveryGeneration, claim, { cause });
      }
    }

    await this.#armContainerSchedules();

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
      // A park keeps the deploy it was made under (D94).
      await this.ctx.storage.put(SETTLED_KEY, restoration.phase === 'unattached' && !restoration.retry ? { ...restoration, version: this.#version() } : restoration);
    } else {
      await this.ctx.storage.delete(SETTLED_KEY);
    }

    if (this.#owns(generation)) this.#restoration = restoration;
  }

  /** The startup row goes through `#armStartup`, not a bare `#arm`: a box with nothing restored
   *  would otherwise arm a successor every second; `#arm` is future-only for periodic rows. */
  async #armContainerSchedules(): Promise<void> {
    await this.#armStartup();

    if (this.ambientCheckpoints) {
      await this.armAlarm(CHECKPOINT_CALLBACK, Math.ceil(this.policy.checkpointIntervalMs / 1000));
    }

    await this.armAlarm(HEARTBEAT_CALLBACK, this.policy.heartbeatSeconds);
  }


  /** A boot-id mismatch is the only replacement signal: fence every read, count and write. */
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

  /** One budget for all phases (D19): an attach overrun replaces the identity; a later step's
   *  exhaustion is reported in `unready` and never re-arms. */
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
    return { size: this.#size(), store: this.#bucket() !== undefined, version: this.#version(), internet: this.enableInternet };
  }

  #version(): string | null {
    return this.workerVersion ?? null;
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
      const startable = startsContainer ? this.#startable() : undefined;

      if (startable instanceof DevboxError) {
        await this.#refuseAdmission({ generation, since, startsContainer, inputs }, { cause: startable });

        return;
      }

      const source = startable === undefined ? undefined : await this.#startSource(startable);

      if (source?.kind === 'pending') {
        this.#awaitingGolden = source;
        this.#trace('startup.admit.exit', { generation, ms: Date.now() - since, admitted: false, awaitingGolden: source.reason });

        return;
      }

      await this.#startNative(inputs, source);

      if (this.#awaitingGolden !== undefined) return;

      this.#refused = undefined;
      this.ctx.storage.kv.delete(START_REFUSED_KEY);
      this.#trace('startup.admit.exit', { generation, ms: Date.now() - since, admitted: true, owned: this.#owns(generation) });
    } catch (thrown) {
      await this.#refuseAdmission({ generation, since, startsContainer, inputs }, { cause: thrown });
    }
  }

  /** An admission that did not start: retried only where waiting can change the answer, else parked once (D94, amending
   *  D47's terminal classes). */
  async #refuseAdmission(
    { generation, since, startsContainer, inputs }: { readonly generation: number; readonly since: number; readonly startsContainer: boolean; readonly inputs: StartInputs },
    failed: { readonly cause: unknown },
  ): Promise<void> {
    const reason = describe(failed);
    this.#trace('startup.admit.exit', {
      generation, ms: Date.now() - since, admitted: false, owned: this.#owns(generation),
      running: this.ctx.container?.running === true, reason,
    });

    if (!this.#owns(generation)) {
      console.error(`[devbox] superseded admission refused: ${reason}`);

      return;
    }

    const failure = classifyRecovery(failed);

    // A start that fails the same way every time is refused once, not re-armed each second: staging 7e411119d's box
    // named itself into a read-only /etc/hostname, an unclassified failure, and took 1,873 alarms in 30 minutes (D94).
    if (!waitingCanChange(failed)) {
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
        && this.#restoration.bootStamp !== 'done';

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

    // A refusal is a park, kept with the deploy it was made under, as `#settle` keeps one (D94).
    const restoration = decision.action === 'refuse'
      ? { phase: 'unattached', reason, retry: false, version: this.#version() } as const
      : { phase: 'unattached', reason, retry: true } as const;

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
        // Terminal: the abandoned work still runs there. Only a caller asking by name may attach.
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

  /** A port is exposed only once its listener answers; each failure is recorded and the phase continues. */
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

      const started = await steps.run(
        (current) => this.#supervised().run({ kind: 'restore', spec }, { generation, current }),
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

    const site = this.#previewSite(spec.port);

    if (site instanceof DevboxError) {
      steps.skip();
      await this.#record('port', site.message, { port: spec.port });

      return false;
    }

    const exposed = await steps.run(
      // The restoration is the readiness gate, so it must not wait on that gate
      // nor queue behind a caller already waiting at it (see `#restartWorkloads`).
      async () => await this.#expose(spec.port, site, { token: spec.token, name: spec.name }),
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
      const endedCommands = this.#running.size;
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

    const base = this.#awaitingGolden;

    // The step its base is at rides along: the caller holds while the build moves on (D79).
    if (base !== undefined && this.ctx.container?.running !== true) return base;
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

  /** Every command runs as `setsid -w bash -c`, in its own group, which `killExec` ends (D37, D69), from
   *  `DEVBOX_WORKDIR` unless `cwd` says otherwise: commands landing outside it are not saved. With an `execId` it runs
   *  once per id, and a retry reads the first answer until `releaseExec` (D48); without one the box claims nothing. */
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { execId } = options;
    const answered = execId === undefined ? undefined : this.#answers.get(execId);

    if (answered !== undefined) return settle(Deferred.await(answered));

    if (execId !== undefined && !this.#claimLaunch(execId)) return settle(Effect.fail(launchUnknown(execId)));
    const id = execId ?? crypto.randomUUID();
    const running: RunningExec = { cancelled: false };
    const answer = execId === undefined ? undefined : Deferred.makeUnsafe<ExecResult, DevboxError>();
    this.#running.set(id, running);

    if (answer !== undefined) this.#answers.set(id, answer);

    return settle(this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      const process = yield* this.#spawn(command, options, running);

      return decoded(yield* attempt('process', () => process.output()));
    })).pipe(
      Effect.exit,
      Effect.tap((exit) => (answer === undefined ? Effect.void : Deferred.done(answer, exit))),
      Effect.flatten,
      Effect.ensuring(Effect.sync(() => { this.#running.delete(id); })),
    ));
  }

  /** The same native listener command/parser used during restore; core receives evidence, not a curl protocol. */
  probePort(port: number): Promise<boolean> {
    return settle(Effect.gen({ self: this }, function* () {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return yield* Effect.fail(new DevboxError('invalid-input', `invalid port ${String(port)}`));
      }

      const answer = yield* attempt('io', () => this.exec(healthProbeCommand(port), { cwd: DEVBOX_WORKDIR }));

      return !healthProbeSilent(answer.stdout);
    }));
  }

  /** Forgets an `execId`: its answer and its claim. */
  releaseExec(execId: string): Promise<void> {
    return settle(attempt('io', async () => {
      this.#answers.delete(execId);
      this.ctx.storage.kv.delete(`${EXEC_CLAIM_PREFIX}${execId}`);
    }));
  }

  #claimLaunch(execId: string): boolean {
    const key = `${EXEC_CLAIM_PREFIX}${execId}`;

    if (this.ctx.storage.kv.get(key) !== undefined) return false;
    this.ctx.storage.kv.put(key, true);

    return true;
  }

  /** `exec` as framed records, read with `readExec`; cancelling the stream ends the command. A stream keeps no answer,
   *  so a retry under the same `execId` is `indeterminate`. */
  execStream(command: string, options: ExecOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const { execId } = options;

    if (execId !== undefined && !this.#claimLaunch(execId)) return settle(Effect.fail(launchUnknown(execId)));
    const id = execId ?? crypto.randomUUID();
    const running: RunningExec = { cancelled: false };
    this.#running.set(id, running);
    const leave = this.#arrive();
    const gone = Promise.withResolvers<void>();
    const ended = (): void => { this.#running.delete(id); leave(); gone.resolve(); };

    return settle(this.#spawn(command, options, running).pipe(
      Effect.map((process) => {
        unawaited(process.exitCode.finally(ended), `exec ${id} ended without its exit code`);

        return execRecords(process, {
          exited: ended,
          cancelled: async () => { await this.killExec(id); await gone.promise; },
        });
      }),
      Effect.onError(() => Effect.sync(ended)),
    ));
  }

  /** A command string runs in bash; an argv runs as given, so its words need no quoting (the desktop's, D89). */
  #spawn(command: string | readonly string[], { cwd, env }: ExecOptions, running: RunningExec): Effect.Effect<ExecProcess, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const { container } = yield* attempt('not-ready', () => this.#ensureReady(this.#teardowns));

      if (running.cancelled) return yield* Effect.fail(new DevboxError('cancelled', 'computer exec cancelled before admission'));
      const argv = typeof command === 'string' ? ['/bin/bash', '-c', command] : command;
      // Its own group, which its kill ends (D69).
      const started = yield* attemptSync('process', () => launch(container, ['setsid', '-w', ...argv], { cwd, env }));
      running.started = started;

      return yield* attempt('process', () => started);
    });
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

  /** Ends the command's process tree; false when it had already exited. */
  killExec(execId: string): Promise<boolean> {
    return settle(Effect.gen({ self: this }, function* () {
      const running = this.#running.get(execId);

      if (running === undefined) return false;
      running.cancelled = true;
      running.cancel?.abort();
      const started = running.started;

      if (started === undefined) return true;
      const container = this.ctx.container;

      if (container?.running !== true) return false;
      const { pid } = yield* attempt('process', () => started);
      const ended = yield* attempt('process', async () => await (await container.exec(['sh', '-c', `${END_TREE}\nend_tree "$1"`, 'kill-tree', String(pid)])).output());

      if (ended.exitCode === 3) return false;

      if (ended.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `exec ${execId} was not ended: ${new TextDecoder().decode(ended.stderr)}`));

      return true;
    }));
  }

  readonly #running = new Map<string, RunningExec>();
  readonly #answers = new Map<string, Deferred.Deferred<ExecResult, DevboxError>>();

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

  /** Fence admissions, drain owned work, then commit, snapshot and stop. */
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

    if (ending) await Promise.allSettled([...this.#running.keys()].map((execId) => this.killExec(execId)));

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

    let warning: string | undefined;

    try {
      const listed = await this.#processes().list();
      const residents = new Set((await this.#procSpecs()).map(spec => spec.processId));

      if (!ending && listed.some(process => isProcessLive(process.status) && !residents.has(process.id))) {
        return { kind: 'failed', reason: 'the stop is refused: unmanaged commands are still running', bytes: undefined, movedBytes: undefined };
      }
    } catch (cause) {
      const reason = describe({ cause });

      // Never on a guess (D59).
      if (!ending) {
        return { kind: 'failed', reason: 'the stop is held while the process list is unreadable: ' + reason, bytes: undefined, movedBytes: undefined };
      }

      warning = 'the process list was unreadable, so an unobservable command may be stopped: ' + reason;
      this.#trace('quiesce.processes.unreadable', { reason });
      await this.#record('quiesce', warning);
    }

    // The stop ends every terminal session; what each showed and ran goes into the checkpoint first (D97).
    await this.#saveSessions();

    // The commit and the snapshot run beside the box's processes; the container's stop ends them.
    const committed = await this.#checkpoint('quiesce');
    const outcome = warning === undefined ? committed : { ...committed, reason: warning + (committed.reason === undefined ? '' : '; ' + committed.reason) };

    if (outcome.kind === 'failed') {
      await this.#record('checkpoint', `final checkpoint failed: ${outcome.reason ?? 'unknown'}`);

      return outcome;
    }

    await this.#restSnapshot();
    this.#invalidateGeneration();
    await this.#stopContainer();
    await this.#awaitContainerStopped();
    await this.#snapshots.sweep();

    return outcome;
  }

  async #restSnapshot(): Promise<void> {
    const [taken] = await Promise.allSettled([this.#snapshots.save()]);

    if (taken.status === 'rejected') await this.#record('quiesce', `the rest took no snapshot, so the next wake recovers from the backup: ${describe({ cause: taken.reason })}`);
  }


  /** An in-flight restore writes nothing durable after this, and no tick publishes after the
   *  discard; a stopped box never starts an instance to clean. */
  discardState(): Promise<void> {
    return settle(attempt('io', async () => {
      this.#invalidateGeneration();
      await this.#requireStorage().discard();
      await this.#snapshots.sweep();
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
      this.#awaitingGolden = undefined;

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
    return await settle(this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      yield* attempt('io', () => this.ensureReady());
      const result = yield* attempt('process', () => this.#supervised().run({ kind: 'start', command, cwd: cwd ?? DEVBOX_WORKDIR }));

      if (result.kind !== 'started') return yield* Effect.fail(new DevboxError('cancelled', 'supervised start was superseded'));
      // Its session is listed beside the person's own, by what it runs (D95).
      this.#recordJobSession(result.process.id, command, cwd ?? DEVBOX_WORKDIR);

      return { processId: result.process.id };
    })));
  }

  /** Native kill acknowledges both termination and absence; a failure keeps the launch record. */
  stopSupervised(processId: string): Promise<{ stopped: boolean }> {
    return settle(attempt('io', async () => {
      const arrived = this.#teardowns;
      await this.#ensureReady(arrived);
      const result = await this.#supervised().run({ kind: 'stop', processId });
      const ended = result.kind === 'stopped' && result.stopped;

      this.stampInteraction();

      // A stopped job's session goes with it: the shell under its output, and its tab (D95).
      if (ended) await this.#forgetJobSession(processId);

      return { stopped: ended };
    }));
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
          waiting: undefined,
          session: jobSessionId(spec.processId),
        });
      }

      const specIds = new Set(specs.map(spec => spec.processId));

      for (const live of await this.#processes().list()) {
        rows.set(live.id, {
          processId: live.id,
          pid: live.pid,
          status: live.waiting === undefined ? live.status : 'waiting for input',
          command: rows.get(live.id)?.command ?? live.command,
          restartable: specIds.has(live.id),
          waiting: live.waiting,
          session: specIds.has(live.id) ? jobSessionId(live.id) : undefined,
        });
      }

      this.stampInteraction();

      return [...rows.values()];
    }));
  }

  /** Must be asked before the first exposure: restarts re-expose each port with its stored
   *  token, so the first exposure must use the same token for the preview URL to survive. */
  portToken(port: number, name?: string): Promise<{ urlToken: string }> {
    const site = this.#previewSite(port);

    return settle(site instanceof DevboxError ? Effect.fail(site) : attempt('io', async () => {
      return await this.#resources.run(portScope(port), () => this.#portToken(port, name));
    }));
  }

  /** On the port's claim, not readiness: the token must exist before the exposure it names. */
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

  #unready(): string | undefined {
    const refused = this.#refused;

    if (this.#restoration.phase === 'unstarted' && refused?.generation === this.#generation) {
      return `the platform refused this box a container: ${refused.reason}`;
    }

    return unreadyOf(this.#restoration, this.#gateRestore !== undefined);
  }

  /** A read: it starts, arms and wakes nothing. A running container an object reset left is adopted first,
   *  so the report names the restoration it carries. */
  devboxState(): Promise<DevboxReport> {
    return settle(attempt('io', async () => {
      if (this.ctx.container?.running === true) await this.#resolveAdoption();

      const [supervised, ports, incidents] = await Promise.all([
        this.#procSpecs(),
        this.#portSpecs(),
        this.ctx.storage.list<IncidentRow>({ prefix: INCIDENT_PREFIX }),
      ]);

      return {
        running: this.ctx.container?.running === true,
        restoration: this.#restoration.phase,
        ready: this.#quiescing === undefined && this.#restoration.phase === 'attached' && this.#gateRestore === undefined,
        unready: this.#quiescing === undefined ? this.#unready() : QUIESCING,
        lastInteractionAt: this.#lastInteraction
          ?? await this.ctx.storage.get<number>(LAST_INTERACTION_KEY),
        quietSince: await this.ctx.storage.get<number>(QUIET_SINCE_KEY),
        chain: parsedOrNull(DiskChainStateSchema, this.ctx.storage.kv.get<StoredValue>(DISK_STATE_KEY)),
        snapshot: this.#snapshots.record,
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

  /** A write that lands only over the bytes it names (`expected`: their sha256; null: no file there), compared and
   *  written in one guest process (`file-digest-write.ts`); `operation` names it across every send, and `settled` the
   *  caller's operations whose answers it holds. */
  async writeFileIfDigest({ path, contentBase64, ...write }: DigestWriteRequest) {
    return await settle(this.#claimed(pathScopes({ path, membership: true }),
      writeFileIfDigestInGuest(this.#container(), { path, data: Buffer.from(contentBase64, 'base64'), ...write })).pipe(Effect.mapError(fileFault)));
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
    return await settle(this.#claimed(pathScopes({ path, recursive: options?.recursive === true }),
      readDirectory(this.#container(), path, options)).pipe(Effect.mapError(fileFault)));
  }

  statFile(path: string, options?: { readonly follow?: boolean }): Promise<FileMetadata> {
    return settle(this.#claimed(pathScopes({ path }), attempt('file', async () => {
      const files = this.#files();
      const stat = await (options?.follow === false ? files.lstat(path) : files.stat(path));

      return {
        type: stat.type, size: Number(stat.size), mode: stat.mode, mtimeMs: stat.modifiedAt.getTime(),
        uid: stat.uid, gid: stat.gid, atimeMs: stat.accessedAt.getTime(), ctimeMs: stat.changedAt.getTime(),
      };
    })).pipe(Effect.mapError(fileFault)));
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

  /** Published at `https://<port>-<box name>-<token>.<previewHost>`. Refused before a token is minted, so a port
   *  the box cannot name leaves no row a restart would re-expose: `configuration` without a preview host or a name,
   *  `invalid-input` for the desktop's port or a name no host label can carry. */
  async exposePort(port: number, options: { name?: string; token?: string } = {}) {
    const site = this.#previewSite(port);

    return await settle(site instanceof DevboxError ? Effect.fail(site) : this.#claimed(portScope(port), attempt('io', () => this.#expose(port, site, options))));
  }

  /** Revocation touches only this object's preview rows, never the container, so it skips
   *  readiness: a port must stay revocable on a box that is not attached. */
  unexposePort(port: number): Promise<void> {
    return settle(attempt('io', async () => {
      this.ctx.storage.kv.delete(EXPOSED_PREFIX + port);

      return await this.#resources.run(portScope(port), async () => {
        await this.ctx.storage.delete(`${PORT_SPEC_PREFIX}${port}`);
        this.stampInteraction();
      });
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
      case GOLDEN_BUILD_CALLBACK: await this.devboxGolden(false); break;
      case GOLDEN_REFRESH_CALLBACK: await this.devboxGolden(true); break;
      default: throw new DevboxError("io", `unknown devbox alarm: ${callback}`);
    }
  }
  /** An exec on a stopped container would start a blank one, and save its empty disk. */
  async #runCheckpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    if (this.ctx.container?.running !== true) {
      return { kind: 'skipped', reason: 'container is not running', bytes: undefined, movedBytes: 0 };
    }

    return await this.#requireStorage().checkpoint(kind);
  }

  /** A failure becomes an incident: the alarm loop reduces a throw to a console line.
   *  Not re-armed while down; waking a container would keep it alive. */
  devboxCheckpoint(): Promise<void> {
    return settle(attempt('io', async () => {
      // With the ambient schedule disabled the row is never armed: a call here is stray, so the chain ends.
      if (this.#quiescing !== undefined || !this.ambientCheckpoints) return;
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

        try {
          // The boot-id read is the liveness ping too: one container call, not two (D28).
          observed = await this.#readBootId();
        } catch (error) {
          const reason = describe({ cause: error });
          console.error(`[devbox] heartbeat ping failed: ${reason}`);
          await this.#tick({ running: true, ping: `failed: ${reason}`, armedNext: true });

          return beat;
        }

        // Only a settled restoration: mid-wake the row and a fresh instance always mismatch.
        if (await this.#containerWasReplaced({ bootId: observed })) {
          this.#invalidateGeneration();
          await this.#tick({ running: true, ping: 'ok', armedNext: true, replaced: true });
          await this.#armStartup();

          return beat;
        }

        const now = Date.now();

        // Each lane covers its own tail; shell commands and supervised starts count via `#activeCallers`.
        const backgroundWork = this.#quiescing !== undefined || this.#activeCallers !== 0 || this.#openSockets !== 0
          || this.#resources.busy()
          || this.#lane.busy()
          || this.#startup !== undefined
          || this.#gateRestore !== undefined;

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

        if (decision.action !== 'quiesce') {
          await this.#tick({ running: true, ping: 'ok', armedNext: true, decision: decision.action });

          return beat;
        }

        const running = await this.#runningForRest();

        if (running.unreadable !== undefined || running.live.length > 0) {
          const note = await this.#askToRest(running, now);
          await this.#tick({ running: true, ping: 'ok', armedNext: true, decision: 'ask', ...(note !== undefined && { note }) });

          return beat;
        }

        // A quiesce deliberately arms nothing: see `quiesce`.
        await this.#tick({ running: true, ping: 'ok', armedNext: false, decision: 'quiesce' });
        await this.ctx.storage.delete(REST_ASK_KEY);

        // The next beat retries a refused stop with fresh evidence.
        return (await this.quiesce()).kind === 'failed' ? beat : null;
      });
    }));
  }

  async #runningForRest(): Promise<RunningForRest> {
    try {
      const supervised = new Set((await this.#procSpecs()).map((spec) => spec.processId));
      const live = (await this.#processes().list()).filter((row) => isProcessLive(row.status));

      return { live: live.map((row) => ({ ...row, supervised: supervised.has(row.id) })), unreadable: undefined };
    } catch (error) {
      return { live: [], unreadable: describe({ cause: error }) };
    }
  }

  async #askToRest(running: RunningForRest, now: number): Promise<string | undefined> {
    const window = this.policy.idleMs + this.policy.quietConfirmMs;
    const asked = await this.ctx.storage.get<number>(REST_ASK_KEY);

    if (asked !== undefined && now - asked < window) return running.unreadable;
    await this.ctx.storage.put(REST_ASK_KEY, now);
    await this.#record('rest', restAskText(running, await this.#restDetails(running.live), Math.round(window / 60_000)));

    return running.unreadable;
  }

  async #restDetails(live: readonly RestProcess[]): Promise<ReadonlyMap<number, RestDetail>> {
    const pids = live.flatMap((row) => (row.pid === undefined ? [] : [row.pid]));

    if (pids.length === 0) return new Map();

    try {
      const listeners = await this.portListeners('') ?? [];
      const read = await this.#execute(`ps -o pid=,pgid=,etimes= -p ${[...pids, ...listeners.map((row) => row.pid)].join(',')} || true`);
      const groups = new Map(read.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)).map(([pid = 0, pgid = 0, age = 0]) => [pid, { pgid, age }] as const));

      return new Map(pids.map((pid) => [pid, {
        ageSeconds: groups.get(pid)?.age,
        ports: [...new Set(listeners.filter((row) => row.pid === pid || groups.get(row.pid)?.pgid === pid).map((row) => row.port))],
      }]));
    } catch (error) {
      console.error(`[devbox] the rest ask lists processes without ages or ports: ${describe({ cause: error })}`);

      return new Map();
    }
  }

  /** D59: refused with no ask pending. */
  answerRest(answer: RestAnswer): Promise<RestAnswered> {
    return settle(attempt('io', async (): Promise<RestAnswered> => {
      if (await this.ctx.storage.get<number>(REST_ASK_KEY) === undefined) {
        return { kind: 'refused', reason: 'no rest ask is pending: the computer is in use or already resting' };
      }

      await this.ctx.storage.delete(REST_ASK_KEY);

      if (answer === 'keep') {
        const now = Date.now();
        this.stampInteraction();
        await this.ctx.storage.put(LAST_INTERACTION_KEY, now);

        return { kind: 'kept', askAgainAfterMs: this.policy.idleMs + this.policy.quietConfirmMs };
      }

      const outcome = await this.#quiesce(true);

      return outcome.kind === 'failed' ? { kind: 'failed', reason: outcome.reason ?? 'the final checkpoint failed' } : { kind: 'resting' };
    }));
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

  /** Maintenance renews inactivity but is not use; only callers stamp idle time. */
  protected stampInteraction(): void {
    this.#renewContainer();
    const now = Date.now();
    this.#lastInteraction = now;

    if (now - this.#lastInteractionPersisted < INTERACTION_PERSIST_INTERVAL_MS) return;
    this.#lastInteractionPersisted = now;
    // Not awaited: a lost write costs at most one heartbeat cycle of lease.
    unawaited(this.ctx.storage.put(LAST_INTERACTION_KEY, now), 'lease stamp was not persisted');
  }

  /** Commands and supervised starts have no resource lane (no safe scope / no process yet),
   *  so this counter keeps them live to the heartbeat from call entry through settlement. */
  #withActiveCaller<T>(operation: Effect.Effect<T, DevboxError>): Effect.Effect<T, DevboxError> {
    return Effect.suspend(() => {
      const leave = this.#arrive();

      return operation.pipe(Effect.ensuring(Effect.sync(leave)));
    });
  }

  #arrive(): () => void {
    this.#activeCallers += 1;
    this.stampInteraction();
    let left = false;

    return () => {
      if (left) return;
      left = true;
      this.#activeCallers -= 1;

      if (this.#activeCallers === 0) { this.#callersDrained?.resolve(); this.#callersDrained = undefined; }

      this.stampInteraction();
    };
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

  #buildStorage(): DevboxStorage {
    const bucket = this.#bucket();

    if (bucket === undefined) return new UnboundStorage(this.#unboundStore());

    return new DiskChainStorage(this.diskChain(this.#diskChainPorts(bucket)), {
      prepare: () => this.#refreshTools(),
      fromSnapshot: () => this.#started?.kind === 'own',
      recovered: async (restoredTo) => { await this.#record('recovered', recoveryNotice(restoredTo, this.archiveExcludes)); },
      discard: async () => {
        this.ctx.storage.kv.delete(DISK_STATE_KEY);
        this.#snapshots.supersede();

        // R2 pages at 1,000, refuses an empty delete (D64).
        for (let listed = await bucket.list({ prefix: `${chainStoreRoot(this.#boxPrefix())}/` }); listed.objects.length > 0;) {
          await bucket.delete(listed.objects.map(object => object.key));

          if (!listed.truncated) break;
          listed = await bucket.list({ prefix: `${chainStoreRoot(this.#boxPrefix())}/`, cursor: listed.cursor });
        }
      },
    });
  }

  protected diskChain(ports: DiskChainPorts): DiskChain {
    return diskChain(ports);
  }

  #diskChainPorts(bucket: R2Bucket): DiskChainPorts {
    const root = chainStoreRoot(this.#boxPrefix());
    const exec = (command: string) => this.#rawExec(command, DEVBOX_RUNTIME_DIR);

    return {
      exec,
      readState: async () => {
        const stored = await this.ctx.storage.get<StoredValue>(DISK_STATE_KEY);

        return stored === undefined ? null : v.parse(DiskChainStateSchema, stored);
      },
      writeState: async (state, expectedRev) => this.ctx.storage.transactionSync(() => settleSync(Effect.gen({ self: this }, function* () {
        const stored = yield* attemptSync('io', () => this.ctx.storage.kv.get<StoredValue>(DISK_STATE_KEY));
        const rev = stored === undefined ? null : (yield* attemptSync('io', () => v.parse(DiskChainStateSchema, stored))).rev;

        if (rev !== expectedRev) return yield* Effect.fail(chainAdvanced(expectedRev, rev));
        yield* attemptSync('io', () => this.ctx.storage.kv.put(DISK_STATE_KEY, state));
      }))),
      storeRoot: () => root,
      storeObjectUrl: (key) => storeObjectUrl(root, this.store, key),
      objectBytes: async (key) => (await bucket.head(key))?.size,
      deleteObjects: async (keys) => {
        await bucket.delete([...keys]);
      },
      mountStore: async () => {
        if ((await exec(`mountpoint -q ${STORE_MOUNT}`)).exitCode === 0) return;
        await this.#routes().unmount(STORE_MOUNT);
        await this.#routes().mount(STORE_MOUNT);
      },
      excludes: () => this.archiveExcludes,
      now: () => Date.now(),
      log: (message) => {
        console.log(`[devbox] ${message}`);
      },
    };
  }

  /** The Durable Object id is hex and unique per box: no escaping, no collision. */
  #boxPrefix(): string {
    return `boxes/${this.ctx.id.toString()}`;
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
    return this.#supervised().list();
  }

  async #portSpecs(): Promise<readonly PortExposureSpec[]> {
    return [...(await this.ctx.storage.list<PortExposureSpec>({ prefix: PORT_SPEC_PREFIX })).values()].filter((spec) => spec.port !== DESKTOP_PORT);
  }

  #routeClient: ContainerRoutes | undefined;

  #routes(): ContainerRoutes {
    return this.#routeClient ??= new ContainerRoutes({
      container: this.#container(), bindings: this.#gateways, files: this.#files(), prefix: chainStoreRoot(this.#boxPrefix()) + '/',
      internet: this.enableInternet,
    });
  }

  protected async outboundPolicy(): Promise<OutboundPolicy> { return { routes: {} }; }
  /** The name the box answers to, one DNS label of at most 63 characters, read at each start (D96); unset, the
   *  platform's 64-character container id, which no DNS label holds. */
  protected async hostname(): Promise<string | undefined> { return undefined; }
  /** The Worker version this object runs, read at construction and at each start: a start refused under another is asked
   *  again (D94). Unset, only a changed input or a caller's explicit ask lifts a refusal. */
  protected get workerVersion(): string | undefined { return undefined; }
  /** The mark at the centre of the desktop's wallpaper, an SVG document drawn in its own colour (D88); unset, none. */
  protected get desktopMark(): string | undefined { return undefined; }

  protected async configureContainer(reused = this.#adoptionPending || this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair'): Promise<void> {
    await this.#routes().configure(await this.outboundPolicy(), this.store, reused);
    this.#renewContainer();
    const name = await this.hostname();

    // The kernel keeps a name for the boot alone, so each start names the box again (D83, D96).
    if (name === undefined) return;
    const naming = await nameBox(this.#container(), name);

    if (!naming.named) this.#trace('name.unresolved', { name, detail: naming.detail });
  }

  getExposedPorts() {
    return settle(attempt('io', async () => {
      if (this.ctx.container?.running !== true) return [];
      const rows = await this.#portSpecs();
      const result: { port: number; name: string | undefined; url: string }[] = [];

      for (const spec of rows) {
        const site = this.#previewSite(spec.port);

        if (site instanceof DevboxError || this.ctx.storage.kv.get(EXPOSED_PREFIX + spec.port) !== spec.token) continue;
        result.push({ port: spec.port, name: spec.name, url: previewUrl(spec.port, site, spec.token) });
      }

      return result;
    }));
  }

  /** The port comes from the host and the path is the visitor's, `/_devbox/terminal` included (D60). */
  #preview(request: Request, { port, name, token }: PreviewAddress): Effect.Effect<Response, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const spec = yield* attempt('io', () => this.ctx.storage.get<PortExposureSpec>(`${PORT_SPEC_PREFIX}${port}`));

      if (port === DESKTOP_PORT || name !== this.previewName || spec === undefined || !sameToken(spec.token, token)) {
        return new Response('Preview not exposed', { status: 404 });
      }

      return yield* this.#withActiveCaller(attempt('io', async () => {
        await this.ensureReady();

        if (!sameToken(this.ctx.storage.kv.get<string>(EXPOSED_PREFIX + port), token)) return new Response('Preview not ready', { status: 503 });
        const target = new URL(request.url);
        target.protocol = 'http:';
        const [answered] = await Promise.allSettled([this.#container().getTcpPort(port).fetch(new Request(target.toString(), request))]);

        // A server that is not up is the preview's to show, not the box's to throw (staging, 2026-10-08).
        if (answered?.status !== 'fulfilled') {
          return new Response(`Nothing in this box answered on port ${String(port)}: ${describe({ cause: answered?.reason })}`, {
            status: 502, headers: { 'cache-control': 'no-store' },
          });
        }

        const answer = answered.value;

        return answer.webSocket ? this.#bridge(answer.webSocket, answer.headers) : answer;
      }));
    });
  }

  #desktop(request: Request): Effect.Effect<Response, DevboxError> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return Effect.succeed(new Response('WebSocket required', { status: 426 }));

    return this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      const { container } = yield* attempt('io', () => this.#ensureReady(this.#teardowns));

      yield* this.#desktopUp(request.signal);
      const server = `http://127.0.0.1:${String(DESKTOP_PORT)}`;
      const headers = new Headers(request.headers);
      headers.set('origin', server);
      const answer = yield* attempt('io', () => container.getTcpPort(DESKTOP_PORT).fetch(new Request(`${server}/websockify`, { headers })));

      return answer.webSocket ? this.#bridge(answer.webSocket, answer.headers) : answer;
    }));
  }

  /**
   * The desktop running, as the check finds it once it brought back what had died (D89). The first caller runs the check;
   * callers during it share its outcome. One whose `signal` stops waits no longer; the check's runner, stopped, ends its
   * run with `killExec` and settles once it has gone, so a check nobody waits on is ended and an X that stays alive and
   * never opens its port holds no call for good. From taking the check to letting it go nothing interrupts the runner:
   * a runner interrupted in between left the check owned by nobody, and every later call waited on it (a real box,
   * 2026-10-14, 270 s until the edge cancelled the call).
   */
  #desktopUp(signal: AbortSignal | undefined): Effect.Effect<DesktopScreen, DevboxError> {
    return Effect.uninterruptibleMask((restore) => Effect.suspend(() => {
      const shared = this.#desktopCheck;

      // A check its own caller stopped answers that caller; one still waiting starts the next.
      if (shared !== undefined) {
        return restore(untilStopped(Deferred.await(shared.done), signal, 'waiting for the desktop')).pipe(
          Effect.catchIf((failure) => failure.code === 'cancelled' && signal?.aborted !== true, () => this.#desktopUp(signal)),
        );
      }

      if (signal?.aborted === true) return Effect.fail(stopped('waiting for the desktop'));
      const check: DesktopCheck = { id: `desktop-check-${crypto.randomUUID()}`, done: Deferred.makeUnsafe() };
      const running: RunningExec = { cancelled: false };
      const stop = (): void => { unawaited(this.killExec(check.id), 'ending a desktop check its caller stopped'); };

      this.#desktopCheck = check;
      this.#running.set(check.id, running);
      signal?.addEventListener('abort', stop, { once: true });

      // A stop ends its process, and the check answers once it has gone. Forgotten before its waiters wake, so a later
      // stop ends no process.
      return this.#checkDesktop(running).pipe(
        Effect.exit,
        Effect.tap(() => Effect.sync(() => {
          signal?.removeEventListener('abort', stop);
          this.#running.delete(check.id);

          if (this.#desktopCheck === check) this.#desktopCheck = undefined;
        })),
        Effect.tap((exit) => Deferred.done(check.done, exit)),
        Effect.flatten,
      );
    }));
  }

  #checkDesktop(running: RunningExec): Effect.Effect<DesktopScreen, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const process = yield* this.#spawn(['/bin/bash', '-c', DESKTOP_CHECK, 'devbox-desktop', this.desktopMark ?? ''], {}, running);
      const checked = decoded(yield* attempt('process', () => process.output()));

      if (running.cancelled) return yield* Effect.fail(new DevboxError('cancelled', 'the desktop check was stopped by its caller'));
      const [size = '', fresh] = checked.stdout.trim().split('\n');
      const [width = Number.NaN, height = Number.NaN] = size.split(/\s+/u).map(Number);

      if (checked.exitCode !== 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
        return yield* Effect.fail(new DevboxError('io', `the desktop did not start: ${checked.stderr.trim() || checked.stdout.trim()}`));
      }

      if (fresh === 'fresh') this.#desktopLease.clear();

      return { width, height };
    });
  }

  /**
   * One action on the desktop the owner watches, for the agent `request.driver` (D89). The desktop is checked first,
   * under the box's own readiness; then the action's points against the screen and the driver against the lease, before
   * any input. Actions run one at a time, each on the canonical exec path under `request.execId`: `killExec` ends its
   * process, and what it holds down is released once that process has gone, however it ended. A stopped call waits no
   * longer, for the check or for its turn.
   */
  async desktop(request: DesktopRequest): Promise<DesktopAnswer> {
    const asked = v.safeParse(DesktopRequestSchema, request);

    if (!asked.success) return await settle(Effect.fail(new DevboxError('invalid-input', `desktop: ${v.summarize(asked.issues)}`)));
    const { driver, action, execId } = asked.output;
    const id = execId ?? crypto.randomUUID();
    const running: RunningExec = { cancelled: false, cancel: new AbortController() };
    const stop = running.cancel?.signal;

    this.#running.set(id, running);

    return await settle(this.#withActiveCaller(untilStopped(Effect.gen({ self: this }, function* () {
      // Under the box's own readiness: the check's run is admitted as any exec is.
      const screen = yield* this.#desktopUp(stop);
      const outside = offScreen(action, screen);

      if (outside !== null) return { kind: 'refused', reason: 'off_screen', detail: outside } satisfies DesktopAnswer;

      return yield* Effect.gen({ self: this }, function* () {
        const refused = this.#desktopLease.admit(driver, action.kind === 'screenshot' || action.kind === 'watch');

        if (refused !== null) return refused;

        // Run whole: a stop ends its process, and this waits for it to go and for what it held to be let go.
        return yield* Effect.uninterruptible(this.#act(action, running));
      }).pipe(this.#desktopTurns.withPermits(1));
    }), stop, `computer.${action.kind}`)).pipe(Effect.ensuring(Effect.sync(() => { this.#running.delete(id); }))));
  }

  /** The action's run, and its release after it. */
  #act(action: DesktopAction, running: RunningExec): Effect.Effect<DesktopAnswer, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      if (action.kind === 'screenshot' || action.kind === 'watch') {
        const argv = action.kind === 'watch' ? watchArgv(action) : ['/bin/bash', '-c', SCREENSHOT, 'devbox-screenshot'];
        const process = yield* this.#spawn(argv, {}, running);
        const shot = yield* attempt('process', () => process.output());
        const png = new Uint8Array(shot.stdout);
        const size = pngSize(png);

        if (running.cancelled) return yield* Effect.fail(stopped(`computer.${action.kind}`));

        if (shot.exitCode !== 0 || size === null) return yield* Effect.fail(new DevboxError('io', `the ${action.kind} failed: ${new TextDecoder().decode(shot.stderr).trim()}`));

        return { kind: 'screen', png: Buffer.from(png).toString('base64'), ...size } satisfies DesktopAnswer;
      }

      // A UTF-8 locale: under the box's default C locale xdotool's `type` stops at the first character past ASCII. A run
      // that did not end cleanly, killed by its caller's stop or failed, may have left a key or a button down between
      // its press and its release: once its process has gone, whatever X holds down is let up.
      const ran = yield* this.#spawn(xdotoolOf(action), { env: UTF8 }, running).pipe(
        Effect.flatMap((process) => attempt('process', async () => decoded(await process.output())).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) && exit.value.exitCode === 0 && !running.cancelled ? Effect.void : this.#letUp(action.kind))),
        )),
      );

      if (running.cancelled) return yield* Effect.fail(stopped(`computer.${action.kind}`));

      if (ran.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `xdotool ${action.kind} failed: ${ran.stderr.trim()}`));

      return { kind: 'done' } satisfies DesktopAnswer;
    });
  }

  /** The box's own cleanup, after a run's process has gone: no caller's to stop. One that fails is recorded; the
   *  action's own outcome is what the agent hears. */
  #letUp(kind: DesktopAction['kind']): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { container } = yield* attempt('io', () => this.#ensureReady(this.#teardowns));
      const letUp = decoded(yield* attempt('io', async () => await (await launch(container, ['python3', '-c', LET_UP_PY, 'devbox-let-up'], {})).output()));

      if (letUp.exitCode !== 0) return yield* Effect.fail(new DevboxError('io', `letting up what was down failed: ${letUp.stderr.trim()}`));
      this.#trace('desktop.let_up', { action: kind, released: letUp.stdout.trim() });
    }).pipe(Effect.catchTag('DevboxError', (failure) => Effect.sync(() => { this.#trace('desktop.let_up_failed', { action: kind, reason: failure.message }); })));
  }

  /** `driver`'s turns ended, or it was stopped: the desktop is free for another agent to take by looking (D89). */
  releaseDesktop(driver: string): Promise<void> {
    return settle(Effect.sync(() => { this.#desktopLease.release(driver); }));
  }

  /** The SDK's `bridge()`: an open preview socket is the box's use. */
  #bridge(upstream: WebSocket, headers: Headers): Response {
    this.#openSockets += 1;

    return bridgeSockets(upstream, headers, () => {
      this.#openSockets -= 1;
      this.stampInteraction();
    });
  }

  #fileClient: Files | undefined;
  #processClient: Processes | undefined;
  #supervisedClient: SupervisedProcesses | undefined;
  enableInternet = true;

  #container(): Container {
    const container = this.ctx.container;

    // A dev server runs no container (vite.config.ts), so a box there is refused once rather than retried.
    if (container === undefined) throw new DevboxError('configuration', NO_CONTAINER);

    return container;
  }

  #files(): Files { return this.#fileClient ??= new Files(this.#container()); }
  #processes(): Processes { return this.#processClient ??= new Processes(this.#container()); }

  #supervised(): SupervisedProcesses {
    return this.#supervisedClient ??= new SupervisedProcesses({
      storage: this.ctx.storage, lane: this.#resources, native: () => this.#processes(), generation: () => this.#generation,
      failedStop: (processId, cause) => this.#record('process', describe({ cause }), { processId }),
    });
  }

  async #execute(command: string, options: DevboxExecOptions = {}): Promise<ExecResult> {
    return decoded(await (await launch(this.#container(), ['/bin/bash', '-c', command], options)).output());
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
      const preview = previewAddress(url.hostname, this.previewHost);

      if (preview !== null) return yield* this.#preview(request, preview);

      if (url.pathname === '/_devbox/desktop') return yield* this.#desktop(request);

      if (url.pathname !== '/_devbox/terminal') return new Response('Not found', { status: 404 });

      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });

      const session = yield* this.#session(url.searchParams.get('session') ?? FIRST_SESSION.id);

      return yield* this.#withActiveCaller(attempt('io', async () => {
        const { container } = await this.#ensureReady(this.#teardowns);

        return terminalSocket(container, url.searchParams, session);
      }));
    }));
  }

  /** A session's shell and screen end; its next attach opens a fresh one under the same name, in its folder. */
  async resetShell(id: string = FIRST_SESSION.id): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const session = yield* this.#session(id);

      yield* this.#withActiveCaller(attempt("io", async () => {
        const { container } = await this.#ensureReady(this.#teardowns);

        return resetTerminal(container, session.id);
      }));
    }));
  }

  #recordJobSession(processId: string, command: string, cwd: string): void {
    const id = jobSessionId(processId);
    const records = this.#sessionRecords();

    if (!records.some((record) => record.id === id)) this.ctx.storage.kv.put(SESSIONS_KEY, [...records, { id, name: jobSessionName(command), cwd, job: processId }]);
  }

  async #forgetJobSession(processId: string): Promise<void> {
    const id = jobSessionId(processId);
    const container = this.ctx.container;

    if (container?.running === true) await resetTerminal(container, id);
    this.ctx.storage.kv.put(SESSIONS_KEY, this.#sessionRecords().filter((record) => record.id !== id));
  }

  /**
   * What each terminal session showed and was running, kept on the box's disk as it stops (D97). A save that fails is
   * traced and the stop goes on: the sessions come back fresh in their folders, as before D97.
   */
  async #saveSessions(): Promise<void> {
    const container = this.ctx.container;

    if (container?.running !== true) return;
    const ids = this.#sessionRecords().map((record) => record.id);
    const [saved] = await Promise.allSettled([(async () => (await container.exec(['bash', '-c', SESSIONS_SAVE, 'sessions-save', ...ids])).output())()]);

    if (saved.status === 'rejected') this.#trace('sessions.unsaved', { reason: describe({ cause: saved.reason }) });
    else if (saved.value.exitCode !== 0) this.#trace('sessions.unsaved', { reason: new TextDecoder().decode(saved.value.stderr).trim() });
  }

  /** The recorded sessions, the first one when there is none. */
  #sessionRecords(): SessionRecord[] {
    const records = parsedOrNull(SessionRecordsSchema, this.ctx.storage.kv.get<StoredValue>(SESSIONS_KEY));

    return records === null || records.length === 0 ? [FIRST_SESSION] : records;
  }

  #session(id: string): Effect.Effect<SessionRecord, DevboxError> {
    const record = this.#sessionRecords().find((session) => session.id === id);

    return record === undefined ? Effect.fail(new DevboxError('invalid-input', `no terminal session ${id}`)) : Effect.succeed(record);
  }

  /**
   * Every terminal session, as one read of the running box finds it (D90): its folder, the command in its foreground,
   * how its last command ended, the ports under it, its folder's branch. A box that is not running is not woken: its
   * sessions read as they were left. A session's folder, read, is kept for the next start.
   */
  terminalSessions(): Promise<readonly TerminalSession[]> {
    return settle(attempt('io', async () => {
      const records = this.#sessionRecords();
      const container = this.ctx.container;

      if (container?.running !== true) return mergeSessions(records, null);
      const read = await (await container.exec(['bash', '-c', SESSIONS_READ, 'terminal-sessions', PORT_LISTENERS])).output();
      const sessions = mergeSessions(records, parseSessionsRead(new TextDecoder().decode(read.stdout)));
      const moved = records.map((record) => ({ ...record, cwd: sessions.find((session) => session.id === record.id && session.open)?.cwd ?? record.cwd }));

      if (moved.some((record, at) => record.cwd !== records[at]?.cwd)) this.ctx.storage.kv.put(SESSIONS_KEY, moved);

      return sessions;
    }));
  }

  /** A new session, named; its first attach opens its shell in the workspace. */
  openTerminalSession(name?: string): Promise<SessionRecord> {
    return settle(attemptSync('invalid-input', () => {
      const records = this.#sessionRecords();
      const record = { id: newSessionId(records), name: v.parse(SessionNameSchema, name ?? newSessionName(records)), cwd: FIRST_SESSION.cwd };

      this.ctx.storage.kv.put(SESSIONS_KEY, [...records, record]);

      return record;
    }));
  }

  renameTerminalSession(id: string, name: string): Promise<SessionRecord> {
    return settle(Effect.gen({ self: this }, function* () {
      const session = yield* this.#session(id);
      const renamed = { ...session, name: yield* attemptSync('invalid-input', () => v.parse(SessionNameSchema, name)) };

      this.ctx.storage.kv.put(SESSIONS_KEY, this.#sessionRecords().map((record) => (record.id === id ? renamed : record)));

      return renamed;
    }));
  }

  /** Ends a session and forgets it; the box keeps one, so closing the last leaves a fresh first session. Closing an
   *  agent's job's session stops the job, so a restart does not bring it back (D95). */
  closeTerminalSession(id: string): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      const session = yield* this.#session(id);

      if (session.job !== undefined) {
        const job = session.job;

        yield* attempt('io', () => this.stopSupervised(job));

        return;
      }

      const container = this.ctx.container;

      if (container?.running === true) yield* attempt('io', () => resetTerminal(container, id));
      this.ctx.storage.kv.put(SESSIONS_KEY, this.#sessionRecords().filter((record) => record.id !== id));
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
    return settle(this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      yield* attempt('io', () => this.ensureReady());

      const result = yield* attempt('process', () => this.#supervised().run({ kind: 'native-start', command, cwd: options.cwd ?? DEVBOX_WORKDIR,
        processId: options.processId ?? crypto.randomUUID() }));

      return result.kind === 'started' ? result.process
        : yield* Effect.fail(new DevboxError('cancelled', 'native start was superseded'));
    })));
  }

  async getProcess(id: string) { return settle(this.#withActiveCaller(attempt("io", async () => { await this.ensureReady();

 return this.#processes().get(id); }))); }
  async listProcesses() { return settle(this.#withActiveCaller(attempt("io", async () => { await this.ensureReady();

 return this.#processes().list(); }))); }
  async killProcess(id: string): Promise<void> {
    return settle(this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      yield* attempt('io', () => this.ensureReady());

      const result = yield* attempt('process', () => this.#supervised().run({ kind: 'native-stop', processId: id }));

      if (result.kind === 'stale') return yield* Effect.fail(new DevboxError('cancelled', 'native stop was superseded'));
    })));
  }

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

  async #expose(port: number, site: PreviewSite, options: { token?: string; name?: string }) {
    const token = options.token ?? (await this.#portToken(port, options.name)).urlToken;
    this.ctx.storage.kv.put(EXPOSED_PREFIX + port, token);

    return { port, name: options.name, url: previewUrl(port, site, token) };
  }

  /** `<port>-<name>-<token>` is one DNS label, so a name gets what the port and a token leave of 63 (D86). */
  #previewSite(port: number): PreviewSite | DevboxError {
    const host = this.previewHost;
    const name = this.previewName;

    if (port === DESKTOP_PORT) return new DevboxError('invalid-input', `port ${String(DESKTOP_PORT)} is the desktop's, and is never a preview`);

    if (host === undefined || host.length === 0) return new DevboxError('configuration', 'previews are off: set `DEVBOX_PREVIEW_HOST` to the zone a wildcard route serves, or override `previewHost`');

    if (name === undefined) return new DevboxError('configuration', 'no preview host can name this box: it was never reached by `getByName`');
    const budget = LABEL_LIMIT - String(port).length - 2 - PORT_TOKEN_LENGTH;

    if (!LABEL_NAME.test(name) || name.length > budget) {
      return new DevboxError('invalid-input', `the box name \`${name}\` cannot be a preview host label: a label holds 63 characters, which leaves a name ${String(budget)} lowercase letters, digits or hyphens`);
    }

    return { host: host.toLowerCase(), name };
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


/** A start the platform refuses rejects `monitor()` in its own words; an exec after it says only that the container
 *  has not been started (staging, 2026-10-08: "Account resource limit exceeded"). Kept per container, per start. */
const startRefusals = new WeakMap<Container, LateStartFailure['cause']>();

/** Called right after each start, so a refusal of that start is what the first exec reports. */
function keepStartRefusal(container: Container): void {
  startRefusals.delete(container);
  unawaited(Promise.allSettled([container.monitor()]).then(([ended]) => {
    if (ended?.status === 'rejected') startRefusals.set(container, ended.reason);
  }), 'keeping a start refusal');
}

/** The platform's refusal of the last start, else what the exec itself failed with. */
function admissionFailure(container: Container, failed: LateStartFailure): Error {
  const cause = startRefusals.get(container) ?? failed.cause;

  return cause instanceof Error ? cause : new Error(describe({ cause }));
}

/** Why the first exec after a start failed, or nothing when it ran clean. */
async function admissionFailureOf(container: Container, signal: AbortSignal): Promise<Error | undefined> {
  const [admitted] = await Promise.allSettled([container.exec(['/bin/true'], { signal })]);

  if (admitted?.status !== 'fulfilled') return admissionFailure(container, { cause: admitted?.reason });
  const { exitCode } = await admitted.value.output();

  return exitCode === 0 ? undefined : new DevboxError('io', `native container admission exited ${String(exitCode)}`);
}

async function firstExec(container: Container, signal: AbortSignal): Promise<void> {
  const failed = await admissionFailureOf(container, signal);

  if (failed !== undefined) throw failed;
}

/** A locale that reads text as UTF-8; the C one the box starts in reads a byte past ASCII as an invalid sequence. */
const UTF8 = { LC_ALL: 'C.UTF-8' };

function launch(container: Container, argv: readonly string[], options: DevboxExecOptions): Promise<ExecProcess> {
  return container.exec([...argv], {
    cwd: options.cwd ?? DEVBOX_WORKDIR, env: { ...CONTAINER_ENV, ...options.env }, signal: options.signal,
  });
}

function decoded(output: ExecOutput): ExecResult {
  const decoder = new TextDecoder();

  return { stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr), exitCode: output.exitCode };
}

function parsedOrNull<S extends v.GenericSchema>(schema: S, value: StoredValue): v.InferOutput<S> | null {
  const parsed = v.safeParse(schema, value);

  return parsed.success ? parsed.output : null;
}

