/** Pure decisions: nothing here touches a container, a bucket or a clock. */

import * as v from 'valibot';
import { devboxFailure, startOverrun } from './errors';

import type { StoredValue } from './storage';

/** A subclass returns a whole policy, never a partial override, so one place states every
 *  timing a box runs on. */
export interface DevboxPolicy {
  /** Stays well under every platform idle window, and is cheap enough to leave armed
   *  for the container's whole life. */
  readonly heartbeatSeconds: number;
  /** The last interaction must be at least this old before quiescing starts. */
  readonly idleMs: number;
  /** Quiescing also requires this much OBSERVED quiet — consecutive
   *  heartbeats that agreed — so one unlucky sample cannot stop a box. */
  readonly quietConfirmMs: number;
  /** The ambient checkpoint's period and minimum gap: the loss window. */
  readonly checkpointIntervalMs: number;
  /** The whole onStart restore budget; a raced timer bounds each step. */
  readonly attachBudgetMs: number;
  /** Cap on waiting for a restored server to listen; a forked process is STARTED before it binds.
   *  A cap, not a per-port timer: each port gets min(this, remaining `attachBudgetMs`). */
  readonly portWaitMs: number;
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

/** The `devbox:` prefix keeps these rows apart from a host's own durable keys.
 *  The names are a contract kept beside the policy, not one module's internals. */
export const LAST_INTERACTION_KEY = 'devbox:last-interaction';

export const QUIET_SINCE_KEY = 'devbox:quiet-since';

/** What abandoned container-start work rejected with, if it ever settled.
 *  Any value can be thrown, so `cause` is `unknown`; every reader narrows it before use. */
export interface LateStartFailure {
  readonly cause: unknown;
}

/** Every post-attach step (restart, listener proof, expose, boot stamp) draws on this one budget;
 *  each allowance is the remainder divided by the steps still declared, nothing reserved. */
interface StartBudget {
  /** The window this budget was opened with; carried so a refusal names the budget it spent
   *  and the call site holds no second copy of the number. */
  readonly budgetMs: number;
  readonly clock: StartClock;
  /** Milliseconds left before the deadline, never negative. */
  remainingMs(): number;
  declare(steps: number): void;
  /** The next step's allowance, which also counts that step as taken. */
  nextAllowanceMs(): number;
}

/** A start budget takes its clock from the host; the native owner uses a container deadline. */
export interface StartClock {
  now(): number;
  after(ms: number, fire: () => void): () => void;
}

const REAL_START_CLOCK: StartClock = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);

    return () => clearTimeout(timer);
  },
};

export function openStartBudget(budgetMs: number, clock: StartClock = REAL_START_CLOCK): StartBudget {
  const openedAt = clock.now();
  let declared = 0;
  const remainingMs = (): number => Math.max(0, budgetMs - (clock.now() - openedAt));

  return {
    budgetMs,
    clock,
    remainingMs,
    declare: (steps) => { declared += Math.max(0, steps); },
    nextAllowanceMs: () => {
      const share = remainingMs() / Math.max(1, declared);
      declared = Math.max(0, declared - 1);

      return share;
    },
  };
}

/** What one step of the restoration did with its allowance. Neither `late` nor
 *  `failed` is thrown: see {@link runRestoreStep}. */
export type StepOutcome<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'late' }
  | { readonly kind: 'failed'; readonly cause: unknown };

/** Reporting counterpart of `withContainerStartDeadline`: post-attach steps never mutate the mount,
 *  so a late one leaves no retry collision and costs only readiness, never the container. */
