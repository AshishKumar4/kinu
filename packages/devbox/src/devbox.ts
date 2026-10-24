/** Native container owner: start, restore and admission share one generation. */
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { Files, SandboxFileError } from '@cloudflare/sandbox';
import { Processes, isProcessLive, nameBox, containerExec, seamedContainer, boxEnv, endEveryProcess, END_TREE, type ProcessRecord } from "./processes";
import { launched } from './exec-launcher';
import { nativeStartClock } from './native-clock';
import type { DevboxExecOptions, ExecResult, ReadOptions, FileResult, ListFilesOptions, FileMetadata, GatewayBindings } from './contracts';
import { listFiles as readDirectory } from './file-listing';
import { writeFileIfDigest as writeFileIfDigestInGuest } from './file-digest-write';
import { DEFAULT_EXCLUDES, DiskChainStateSchema, DiskChainStorage, UnboundStorage, diskChain, recoveryNotice, type DiskChain, type DiskChainPorts } from './disk-chain';
import { STORE_MOUNT, chainStoreRoot, storeObjectUrl } from './store-gateway';
import { snapshotRegistry, type SnapshotRegistry } from './snapshot-registry';
import { DISK_PROBE, DISK_STALL_RESTARTED, DISK_STALLED, diskStallOf, type DiskStall } from './disk-stall';
import { Snapshots } from './snapshots';
import {
  GOLDEN_BASE, GOLDEN_ENTRYPOINT, GOLDEN_NAME, GOLDEN_REFRESH_MS, GoldenStateSchema, buildGolden, goldenFor, pipeParts, refreshTools, type ToolsRefresh,
  type GoldenAnswer, type GoldenPorts, type GoldenState,
} from './golden';
import artifact from '../block-lower/upstream.json';
import { ContainerRoutes, type OutboundPolicy } from './gateway';
import { attachTerminal, attachWhenReady, resetTerminal, type TerminalControl, type TerminalSocketEvents } from './terminal';
import {
  FIRST_SESSION, SESSIONS_CLOSED_KEY, SESSIONS_FORGET, SESSIONS_KEY, SESSIONS_READ, SESSIONS_SAVE, SessionNameSchema, SessionRecordsSchema, jobSessionId, jobSessionName, mergeSessions, newSessionId, newSessionName,
  parseSessionsRead, type SessionRecord, type TerminalSession,
} from './sessions';
import { bridgeSockets } from './socket-bridge';
import { DESKTOP_CHECK, DESKTOP_PORT } from './desktop';
import { DesktopLease, LET_UP_PY, SCREENSHOT, offScreen, pngSize, watchArgv, xdotoolOf } from './desktop-input';
import {
  DEVBOX_WORKDIR, DesktopRequestSchema, type DesktopAction, type DesktopAnswer, type DesktopRequest, type DesktopScreen, type DigestWriteRequest,
} from './wire';
import { LABEL_LIMIT, LABEL_NAME, ZoneSchema, previewAddress, type PreviewAddress } from './preview';
import { Cause, Deferred, Effect, Exit, Result, Semaphore } from 'effect';

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
import { SupervisedProcesses, type EndTold } from './supervised-processes';
import { DevboxError, attempt, attemptSync, hold, refuseStart, settle, settleSync, startOverrun, startInterrupted, chainAdvanced, type DevboxErrorCode } from './errors';
import { execRecords } from './exec-stream';
import { BOX_SIZE_ORDER, BoxSizeSchema, DEFAULT_BOX_SIZE, instanceOf, type BoxSize, type ResizeOutcome } from './sizes';
import type { RestorePhase, RestorePhaseStamps } from './durability/contracts';
import {
  admissionOf, isSettledRestoration, recoveryRow, refusedStart, settledRestoration, terminalRefusal, unreadyOf,
  type RecoveryClaim, type RestoreAdmission, type RestoreClockPhase, type RestoreReadiness, type RestoreStatus,
  type Restoration, type SettledRestoration, type StampOutcome, type StartInputs,
} from './restoration';
import type { DevboxReport, HeartbeatTick, IncidentReasonRow, LastRestore, SupervisedProcessRow } from './report';
import {
  deliverIncidents, INCIDENT_PREFIX, INCIDENT_REASON_MAX_CHARS, incidentTotals, recordIncident,
  type IncidentRow,
} from './incidents';
import {
  DEVBOX_RUNTIME_DIR,
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
  /** Its process, once the container started it: the root of the tree its kill ends. */
  pid?: number;
  /** Set once a kill of it began: one that never ends is what the owner's second stop asks after (`stopStalled`). */
  killing?: true;
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

/**
 * `port-listeners STAMP [PORT...]`: `port pid ancestry stamp command` per socket holder, tab-separated; /proc, as the
 * image has no `ss`. The ancestry is the holder's pid and each parent's up to init: the one answer to which command,
 * session or job a listener is under, whatever process group it runs in. The stamp is the nearest one along it, and
 * comes after the ancestry, never empty, because a shell's `read` merges empty tab-separated fields.
 */
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
ancestry() {
  p=$1
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    printf '%s ' "$p"
    p=$(awk '/^PPid:/ { print $2 }' "/proc/$p/status" 2>/dev/null)
  done
}
stampof() {
  [ -n "$stamp" ] || return 0
  for p in $1; do
    v=$(tr '\\000' '\\n' < "/proc/$p/environ" 2>/dev/null | grep -m1 "^$stamp=")
    [ -n "$v" ] && { printf '%s' "\${v#*=}"; return; }
  done
}
echo "$socks" | while read -r inode port; do
  echo "$holders" | awk -v i="$inode" '$1 == i { print $2 }' | sort -un | while read -r pid; do
    chain=$(ancestry "$pid")
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$port" "$pid" "$chain" "$(stampof "$chain")" "$(tr '\\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  done
done
`;

/** `stamped-processes STAMP VALUE`: the pid of every process whose environment holds `STAMP=VALUE`, one a line; /proc, as
 *  `portListeners` reads it. A process that has exited and not been reaped holds no environment, so it is not one. */
const STAMPED = `
want="$1=$2"
for d in /proc/[0-9]*; do
  tr '\\000' '\\n' 2>/dev/null < "$d/environ" | grep -qxF -- "$want" && echo "\${d#/proc/}"
done
`;

export interface PortListener {
  readonly port: number;
  readonly pid: number;
  readonly stamp: string | null;
  /** The listener's pid, then each parent's, up to init. */
  readonly ancestry: readonly number[];
  readonly command: string;
}

const Pid = v.pipe(v.string(), v.toNumber(), v.integer());

const ListenerLineSchema = v.pipe(v.string(), v.transform((line) => line.split('\t')), v.tuple([
  Pid,
  Pid,
  v.pipe(v.string(), v.transform((chain) => chain.trim().split(' ').filter((pid) => pid !== '')), v.array(Pid)),
  v.string(),
  v.string(),
]));

function parsePortListeners(output: string): PortListener[] {
  return output.split('\n').filter((line) => line !== '').map((line) => {
    const [port, pid, ancestry, stamp, command] = v.parse(ListenerLineSchema, line);

    return { port, pid, stamp: stamp === '' ? null : stamp, ancestry, command: command.trimEnd() };
  });
}

const CONTAINER_STOP_INTERVAL_MS = 100;


/** All durable keys share the `devbox:` prefix so a host's own keys cannot collide with them. */

const PORT_SPEC_PREFIX = 'devbox:port:';

const LAST_ATTACH_KEY = 'devbox:last-attach';

/** The last restore's phases and tools refresh (`LastRestore`), written as it settles. */
const LAST_RESTORE_KEY = 'devbox:last-restore';

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

/** How long a start from the golden, or the golden object's own build start, has to admit its first command: the
 *  platform's slowest first wakes ran 30 to 53 s, and once 351 s (D64). */
const GOLDEN_ADMISSION_MS = 120_000;

const AWAITING_GOLDEN_KEY = 'devbox:awaiting-golden';

/** A snapshot a box starts from, and the namespace that gave it, which a failed wake asks for the next one. */
type StartSource = { readonly kind: 'own' | 'golden'; readonly id: string; readonly boxes: Siblings };

/** What the one adoption found (D102); `Devbox.#adopt` names each. */
type Adoption = 'adopted' | 'refused' | 'replaced' | 'unclaimed' | 'unread' | 'unconfigured';

/** The outcomes that answer for the container; the others leave the next start to ask again. */
const ANSWERED: ReadonlySet<Adoption> = new Set(['adopted', 'refused', 'replaced', 'unclaimed']);

/** A boot id read against the claimed one: a read that never answered adopts nothing. */
function adoptionOf(answered: string | undefined, expected: string): Adoption {
  if (answered === undefined) return 'unread';

  return answered === expected ? 'adopted' : 'replaced';
}

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
  /** What its tools refresh did, once it has. */
  tools?: ToolsRefresh;
}


/** One attempt in flight and when it opened, so a report can say how long a
 *  box has been waiting on it rather than only that it is. */
interface Flight {
  readonly generation: number;
  readonly run: Promise<void>;
  readonly since: number;
}

/** The start hook's restore, and the box's own start or repair: one attempt each at a time. */
interface Flights {
  hook?: Flight;
  startup?: Flight;
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

/** What a request that would start the box is told while it saves and stops; the workspace asks again until it has. */
const SAVING_AND_STOPPING = 'the computer is saving its work and stopping; it starts again as soon as that is done';

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

/** A start from stopped as the box's host admits it: the size it starts at, or the refusal's words. */
export type StartAdmission = { readonly size: BoxSize } | { readonly refused: string };

export class Devbox<Env = unknown> extends DurableObject<Env> {
  readonly #gateways: GatewayBindings;
  #storage: DevboxStorage | undefined;

  /** What this object last started the container from; undefined until it starts one (an adopted container). */
  #started: StartSource | undefined;
  #siblings: Siblings | undefined;
  #snapshotOwner: Snapshots | undefined;
  /** Fences every write below: an abandoned startup continuation keeps running, and must
   *  re-check this token after every await or it can clear its successor's single-flight entry. */
  #generation = 0;
  /**
   * The attempts run one at a time per generation (`#fly`): the start hook's restore, and the box's own start or repair.
   * A caller joins one only while its generation still matches: a superseded attempt's result is already discarded.
   */
  readonly #flights: Flights = {};
  /** `destroy` cancels and awaits these. */
  readonly #admissions = new Set<{ readonly abort: () => void; readonly settled: Promise<void> }>();
  /** Each terminal's socket, held by the runtime (`acceptWebSocket`): attached, its events' PTY; or still waiting for the
   *  box, what its pane sent meanwhile, given to the PTY in order as it attaches (D109). */
  readonly #terminals = new Map<WebSocket, { readonly attached: TerminalSocketEvents } | { readonly waiting: (string | ArrayBuffer)[] }>();
  #refused: { readonly generation: number; readonly reason: string } | undefined;

  /** The size the host admitted this box's last start from stopped at (`admitStart`), which the start runs at. */
  #admittedSize: BoxSize | undefined;
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
  /** This incarnation's one adoption of the container it woke beside (D102); memory, so a reset adopts again. */
  #adoption: Promise<Adoption> | undefined;
  /** The adoption settled with no answer, so the next start asks again. */
  #unanswered = false;
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

  /** Constructor work is synchronous storage, so no event waits on it (`gate:do-init`); the container the object woke
   *  beside is adopted by the first member that touches it (D102). */
  #activate(): void {
    if (this.ctx.container?.running !== true) return;
    const parked = this.ctx.storage.kv.get<SettledRestoration>(SETTLED_KEY);

    // A park made under another deploy is lifted: that deploy may be the change its refusal waits on (D94).
    if (parked?.phase === 'unattached' && !parked.retry && parked.version !== this.#version()) this.ctx.storage.kv.delete(SETTLED_KEY);
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

  /**
   * The one adoption of this incarnation (D102): opened by the first member that touches the container, and awaited by
   * every member that touches it, before anything else. It runs inside `blockConcurrencyWhile`, so no event reaches the
   * object until the box has taken or refused the container it woke beside (R1, D104); never from the constructor
   * (`gate:do-init`). An outcome with no answer stands for members that only read, which find the box unready, and a
   * start's hook (`asking`), with the control listener proven, asks again; so retries keep the startup row's pace.
   */
  async #adopted(asking = false): Promise<Adoption> {
    if (asking && this.#unanswered) {
      this.#adoption = undefined;
      this.#unanswered = false;
    }

    const adoption = this.#adoption ??= this.#adoptInBlock();
    const [outcome] = await Promise.allSettled([adoption]);

    if (this.#adoption === adoption) {
      // A step that failed is no outcome to keep: the next member adopts again.
      if (outcome.status === 'rejected') this.#adoption = undefined;
      this.#unanswered = outcome.status === 'fulfilled' && !ANSWERED.has(outcome.value);
    }

    return await adoption;
  }

  /** {@link #adopt} in a block of its own; its failure is answered outside it, where a rejection resets nothing. */
  async #adoptInBlock(): Promise<Adoption> {
    const held = await this.ctx.blockConcurrencyWhile(async () => {
      const adopting = this.#adopt();

      await Promise.allSettled([adopting]);

      return { adopting };
    });

    return await held.adopting;
  }

  /**
   * The running container against the restoration the box claims (BOOT_ID_KEY with SETTLED_KEY), by the kernel's boot
   * id. `adopted` takes the claim and configures the container as a start's admission would, and `refused` is that
   * configuration refused for good (D94, D47); `replaced` turns over and arms the start that restores it; `unclaimed` is
   * no running container, or a box that claims nothing. With no answer: `unread`, a read that never answered (a stopping
   * container, or a stop or turnover meanwhile), and `unconfigured`, a configuration refused for now, whose retry adopts
   * the claim again rather than restoring over it. Absent rows prove nothing, so only a container answer refutes a claim.
   */
  async #adopt(): Promise<Adoption> {
    const claim = this.#durableClaim();

    if (this.ctx.container?.running !== true || claim === undefined) return 'unclaimed';
    const generation = this.#generation;
    const since = Date.now();
    const [read] = await Promise.allSettled([this.#readBootId()]);
    const answered = this.#owns(generation) && read.status === 'fulfilled' ? read.value : undefined;
    const adoption = adoptionOf(answered, claim.expected);
    this.#trace('adoption', { adoption, ms: Date.now() - since, phase: this.#restoration.phase });

    if (adoption === 'replaced') {
      console.error('[devbox] the box claims a restoration the container does not carry; restoring it rather than serving callers a world that is gone');
      this.#invalidateGeneration();
      await this.#armStartup();
    }

    if (adoption !== 'adopted') return adoption;
    this.#restoration = claim.settled;
    const [configured] = await Promise.allSettled([this.configureContainer(true)]);

    if (configured.status === 'fulfilled') return adoption;
    // Refused as a start's configuration is (D94, D47): the container is the same either way.
    const refused = { cause: configured.reason };

    if (this.#owns(generation)) this.#restoration = { phase: 'unstarted' };
    await this.#refuseAdmission({ generation, since, startsContainer: false, inputs: this.#startInputs() }, refused);

    return waitingCanChange(refused) ? 'unconfigured' : 'refused';
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

  /**
   * One build at a time on this object: a build asked for while one runs (the cron's, the alarm a box's ask arms, a
   * refresh) waits for it, then finds the golden it built, or retries the one it failed. A second at once would start
   * its own container, destroying the one the first is installing into: staging, 2026-10-20, failed "installing the
   * tools: Network connection lost." that way, and every box waiting was told so.
   */
  #buildGolden(keepAlive: boolean): Effect.Effect<GoldenState, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const state = yield* buildGolden(this.#goldenPorts(), keepAlive);
      const next = state.current === undefined ? undefined : state.current.takenAt + GOLDEN_REFRESH_MS - Date.now();

      if (next !== undefined) yield* attempt('io', () => this.armAlarm(GOLDEN_REFRESH_CALLBACK, Math.max(0, next / 1000)));

      return state;
    }).pipe(this.#goldenTurns.withPermits(1));
  }

  readonly #goldenTurns = Semaphore.makeUnsafe(1);

  /** The attach's first step: the box's tools brought to the pin, its record kept on the restore's clock and traced. */
  #refreshTools(): Effect.Effect<void, DevboxError> {
    const bucket = this.#bucket();

    return refreshTools({
      pin: this.toolsPin, exec: (command) => this.#rawExec(command, DEVBOX_RUNTIME_DIR), pipe: (key, path) => this.#pipeParts(key, path),
      read: async (key) => await (await bucket?.get(`${key}.0`))?.text() ?? null, now: () => Date.now(),
    }).pipe(Effect.map((refresh) => {
      const clock = this.#phaseClock;

      if (clock !== undefined) clock.tools = refresh;
      this.#stampPhase('tools');
      this.#trace('restore.tools', { ...refresh, pin: this.toolsPin });
    }));
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
        await firstExec(container(), AbortSignal.timeout(GOLDEN_ADMISSION_MS));
      },
      exec: async (command) => decoded(await (await containerExec(container(), ['/bin/bash', '-c', command])).output()),
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

  /**
   * How long the box's own snapshot may take to be admitted before the box gives it up and wakes from its backup, which
   * keeps the workspace and loses the rest of the root (D111). A snapshot the platform no longer holds is refused at once
   * ("not found", D64) and the box wakes from the backup then; one still on its way is waited for. 199 quick restarts (a
   * stop, then a start at once) on real boxes were admitted p50 1.64 s, p90 7.12 s, max 32.3 s, and the slowest wake on
   * record took 53 s; at 10 s it discarded seven snapshots still on their way in the week to 2026-10-24. The wait is the
   * admission's, before the start gate, so no start hook's budget holds it.
   */
  protected get snapshotWakeCutoverMs(): number {
    return 60_000;
  }

  /**
   * How long a rest waits for the platform's snapshot of its container. The snapshot only speeds the next wake (D51):
   * the rest committed the chain before it. A save took 4.1-9.5 s on Medium (D51), and the snapshot and stop after a
   * rest's commit took 0.15-6.1 s in each of the 40 rests on staging and the contracts in the week to 2026-10-22; one
   * take on f44999 never answered (D108), and the box refused every terminal for the 14 minutes it waited.
   */
  protected get restSnapshotWaitMs(): number {
    return 60_000;
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

  /**
   * Whether this box, set to `size`, may start from stopped: the size it starts at, which may be smaller than the one
   * set and leaves the setting as it is, or the refusal's words. Asked at every start of a stopped container
   * (`#startContainer`), never of a running one.
   */
  protected async admitStart(size: BoxSize): Promise<StartAdmission> {
    return { size };
  }

  /** The box seen running at a heartbeat, at `size`: what its host counts running time by. A host's failure here is its
   *  own to keep from the heartbeat. */
  protected async onRunningTick(_size: BoxSize): Promise<void> {}

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
    const settledMs = Date.now() - clock.openedAt;
    const record: LastRestore = { openedAt: clock.openedAt, stamps: clock.stamps, tools: clock.tools, settledMs };

    // The box's own record of where a restore's time went, which a lost telemetry row cannot take (ledger 1024-h).
    this.ctx.storage.kv.put(LAST_RESTORE_KEY, record);
    this.#trace('restore.phases', { ...clock.stamps, settledMs, tools: clock.tools?.mode, toolsMs: clock.tools?.ms });
    this.onRestorePhase('settled', settledMs);
  }

  /** A benchmark box turns them off, so no ambient tick pre-empts the driver's own. */
  protected get ambientCheckpoints(): boolean {
    return true;
  }

  /**
   * Where the guest keeps digest writes' answers (`file-digest-write.ts`): the container's own `/tmp`, so they go with
   * it. A test that runs the guest program on its host gives a folder of its own.
   */
  protected get digestJournal(): string {
    return '/tmp/kinu-digest-writes';
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
      this.ctx.storage.kv.put(RUNNING_SIZE_KEY, this.#admittedSize ?? inputs.size);
      this.#startFrom(container, inputs, source);
    }

    const cancel = new AbortController();

    const run = (async () => {
      if (!await this.#admit(container, cancel.signal, inputs)) return;

      if (!this.#owns(generation) || this.#closed) return;
      // The configuration and the restore run in one block, so nothing reaches the container before it is ready (R1,
      // D104). A configuration refused is answered outside it, where its throw fails the start and resets nothing.
      let configuring = Promise.resolve();

      await this.ctx.blockConcurrencyWhile(async () => {
        configuring = this.configureContainer(wasRunning && this.#reused());
        const [configured] = await Promise.allSettled([configuring]);

        if (configured.status === 'fulfilled' && this.#owns(generation) && !this.#closed) await this.#restoreInStartGate(!wasRunning);
      });
      await configuring;
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
    const answer = await boxes.getByName(this.goldenName).goldenFor(this.ctx.id.toString(), lost);

    return answer.kind === 'ready' ? { kind: 'golden', id: answer.id, boxes } : answer;
  }

  #startFrom(container: Container, inputs: StartInputs, source: StartSource): void {
    this.#started = source;
    this.#awaitingGolden = undefined;
    this.#snapshots.started(source.kind === 'own' ? source.id : undefined);
    // At the size its host admitted the start at (`admitStart`); a refusal stays keyed by the size set (D52).
    container.start({ containerSnapshot: { id: source.id }, entrypoint: GOLDEN_ENTRYPOINT, instance: instanceOf(this.#admittedSize ?? inputs.size), enableInternet: this.enableInternet });
    keepStartRefusal(container);
  }

  /**
   * A snapshot start that fails falls back to the next source and the chain, and so does the box's own snapshot not
   * admitted within {@link snapshotWakeCutoverMs}, past which it is taken for lost (D111). A golden has nothing faster behind it, so its
   * start has the golden object's own bound to be admitted before it is reported lost: at the cutover, a slow golden was
   * retired and every waiting box held for a rebuild (staging 99a13686c, 2026-10-23).
   */
  async #admit(container: Container, signal: AbortSignal, inputs: StartInputs): Promise<boolean> {
    const started = this.#started;

    if (started !== undefined) {
      // Cleared once settled: a later abort killed the image's container (D64).
      const cutover = new AbortController();

      const [bound, missed] = started.kind === 'own'
        ? [this.snapshotWakeCutoverMs, 'the snapshot start was not admitted within the cutover']
        : [GOLDEN_ADMISSION_MS, `the golden start was not admitted in ${String(GOLDEN_ADMISSION_MS / 1000)} s`];

      const timer = setTimeout(() => { cutover.abort(new DevboxError('io', missed)); }, bound);
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


  /** Joins a re-entered hook; adopts a settled boot without re-attaching. `started`: this admission started the container. */
  async #restoreInStartGate(started: boolean): Promise<void> {
    if (this.#closed) {
      this.#trace('startup.hook.closed', { generation: this.#generation });

      return;
    }

    await this.#fly('hook', this.#generation, () => this.#runStartHook(started));
  }

  /**
   * The run under way in `slot` for `generation`, joined; or `open`'s, held there until it ends, unless another has taken
   * its place by then.
   */
  async #fly(slot: keyof Flights, generation: number, open: () => Promise<void>): Promise<void> {
    const pending = this.#flights[slot];

    if (pending?.generation === generation) {
      this.#trace(`startup.${slot}.join`, { generation, sinceMs: Date.now() - pending.since });

      return await pending.run;
    }

    const since = Date.now();
    this.#trace(`startup.${slot}.open`, { generation, running: this.ctx.container?.running === true, phase: this.#restoration.phase });
    const run = open();
    this.#flights[slot] = { generation, run, since };
    let settled = false;

    try {
      await run;
      settled = true;
    } finally {
      if (this.#flights[slot]?.run === run) this.#flights[slot] = undefined;
      this.#trace(`startup.${slot}.exit`, { generation, ms: Date.now() - since, settled, phase: this.#restoration.phase });
    }
  }

  /** One structured line per lifecycle edge, on the console the platform
   *  tails. Primitives only: a reader who wants the object asks `/state`. */
  #trace(event: string, fields: Record<string, string | number | boolean | undefined>): void {
    console.log(JSON.stringify({ event: `devbox.${event}`, at: Date.now(), ...fields }));
  }

  /** One budget includes adoption, restore, resumption and durable settlement. */
  async #runStartHook(started: boolean): Promise<void> {
    const budgetMs = Math.min(this.policy.attachBudgetMs, DEFAULT_DEVBOX_POLICY.attachBudgetMs);
    const budget = openStartBudget(budgetMs, this.startClock);
    let generation = this.#generation;

    const stepped = await runRestoreStep(
      budget.remainingMs(),
      async (): Promise<'unanswered' | undefined> => {
        const previous = await this.ctx.storage.get<Restoration>(SETTLED_KEY);

        if (!this.#owns(generation)) return;

        if (previous?.phase === 'restoring') {
          const claim = await this.#claimRecovery();
          await this.#recover(generation, claim, { cause: startInterrupted() });

          return;
        }

        const over = started ? 'restore' : await this.#overRunning(generation);

        if (over !== 'restore') return over === 'unanswered' ? over : undefined;

        if (this.#restoration.phase !== 'unstarted') return;
        generation = this.#generation;
        const failure = await this.#restoreNow(generation, racedRestoreSteps(budget), started);

        if (failure !== undefined) console.error(`[devbox] start refused: ${describe(failure)}`);
      },
      (failure) => console.error(`[devbox] abandoned start hook failed: ${describe(failure)}`),
      this.startClock,
    );

    // No answer over a claim fails the hook into its recovery, as an unanswered identity read always did.
    const result = stepped.kind === 'done' && stepped.value === 'unanswered'
      ? { kind: 'failed', cause: new DevboxError('io', 'the running container did not answer the read of its boot id') } as const
      : stepped;

    if (!this.#owns(generation)) return;

    if (result.kind !== 'done') {
      const clock = this.#phaseClock;
      const attached = clock?.stamps.attached !== undefined;

      const cause = result.kind === 'late'
        ? startOverrun('Devbox.onStart', budgetMs)
        : result.cause;

      if (clock !== undefined) this.#settleClock(clock);
      this.#invalidateGeneration();

      if (this.#stoppedUnder(started)) return;

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

  /**
   * A start's hook over a container its admission did not start (D102). It asks the adoption again, the control listener
   * now proven, and checks a live restoration's boot id as the heartbeat does (T9). `restore` goes on to restore what
   * the box does not have; `kept` ends the hook over a restoration, a refusal, or a retry that already stands;
   * `unanswered` is no answer over a claim, where restoring could attach over the live workspace.
   */
  async #overRunning(generation: number): Promise<'restore' | 'kept' | 'unanswered'> {
    const adoption = await this.#adopted(true);

    if (adoption === 'unread' && this.#durableClaim() !== undefined) return 'unanswered';

    if (adoption === 'unconfigured') return 'kept';

    if (this.#admission() !== undefined && await this.#containerWasReplaced() && this.#owns(generation)) {
      console.error('[devbox] the restored container was replaced; restoring it rather than serving callers a world that is gone');
      this.#invalidateGeneration();
    }

    return this.#restoration.phase === 'unstarted' ? 'restore' : 'kept';
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


  /**
   * Records the container the box restores as the kernel's boot id: the container's own identity, new at every start,
   * wake and replacement, and the one the process fences use. A boot-id mismatch is the only replacement signal, so
   * every read, count and write is fenced. The box's own stop clears the row, so a start or wake after it is not
   * counted as a replacement (D67).
   */
  async #stampBootId(generation: number): Promise<void> {
    const previous = await this.ctx.storage.get<string>(BOOT_ID_KEY);
    const actual = await this.#readBootId();
    const replaced = previous === undefined || previous === actual ? undefined : (await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0) + 1;

    // A stale attempt writes nothing: the row names the container of record.
    if (!this.#owns(generation)) return;

    if (replaced !== undefined) {
      await this.ctx.storage.put(REPLACED_COUNT_KEY, replaced);
      console.error(`[devbox] the container instance was replaced (${replaced} so far)`);
    }

    if (actual !== previous) await this.ctx.storage.put(BOOT_ID_KEY, actual);
    this.#stampPhase('bootId');
  }

  /** The heartbeat re-drives a stale restoration; commit paths must not commit to a gone container.
   *  No stamp means no claim about any instance, so the answer is `false`, not replaced. */
  async #containerWasReplaced(observed?: { readonly bootId: string }): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(BOOT_ID_KEY);

    if (expected === undefined) return false;

    return (observed === undefined ? await this.#readBootId() : observed.bootId) !== expected;
  }

  /** A checkpoint must refuse a workspace replaced under a live object until the startup hook restores it. */
  async #healReplacedContainer(): Promise<void> {
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

  /** The kernel's boot id, through the reader the process fences use: one identity per container. */
  async #readBootId(): Promise<string> {
    return await this.#processes().incarnation();
  }


  async #restoreNow(
    generation: number,
    steps: RestoreSteps,
    started: boolean,
  ): Promise<{ readonly cause: unknown } | undefined> {
    await this.#settle({ phase: 'restoring', where: 'start', since: Date.now() });

    if (!this.#owns(generation)) return undefined;
    const clock = this.#openClock();

    try {
      return await this.#classifiedRestore(generation, steps, started);
    } finally {
      this.#settleClock(clock);
    }
  }

  async #classifiedRestore(
    generation: number,
    steps: RestoreSteps,
    started: boolean,
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
      // Fenced as `#recover` is: a superseded attempt clears nothing its successor holds.
      if (!this.#stoppedUnder(started)) await this.#recover(generation, claim, { cause: error });
      else if (this.#owns(generation)) this.#invalidateGeneration();

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
          await this.#adopted();

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

  /** All delivered startup doors share adoption, admission and destructive recovery. */
  async #startContainer(): Promise<void> {
    await this.#adopted();
    const refused = this.#refusedStart();

    if (refused !== undefined) {
      await this.#settle({ phase: 'unattached', reason: refused, retry: false });

      return;
    }

    // A stopped box starts only if its host admits it; a running one is never asked. Nothing is kept of a refusal, so
    // the next door asks again, once what refused it has changed.
    if (this.ctx.container?.running !== true) {
      const admitted = await this.admitStart(this.#size());

      if ('refused' in admitted) refuseStart(admitted.refused);
      this.#admittedSize = admitted.size;
    }

    if (this.ctx.container?.running !== true
      && (this.#restoration.phase !== 'unstarted' || this.#flights.hook !== undefined)) {
      this.#invalidateGeneration();
    }

    await this.#fly('startup', this.#generation, () => this.#recoverAndStart());
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
          this.#invalidateGeneration(this.#flights.startup);
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

    if (this.#stoppedUnder(startsContainer)) return;
    const failure = classifyRecovery(failed);

    // A start that fails the same way every time is refused once, not re-armed each second: staging 7e411119d's box
    // named itself into a read-only /etc/hostname, an unclassified failure, and took 1,873 alarms in 30 minutes (D94).
    if (!waitingCanChange(failed)) {
      const refusal = `[${failure} -> refuse] ${reason}`;

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
    const pending = this.#flights.startup;

    if (pending !== undefined && pending.generation === generation) return await pending.run;

    return await this.#withStorageMutation(async () => {
      if (!this.#owns(generation)) return;

      const retryBootStamp = this.#restoration.phase === 'repair'
        && this.#restoration.bootStamp !== 'done';

      await this.#fly('startup', generation, async () => {
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
      });
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

  /** An admission that did not start its container ends, wherever that container's stop lands: a retry or a recovery
   *  would start the container the stop ended (D34), and a refusal would park a box nothing refused. */
  #stoppedUnder(started: boolean): boolean {
    return !started && this.ctx.container?.running !== true;
  }

  /** Called only on evidence the container identity is gone or going. The bump makes every
   *  in-flight attempt state-inert: no readiness, attach failure, release or destroy. */
  #invalidateGeneration(recoveryFlight?: Flight): void {
    this.#generation += 1;
    this.#flights.startup = recoveryFlight === undefined
      ? undefined
      : { generation: this.#generation, run: recoveryFlight.run, since: recoveryFlight.since };
    this.#restoration = { phase: 'unstarted' };
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
    this.#invalidateGeneration(this.#flights.startup);
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
   *  the old mount. Count-bounded: a stop that never flips must refuse, not pin the startup flight. */
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

      if (started.kind === 'done') {
        // The box went away and came back: that is the change that makes a start again right, and its job is told so.
        if (spec.job !== undefined) await this.#record('process-restored', 'the computer restarted, and started this process again', { processId: spec.processId, job: spec.job });
        continue;
      }

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
    if (this.#quiescing !== undefined || this.#flights.startup !== undefined || this.#flights.hook !== undefined) return;
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

  /** `stalled`: said while a stop waits on a disk that stopped answering, which the owner's second stop restarts
   *  (`stopStalled`); read only while a kill is pinned. */
  boxSize(): Promise<{
    readonly size: BoxSize; readonly chosen: BoxSize | undefined; readonly running: BoxSize | undefined; readonly startRefused: string | undefined;
    readonly stalled: string | undefined;
  }> {
    return settle(Effect.gen({ self: this }, function* () {
      const pinned = this.#pinned();
      const stall = pinned.length === 0 ? null : yield* this.#diskStall(pinned);

      return {
        size: this.#size(), chosen: this.#stored(SIZE_KEY), running: this.#runningSize(), startRefused: this.#refusedStart(),
        stalled: stall === null ? undefined : `${DISK_STALLED}: ${stall.waiting.join(', ')}`,
      };
    }));
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
    if (this.#quiescing !== undefined) return { kind: 'pending', reason: SAVING_AND_STOPPING, quiescing: true };

    if (arrived !== this.#teardowns) return { kind: 'pending', reason: DESTROYED_AFTER_ARRIVAL };
    this.#closed = false;
    const wasRunning = this.ctx.container?.running === true;
    this.#trace('readiness.enter', { generation: this.#generation, running: wasRunning, phase: this.#restoration.phase });

    if (!wasRunning) await this.#startContainer();

    const base = this.#awaitingGolden;

    // The step its base is at rides along: the caller holds while the build moves on (D79).
    if (base !== undefined && this.ctx.container?.running !== true) return base;
    await this.#adopted();
    this.#trace('readiness.adopted', { phase: this.#restoration.phase });

    // Native allocation can report running before restoration starts.
    if (wasRunning && this.#restoration.phase === 'unstarted') await this.#startContainer();

    if (this.#quiescing !== undefined) return { kind: 'pending', reason: SAVING_AND_STOPPING, quiescing: true };

    if (arrived !== this.#teardowns) return { kind: 'pending', reason: DESTROYED_AFTER_ARRIVAL };
    const admission = this.#admission();

    if (admission !== undefined) return admission;

    await this.#armStartup();
    this.#trace('readiness.armed', { phase: this.#restoration.phase });

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

      return decoded(yield* this.#output(process));
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

  /**
   * A command string runs in bash, answering when it exits (`launched`); an argv runs as given, so its words need no
   * quoting (the desktop's, D89).
   */
  #spawn(command: string | readonly string[], { cwd, env }: ExecOptions, running: RunningExec): Effect.Effect<ExecProcess, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const { container } = yield* attempt('not-ready', () => this.#ensureReady(this.#teardowns));

      if (running.cancelled) return yield* Effect.fail(new DevboxError('cancelled', 'computer exec cancelled before admission'));
      const argv = typeof command === 'string' ? launched(command) : command;
      // Its own group, which its kill ends (D69).
      const started = yield* attemptSync('process', () => launch(container, ['setsid', '-w', ...argv], { cwd, env }));
      running.started = started;
      const process = yield* this.#unlessRestarted(() => started);

      running.pid = process.pid;

      return process;
    });
  }

  portListeners(stamp: string, ports?: readonly number[]): Promise<readonly PortListener[] | null> {
    return settle(attempt('io', async () => {
      await this.#adopted();
      const container = this.#readyContainer();

      if (container === undefined) return null;

      if (ports?.length === 0) return [];
      const read = await (await containerExec(container, ['sh', '-c', PORT_LISTENERS, 'port-listeners', stamp, ...(ports ?? []).map(String)])).output();

      return parsePortListeners(new TextDecoder().decode(read.stdout));
    }));
  }

  /** The processes still running under `stamp=value` (a job's id), whatever started them: null while the box is down,
   *  which this read never starts. */
  stampedProcesses(stamp: string, value: string): Promise<readonly number[] | null> {
    return settle(attempt('io', async () => {
      await this.#adopted();
      const container = this.#readyContainer();

      if (container === undefined) return null;
      const read = await (await containerExec(container, ['sh', '-c', STAMPED, 'stamped-processes', stamp, value])).output();

      return new TextDecoder().decode(read.stdout).split('\n').filter((line) => /^\d+$/.test(line)).map(Number);
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
      running.killing = true;
      const { pid } = yield* this.#unlessRestarted(() => started);
      const ended = yield* this.#unlessRestarted(async () => await (await containerExec(container, ['sh', '-c', `${END_TREE}\nend_tree "$1"`, 'kill-tree', String(pid)])).output());

      if (ended.exitCode === 3) return false;

      if (ended.exitCode !== 0) return yield* Effect.fail(new DevboxError('process', `exec ${execId} was not ended: ${new TextDecoder().decode(ended.stderr)}`));

      return true;
    }));
  }

  readonly #running = new Map<string, RunningExec>();
  readonly #answers = new Map<string, Deferred.Deferred<ExecResult, DevboxError>>();

  /** Aborted when a stop restarts the computer under its disk's stall (`stopStalled`): every wait on the old container
   *  ends with it, so a run whose read never completes ends with the refusal that says why. */
  #stallRestart = new AbortController();

  /** `work`'s answer, or the restart's refusal once the computer restarted under it: a promise race, not a fiber's, so
   *  a run inside an uninterruptible action still ends. */
  #unlessRestarted<T>(work: () => Promise<T>): Effect.Effect<T, DevboxError> {
    const restarted = this.#stallRestart.signal;

    return attempt('process', async () => {
      let off = (): void => {};

      const refused = new Promise<{ readonly refused: true }>((resolve) => {
        const on = (): void => { resolve({ refused: true }); };

        off = () => { restarted.removeEventListener('abort', on); };

        if (restarted.aborted) on();
        else restarted.addEventListener('abort', on, { once: true });
      });

      try {
        return await Promise.race([work().then((value) => ({ value })), refused]);
      } finally {
        off();
      }
    }).pipe(Effect.flatMap((outcome) => ('refused' in outcome ? Effect.fail(new DevboxError('io', DISK_STALL_RESTARTED)) : Effect.succeed(outcome.value))));
  }

  #output(process: ExecProcess): Effect.Effect<Awaited<ReturnType<ExecProcess['output']>>, DevboxError> {
    return this.#unlessRestarted(() => process.output());
  }

  /** The runs whose kill began and has not ended. */
  #pinned(): readonly RunningExec[] {
    return [...this.#running.values()].filter((running) => running.killing === true);
  }

  /** Whether the pinned kills' trees wait on a disk that stopped answering: read with bash builtins alone, as a program
   *  not yet read from that disk would wait on it too. A kill whose process never answered its start has no tree to
   *  name, and the reading takes every process for it. */
  #diskStall(pinned: readonly RunningExec[]): Effect.Effect<DiskStall | null, DevboxError> {
    return Effect.gen({ self: this }, function* () {
      const container = this.ctx.container;

      if (container?.running !== true) return null;
      const read = yield* attempt('process', async () => await (await containerExec(container, ['/bin/bash', '-c', DISK_PROBE, 'devbox-disk-stall'])).output());
      const roots = pinned.every((running) => running.pid !== undefined) ? pinned.map((running) => running.pid ?? 0) : undefined;
      const stall = diskStallOf(new TextDecoder().decode(read.stdout), roots);

      this.#trace('disk.stall.read', { pinned: pinned.length, stalled: stall !== null, waiting: stall?.waiting.join(', '), reads: stall?.reads });

      return stall;
    });
  }

  /**
   * The owner's stop of a computer whose last stop is still waiting. A normal stop never restarts anything: this acts
   * only on a kill that began before it and has not ended, and restarts the computer only when the box's reading shows
   * that kill's tree waiting on a disk with reads in flight that never complete (`disk-stall.ts`). The container goes,
   * every run on it ends with the refusal that says why, and the next operation starts a fresh one from the box's last
   * save. Otherwise the stop is still finishing, and nothing changes.
   */
  stopStalled(): Promise<'restarted' | 'finishing' | 'nothing'> {
    return settle(Effect.gen({ self: this }, function* () {
      const pinned = this.#pinned();

      if (pinned.length === 0) return 'nothing' as const;
      const stall = yield* this.#diskStall(pinned);

      if (stall === null) return 'finishing' as const;
      const restart = this.#stallRestart;

      this.#stallRestart = new AbortController();
      this.#trace('disk.stall.restart', { waiting: stall.waiting.join(', '), device: stall.device, reads: stall.reads });
      restart.abort();
      yield* attempt('io', () => this.#replaceContainer(DISK_STALL_RESTARTED));

      return 'restarted' as const;
    }));
  }

  /** The only transition that clears a terminal refusal; keeps the `replace` stage, so a failed
   *  retry refuses again instead of destroying. Also re-runs an incomplete restoration. */
  attachNow(): Promise<AttachOutcome> {
    const arrived = this.#teardowns;

    return settle(Effect.gen({ self: this }, function* () {
      yield* this.#afterQuiesce(arrived, 'not-ready');

      return yield* attempt('not-ready', async (): Promise<AttachOutcome> => {
        this.#closed = false;
        this.stampInteraction();
        await this.#adopted();

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

      return await this.#checkpoint(kind);
    }));
  }

  /** Every checkpoint runs through here, so none interleave in storage (`createCheckpointLane`), and each awaits the
   *  adoption (D102) and checks the container it is about to commit as it runs, not as it was asked. */
  #checkpoint(kind: CheckpointKind): Promise<CheckpointOutcome> {
    return this.#lane.run(kind, async () => await this.#withStorageMutation(async () => {
      await this.#adopted();
      await this.#healReplacedContainer();
      const pending = this.#flights.startup;

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
    const starting = this.#flights.startup;

    this.#trace('quiesce.enter', { starting: starting !== undefined, callers: this.#activeCallers, ending });

    if (starting !== undefined) await Promise.allSettled([starting.run]);
    this.#trace('quiesce.startup', {});

    if (ending) await Promise.allSettled([...this.#running.keys()].map((execId) => this.killExec(execId)));

    if (this.#activeCallers !== 0) {
      this.#callersDrained = Promise.withResolvers<void>();
      await this.#callersDrained.promise;
    }

    this.#trace('quiesce.callers', {});

    await this.#resources.drain();
    this.#trace('quiesce.resources', {});
    await this.#lane.drain();
    this.#trace('quiesce.lane', {});
    await this.#storageMutationTail;
    this.#trace('quiesce.storage', {});

    if (this.ctx.container?.running !== true) {
      this.#invalidateGeneration();
      await this.onStop();

      return { kind: 'skipped', reason: 'the container is not running: nothing is attached to commit', bytes: undefined, movedBytes: undefined };
    }

    await this.#adopted();
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
      this.#trace('quiesce.list.enter', {});
      const listed = await this.#processes().list();
      this.#trace('quiesce.list.exit', { count: listed.length });
      const residents = new Set((await this.#procSpecs()).map(spec => spec.processId));

      // A supervised command seen to finish is done: its spec goes, so the next start does not run it again (staging
      // rc27, 2026-10-20: a three-hour job ran again from its first line on the next wake). One that failed keeps its
      // spec and restarts cold (D35), unless it runs as a job, whose end is told. Here, with admissions fenced, no start
      // of the same command can race the forget.
      await this.#reapJobs();

      for (const process of listed) if (process.status === 'completed' && residents.has(process.id)) await this.#supervised().forget(process.id, 'it finished');

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

  /** The rest's snapshot, given up after {@link restSnapshotWaitMs}: the box stops without it, and a take that lands
   *  later is owed for deletion. A box that waited on it refused every request while it waited. */
  async #restSnapshot(): Promise<void> {
    const saving = this.#snapshots.save();
    const waitMs = this.restSnapshotWaitMs;
    const late = Symbol('late');
    const [taken] = await Promise.allSettled([Promise.race([saving, scheduler.wait(waitMs).then(() => late)])]);

    if (taken.status === 'fulfilled' && taken.value === late) {
      this.#snapshots.abandon();
      unawaited(Promise.allSettled([saving]), 'a rest snapshot given up');
      await this.#record('quiesce', `the rest took no snapshot: the platform had not answered in ${String(waitMs / 1000)} s, so the next wake recovers from the backup`);
    } else if (taken.status === 'rejected') {
      await this.#record('quiesce', `the rest took no snapshot, so the next wake recovers from the backup: ${describe({ cause: taken.reason })}`);
    }
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

  /**
   * Also ends the box's own starts (D36), and deletes what the box kept of its workspace: its process specs, sessions,
   * settings and records, all but the snapshots still owed a deletion (account deletion).
   */
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
      await this.#snapshots.keepingOwed(async () => {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
      });
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
   *  a re-issue restarts under the same id; a failed start keeps the row for `stopSupervised`. `reveal`: the
   *  workspace's owner started it, so each of its launches reads the values its agents may read (`revealedEnv`). `job`:
   *  the background job it runs as, which the box tells of its end and its restores (`SupervisedProcessSpec.job`). */
  async startSupervised(command: string, cwd?: string, env: Readonly<Record<string, string>> = {}, as: { readonly reveal?: boolean; readonly job?: string } = {}): Promise<{ processId: string; job?: string }> {
    return await settle(this.#withActiveCaller(Effect.gen({ self: this }, function* () {
      yield* attempt('io', () => this.ensureReady());

      const result = yield* attempt('process', () => this.#supervised().run({
        kind: 'start', command, cwd: cwd ?? DEVBOX_WORKDIR, env, reveal: as.reveal === true, ...(as.job !== undefined && { job: as.job }),
      }));

      if (result.kind !== 'started') return yield* Effect.fail(new DevboxError('cancelled', 'supervised start was superseded'));
      // Its session is listed beside the person's own, by what it runs (D95).
      this.#recordJobSession(result.process.id, command, cwd ?? DEVBOX_WORKDIR);

      // The job it runs as, which a live run keeps from the start that made it.
      return { processId: result.process.id, ...(result.job !== undefined && { job: result.job }) };
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
      if (ended) await this.#endSession(jobSessionId(processId));

      return { stopped: ended };
    }));
  }

  /** What a supervised job wrote most recently. */
  supervisedLogs(processId: string, limits: { readonly lines?: number | undefined; readonly bytes?: number | undefined }): Promise<string> {
    return settle(Effect.gen({ self: this }, function* () {
      yield* attempt('io', () => this.ensureReady());

      return yield* attempt('process', () => this.#processes().logs(processId, limits));
    }));
  }

  /** A spec with no live row is not running: restoration has not started it yet, or its start
   *  failed and was recorded. */
  listSupervised(): Promise<readonly SupervisedProcessRow[]> {
    return settle(attempt('io', async () => {
      await this.ensureReady();
      this.#trace('list.ready', {});
      const specs = await this.#procSpecs();
      this.#trace('list.specs', { count: specs.length });
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

      const native = await this.#processes().list();
      this.#trace('list.native', { count: native.length });

      for (const live of native) {
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

    return unreadyOf(this.#restoration, this.#flights.hook !== undefined);
  }

  /** A read: it starts and wakes nothing. A running container an object reset left is adopted first (D102), so the
   *  report names the restoration it carries. */
  devboxState(): Promise<DevboxReport> {
    return settle(attempt('io', async () => {
      await this.#adopted();

      const [supervised, ports, incidents] = await Promise.all([
        this.#procSpecs(),
        this.#portSpecs(),
        this.ctx.storage.list<IncidentRow>({ prefix: INCIDENT_PREFIX }),
      ]);

      return {
        running: this.ctx.container?.running === true,
        restoration: this.#restoration.phase,
        ready: this.#quiescing === undefined && this.#restoration.phase === 'attached' && this.#flights.hook === undefined,
        unready: this.#quiescing === undefined ? this.#unready() : QUIESCING,
        lastInteractionAt: this.#lastInteraction
          ?? await this.ctx.storage.get<number>(LAST_INTERACTION_KEY),
        quietSince: await this.ctx.storage.get<number>(QUIET_SINCE_KEY),
        chain: parsedOrNull(DiskChainStateSchema, this.ctx.storage.kv.get<StoredValue>(DISK_STATE_KEY)),
        snapshot: this.#snapshots.record,
        lastAttach: await this.ctx.storage.get<AttachOutcome>(LAST_ATTACH_KEY),
        lastRestore: this.ctx.storage.kv.get<LastRestore>(LAST_RESTORE_KEY),
        lastTick: await this.ctx.storage.get<HeartbeatTick>(LAST_TICK_KEY),
        bootId: await this.ctx.storage.get<string>(BOOT_ID_KEY),
        replacedCount: await this.ctx.storage.get<number>(REPLACED_COUNT_KEY) ?? 0,
        size: this.#size(),
        runningSize: this.#runningSize(),
        supervised,
        ports,
        incidents: incidentTotals(incidents.values()),
        flights: {
          startupMs: this.#flights.startup === undefined ? null : Date.now() - this.#flights.startup.since,
          hookMs: this.#flights.hook === undefined ? null : Date.now() - this.#flights.hook.since,
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
      writeFileIfDigestInGuest(this.#container(), { journal: this.digestJournal, path, data: Buffer.from(contentBase64, 'base64'), ...write })).pipe(Effect.mapError(fileFault)));
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

        // A box that is not ready has nothing restored to commit: its start restores it, and no checkpoint failed
        // (#117 filed one every tick for an object that had restarted beside its container).
        if (outcome.kind === 'failed' && this.#admission() === undefined) {
          await this.#armStartup();

          return period;
        }

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
        await this.#adopted();

        if (this.ctx.container?.running !== true) {
          await this.#tick({ running: false, ping: 'skipped', armedNext: false });

          return null;
        }

        const settled = this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair';

        if (!settled) {
          await this.#tick({ running: true, ping: 'unready', armedNext: true });
          await this.#armStartup();

          return beat;
        }

        let observed: string;

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

        // A process that runs as a job and has ended is told now, on this beat: no other arm watches it. A store or box
        // that cannot answer is asked again on the next beat; the beat itself goes on.
        const told = await hold(attempt('io', () => this.#reapJobs()));

        if (Exit.isFailure(told)) console.error(`[devbox] telling ended jobs failed: ${describe({ cause: Cause.squash(told.cause) })}`);

        const now = Date.now();

        // Each lane covers its own tail; shell commands and supervised starts count via `#activeCallers`.
        const backgroundWork = this.#quiescing !== undefined || this.#activeCallers !== 0 || this.#openSockets !== 0
          || this.#resources.busy()
          || this.#lane.busy()
          || this.#flights.startup !== undefined
          || this.#flights.hook !== undefined;

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
      const read = await this.#execute(`ps -o pid=,etimes= -p ${pids.join(',')} || true`);
      const ages = new Map(read.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)).map(([pid = 0, age = 0]) => [pid, age] as const));

      return new Map(pids.map((pid) => [pid, {
        ageSeconds: ages.get(pid),
        ports: [...new Set(listeners.filter((row) => row.ancestry.includes(pid)).map((row) => row.port))],
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

    if (input.running) await this.onRunningTick(this.#runningSize() ?? this.#size());
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

  /**
   * A process that runs as a job has ended, or is being forgotten: its end is recorded for the workspace, with its exit
   * code and the tail of what it wrote, which says why. Its reason is never empty: a process that wrote nothing is said
   * to have written nothing, and one something else ended says what did. A crash is not restarted on a clock: the job
   * ends, and its agent decides.
   */
  async #jobEnded(spec: SupervisedProcessSpec & { readonly job: string }, process: ProcessRecord | null, as: EndTold = {}): Promise<void> {
    // A tail the box cannot read is no reason to keep the end untold.
    const read = await hold(attempt('io', async () => (process === null ? '' : await this.#processes().logs(spec.processId, { bytes: INCIDENT_REASON_MAX_CHARS }))));

    // A teardown or a replaced container came while it read: nothing is written to a box that is gone, and the spec it
    // leaves is told, or restored, by what holds the box now.
    if (as.current?.() === false) return;
    const tail = Exit.isSuccess(read) ? read.value : `(what it wrote could not be read: ${describe({ cause: Cause.squash(read.cause) })})`;
    const reason = [as.why, tail.trim() === '' ? undefined : tail].filter((part) => part !== undefined).join('\n') || 'it ended, and wrote nothing';

    await this.#record('process-ended', reason, { processId: spec.processId, job: spec.job, ...(process?.exitCode !== undefined && { exitCode: process.exitCode }) });
  }

  /**
   * Every process that runs as a job and has ended, told and forgotten, each under the reservation its start and stop
   * hold, so a start that took its id since is never retired by a stale look (D105).
   */
  async #reapJobs(): Promise<void> {
    for (const spec of await this.#procSpecs()) {
      if (spec.job !== undefined) await this.#supervised().run({ kind: 'reap', spec });
    }
  }

  async #record(
    stage: IncidentStage,
    reason: string,
    extra?: { readonly processId?: string; readonly port?: number; readonly job?: string; readonly exitCode?: number },
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

    // Each container call the chain makes, named by its command's first line, which holds paths and layer keys and no
    // credential: a checkpoint that never returns names the call it waits on.
    const exec = async (command: string) => {
      const call = command.split('\n', 1)[0]?.slice(0, 80) ?? '';

      this.#trace('chain.exec.enter', { call });
      const result = await this.#rawExec(command, DEVBOX_RUNTIME_DIR);

      this.#trace('chain.exec.exit', { call, exitCode: result.exitCode });

      return result;
    };

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
        this.#trace('chain.mount.unmount', {});
        await this.#routes().unmount(STORE_MOUNT);
        this.#trace('chain.mount.mount', {});
        await this.#routes().mount(STORE_MOUNT);
        this.#trace('chain.mount.exit', {});
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

  /**
   * The values a supervised job its owner started may read, asked at each of its launches: a box with no account to
   * ask has none. The job holds them in memory; nothing of them is written to its spec or its directory.
   */
  protected async revealedEnv(): Promise<Readonly<Record<string, string>>> { return {}; }
  /** The name the box answers to, one DNS label of at most 63 characters, read at each start (D96); unset, the
   *  platform's 64-character container id, which no DNS label holds. */
  protected async hostname(): Promise<string | undefined> { return undefined; }
  /** The object of this class that builds the golden every box starts from (D65): one per deployment of the class,
   *  unless a host that deploys the class again for each run names its own. */
  protected get goldenName(): string { return GOLDEN_NAME; }
  /** The Worker version this object runs, read at construction and at each start: a start refused under another is asked
   *  again (D94). Unset, only a changed input or a caller's explicit ask lifts a refusal. */
  protected get workerVersion(): string | undefined { return undefined; }
  /** The mark at the centre of the desktop's wallpaper, an SVG document drawn in its own colour (D88); unset, none. */
  protected get desktopMark(): string | undefined { return undefined; }

  /** Whether a running container is the one the box restored, as far as storage says: its routes and mounts are kept. */
  #reused(): boolean {
    return this.#durableClaim() !== undefined || this.#restoration.phase === 'attached' || this.#restoration.phase === 'repair';
  }

  /** The container while the box is ready for it, else undefined: reads that neither start nor wait take this (R1). */
  #readyContainer(): Container | undefined {
    const container = this.ctx.container;

    return container?.running === true && this.#quiescing === undefined && this.#admission() !== undefined ? container : undefined;
  }

  /** Applies a changed outbound policy to the running container once it is adopted (D102); a stopped one takes it at its
   *  start. */
  protected async reconfigure(): Promise<void> {
    await this.#adopted();

    if (this.ctx.container?.running === true) await this.configureContainer();
  }

  protected async configureContainer(reused = this.#reused()): Promise<void> {
    await this.#routes().configure(await this.outboundPolicy(), this.store, reused);
    this.#renewContainer();
    await this.#forgetClosedSessions();
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
      this.#trace('desktop.check.enter', {});
      const process = yield* this.#spawn(['/bin/bash', '-c', DESKTOP_CHECK, 'devbox-desktop', this.desktopMark ?? ''], {}, running);

      this.#trace('desktop.check.started', {});
      const checked = decoded(yield* this.#output(process));

      this.#trace('desktop.check.exit', { exitCode: checked.exitCode });

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
        const shot = yield* this.#output(process);
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
        Effect.flatMap((process) => this.#output(process).pipe(Effect.map(decoded)).pipe(
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

  #files(): Files { return this.#fileClient ??= new Files(seamedContainer(this.#container())); }
  #processes(): Processes {
    return this.#processClient ??= new Processes(this.#container(), undefined, (event, fields) => { this.#trace(event, fields); });
  }

  #supervised(): SupervisedProcesses {
    return this.#supervisedClient ??= new SupervisedProcesses({
      storage: this.ctx.storage, lane: this.#resources, native: () => this.#processes(), generation: () => this.#generation,
      failedStop: (processId, cause) => this.#record('process', describe({ cause }), { processId }),
      revealed: () => this.revealedEnv(),
      ended: (spec, process, as) => this.#jobEnded(spec, process, as),
    });
  }

  async #execute(command: string, options: DevboxExecOptions = {}): Promise<ExecResult> {
    return decoded(await (await launch(this.#container(), ['/bin/bash', '-c', command], options)).output());
  }

  #renewContainer(): void {
    if (this.ctx.container?.running) unawaited(this.ctx.container.setInactivityTimeout(this.policy.idleMs + this.policy.quietConfirmMs + 60_000), 'setting container inactivity timeout');
  }

  async #destroyContainer(): Promise<void> {
    // A server that runs no containers (a dev server, vite.config.ts) never started one: there is none to end.
    if (this.ctx.container === undefined) return;

    await this.#container().destroy();
    await this.onStop();
  }

  async #stopContainer(): Promise<void> {
    const container = this.#container();

    if (!container.running) return;
    const ending = container.monitor();

    // PID 1 is tini, which catches no signal, so the kernel drops a TERM sent it from inside: every other process gets
    // one, and tini exits with its child, the container with it (staging, 2026-10-21: a new boot id after). Through
    // the seam, as the platform's `signal()` is a task nobody can await (`containerExec`). Its exec may end with the
    // container it ends, which is no failure; a kill that refuses fails the stop (`endEveryProcess`).
    const sending = endEveryProcess(container);

    try { await Promise.all([sending, ending]); }
    catch (cause) { if (container.running) throw cause; }

    // The box ended this container itself: the next one is a start, not a replacement.
    await this.ctx.storage.delete(BOOT_ID_KEY);
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

      // Answered at once, the socket the runtime's (D109): the pane is told why it waits, and attaches as soon as the box
      // can take it. One that left meanwhile is owed no PTY.
      const sockets = new WebSocketPair();
      const server = sockets[1];

      this.ctx.acceptWebSocket(server);
      this.#terminals.set(server, { waiting: [] });
      unawaited(this.#attachWhenReady(server, url.searchParams, session, this.#teardowns), 'attaching a terminal');

      return new Response(null, { status: 101, webSocket: sockets[0] });
    }));
  }

  /** The terminal on `server` once the box is ready (`attachWhenReady`, D109). `arrived`: the box's teardowns when it was
   *  asked, so a destroy meanwhile ends the wait. A pane that could not attach is let go. */
  async #attachWhenReady(server: WebSocket, params: URLSearchParams, session: SessionRecord, arrived: number): Promise<void> {
    const events = await attachWhenReady({
      socket: server, held: () => this.#terminals.has(server),
      ask: () => this.#resolveReadiness(arrived), wait: (ms) => scheduler.wait(ms), now: () => Date.now(),
      attach: () => this.#withActiveCaller(attempt('io', async () => attachTerminal((await this.#ensureReady(arrived)).container, params, session, server))),
    });

    if (events === null) this.#terminals.delete(server);
    else this.#attached(server, events);
  }

  /** The pane's PTY on `server` takes its events, and what the pane sent while it waited; one gone meanwhile ends it. */
  #attached(server: WebSocket, events: TerminalSocketEvents): void {
    const held = this.#terminals.get(server);

    if (held === undefined || !('waiting' in held)) {
      events.close();

      return;
    }

    this.#terminals.set(server, { attached: events });
    server.send(JSON.stringify({ type: 'ready' } satisfies TerminalControl));

    for (const message of held.waiting) events.message(message);
  }

  /** A terminal's keystrokes and resizes: to its PTY, or kept for it while it attaches. One the box no longer holds (its
   *  object restarted under it) is closed, so its pane attaches again. */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const held = this.#terminals.get(socket);

    if (held === undefined) {
      socket.close(1012, 'terminal restarted');

      return;
    }

    if ('waiting' in held) held.waiting.push(message);
    else held.attached.message(message);
  }

  /** A terminal's visitor left, cleanly or not: a close of ours, never the request's exception (D109). */
  override webSocketClose(socket: WebSocket): void {
    this.#released(socket)?.close();
  }

  override webSocketError(socket: WebSocket): void {
    this.#released(socket)?.error();
  }

  /** The box lets the terminal on `socket` go: its PTY's events, when it had attached. */
  #released(socket: WebSocket): TerminalSocketEvents | undefined {
    const held = this.#terminals.get(socket);

    this.#terminals.delete(socket);

    return held !== undefined && 'attached' in held ? held.attached : undefined;
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


  /**
   * What each terminal session showed and was running, kept on the box's disk as it stops (D97). A save that fails is
   * traced and the stop goes on: the sessions come back fresh in their folders, as before D97.
   */
  async #saveSessions(): Promise<void> {
    const container = this.ctx.container;

    if (container?.running !== true) return;
    const ids = this.#sessionRecords().map((record) => record.id);
    const [saved] = await Promise.allSettled([(async () => (await containerExec(container, ['bash', '-c', SESSIONS_SAVE, 'sessions-save', ...ids])).output())()]);

    if (saved.status === 'rejected') this.#trace('sessions.unsaved', { reason: describe({ cause: saved.reason }) });
    else if (saved.value.exitCode !== 0) this.#trace('sessions.unsaved', { reason: new TextDecoder().decode(saved.value.stderr).trim() });
  }

  /** The sessions closed while the box was stopped, whose saves its next start removes (D97). */
  #closedSessions(): string[] {
    return parsedOrNull(v.array(v.string()), this.ctx.storage.kv.get<StoredValue>(SESSIONS_CLOSED_KEY)) ?? [];
  }

  /**
   * Removes what the box saved of sessions closed while it was stopped, before any attach could show one: the first
   * session comes back under its own id when the last is closed. A removal that fails is traced and asked again at the
   * next start.
   */
  async #forgetClosedSessions(): Promise<void> {
    const ids = this.#closedSessions();

    if (ids.length === 0) return;
    const [forgot] = await Promise.allSettled([(async () => (await containerExec(this.#container(), ['sh', '-c', SESSIONS_FORGET, 'sessions-forget', ...ids])).output())()]);

    if (forgot.status === 'fulfilled' && forgot.value.exitCode === 0) this.ctx.storage.kv.delete(SESSIONS_CLOSED_KEY);
    else this.#trace('sessions.unforgotten', { ids: ids.join(' '), reason: forgot.status === 'rejected' ? describe({ cause: forgot.reason }) : new TextDecoder().decode(forgot.value.stderr).trim() });
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
  /**
   * The records as they are when the read answers, not as they were when it began: an open, rename or close made while
   * the exec ran stays, and a session still recorded keeps the folder the read found it in.
   */
  terminalSessions(): Promise<readonly TerminalSession[]> {
    return settle(attempt('io', async () => {
      await this.#adopted();
      const container = this.#readyContainer();

      // An unready box's sessions are its records: its container's restoration is not confirmed, and the records must
      // not move to it (R1).
      if (container === undefined) return mergeSessions(this.#sessionRecords(), null);
      const read = parseSessionsRead(decoded(await (await containerExec(container, ['bash', '-c', SESSIONS_READ, 'terminal-sessions', PORT_LISTENERS])).output()).stdout);
      const records = this.#sessionRecords();
      const moved = records.map((record) => ({ ...record, cwd: read.get(record.id)?.cwd ?? record.cwd }));

      if (moved.some((record, at) => record.cwd !== records[at]?.cwd)) this.ctx.storage.kv.put(SESSIONS_KEY, moved);

      return mergeSessions(moved, read);
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

      const job = session.job;

      // A job on a computer that is running or starting is stopped there; a stopped computer is not started to stop
      // it: its spec goes, so no start brings it back.
      if (job !== undefined && (this.ctx.container?.running === true || this.#flights.startup !== undefined)) {
        yield* attempt('io', () => this.stopSupervised(job));

        return;
      }

      if (job !== undefined) yield* attempt('io', () => this.#supervised().forget(job, 'its session was closed while the computer was stopped'));
      yield* attempt('io', () => this.#endSession(id));
    }));
  }

  /**
   * A session's shell and screen end, and its record goes. A stopped box cannot remove what it saved of the session;
   * its next start does, before any attach (D97).
   */
  async #endSession(id: string): Promise<void> {
    await this.#adopted();
    const container = this.ctx.container;

    if (container?.running === true) await resetTerminal(container, id);
    else this.ctx.storage.kv.put(SESSIONS_CLOSED_KEY, [...this.#closedSessions(), id]);
    this.ctx.storage.kv.put(SESSIONS_KEY, this.#sessionRecords().filter((record) => record.id !== id));
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
  // Its output is the exec's too: a container that answered and then went is read against the start's refusal as well.
  const [admitted] = await Promise.allSettled([containerExec(container, ['/bin/true'], { signal }).then(async (process) => await process.output())]);

  if (admitted?.status !== 'fulfilled') return admissionFailure(container, { cause: admitted?.reason });

  return admitted.value.exitCode === 0 ? undefined : new DevboxError('io', `native container admission exited ${String(admitted.value.exitCode)}`);
}

async function firstExec(container: Container, signal: AbortSignal): Promise<void> {
  const failed = await admissionFailureOf(container, signal);

  if (failed !== undefined) throw failed;
}

/** A locale that reads text as UTF-8; the C one the box starts in reads a byte past ASCII as an invalid sequence. */
const UTF8 = { LC_ALL: 'C.UTF-8' };

function launch(container: Container, argv: readonly string[], options: DevboxExecOptions): Promise<ExecProcess> {
  return containerExec(container, [...argv], {
    cwd: options.cwd ?? DEVBOX_WORKDIR, env: boxEnv(options.env ?? {}),
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

