/** Pure decisions: nothing here touches a container, a bucket or a clock. */

import * as v from 'valibot';

import {
  DEVBOX_WORKDIR, type CheckpointKind, type CheckpointOutcome, type StoredValue,
} from './storage';

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
  /** Minimum checkpoint gap and the sync's tick period are one number, so an early tick (a
   *  container restart re-arms it) cannot double-commit. It bounds the loss window (D30). */
  readonly checkpointIntervalMs: number;
  /** Whole onStart restore budget: identity, attachment, workload resumption, durable settlement.
   *  A raced timer bounds each step; control-listener proof precedes the SDK opening the block. */
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

/** A distinct type because abandoned `exec` work keeps mounting paths no DO token can reach;
 *  recovery replaces the container identity instead of retrying, and must not parse messages. */
export class ContainerStartOverrun extends Error {
  constructor(label: string, budgetMs: number) {
    super(
      `${label} exceeded its ${budgetMs}ms budget and was abandoned; the work it left `
      + 'running inside the container cannot be fenced from here.',
    );
    this.name = 'ContainerStartOverrun';
  }
}

export class ContainerStartInterrupted extends Error {
  constructor() {
    super('the previous restoration was interrupted before settlement; its container work may still be running');
    this.name = 'ContainerStartInterrupted';
  }
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

/** One clock for a start budget and its timers, handed in so tests advance time (D19).
 *  Production uses {@link REAL_START_CLOCK}. */
export interface StartClock {
  now(): number;
  after(ms: number, fire: () => void): () => void;
}

export const REAL_START_CLOCK: StartClock = {
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

  if (raced.kind === 'late') throw new ContainerStartOverrun(label, budgetMs);

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

/** Only SDK codes whose class is certain: a wrong `permanent` refuses a fixable box, a wrong
 *  `transient` retries doomed work. Absent codes are `unclassified` (retry once, escalate). */
const RECOVERY_BY_SDK_CODE: ReadonlyMap<string, RecoveryClass> = new Map([
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

/** The SDK's error classes are not exported and `code` is a getter on them, so match the
 *  shape, not the class (same boundary as `ProcessAbsentSchema` in devbox.ts). */
const CodedFailureSchema = v.object({ code: v.string() });

/** Walks the whole cause chain: the snapshot chain wraps SDK failures as `cause`.
 *  The outermost classified answer wins; an unclassified wrapper is transparent. */
export function classifyRecovery(thrown: { readonly cause: unknown }): RecoveryClass {
  for (let value = thrown.cause; ;) {
    if (value instanceof ContainerStartOverrun || value instanceof ContainerStartInterrupted) return 'abandoned';
    const coded = v.safeParse(CodedFailureSchema, value);

    if (coded.success) {
      const held = RECOVERY_BY_SDK_CODE.get(coded.output.code);

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

/** A stale owner retries without advancing: a failure on a gone identity says nothing of its successor.
 *  Abandoned work enters at `replace`, since its only cancellation is the container's death. */
export function recoveryStep(input: RecoveryInput): RecoveryDecision {
  if (!input.owned) return { action: 'inert', stage: input.stage };
  const { stage } = input;

  if (input.failure === 'exhausted' || input.failure === 'permanent') {
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

interface MountLine {
  readonly source: string;
  readonly fstype: string;
  readonly options: string;
}

/** Fields follow fstab order; mountpoints octal-escape spaces (`\040`), so decode first. */
export function findMount(procMounts: string, dir: string): MountLine | undefined {
  for (const line of procMounts.split('\n')) {
    const [source, mountpoint, fstype, options] = line.trim().split(/\s+/);

    if (source === undefined || mountpoint === undefined || fstype === undefined) continue;

    if (mountpoint.replace(/\\040/g, ' ') !== dir) continue;

    return { source, fstype, options: options ?? '' };
  }

  return undefined;
}

/** Bounded because a waiting caller's stop runs this; an unbounded wait makes one process
 *  that ignores SIGTERM unstoppable. Long enough to flush, short enough to stop within ceilings. */
const HOLDER_TERM_WAIT_MS = 5_000;

/** Frees the work directory for unmount: TERMs then KILLs fd holders; names cwd holders,
 *  pid 1 and this shell's ancestors unsignalled. One line, no `exit`: shares the SDK session. */
export function releaseWorkdirHoldersCommand(workdir: string): string {
  const quoted = `'${workdir.replaceAll("'", `'\\''`)}'`;
  const termWait = String(Math.ceil(HOLDER_TERM_WAIT_MS / 1_000));

  // This shell's parent chain. `comm` can hold spaces and parentheses, so ppid is read after
  // the last `)` of `pid (comm) state ppid …`, never by column.
  const ancestorPids = 'mine=" $$ "; a=$$; '
    + 'while [ -n "$a" ] && [ "$a" != 0 ] && [ "$a" != 1 ]; do '
    + `a=$(sed 's/.*) //' /proc/$a/stat 2>/dev/null | cut -d' ' -f2); `
    + 'if [ -n "$a" ]; then mine="$mine$a "; fi; done; ';

  // One scan function, run before signalling and after it; both runs must classify identically.
  // The odd name keeps it from colliding with anything else in the shared session shell.
  const scan = '__devbox_hold() { fdh=""; cwdh=""; kin=""; '
    + `for pid in $(ls /proc | grep -E '^[0-9]+$' | grep -v '^1$'); do `
    + 'h=""; '
    + `if ls -l /proc/$pid/fd 2>/dev/null | grep -q -F ${quoted}; then h=fd; `
    + `else case "$(readlink /proc/$pid/cwd 2>/dev/null)" in `
    + `${quoted}|${quoted}/*) h=cwd;; esac; fi; `
    + 'if [ -n "$h" ]; then '
    + 'entry="$pid:$(cat /proc/$pid/comm 2>/dev/null)"; '
    + 'case "$mine" in *" $pid "*) kin="$kin $entry"; h=kin;; esac; '
    + 'if [ "$h" = fd ]; then fdh="$fdh $entry"; elif [ "$h" = cwd ]; then '
    + 'cwdh="$cwdh $entry"; fi; fi; '
    + 'done; }; ';

  return `${ancestorPids}${scan}__devbox_hold; `
    + 'if [ -n "$kin" ]; then echo "not signalled, this session\'s own:$kin" >&2; fi; '
    + 'if [ -n "$cwdh" ]; then echo "not signalled, cwd-only holders:$cwdh" >&2; fi; '
    + 'if [ -n "$fdh" ]; then echo "signalling:$fdh" >&2; '
    + 'for name in $fdh; do kill -TERM "${name%%:*}" 2>/dev/null || true; done; '
    + `sleep ${termWait}; `
    + 'for name in $fdh; do p="${name%%:*}"; '
    + 'if [ -d "/proc/$p" ]; then kill -KILL "$p" 2>/dev/null || true; fi; done; fi; '
    // The final stdout line comes from a fresh `__devbox_hold` scan after signalling, not from
    // the pre-signal lists; it is the only output a caller acts on.
    + '__devbox_hold; still="$fdh$cwdh$kin"; '
    + 'if [ -z "$still" ]; then echo none; else echo "$still"; fi';
}

/** Holders still present after one {@link releaseWorkdirHoldersCommand} run; `none` means a
 *  clear scan and parses to an empty list, not a failure. */
export function parseWorkdirHolders(
  stdout: string,
): readonly { readonly pid: string; readonly comm: string }[] {
  const trimmed = stdout.trim();

  if (trimmed.length === 0 || trimmed === 'none') return [];
  const holders: { readonly pid: string; readonly comm: string }[] = [];

  for (const token of trimmed.split(/\s+/)) {
    const [pid, comm] = token.split(':');

    if (pid === undefined || pid.length === 0) continue;
    holders.push({ pid, comm: comm ?? 'unknown' });
  }

  return holders;
}

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
export const PORT_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

/** The SDK deletes a fired row only after its callback returns, so a dispatching callback
 *  counts only future rows; other callers count every row, since re-arming a due one is D14. */
export function needsArming(
  rows: readonly { readonly time: number }[],
  nowSeconds: number,
  dispatching: boolean,
): boolean {
  if (dispatching) return !rows.some(row => row.time > nowSeconds);

  return rows.length === 0;
}


/** `path` leads with its namespace (`file:/workspace/src`, `port:3000`, `proc:sup-1`) so one
 *  lane orders all kinds; `subtree` claims everything beneath, as recursive list/remove need. */
export interface ResourceScope {
  readonly path: string;
  readonly subtree: boolean;
}

function atOrUnder(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** A `subtree` scope conflicts with every path at or beneath it, whichever side holds it:
 *  a recursive delete of `/a` and a write to `/a/b/c` are the same resource. */
function scopesTouch(left: ResourceScope, right: ResourceScope): boolean {
  if (left.subtree) return atOrUnder(left.path, right.path);

  if (right.subtree) return atOrUnder(right.path, left.path);

  return left.path === right.path;
}

export function scopesOverlap(
  left: readonly ResourceScope[],
  right: readonly ResourceScope[],
): boolean {
  return left.some(a => right.some(b => scopesTouch(a, b)));
}

interface ResourceLane {
  /** A streamed read keeps the lane busy until its body drains or is cancelled. */
  busy(): boolean;
  /** Strict FIFO per resource, no shared reads; the whole scope set is claimed in one step,
   *  so a multi-resource operation cannot hold one resource while waiting for another. */
  run<T>(scopes: readonly ResourceScope[], op: () => Promise<T>): Promise<T>;
  /** Claim `scopes`, then hand back the release. The caller MUST call it on
   *  every path out, including cancellation. */
  hold(scopes: readonly ResourceScope[]): Promise<() => void>;
}

/** Lives in the container's owner object: facets are separate isolates, so a per-client queue
 *  orders only that client's calls. In-flight only, so nothing persists across eviction. */
export function createResourceLane(): ResourceLane {
  const inFlight = new Set<{ scopes: readonly ResourceScope[]; settled: Promise<void> }>();

  const hold = async (scopes: readonly ResourceScope[]): Promise<() => void> => {
    // Loop, not one pass: while waiting, a third operation can claim an overlapping resource,
    // and admitting this one anyway is the interleaving the lane exists to stop.
    for (;;) {
      const blocking = [...inFlight].filter(entry => scopesOverlap(entry.scopes, scopes));

      if (blocking.length === 0) break;
      await Promise.all(blocking.map(entry => entry.settled));
    }

    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const entry = { scopes, settled };
    inFlight.add(entry);

    return () => {
      inFlight.delete(entry);
      resolve();
    };
  };

  return {
    busy: () => inFlight.size !== 0,
    hold,
    async run(scopes, op) {
      const release = await hold(scopes);

      try {
        return await op();
      } finally {
        release();
      }
    },
  };
}

/** Ports have no subtree: `port:3000` and `port:30001` share no segment boundary, so never overlap. */
export function portScope(port: number): readonly ResourceScope[] {
  return [{ path: `port:${port}`, subtree: false }];
}

export function processScope(processId: string): readonly ResourceScope[] {
  return [{ path: `proc:${processId}`, subtree: false }];
}

/** A returned `ReadableStream` is unconsumed, so releasing on return lets a sibling write race
 *  the reader; release once on last chunk, error, or cancel so a half-read body frees it. */
export function heldUntilDrained<Chunk>(
  stream: ReadableStream<Chunk>,
  release: () => void,
): ReadableStream<Chunk> {
  let released = false;

  const done = (): void => {
    if (released) return;
    released = true;
    release();
  };

  return stream.pipeThrough(new TransformStream<Chunk, Chunk>({
    flush: done,
    cancel: done,
  }));
}

/** A membership-changing operation also claims its directory, so same-directory creates order;
 *  an overwrite claims it too, since it cannot be told from a create without the container. */
export function pathScopes(input: {
  readonly path: string;
  readonly membership?: boolean;
  readonly ancestors?: boolean;
  readonly recursive?: boolean;
}): readonly ResourceScope[] {
  const path = canonicalPath(input.path);
  const scopes: ResourceScope[] = [{ path: `file:${path}`, subtree: input.recursive === true }];
  const above = ancestors(path);
  // Claim only the immediate parent unless the operation creates the whole chain: every
  // ancestor would be a global lock, since unrelated creates all name `/workspace`.
  const claimed = input.ancestors === true ? above : above.slice(0, 1);

  if (input.membership === true || input.ancestors === true) {
    for (const directory of claimed) scopes.push({ path: `file:${directory}`, subtree: false });
  }

  return scopes;
}

/** Every directory above `path`, NEAREST FIRST — the order the caller slices,
 *  so taking one takes the immediate parent. */
function ancestors(path: string): readonly string[] {
  const out: string[] = [];

  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    out.push(path.slice(0, cut));
  }

  return out;
}

/** One spelling per file, so two names for one path are one resource. A spelling, not an inode:
 *  a symlink or bind mount can still name one file under two paths. */
export function canonicalPath(path: string): string {
  const absolute = path.startsWith('/') ? path : `${DEVBOX_WORKDIR}/${path}`;
  const out: string[] = [];

  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue;

    if (segment === '..') {
      out.pop();
      continue;
    }

    out.push(segment);
  }

  return `/${out.join('/')}`;
}

interface CheckpointLane {
  busy(): boolean;
  /** Same kind in flight joins it; a different kind queues, so a quiesce never inherits a tick's
   *  `skipped` and stops over just-landed work. */
  run(kind: CheckpointKind, op: () => Promise<CheckpointOutcome>): Promise<CheckpointOutcome>;
}

export function createCheckpointLane(): CheckpointLane {
  const inFlight: Partial<Record<CheckpointKind, Promise<CheckpointOutcome>>> = {};
  let tail: Promise<unknown> = Promise.resolve();

  return {
    busy: () => Object.values(inFlight).some(run => run !== undefined),
    run(kind, op) {
      const pending = inFlight[kind];

      if (pending !== undefined) return pending;
      const run = tail.then(() => op());
      inFlight[kind] = run;

      const cleaned = (async () => {
        try {
          await run;
        } catch (cause) {
          console.error(`[devbox] ${kind} checkpoint rejected: ${describeThrown({ cause })}`);
        }

        if (inFlight[kind] === run) inFlight[kind] = undefined;
      })();

      // The next lane entry observes cleanup too; no detached promise remains.
      tail = cleaned;

      return run;
    },
  };
}


/** A runtime list, not a bare type union: the receiving host validates stages against it,
 *  so producer and consumer share this one list or incidents get rejected unseen. */
export const INCIDENT_STAGES = ['attach', 'checkpoint', 'process', 'port'] as const;

export type IncidentStage = (typeof INCIDENT_STAGES)[number];

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