export async function runRestoreStep<T>(
  allowanceMs: number,
  work: () => Promise<T>,
  onLate: (failure: LateStartFailure) => void,
  clock: StartClock = REAL_START_CLOCK,
): Promise<StepOutcome<T>> {
  // A thrown step is returned as `failed`, not rethrown: every caller needs a reason to report
  // and a walk that continues.
  try {
    return await raceAllowance(allowanceMs, work, onLate, clock);
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/** The only place a timer bounds container work; `withContainerStartDeadline` and
 *  `runRestoreStep` both build on it, so keep one copy of this race. */
async function raceAllowance<T>(
  allowanceMs: number,
  work: () => Promise<T>,
  onLate: (failure: LateStartFailure) => void,
  clock: StartClock,
): Promise<StepOutcome<T>> {
  let late = false;

  // `then` is annotated, not cast: inference widens `{ kind: 'done' }` to `{ kind: string }`,
  // and a cast would put a caller-selected type where a constructed one belongs.
  const started = work().then<StepOutcome<T>, StepOutcome<T>>(
    (value) => ({ kind: 'done', value }),
    (cause: LateStartFailure['cause']) => {
      if (!late) throw cause;
      onLate({ cause });

      // The race already answered `late`; this arm reports the failure instead of leaving
      // an unhandled rejection, and returns a promise that never settles.
      return Promise.withResolvers<StepOutcome<T>>().promise;
    },
  );

  const { promise: expiry, resolve } = Promise.withResolvers<StepOutcome<T>>();

  const disarm = clock.after(allowanceMs, () => {
    late = true;
    resolve({ kind: 'late' });
  });

  try {
    return await Promise.race([started, expiry]);
  } finally {
    disarm();
  }
}

/** Throws on overrun: an abandoned attach is mid-mount and unreachable, so a retry collides;
 *  recovery replaces the container. `onOverrun` gets the late outcome, often the only diagnostic. */
async function withContainerStartDeadline<T>(
  label: string,
  budget: StartBudget,
  work: () => Promise<T>,
  onOverrun: (failure: LateStartFailure) => void,
): Promise<T> {
  const budgetMs = budget.remainingMs();
  const raced = await raceAllowance(budgetMs, work, onOverrun, budget.clock);

  if (raced.kind === 'late') throw startOverrun(label, budgetMs);

  // A real failure is rethrown unwrapped so the attach's own error reaches the taxonomy
  // unchanged.
  if (raced.kind === 'failed') throw raced.cause;

  return raced.value;
}

/** Handed to the restore walk so its two failure policies (attach throws, post-attach steps
 *  report) stay one contract instead of spreading over six call sites. */
export interface RestoreSteps {
  /** A post-attach step (process start, listener proof, exposure, boot stamp); reports,
   *  never throws — see {@link runRestoreStep}. */
  run<T>(work: () => Promise<T>, onLate: (failure: LateStartFailure) => void): Promise<StepOutcome<T>>;
  /** The attach: the one step whose failure THROWS, because it is the only one
   *  that is mid-mount when it ends. */
  attach<T>(work: () => Promise<T>, onOverrun: (failure: LateStartFailure) => void): Promise<T>;
  declare(steps: number): void;
  /** A declared step that will not run, releasing its budget share to the steps after it,
   *  so ports behind an unanswered listener are not charged for its silence. */
  skip(): void;
  remainingMs(): number;
}

/** Each step races its allowance; an abandoned attach is classified `abandoned` so
 *  the ladder replaces the identity whose mount it left half-built. */
export function racedRestoreSteps(budget: StartBudget): RestoreSteps {
  return {
    run: async (work, onLate) => await runRestoreStep(budget.nextAllowanceMs(), work, onLate, budget.clock),
    attach: async (work, onOverrun) =>
      await withContainerStartDeadline('Devbox.attach', budget, work, onOverrun),
    declare: (steps) => budget.declare(steps),
    skip: () => void budget.nextAllowanceMs(),
    remainingMs: () => budget.remainingMs(),
  };
}

/** Classifies failures by the SDK's `ErrorCode`, never by message text; each class needs
 *  a different recovery, so one generic retry policy is wrong for most of them. */
export type RecoveryClass =
  /** This attempt left work running in the container that the Durable Object cannot stop,
   *  so the identity must go. Evidence against the container, unlike `stale-owner`. */
  | 'abandoned'
  /** The attempt is void, its successor is not; says nothing about the container's health,
   *  so it must never advance a ladder that ends in destroying one. */
  | 'stale-owner'
  /** A resource ran out. Running the same work again spends it again. */
  | 'exhausted'
  /** Configuration the container cannot satisfy. The inputs are the same next
   *  time, so the answer is too. */
  | 'permanent'
  /** The transport dropped, or the container was not up yet. */
  | 'transient'
  /** Nothing classified it, e.g. an R2 rejection or a defect in this package; handled as
   *  the least destructive outcome that can still make progress. */
  | 'unclassified';

/** Only codes whose recovery class is known; an unknown wrapper is transparent. */
const RECOVERY_BY_CODE: ReadonlyMap<string, RecoveryClass> = new Map([
  ['mount-marker', 'permanent'],
  ['configuration', 'permanent'],
  ['invalid-input', 'permanent'],
  ['not-ready', 'transient'],
  ['ENOSPC', 'exhausted'],
  ['EFBIG', 'exhausted'],
  ['EMFILE', 'exhausted'],
  ['ENFILE', 'exhausted'],
  ['EACCES', 'permanent'],
  ['EPERM', 'permanent'],
  ['EROFS', 'permanent'],
  // The container's own disk and descriptor limits. Copying a base into a full
  // filesystem again is exactly the harmful repetition this class exists for.
  ['NO_SPACE', 'exhausted'],
  ['FILE_TOO_LARGE', 'exhausted'],
  ['TOO_MANY_FILES', 'exhausted'],
  // Credentials, mount options and commands are inputs. A retry reads the same
  // ones.
  ['MISSING_CREDENTIALS', 'permanent'],
  ['INVALID_MOUNT_CONFIG', 'permanent'],
  ['INVALID_BACKUP_CONFIG', 'permanent'],
  ['COMMAND_NOT_FOUND', 'permanent'],
  ['INVALID_COMMAND', 'permanent'],
  ['COMMAND_PERMISSION_DENIED', 'permanent'],
  ['PERMISSION_DENIED', 'permanent'],
  ['READ_ONLY', 'permanent'],
  // The runtime was replaced or the session died under the operation; the SDK code says so,
  // so no generation comparison is needed.
  ['OPERATION_INTERRUPTED', 'stale-owner'],
  ['SESSION_TERMINATED', 'stale-owner'],
  ['SESSION_DESTROYED', 'stale-owner'],
  ['RPC_TRANSPORT_ERROR', 'transient'],
  ['CONTAINER_UNAVAILABLE', 'transient'],
]);

/** Code getters and JSRPC-crossed error properties share this boundary. */
const CodedFailureSchema = v.object({ code: v.string() });

/** Walks the whole cause chain: the snapshot chain wraps SDK failures as `cause`.
 *  The outermost classified answer wins; an unclassified wrapper is transparent. */
export function classifyRecovery(thrown: { readonly cause: unknown }): RecoveryClass {
  for (let value = thrown.cause; ;) {
    const code = devboxFailure({ cause: value })?.code;

    if (code === 'start-overrun' || code === 'start-interrupted') return 'abandoned';
    const coded = v.safeParse(CodedFailureSchema, value);

    if (coded.success) {
      const held = RECOVERY_BY_CODE.get(coded.output.code);

      if (held !== undefined) return held;
    }

    if (!(value instanceof Error) || value.cause === undefined) return 'unclassified';
    value = value.cause;
  }
}

/** Stages are actions: retry the same identity, then replace it; a failure at `replace` is
 *  terminal. Stored durably: `onStart` is a container hook, so an alarm-woken object skips it. */
const RECOVERY_STAGES = ['retry', 'replace'] as const;

export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

/** `owner` is minted per attempt; every write is conditional on it, since an isolate reset
 *  restarts the generation counter. `stage` appears only when the ladder advances. */
const RecoveryRowSchema = v.strictObject({
  owner: v.string(),
  stage: v.optional(v.picklist(RECOVERY_STAGES)),
});

export type RecoveryRow = v.InferOutput<typeof RecoveryRowSchema>;

/** `malformed` is not `absent`: absent leads to a retry, so treating an unreadable row as
 *  absent restarts the ladder every time and could destroy an identity repeatedly. */
type StoredRecovery =
  | { readonly kind: 'absent' }
  | { readonly kind: 'row'; readonly row: RecoveryRow }
  | { readonly kind: 'malformed' };

/** Strict parse, unknown keys included: one code path writes this row and a successful
 *  attempt deletes it, so there is no older shape to accept. */
export function parseRecoveryRow(stored: StoredValue): StoredRecovery {
  if (stored === undefined) return { kind: 'absent' };
  const parsed = v.safeParse(RecoveryRowSchema, stored);

  return parsed.success ? { kind: 'row', row: parsed.output } : { kind: 'malformed' };
}

interface RecoveryAdmission {
  readonly admit: boolean;
  /** The stage the claim must carry: preserved for an admitted attempt, and the
   *  most conservative readable value for a refused one. */
  readonly stage: RecoveryStage | undefined;
}

/** A malformed row is refused, not treated as absent: absent restarts the ladder and could
 *  destroy an identity again; normalising to terminal `replace` keeps the ladder readable. */
export function admissionStep(stored: StoredRecovery): RecoveryAdmission {
  if (stored.kind === 'malformed') return { admit: false, stage: 'replace' };

  return { admit: true, stage: stored.kind === 'row' ? stored.row.stage : undefined };
}

type RecoveryAction =
  /** A newer attempt owns the lifecycle. Change nothing, tell no one, arm
   *  nothing, destroy nothing. */
  | 'inert'
  /** Ask this same container identity again, on the existing schedule. */
  | 'retry'
  /** Destroy the container identity and prove it gone before anything attaches
   *  again. */
  | 'replace'
  /** Stop. Nothing this box can do next changes the answer. */
  | 'refuse';

interface RecoveryInput {
  readonly owned: boolean;
  readonly failure: RecoveryClass;
  /** Read once, at admission: the claim proves ownership of the row, and a re-read may see
   *  a value another attempt has moved. */
  readonly stage: RecoveryStage | undefined;
}

interface RecoveryDecision {
  readonly action: RecoveryAction;
  /** Never deletes the row: only a succeeded attempt may, or the next eviction resets a
   *  destructive stage and the box could destroy an identity again. */
  readonly stage: RecoveryStage | undefined;
}

/** No retry and no replacement changes the answer: the same container, or its successor, fails the same way. */
export function isTerminalRecovery(failure: RecoveryClass): boolean {
  return failure === 'exhausted' || failure === 'permanent';
}

/** A stale owner retries without advancing; abandoned work enters at `replace`. */
export function recoveryStep(input: RecoveryInput): RecoveryDecision {
  if (!input.owned) return { action: 'inert', stage: input.stage };
  const { stage } = input;

  if (isTerminalRecovery(input.failure)) {
    return { action: 'refuse', stage };
  }

  if (input.failure === 'stale-owner') {
    return { action: 'retry', stage };
  }

  if (stage === 'replace') return { action: 'refuse', stage };

  if (input.failure === 'abandoned' || stage === 'retry') {
    return { action: 'replace', stage: 'replace' };
  }

  return { action: 'retry', stage: 'retry' };
}

// A devbox serving a caller must not sleep: the disk is ephemeral (P1), so idle expiry costs
// an attach. `renewActivityTimeout()` calls become one durable stamp the heartbeat reads.

interface QuiesceInput {
  readonly now: number;
  readonly containerRunning: boolean;
  readonly lastInteractionAt: number;
  /** When quiet was first observed on this stretch; the caller carries it between ticks
   *  because the clock lives in durable state, not here. */
  readonly quietSince: number | undefined;
  readonly backgroundWork: boolean;
  readonly idleMs: number;
  readonly quietConfirmMs: number;
}

export type QuiesceAction = 'hold' | 'quiesce';

interface QuiesceDecision {
  readonly action: QuiesceAction;
  /** What the caller must persist for the next tick. `undefined` means the
   *  quiet stretch ended and the stored value must be deleted. */
  readonly quietSince: number | undefined;
}

/** A quiet stretch cannot predate the last interaction: a long alarm callback starves beats,
 *  so a busy sample can be missed; an older `quietSince` restarts the confirmation. */
export function quiesceStep(input: QuiesceInput): QuiesceDecision {
  if (!input.containerRunning) return { action: 'hold', quietSince: undefined };

  const idleEnough = input.now - input.lastInteractionAt >= input.idleMs
    && !input.backgroundWork;

  if (!idleEnough) return { action: 'hold', quietSince: undefined };

  const quietSince = input.quietSince !== undefined && input.quietSince >= input.lastInteractionAt
    ? input.quietSince
    : input.now;

  const confirmed = input.now - quietSince >= input.quietConfirmMs;

  return { action: confirmed ? 'quiesce' : 'hold', quietSince };
}

/** TERM's grace before KILL for supervised processes: long enough to flush, short
 *  enough to stop within ceilings. */
export const TERM_GRACE_MS = 5_000;

/** A rejection reason is whatever was thrown, so a non-`Error` value is stringified.
 *  Shared so every failure path renders thrown values the same way. */
export function describeThrown(thrown: { readonly cause: unknown }): string {
  const { cause } = thrown;

  if (cause instanceof Error) {
    return cause.cause === undefined
      ? cause.message
      : `${cause.message}: ${describeThrown({ cause: cause.cause })}`;
  }

  return String(cause);
}

/** A background process a devbox restarts after attach. A bare `nohup … &` child is not
 *  restorable: only a durable spec survives container replacement, so use the supervised call. */
export interface SupervisedProcessSpec {
  readonly processId: string;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly createdAt: number;
}

/** The token is generated once and reused so preview URLs survive restarts verbatim;
 *  forwarding is re-activated after attach by exposing the port with the same token. */
export interface PortExposureSpec {
  readonly port: number;
  readonly name: string | undefined;
  readonly token: string;
  readonly createdAt: number;
}

/** The SDK accepts preview-URL tokens of 1 to 16 chars of `[a-z0-9_]`; sixteen matches the
 *  shape of an auto-generated one. */
const PORT_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generatePortToken(random: (n: number) => Uint8Array): string {
  const bytes = random(16);
  let token = '';

  for (const byte of bytes) token += PORT_TOKEN_ALPHABET[byte % PORT_TOKEN_ALPHABET.length];

  return token;
}

/** Any HTTP answer, 4xx and 5xx included, proves a listener exists; health is not the question.
 *  curl exit 7 is connection refused. */
export function healthProbeCommand(port: number): string {
  return `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 `
    + `--head http://127.0.0.1:${port}/ 2>&1 || true`;
}

/** An unparsable answer counts as silent: exposing a port on that guess hands back a URL
 *  that answers 502. */
export function healthProbeSilent(output: string): boolean {
  const [codeStr, exitStr] = output.trim().split('|');

  if (exitStr !== undefined && Number.parseInt(exitStr, 10) === 7) return true;
  const code = codeStr === undefined ? Number.NaN : Number.parseInt(codeStr, 10);

  return !Number.isFinite(code) || code === 0;
}

/** Waits in the container (one hop, not a round trip per probe); count-bounded; breaks on
 *  curl's exit code; `break`, never `exit`, since `exit` kills the persistent session shell. */
export function awaitListenerCommand(port: number, attempts: number, intervalMs: number): string {
  // Fractional seconds, because the cadence is expressed in milliseconds and
  // `sleep` in an Alpine image takes a decimal.
  const seconds = (Math.max(1, intervalMs) / 1_000).toFixed(2);

  return `answer=; for _ in $(seq 1 ${String(Math.max(1, attempts))}); do `
    + `answer=$(${healthProbeCommand(port)}); `
    + `case "$answer" in *'|0') break ;; *) sleep ${seconds} ;; esac; `
    + 'done; printf %s "$answer"';
}

/** Two phases: every process starts before any port is exposed, and a port is exposed only
 *  after its own listener answers, so the shape cannot express "expose without a listener". */
interface RestartPlan {
  readonly start: readonly SupervisedProcessSpec[];
  /** Ascending and deduplicated so every restart is identical and reproducible when it fails.
   *  A second spec for one port resolves to the storage's last write. */
  readonly serve: readonly PortExposureSpec[];
}

export function restartPlan(
  processes: readonly SupervisedProcessSpec[],
  ports: readonly PortExposureSpec[],
): RestartPlan {
  const exposed = new Map(ports.map(spec => [spec.port, spec]));

  return {
    start: processes,
    serve: [...exposed.values()].sort((a, b) => a.port - b.port),
  };
}


/** A runtime list, not a bare type union: the receiving host validates stages against it,
 *  so producer and consumer share this one list or incidents get rejected unseen. */
export const INCIDENT_STAGES = ['attach', 'checkpoint', 'process', 'port', 'quiesce', 'rest', 'recovered'] as const;

export type IncidentStage = (typeof INCIDENT_STAGES)[number];

export interface RestProcess {
  readonly id: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly supervised: boolean;
}

export interface RunningForRest {
  readonly live: readonly RestProcess[];
  readonly unreadable: string | undefined;
}

export interface RestDetail {
  readonly ageSeconds: number | undefined;
  readonly ports: readonly number[];
}

export type RestAnswer = 'now' | 'keep';

export type RestAnswered =
  | { readonly kind: 'resting' }
  | { readonly kind: 'kept'; readonly askAgainAfterMs: number }
  | { readonly kind: 'refused' | 'failed'; readonly reason: string };

function ageText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
}

export function restAskText(running: RunningForRest, details: ReadonlyMap<number, RestDetail>, windowMinutes: number): string {
  const head = `The sandbox has not been used for ${String(windowMinutes)} minutes and would rest now`;
  const again = `sandbox.rest('keep') leaves it running, and it asks again after about ${String(windowMinutes)} minutes without use.`;

  if (running.unreadable !== undefined) {
    return `${head}, but its process list could not be read (${running.unreadable}), so it cannot tell whether a command `
      + `is still running, and resting could end one. ${again}`;
  }

  const lines = running.live.map((row) => {
    const detail = row.pid === undefined ? undefined : details.get(row.pid);

    const facts = [
      ...(row.pid === undefined ? [] : [`pid ${String(row.pid)}`]),
      ...(detail?.ageSeconds === undefined ? [] : [`running ${ageText(detail.ageSeconds)}`]),
      ...(detail === undefined || detail.ports.length === 0 ? [] : [`listening on ${detail.ports.join(', ')}`]),
    ];

    const fate = row.supervised
      ? 'supervised: resting stops it, and it restarts cold on its next use, without its in-memory state'
      : 'resting ends it, and it does not come back';

    return `- \`${row.command.slice(0, 160)}\` (${[...facts, fate].join('; ')})`;
  });

  return `${head}, but these processes still run in it:\n${lines.join('\n')}\n${again}`;
}

/** Recorded durably before anyone is told. `reason` carries ids and stages only: never an
 *  object key, bucket name, token or presigned value, since incidents get forwarded. */
export interface DevboxIncident {
  readonly incidentId: string;
  readonly stage: IncidentStage;
  readonly reason: string;
  readonly processId: string | undefined;
  readonly port: number | undefined;
  readonly at: number;
}

/** `queued` only once the announcement landed; `undelivered` (or a throw) keeps the row pending
 *  for retry; `rejected` is a caller shape defect, recorded and never retried. */
export type IncidentDisposition = 'queued' | 'undelivered' | 'rejected';

/** Delivery persists before the first attempt and retries by schedule until the host accepts,
 *  so an eviction between recording and delivering loses nothing. */
export function incidentRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 300_000);
}


