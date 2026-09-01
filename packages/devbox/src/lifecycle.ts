/**
 * Every decision a devbox makes, as a pure function.
 *
 * The class in devbox.ts holds the platform: schedules, storage, container
 * RPC. This file holds the reasoning. The split is not tidiness — a container
 * lifecycle is nearly impossible to test through the platform, and every rule
 * here has a boundary that has to be pinned by a table rather than by reading
 * it twice. Nothing in this file touches a container, a bucket or a clock.
 */

import * as v from 'valibot';

import {
  DEVBOX_WORKDIR, type CheckpointKind, type CheckpointOutcome, type StoredValue,
} from './storage';

// ── policy ──────────────────────────────────────────────────────────────────

/**
 * The timings a devbox runs on. One override point for all of them.
 *
 * A subclass returns a whole policy, so a deployment that changes one number
 * still states the other three, and there is one place to read to know how a
 * box behaves.
 */
export interface DevboxPolicy {
  /** How often the heartbeat runs, in seconds. Well under every platform idle
   *  window, and cheap enough to leave armed for the container's whole life. */
  readonly heartbeatSeconds: number;
  /** The last interaction must be at least this old before quiescing starts. */
  readonly idleMs: number;
  /** Quiescing also requires this much OBSERVED quiet — consecutive
   *  heartbeats that agreed — so one unlucky sample cannot stop a box. */
  readonly quietConfirmMs: number;
  /** Minimum gap between two checkpoints, and the period the checkpoint
   *  schedule ticks at. Both are this one number: a tick that fires early
   *  (a container restart re-arms the schedule) must not double-commit. */
  readonly checkpointIntervalMs: number;
  /**
   * Budget for the WHOLE restoration: attach, workload restart, listener proof,
   * port exposure and boot stamping.
   *
   * Entirely this package's own bound, and one that can actually fire. The
   * restoration runs in a scheduled callback, outside `blockConcurrencyWhile`,
   * so a timer is delivered normally. It used to run inside that block, where
   * the platform cancels (`do.block_concurrency.cancel_ms`) by RESETTING the
   * object and where a timer set inside the block is not delivered until the
   * block releases — so the bound was unreachable and the reset happened
   * instead.
   *
   * IT COVERS EVERY PHASE, not just the attach. Only `attach()` used to be
   * wrapped, so the phases after it ran unbounded while every caller waited in
   * the readiness gate. Overrunning now abandons the restoration, and because
   * abandoned work keeps running inside the container the recovery is to replace
   * that container identity — see {@link ContainerStartOverrun}.
   */
  readonly attachBudgetMs: number;
  /**
   * The CAP on how long one restart keeps asking whether a restored server is
   * listening, clamped by whatever is left of {@link attachBudgetMs}.
   *
   * A supervised process is reported STARTED the moment the container forked
   * it, which is long before `npm run dev` or a Python app has bound its port.
   * One instant probe therefore declares a healthy server silent, and the
   * incident that follows reaches the agent as a blocker telling it not to hand
   * out a URL that is about to work. This is the window silence has to last
   * before it is a fact.
   *
   * A CAP AND NOT A TIMER OF ITS OWN. Each port used to get this whole window
   * to itself, so silence cost it once per port and nothing bounded the sum.
   * Whichever is smaller — this cap or the restoration's remaining budget — is
   * what a port actually gets, so a box with many silent ports settles inside
   * one budget instead of many windows.
   */
  readonly portWaitMs: number;
  /** Gap between two listener probes inside that window. */
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

// ── the container-start budget ──────────────────────────────────────────────

/** What abandoned container-start work rejected with, if it ever settled.
 *
 *  JavaScript lets any value be thrown, so the field is `cause` and its type is
 *  `unknown`: that pairing is the one place a value with no contract is allowed
 *  to travel, and every reader narrows it before touching anything. */
export interface LateStartFailure {
  readonly cause: unknown;
}

/**
 * An attempt that ran past its budget and abandoned work inside the container.
 *
 * A TYPE, NOT A SENTENCE, because the recovery decision turns on it. Abandoned
 * work keeps running where no token in the Durable Object can reach it — it is
 * `exec` calls mounting and unmounting the same paths — so the recovery for
 * this one class is not a retry but the replacement of the container identity.
 * Reading that back out of a message would put a second authority beside the
 * throw that raised it.
 */
export class ContainerStartOverrun extends Error {
  constructor(label: string, budgetMs: number) {
    super(
      `${label} exceeded its ${budgetMs}ms budget and was abandoned; the work it left `
      + 'running inside the container cannot be fenced from here.',
    );
    this.name = 'ContainerStartOverrun';
  }
}

/**
 * The restoration's one clock, and the allowance it hands each step.
 *
 * ONE OWNER FOR THE WHOLE RESTORATION. Every phase after the attach —
 * restarting processes, proving a listener, exposing a port, stamping the boot
 * id — used to run outside any budget, and the listener proof carried its OWN
 * window per port. Three silent ports therefore added three full windows, about
 * ninety seconds, while every caller sat in the readiness gate; nothing bounded
 * the total, and adding a fourth port made it worse.
 *
 * The allowance is what remains divided by the work still DECLARED, so every
 * step of the restoration is counted — each probe, each exposure and the boot
 * stamp, not the ports alone. Nothing is reserved and no share is invented: the
 * last step is welcome to the whole remainder, and a step that needs none leaves
 * it to the next.
 */
export interface StartBudget {
  /** Milliseconds left before the deadline, never negative. */
  remainingMs(): number;
  /** Add to the work this budget must still cover. */
  declare(steps: number): void;
  /** The next step's allowance, which also counts that step as taken. */
  nextAllowanceMs(): number;
}

export function openStartBudget(budgetMs: number): StartBudget {
  const openedAt = Date.now();
  let declared = 0;
  const remainingMs = (): number => Math.max(0, budgetMs - (Date.now() - openedAt));
  return {
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

/**
 * Race one piece of work against a time allowance, and REPORT rather than throw.
 *
 * {@link withContainerStartDeadline} is the throwing policy, for work whose
 * abandonment leaves the container unfenceable. This is the reporting policy,
 * for the post-attach steps: a process that will not start, a listener that
 * never answers, a port that will not expose, a boot id that will not stamp.
 * Both sit on one race, `raceAllowance`, so they cannot drift apart.
 *
 * WHY THOSE REPORT INSTEAD OF THROWING. None of them mutates the mount, so an
 * abandoned one leaves nothing for a retry to collide with — where an abandoned
 * ATTACH is mid-mount and does. So a slow app costs the box its readiness and
 * nothing else: the container stays, its specs stay, `unready` says which
 * service did not come back, and an agent or an explicit readiness call can try
 * again. Replacing a healthy container because a dev server was slow to bind
 * would be the cure that destroys the patient.
 */
export async function runRestoreStep<T>(
  allowanceMs: number,
  work: () => Promise<T>,
  onLate: (failure: LateStartFailure) => void,
): Promise<StepOutcome<T>> {
  // A THROWN step is a value here too. Every caller wants a reason to report and
  // a walk that continues, so handing the failure back is the contract rather
  // than a convenience — and a caught binding is not a parameter, so nothing
  // untyped travels through a `.catch` at each call site.
  try {
    return await raceAllowance(allowanceMs, work, onLate);
  } catch (cause) {
    return { kind: 'failed', cause };
  }
}

/**
 * The ONE race, and the only place a timer bounds container work.
 *
 * Both policies above are built on it: {@link withContainerStartDeadline} throws
 * on the late arm, {@link runRestoreStep} reports it. Two copies of this race
 * drifted within a day of the second landing, which is why there is one.
 */
async function raceAllowance<T>(
  allowanceMs: number,
  work: () => Promise<T>,
  onLate: (failure: LateStartFailure) => void,
): Promise<StepOutcome<T>> {
  let late = false;
  // Both arms ANNOTATED rather than asserted: `then`'s inference widens
  // `{ kind: 'done' }` to `{ kind: string }`, and a cast to paper over that
  // would be a caller-selected type standing where a constructed one belongs.
  const started = work().then<StepOutcome<T>, StepOutcome<T>>(
    (value) => ({ kind: 'done', value }),
    (cause: LateStartFailure['cause']) => {
      if (!late) throw cause;
      onLate({ cause });
      // The race already answered `late`, so this branch has no value to
      // produce. It exists so the late failure is reported rather than surfacing
      // as an unhandled rejection.
      return Promise.withResolvers<StepOutcome<T>>().promise;
    },
  );
  const { promise: expiry, resolve } = Promise.withResolvers<StepOutcome<T>>();
  const timer = setTimeout(() => {
    late = true;
    resolve({ kind: 'late' });
  }, allowanceMs);
  try {
    return await Promise.race([started, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run UNFENCEABLE start-path work under a hard budget: the container's own start,
 * and the filesystem attach.
 *
 * THE THROWING POLICY, and the only one that may be. Both of these are mid-mount
 * when abandoned — the attach unmounts and remounts the same paths — so work left
 * running after the deadline is work a retry would collide with, and no token in
 * the Durable Object can reach it. The recovery is therefore to replace the
 * container identity, which is what {@link ContainerStartOverrun} tells the
 * taxonomy. Every step AFTER the attach reports instead: see
 * {@link withStepAllowance}.
 *
 * ONE mechanism for both hooks (`onStart` under the concurrency gate, the
 * scheduled restoration outside it) — two copies of this race drifted within a
 * day of the second landing.
 *
 * Inside `blockConcurrencyWhile` the timer is NOT delivered until the block
 * releases (measured, not assumed), so there the platform cancel
 * (`do.block_concurrency.cancel_ms`) is the real backstop and this budget is
 * the shape the do-init gate pins. Outside the block — the scheduled attach —
 * the timer delivers normally and the budget genuinely fires.
 *
 * Detaching the work is not an alternative either: a promise left floating in a
 * Durable Object is cancelled on eviction with its rejection swallowed, so the
 * work would silently not happen.
 *
 * `onOverrun` receives the outcome of the abandoned work if it ever settles.
 * Abandoning a value is not the same as discarding an error, and that late
 * error is usually the only diagnostic there is.
 */
export async function withContainerStartDeadline<T>(
  label: string,
  budget: StartBudget,
  work: () => Promise<T>,
  onOverrun: (failure: LateStartFailure) => void,
): Promise<T> {
  const budgetMs = budget.remainingMs();
  const raced = await raceAllowance(budgetMs, work, onOverrun);
  if (raced.kind === 'late') throw new ContainerStartOverrun(label, budgetMs);
  // `raceAllowance` rethrows a real failure rather than reporting it, so the
  // attach's own error reaches the taxonomy unchanged.
  if (raced.kind === 'failed') throw raced.cause;
  return raced.value;
}

// ── the recovery taxonomy ───────────────────────────────────────────────────

/**
 * What a failed lifecycle attempt IS, in the only terms recovery can act on.
 *
 * ONE TAXONOMY, and it is read from the SDK's own error registry rather than
 * from prose. A devbox reaches its container only through
 * `@cloudflare/sandbox`, every failure that package raises carries one of its
 * `ErrorCode`s, and the code is the classification its author already made.
 * Matching on messages would be a second opinion on the same question and the
 * one that rots first.
 *
 * The point of the split is that these five need DIFFERENT things. One generic
 * retry policy spends a retry on a configuration that cannot change, repeats a
 * copy into a filesystem that is already full, and treats work abandoned inside
 * a container as if asking the same container again were safe.
 */
export type RecoveryClass =
  /** THIS attempt left work running inside the container. Nothing in the
   *  Durable Object can stop it, so the identity has to go. Evidence against
   *  the container, unlike `stale-owner`. */
  | 'abandoned'
  /** The runtime under the work changed: the attempt is void and its successor
   *  is not. Says NOTHING about the health of a container identity, so it must
   *  never advance a ladder that ends in destroying one. */
  | 'stale-owner'
  /** A resource ran out. Running the same work again spends it again. */
  | 'exhausted'
  /** Configuration the container cannot satisfy. The inputs are the same next
   *  time, so the answer is too. */
  | 'permanent'
  /** The transport dropped, or the container was not up yet. */
  | 'transient'
  /** Nothing classified it. The honest answer for an R2 rejection or a defect
   *  in this package, and it is handled as the least destructive thing that can
   *  still make progress. */
  | 'unclassified';

/**
 * The SDK codes whose class is not in doubt, and nothing else.
 *
 * NARROW ON PURPOSE, in the same way `do-rpc`'s platform table is: a code
 * guessed into `permanent` refuses a box a retry would have fixed, and a code
 * guessed into `transient` retries work that cannot succeed. A code absent from
 * here is `unclassified`, which retries once and then escalates — the safe
 * default, and the behaviour every failure has today.
 *
 * This is an adapter at the SDK boundary, which is the one place a foreign
 * vocabulary may be named. The strings are verbatim from that registry.
 */
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
  // The runtime was replaced, or the session died under the operation. The SDK
  // says so itself, which is why no generation comparison is needed here.
  ['OPERATION_INTERRUPTED', 'stale-owner'],
  ['SESSION_TERMINATED', 'stale-owner'],
  ['SESSION_DESTROYED', 'stale-owner'],
  // The socket dropped, or the container had not finished booting.
  ['RPC_TRANSPORT_ERROR', 'transient'],
  ['CONTAINER_UNAVAILABLE', 'transient'],
]);

/** A value carrying an SDK error code. The code is a GETTER on the SDK's own
 *  error classes and none of them is exported, so the shape is what can be
 *  asked — the same boundary `ProcessAbsentSchema` in devbox.ts stands on. */
const CodedFailureSchema = v.object({ code: v.string() });

/**
 * Classify a thrown value, and everything in its cause chain.
 *
 * THE WHOLE CHAIN, because this package wraps: the snapshot chain rethrows a
 * mount failure as its own sentence with the SDK's error as `cause`, so a
 * classifier that read only the outermost value would answer `unclassified` for
 * every wrapped failure — which is the single generic policy this taxonomy
 * exists to end. The outermost classified answer wins; an unclassified wrapper
 * is transparent rather than an answer.
 */
export function classifyRecovery(thrown: { readonly cause: unknown }): RecoveryClass {
  for (let value = thrown.cause; ;) {
    if (value instanceof ContainerStartOverrun) return 'abandoned';
    const coded = v.safeParse(CodedFailureSchema, value);
    if (coded.success) {
      const held = RECOVERY_BY_SDK_CODE.get(coded.output.code);
      if (held !== undefined) return held;
    }
    if (!(value instanceof Error) || value.cause === undefined) return 'unclassified';
    value = value.cause;
  }
}

/**
 * How far this box has gone recovering ONE container identity.
 *
 * Two stages, and they are ACTIONS rather than counts: ask the same identity
 * again, then replace it. A third failure while `replace` is the stored stage
 * is terminal, so a box can never loop destroying containers.
 *
 * Durable, because the retry is a schedule row and the object that runs it is
 * often a fresh one: `onStart` is a CONTAINER hook, so a Durable Object woken
 * by an alarm beside a surviving container never runs it, and an in-memory
 * stage would reset before it could ever escalate.
 */
export const RECOVERY_STAGES = ['retry', 'replace'] as const;

export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

/**
 * The ladder row: WHO is attempting, and how far the ladder has gone.
 *
 * `owner` is the reason this row is the ladder's only authority. The
 * in-memory generation fences what an abandoned attempt writes to the OBJECT,
 * and it cannot fence what it writes to STORAGE: a Durable Object is evicted and
 * rebuilt with the counter back at zero, so two attempts from two isolates can
 * hold the same number. The owner is minted per attempt and claimed durably, and
 * every later write to this row is conditional on it still being there. An
 * attempt whose write races a newer attempt's success therefore changes NOTHING
 * instead of resurrecting a stage the success had cleared.
 *
 * `stage` is absent while an attempt is merely in flight; it appears when the
 * ladder advances. A successful attempt deletes the whole row.
 */
const RecoveryRowSchema = v.strictObject({
  owner: v.string(),
  stage: v.optional(v.picklist(RECOVERY_STAGES)),
});

export type RecoveryRow = v.InferOutput<typeof RecoveryRowSchema>;

/** The stored ladder row. `malformed` is NOT `absent`: absent means no attempt
 *  has failed and leads to a retry, so reading an unreadable row as absent would
 *  restart the ladder every time and could destroy an identity repeatedly. */
export type StoredRecovery =
  | { readonly kind: 'absent' }
  | { readonly kind: 'row'; readonly row: RecoveryRow }
  | { readonly kind: 'malformed' };

/** Parse the ladder row STRICTLY, unknown keys included. There is no earlier
 *  shape to accept: this row is written by one code path, and a successful
 *  attempt deletes it.
 *
 *  The parameter is `StoredValue` — what durable storage can actually hand back
 *  — rather than a bare `unknown`: it is the same boundary `normalizeChainState`
 *  and `readCandidateControl` already stand on. */
export function parseRecoveryRow(stored: StoredValue): StoredRecovery {
  if (stored === undefined) return { kind: 'absent' };
  const parsed = v.safeParse(RecoveryRowSchema, stored);
  return parsed.success ? { kind: 'row', row: parsed.output } : { kind: 'malformed' };
}

/** What an attempt may do before it has attached anything. */
export interface RecoveryAdmission {
  /** May this attempt attach at all? */
  readonly admit: boolean;
  /** The stage the claim must carry: preserved for an admitted attempt, and the
   *  most conservative readable value for a refused one. */
  readonly stage: RecoveryStage | undefined;
}

/**
 * Admit one attempt, or refuse it on evidence it cannot read.
 *
 * A ROW THAT DOES NOT PARSE IS NOT A ROW TO ACT ON, and it is not an absent one
 * either. Refusing is the only safe answer: absent would restart the ladder and
 * could destroy an identity again. The refusal also NORMALISES the row to
 * `replace`, which is the terminal stage — so the box is left with a readable,
 * conservative ladder rather than an unreadable one that would refuse forever.
 * The next successful attach deletes it; `attachNow()` is the explicit
 * re-attempt, and it destroys nothing.
 */
export function admissionStep(stored: StoredRecovery): RecoveryAdmission {
  if (stored.kind === 'malformed') return { admit: false, stage: 'replace' };
  return { admit: true, stage: stored.kind === 'row' ? stored.row.stage : undefined };
}

/** What the box does about one failed attempt. */
export type RecoveryAction =
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

export interface RecoveryInput {
  /** Does the failed attempt still own the current lifecycle generation? */
  readonly owned: boolean;
  readonly failure: RecoveryClass;
  /** The stage this attempt's own claim carries. Read once, at admission: the
   *  claim is what proves the attempt owns the row, so re-reading it here would
   *  be reading a value another attempt may have moved. */
  readonly stage: RecoveryStage | undefined;
}

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  /** The stage the row must carry after this failure. Equal to the incoming one
   *  means the ladder did not move. NOTHING here deletes the row: only an
   *  attempt that succeeded may do that, or a destructive stage would be reset
   *  by the next eviction and the box could destroy an identity again. */
  readonly stage: RecoveryStage | undefined;
}

/**
 * One failure, one decision. No count, no timing, no budget.
 *
 * Read top to bottom, the rules are: a superseded attempt does nothing;
 * exhaustion and permanent configuration refuse without repeating the work,
 * destroying anything, or moving the ladder; a stale owner retries WITHOUT
 * advancing it, because the identity it failed on is already gone; a failure at
 * `replace` is terminal and STAYS at `replace`; and everything else walks the
 * ladder — retry the identity, then replace the identity. Abandoned work enters
 * at `replace`, since the only cancellation for it is the container's death.
 *
 * An unreadable row never reaches here: {@link admissionStep} refuses the
 * attempt before it attaches anything.
 */
export function recoveryStep(input: RecoveryInput): RecoveryDecision {
  if (!input.owned) return { action: 'inert', stage: input.stage };
  const { stage } = input;
  if (input.failure === 'exhausted' || input.failure === 'permanent') {
    return { action: 'refuse', stage };
  }
  if (input.failure === 'stale-owner') return { action: 'retry', stage };
  if (stage === 'replace') return { action: 'refuse', stage };
  if (input.failure === 'abandoned' || stage === 'retry') {
    return { action: 'replace', stage: 'replace' };
  }
  return { action: 'retry', stage: 'retry' };
}

// ── the activity lease ──────────────────────────────────────────────────────
//
// While a devbox serves a caller it must not sleep: the disk is ephemeral, so
// every idle expiry costs an attach. The lease is one durable timestamp plus
// one scheduled heartbeat. The SDK calls `renewActivityTimeout()` on every RPC
// interaction and every preview fetch; the class turns those calls into the
// durable stamp, and the heartbeat reads it.

export interface QuiesceInput {
  readonly now: number;
  readonly containerRunning: boolean;
  readonly lastInteractionAt: number;
  /** When quiet was first observed on this stretch, or undefined. Carried
   *  between ticks by the caller: the clock lives in durable state, not here. */
  readonly quietSince: number | undefined;
  /** Does the host still hold work bound to this container? */
  readonly backgroundWork: boolean;
  readonly idleMs: number;
  readonly quietConfirmMs: number;
}

export type QuiesceAction = 'hold' | 'quiesce';

export interface QuiesceDecision {
  readonly action: QuiesceAction;
  /** What the caller must persist for the next tick. `undefined` means the
   *  quiet stretch ended and the stored value must be deleted. */
  readonly quietSince: number | undefined;
}

/**
 * One heartbeat's decision.
 *
 * Three gates must all hold — the container is up, the last interaction is old
 * enough, the host reports no background work — and then the quiet has to be
 * observed for the confirmation window before the answer flips to `quiesce`.
 * A single busy sample resets the stretch, which is why `quietSince` travels
 * out as well as in.
 */
export function quiesceStep(input: QuiesceInput): QuiesceDecision {
  if (!input.containerRunning) return { action: 'hold', quietSince: undefined };
  const idleEnough = input.now - input.lastInteractionAt >= input.idleMs
    && !input.backgroundWork;
  if (!idleEnough) return { action: 'hold', quietSince: undefined };
  const quietSince = input.quietSince ?? input.now;
  const confirmed = input.now - quietSince >= input.quietConfirmMs;
  return { action: confirmed ? 'quiesce' : 'hold', quietSince };
}

// ── mount facts ─────────────────────────────────────────────────────────────

/** One `/proc/mounts` entry. */
export interface MountLine {
  readonly source: string;
  readonly fstype: string;
  readonly options: string;
}

/**
 * The `/proc/mounts` entry for `dir`, or undefined when nothing is mounted
 * there.
 *
 * Both strategies ask the kernel whether their work directory is really
 * attached, and they ask different follow-up questions of the answer — one
 * wants the overlay's upper directory, the other only the filesystem type — so
 * the parse is shared and the predicates are not.
 *
 * Field order is fstab's: source, mountpoint, fstype, options. fstab
 * octal-escapes spaces, so a path with a space has to survive the parse.
 */
export function findMount(procMounts: string, dir: string): MountLine | undefined {
  for (const line of procMounts.split('\n')) {
    const [source, mountpoint, fstype, options] = line.trim().split(/\s+/);
    if (source === undefined || mountpoint === undefined || fstype === undefined) continue;
    if (mountpoint.replace(/\\040/g, ' ') !== dir) continue;
    return { source, fstype, options: options ?? '' };
  }
  return undefined;
}

// ── work-directory holders, before a mount is released ──────────────────────

/**
 * How long a holder gets to notice SIGTERM before SIGKILL answers for it.
 *
 * Bounded, because this runs inside a stop that a caller is waiting on: an
 * unbounded wait would make one rude process unstoppable, which is the exact
 * defect the signal order exists to repair. Five seconds is enough for a
 * process to flush on SIGTERM, and short enough that a box still stops inside
 * its own ceilings.
 */
const HOLDER_TERM_WAIT_MS = 5_000;

/**
 * ONE bounded container command that releases every process holding the work
 * directory, so a mount can be unmounted underneath it.
 *
 * MEASURED DEFECT THIS REPAIRS. `quiesce` detached the mount before it
 * signalled anything, and s3fs refuses an unmount with an open fd — EBUSY —
 * so a box whose caller left one writer alive could neither stop nor be torn
 * down: the refusal landed before `stop()` was ever reached. The order has to
 * be: signal the holders, wait, kill the survivors, THEN detach.
 *
 * PROCFS, NOT `fuser`/`lsof`. `/proc` is guaranteed present in the container
 * image (both already read `/proc/mounts` through it), reports pid + comm in
 * the same read as the holding fd, and needs no tool the image may not carry.
 * Both `/proc/<pid>/fd/*` and `/proc/<pid>/cwd` are scanned, but ONLY fd
 * holders are signalled: the deployed control proves a session shell holding
 * its cwd under the work directory does not block an s3fs unmount, and TERMing
 * it would kill the one shared session every later command needs.
 *
 * PID 1 IS EXCLUDED, for the same reason from the other end: it is the
 * container's init, holds the root of everything, and signalling it is a
 * container stop — this command's job is to release a mount, not to race the
 * platform's own shutdown. In the sandbox image pid 1 is the container server
 * itself (`ENTRYPOINT ["/container-server/sandbox"]`), which is the process
 * serving this very exec.
 *
 * AND SO IS EVERY ANCESTOR OF THIS COMMAND'S OWN SHELL, which pid 1 alone does
 * not cover. The scan runs INSIDE the session the SDK keeps for the box, so its
 * parent chain is the exec channel the stop is speaking through: signalling any
 * link of it kills the answer to the command doing the signalling, and every
 * command after it. An ancestor that really is holding the work directory is
 * still NAMED — it travels in the output, so the detach refusal can report it —
 * it is simply not signalled, because a refusal that names a holder is
 * recoverable and a dead session is not.
 *
 * TERMINATE, THEN KILL, inside the one command so the wait needs no second
 * round trip: a process that catches TERM and flushes is given the chance, and
 * one that does not is removed anyway. `comm` is read BEFORE the signal so the
 * names a later refusal reports are the ones that were holding, not
 * post-mortem.
 *
 * The output is one line per holder, `pid comm`, or the word `none` — a
 * distinct token so an empty answer reads as "nothing was holding" rather
 * than "the command said nothing".
 *
 * IT IS ONE LINE, AND EVERY SEPARATOR IS WRITTEN HERE, which is the defect
 * this shape repairs. The command was composed as an array joined with a
 * SPACE, so the container received `… fi done if [ -z "$holders" ] …` — no
 * separator before `done`, no separator before `if`. `sh` answered `Syntax
 * error: "do" unexpected` and exited 2, and because every command runs inside
 * the SDK's ONE persistent session shell that exit ENDED THE SESSION: run
 * `e2e20260901140445` lost `stop-small` on snapshot-chain and r2fs to
 * `SessionTerminatedError: Session 'sandbox-default' shell exited (exit code:
 * 2)`, 2,362 ms and 785 ms into a stop that had already committed its
 * checkpoint. A separator that lives in the data is a separator somebody can
 * forget; the fakes now parse every composed command with `sh -n`, so this
 * class cannot pass a test again.
 *
 * AND IT MUST NOT SAY `exit`. The empty scan used to answer `echo none; exit
 * 0`, which ends the session shell exactly as the syntax error did — the same
 * defect the chain's visibility probe was repaired for. `if`/`else` answers
 * both cases and leaves the shell alive.
 *
 * `${name%%:*}` RATHER THAN `echo | cut`: POSIX parameter expansion, and two
 * fewer processes per holder inside a stop a caller is waiting on.
 */
export function releaseWorkdirHoldersCommand(workdir: string): string {
  const quoted = `'${workdir.replaceAll("'", `'\\''`)}'`;
  const termWait = String(Math.ceil(HOLDER_TERM_WAIT_MS / 1_000));
  // The parent chain of this shell, walked once through /proc. The comm field
  // can hold spaces and parentheses, so ppid is read AFTER the last `)` rather
  // than by column number — `pid (comm) state ppid …`.
  const ancestors = 'mine=" $$ "; a=$$; '
    + 'while [ -n "$a" ] && [ "$a" != 0 ] && [ "$a" != 1 ]; do '
    + `a=$(sed 's/.*) //' /proc/$a/stat 2>/dev/null | cut -d' ' -f2); `
    + 'if [ -n "$a" ]; then mine="$mine$a "; fi; done; ';
  return `${ancestors}holders=""; kin=""; `
    + `for pid in $(ls /proc | grep -E '^[0-9]+$' | grep -v '^1$'); do `
    + `if ls -l /proc/$pid/fd 2>/dev/null | grep -q -F ${quoted}; then `
    + 'entry="$pid:$(cat /proc/$pid/comm 2>/dev/null)"; '
    + 'case "$mine" in *" $pid "*) kin="$kin $entry";; *) holders="$holders $entry";; esac; '
    + 'fi; '
    + 'done; '
    // EVERY holder is reported, signalled or not: the names are what a refused
    // detach reports, and one this command declined to signal is the most
    // important name in that sentence.
    + 'all="$holders$kin"; '
    + 'if [ -n "$kin" ]; then echo "not signalled, this session\'s own:$kin" >&2; fi; '
    + 'if [ -z "$all" ]; then echo none; else '
    // Report first, signal second: the comm of a killed process cannot be
    // read again, so the names travel on stderr before any signal lands.
    + 'echo "$all" >&2; '
    + 'for name in $holders; do kill -TERM "${name%%:*}" 2>/dev/null || true; done; '
    + `sleep ${termWait}; `
    + 'for name in $holders; do p="${name%%:*}"; '
    + 'if [ -d "/proc/$p" ]; then kill -KILL "$p" 2>/dev/null || true; fi; done; '
    + 'echo "$all"; fi';
}

/**
 * The pids and names one {@link releaseWorkdirHoldersCommand} run signalled,
 * parsed from its stdout. `none` — the command's own word for an empty scan —
 * is an empty answer rather than a parse failure, because the caller's
 * question ("did anything need signalling?") is answered either way.
 */
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

/** Render a thrown value and its cause chain.
 *
 *  A rejection reason is whatever the thrower threw, so a value that is not an
 *  `Error` is stringified rather than assumed to carry a message. Shared,
 *  because every failure path in this package needs the same answer and a
 *  second version of it would eventually disagree. */
export function describeThrown(thrown: { readonly cause: unknown }): string {
  const { cause } = thrown;
  if (cause instanceof Error) {
    return cause.cause === undefined
      ? cause.message
      : `${cause.message}: ${describeThrown({ cause: cause.cause })}`;
  }
  return String(cause);
}

// ── supervised processes and ports ──────────────────────────────────────────

/** A durably-recorded background process a devbox restarts after attach.
 *
 *  An arbitrary `nohup … &` child is NOT restorable: nothing captured its
 *  identity, so after the container is replaced there is no way to know it
 *  should exist. A spec is the only thing that survives, which is why starting
 *  a long-lived process goes through the supervised call. */
export interface SupervisedProcessSpec {
  readonly processId: string;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly createdAt: number;
}

/** A durably-recorded port exposure. The token is generated once and reused,
 *  so a box's preview URLs survive restarts verbatim: forwarding is
 *  re-activated after attach by exposing the port with the same token. */
export interface PortExposureSpec {
  readonly port: number;
  readonly name: string | undefined;
  readonly token: string;
  readonly createdAt: number;
}

/** The token alphabet the SDK accepts for preview URLs, which is 1 to 16
 *  characters of `[a-z0-9_]`. Sixteen gives the URL the same shape an
 *  auto-generated one has. */
export const PORT_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generatePortToken(random: (n: number) => Uint8Array): string {
  const bytes = random(16);
  let token = '';
  for (const byte of bytes) token += PORT_TOKEN_ALPHABET[byte % PORT_TOKEN_ALPHABET.length];
  return token;
}

/** Shell probe deciding whether anything listens on a container port. Any HTTP
 *  answer counts, 4xx and 5xx included: the question is whether a listener
 *  exists, not whether it is happy. curl exit 7 is connection refused. */
export function healthProbeCommand(port: number): string {
  return `curl -sS -o /dev/null -m 3 -w '%{http_code}|%{exitcode}' --connect-timeout 2 `
    + `--head http://127.0.0.1:${port}/ 2>&1 || true`;
}

/** True when the probe says NOTHING is listening, or says nothing at all. An
 *  unparsable answer is not evidence of a listener, and exposing a port on that
 *  guess hands back a URL that answers 502. */
export function healthProbeSilent(output: string): boolean {
  const [codeStr, exitStr] = output.trim().split('|');
  if (exitStr !== undefined && Number.parseInt(exitStr, 10) === 7) return true;
  const code = codeStr === undefined ? Number.NaN : Number.parseInt(codeStr, 10);
  return !Number.isFinite(code) || code === 0;
}

/**
 * The work that turns a bare attached filesystem back into the box the caller
 * left behind, in TWO PHASES.
 *
 * The phases are the correctness. Processes serve the ports, so no port is
 * exposed until every process is back; and a port is exposed only after its own
 * listener answers, or the box publishes a preview URL for a server that is not
 * there. This used to be one flat list of three op kinds — start a process,
 * probe a port, expose a port — and the executor walked it recording each
 * failure and continuing, straight past a silent probe into the exposure of that
 * very port, then reported the box ready. A shape that cannot express "expose
 * without a listener" is a better guard than an executor that remembers not to.
 */
export interface RestartPlan {
  /** Every durably-recorded process, in the order the specs came back. */
  readonly start: readonly SupervisedProcessSpec[];
  /** Each exposed port once, ascending, so a restart is the same restart every
   *  time — which is what makes it reproducible when it goes wrong. A second
   *  spec for one port is the storage's own last write. */
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

/**
 * Does a self-re-arming callback still need a successor armed?
 *
 * THE ROW BEING DISPATCHED IS STILL IN THE TABLE. `@cloudflare/containers`
 * deletes a fired row AFTER the callback returns, not before: in its `alarm()`
 * loop the callback is awaited and only then is the row deleted
 * (`await callback.call(...)` precedes `DELETE FROM container_schedules WHERE
 * id = ...` in the same iteration). So a callback that asks "is a row already
 * pending for me" sees ITSELF, decides it has nothing to do, and returns. The
 * SDK then deletes that row and the chain is dead with no error anywhere.
 *
 * Measured across two deployed probe runs: one died on the first idle tick, the
 * other had already died during an earlier phase, so the next phase found zero
 * rows before any idle had happened.
 *
 * The fix is to count only rows scheduled STRICTLY IN THE FUTURE. The firing row
 * is due now or overdue, so it never counts, and a genuine pending successor
 * always does.
 */
export function needsArming(
  rows: readonly { readonly time: number }[],
  nowSeconds: number,
): boolean {
  return !rows.some(row => row.time > nowSeconds);
}


// ── one caller at a time, per resource ──────────────────────────────────────

/**
 * A resource an operation touches, named the way the operation already names it.
 *
 * `path` carries its own namespace as a first segment — `file:/workspace/src`,
 * `port:3000`, `proc:sup-1` — so one lane orders three kinds of resource without
 * three tables. `subtree` widens the claim to everything beneath the path, which
 * is what a recursive listing reads and a directory removal changes.
 *
 * Segments are `/`-delimited and prefix comparison respects that boundary, so
 * `port:3000` does not overlap `port:30001` and `file:/a/bc` does not overlap
 * `file:/a/b`.
 */
export interface ResourceScope {
  readonly path: string;
  readonly subtree: boolean;
}

/** True when `inner` is `outer` or lies beneath it on a segment boundary. */
function atOrUnder(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Do two operations touch a common resource?
 *
 * An exact scope conflicts only with the same path. A `subtree` scope conflicts
 * with everything at or beneath it, in either direction — a recursive delete of
 * `/a` and a write to `/a/b/c` are the same resource seen from two ends.
 */
export function scopesOverlap(
  left: readonly ResourceScope[],
  right: readonly ResourceScope[],
): boolean {
  return left.some(a => right.some(b => (
    a.subtree ? atOrUnder(a.path, b.path)
      : b.subtree ? atOrUnder(b.path, a.path)
        : a.path === b.path
  )));
}

export interface ResourceLane {
  /**
   * Run `op` once nothing overlapping is in flight, and hold `scopes` until it
   * settles.
   *
   * STRICT FIFO PER RESOURCE, and nothing wider. Two operations that name no
   * common resource never wait for each other; two that do are ordered by
   * arrival. There are no shared reads: admitting a second reader past a queued
   * writer is how a writer starves, and ordering a repeated read of one path is
   * cheap next to being wrong about which write won.
   *
   * The whole scope set is awaited and claimed in ONE step, so a multi-resource
   * operation — a rename touches two paths and both their parents — cannot hold
   * one resource while waiting for another. That removes deadlock by
   * construction rather than by an acquisition order anyone has to maintain.
   *
   * `release` exists for the one operation whose resource outlives its own
   * return: a read that hands back a stream still owns the file until those
   * bytes are done. Everything else uses {@link run}.
   */
  /** Whether this lane currently holds any resource. A streamed read remains
   *  busy until its body drains or is cancelled. */
  busy(): boolean;
  run<T>(scopes: readonly ResourceScope[], op: () => Promise<T>): Promise<T>;
  /** Claim `scopes`, then hand back the release. The caller MUST call it on
   *  every path out, including cancellation. */
  hold(scopes: readonly ResourceScope[]): Promise<() => void>;
}

/**
 * The queue every caller of one container passes through.
 *
 * WHY IT LIVES IN THE OWNER. Each facet of a workspace is a separate Durable
 * Object with its own isolate and its own client, and all of them address ONE
 * container through this one object. A queue built beside any client orders only
 * that client's own calls, so two facets writing one path still interleaved —
 * the object every caller reaches is the only place a claim means anything.
 *
 * IN-FLIGHT ONLY. An entry exists while its operation runs and is dropped when
 * it settles, so this is a queue rather than a register of who owns what: there
 * is nothing to persist, nothing to reconcile after an eviction, and nothing to
 * keep in step with the durable spec tables.
 */
export function createResourceLane(): ResourceLane {
  const inFlight = new Set<{ scopes: readonly ResourceScope[]; settled: Promise<void> }>();
  const hold = async (scopes: readonly ResourceScope[]): Promise<() => void> => {
    // Loop rather than one pass: waiting for today's conflicts can let a third
    // operation claim an overlapping resource in the meantime, and admitting
    // this one anyway would be the interleaving the lane exists to stop.
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

/** The one resource a port operation names: its number. Ports have no subtree
 *  and no membership — `port:3000` and `port:30001` share no segment boundary,
 *  so they never overlap. */
export function portScope(port: number): readonly ResourceScope[] {
  return [{ path: `port:${port}`, subtree: false }];
}

/** The one resource a supervised-process operation names: its id. */
export function processScope(processId: string): readonly ResourceScope[] {
  return [{ path: `proc:${processId}`, subtree: false }];
}

/**
 * Hold a claim until a stream is DONE with it.
 *
 * A read that hands back a `ReadableStream` returns before a byte is consumed,
 * so releasing on return would let a sibling write rewrite the file underneath a
 * reader still pulling from it. This releases on the last chunk, on an error, and
 * on cancellation — every way a stream can end — and releases exactly once, so a
 * consumer that cancels a half-read body does not leave the file claimed forever.
 */
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

/**
 * The resources a path operation touches.
 *
 * TOPOLOGY, NOT JUST THE PATH. A listing of `/a` and a create of `/a/b` name
 * different paths and the same fact: what `/a` contains. So an operation that
 * can change a directory's membership claims that directory too, which is why
 * two creates in one directory are ordered while creates in different
 * directories are not. The cost is stated rather than hidden: a plain overwrite
 * of an existing file also claims its directory, because nothing here can tell
 * an overwrite from a create without asking the container, and guessing in the
 * cheaper direction would be exactly the sibling independence we must not
 * overclaim.
 *
 * `recursive` widens the claim to the subtree, for the operations whose effect
 * is the subtree: a recursive listing reads it, and a removal of a directory
 * changes all of it.
 */
export function pathScopes(input: {
  readonly path: string;
  readonly membership?: boolean;
  readonly ancestors?: boolean;
  readonly recursive?: boolean;
}): readonly ResourceScope[] {
  const path = canonicalPath(input.path);
  const scopes: ResourceScope[] = [{ path: `file:${path}`, subtree: input.recursive === true }];
  const above = ancestors(path);
  // THE IMMEDIATE PARENT ONLY, unless the operation really can create the whole
  // chain. Claiming every ancestor looks safer and is a global lock: two creates
  // in unrelated directories both name `/workspace`, so every write in the
  // workspace would order against every other. A create changes the membership
  // of the directory it lands in, and of higher ones only when it makes them.
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

/**
 * One spelling per file, so two names for one path are one resource.
 *
 * Relative paths resolve against the work directory the way the container does,
 * `.` and `..` collapse, and repeated and trailing slashes go. This is a
 * SPELLING, not an inode: a symlink or a bind mount can still name one file
 * under two paths, and no string comparison can see that.
 */
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

// ── one checkpoint at a time ────────────────────────────────────────────────

export interface CheckpointLane {
  /**
   * Run one strategy checkpoint under the instance-wide gate.
   *
   * A Durable Object interleaves requests at every container and store await,
   * so two overlapping checkpoints would share the chain's staging directory,
   * race its delta PUT against its state write, and stamp overlapping journal
   * sequences — one batch object overwriting another under the same key while
   * both blobs stay. The rules:
   *
   *   same kind already running → JOIN it: the callers share one operation and
   *     one outcome.
   *   a different kind is running → QUEUE behind it: a quiesce that joined an
   *     in-flight tick could inherit a `skipped` answer and stop the container
   *     over work that only just landed; it runs its own final commit instead.
   *
   * Rejections travel to every caller of the failed run; the gate itself
   * survives and the next caller starts clean.
   */
  /** Whether a checkpoint has been admitted or is still running. */
  busy(): boolean;
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

// ── incidents ───────────────────────────────────────────────────────────────


/**
 * Which part of the lifecycle failed. A host routing an incident cares about
 * this more than about the text.
 *
 * A RUNTIME LIST, not a bare type union, because the host that receives these
 * has to validate them: a stage the producer emits and the consumer's schema
 * rejects is an incident that never reaches anyone, and that is exactly what
 * happened when the two sides each kept their own list. There is one list, and
 * it is this one.
 */
export const INCIDENT_STAGES = ['attach', 'checkpoint', 'process', 'port'] as const;

export type IncidentStage = (typeof INCIDENT_STAGES)[number];

/** A lifecycle failure, recorded durably before anyone is told about it.
 *
 *  `reason` carries ids and stages only. No object key, no bucket name, no
 *  token, no presigned value ever lands in it: an incident is the one row most
 *  likely to be forwarded somewhere the container's own secrets should not go. */
export interface DevboxIncident {
  readonly incidentId: string;
  readonly stage: IncidentStage;
  readonly reason: string;
  readonly processId: string | undefined;
  readonly port: number | undefined;
  readonly at: number;
}

/**
 * What the host did with an incident.
 *
 * `queued` means the announcement LANDED, and delivery stops. `undelivered`
 * means the host took the incident but could not announce it, so the row stays
 * pending and the next delivery pass tries again — the distinction exists
 * because a host that answered `queued` for an announcement that never reached
 * anyone made the box stop retrying an incident nobody had seen, while the
 * host's own ledger still held it as re-deliverable. `rejected` means the host
 * refused the SHAPE, which is a defect in the caller rather than a transient
 * failure, so it is recorded and never retried. A thrown handler is treated as
 * `undelivered`: it is transient, and the schedule retries it.
 */
export type IncidentDisposition = 'queued' | 'undelivered' | 'rejected';

/** Backoff for delivering an incident: 5 s doubling to a 5-minute ceiling.
 *
 *  Delivery persists BEFORE the first attempt and retries by schedule until
 *  the host accepts, so an eviction between recording and delivering loses
 *  nothing. */
export function incidentRetryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt), 300_000);
}


