// withBackgroundThreshold — the auto-background race.
//
// Runs a tool's work and races it against the surface's detach threshold. If it
// finishes first, the result is returned inline (the common, fast case — no job,
// no overhead). If the threshold elapses, the still-running promise is handed to
// `deps.onThreshold` (which the orchestrator wraps in a durable runFiber that
// keeps the DO alive, settles the job, and publishes a completion event the
// reactor drains into a synthesis turn) and the model gets a BackgroundHandle
// immediately — "this is continuing in the background; you'll be woken with the
// result." When too many jobs are already in flight the detach is refused
// instead: the work is cancelled and the model is told why.
import * as v from 'valibot';
import { tolerate } from '../obs/index';

/** Who owns the session, which is what makes a detach cheap or expensive.
 *  Not a toggle — every session has exactly one of these, fixed at construction. */
export type SessionSurface = 'interactive' | 'one-shot';

export interface BackgroundPolicy {
  /** How long a tool call may run before it is moved to the background. */
  readonly detachAfterMs: number;
  /** How long teardown waits on work that has not settled before leaving it. */
  readonly settleGraceMs: number;
  /**
   * Whether this session outlives the turn, and can therefore receive a wake.
   *
   * It decides what SPAWN-shaped work (a swarm node) does, and both answers follow
   * from it. Where a wake can arrive, a node detaches the moment its spawn is
   * confirmed started — its duration is long by construction, so waiting on a
   * threshold could only ever be dead air. Where no wake can arrive, the turn
   * is the ONLY consumer the result will ever have, so the node runs inline to
   * completion: detaching it there produces an answer with nobody left to read
   * it.
   */
  readonly wakesAfterTurn: boolean;
}

/**
 * The two policies, and why they differ.
 *
 * `interactive` — a human is watching the stream, so a tool call that outlives
 * their patience must hand back a handle fast; the wake turn arrives in the
 * same live session, and teardown can afford to wait a while for in-flight work
 * because the session was going to stay open anyway. A node detaches the
 * moment it is confirmed started rather than after the threshold: its duration
 * is not unknown — it is long by construction — so the threshold wait could
 * only ever be dead air in the chat.
 *
 * `one-shot` — nobody is waiting on a fast turn, and the process exits after the
 * answer. Here a detach is expensive, not cheap: it truncates the turn, forces a
 * second (synthesis) turn, and — measured over an 89-task benchmark run — pushes
 * the model into polling its own jobs instead of doing the work (151 of 202
 * sandbox scripts were `agent.jobResult` polls, and nodes were spawned as
 * pollers rather than workers). So ordinary long work — a build, a test suite,
 * an install — runs to completion inline, and only genuinely non-terminating
 * work (a server, a VM) ever crosses. Because anything that DID cross is very
 * unlikely to finish at all, teardown gives it a short grace and then leaves it
 * running rather than joining it: that unbounded join was 6.4 of 16.2 agent-hours
 * of pure idle tail in the same run.
 *
 * A fork here is the case that grace was never meant to cover. It terminates,
 * its result IS the point, and no wake can arrive to deliver one — so letting
 * it cross the threshold guaranteed the worst outcome available: the model got
 * a handle instead of an answer, the search kept running unread, and teardown
 * abandoned it 120s later. A `settle=mcts` fork under `kinu exec` did
 * exactly that — 4 of 40 iterations, `bg_jobs_abandoned`, and a model left to
 * narrate a convergence over rival approaches it never saw. `wakesAfterTurn`
 * is what stops it: no wake, no detach, the turn waits for its own answer.
 */
export const BACKGROUND_POLICY = {
  interactive: { detachAfterMs: 30_000, settleGraceMs: 300_000, wakesAfterTurn: true },
  'one-shot': { detachAfterMs: 300_000, settleGraceMs: 120_000, wakesAfterTurn: false },
} as const satisfies Record<SessionSurface, BackgroundPolicy>;

/** Returned to the model when a tool call is moved to the background. */
export interface BackgroundHandle {
  readonly background: true;
  readonly jobId: string;
  readonly kind: string;
  readonly message: string;
}

/** Returned to the model when a tool call crossed the threshold but could NOT
 *  be detached — too many jobs are already in flight. The work was cancelled. */
export interface BackgroundRefusal {
  readonly background: false;
  readonly kind: string;
  readonly message: string;
}

const BackgroundHandleSchema: v.GenericSchema<BackgroundHandle> = v.object({
  background: v.literal(true),
  jobId: v.string(),
  kind: v.string(),
  message: v.string(),
});

export function isBackgroundHandle<T>(value: T): value is T & BackgroundHandle {
  return v.safeParse(BackgroundHandleSchema, value).success;
}

/**
 * The same discriminator over the SERIALIZED result — a handle OR a refusal.
 *
 * The tool-result extension seam carries the rendered string, not the value
 * (extension.ts), so a consumer that must not read a detached call as a
 * finished one has only the text. Both outcomes matter equally there: a handle
 * means the work is still running, a refusal means it was cancelled, and
 * neither is a result.
 */
export function isBackgroundOutcomeText(result: string): boolean {
  const text = result.trimStart();
  if (!text.startsWith('{')) return false;
  const parsed: unknown = tolerate(() => JSON.parse(text), 'malformed-input');
  return v.safeParse(v.object({ background: v.boolean(), kind: v.string() }), parsed).success;
}

/** What `onThreshold` decided: the job it minted, or why it refused. */
export type DetachOutcome =
  | { readonly detached: true; readonly jobId: string }
  | { readonly detached: false; readonly reason: string };

export interface ThresholdDeps {
  /** Override the surface's detach threshold. */
  thresholdMs?: number;
  /** The threshold elapsed. Either mint a background job and keep `promise`
   *  alive durably (settling the job and waking the agent when it resolves), or
   *  refuse — in which case the implementation has already cancelled the work
   *  and `reason` is what the model is told. */
  onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome;
}

const TIMED_OUT = Symbol('timed-out');

export async function withBackgroundThreshold<T>(
  kind: string,
  exec: () => Promise<T>,
  deps: ThresholdDeps,
): Promise<T | BackgroundHandle | BackgroundRefusal> {
  const thresholdMs = deps.thresholdMs ?? BACKGROUND_POLICY.interactive.detachAfterMs;
  const promise = exec();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), thresholdMs);
  });
  // Wrap with both handlers so the abandoned branch never throws unhandled.
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  const winner = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);

  if (winner !== TIMED_OUT) {
    if ('error' in winner) throw winner.error;
    return winner.value;
  }

  // Slow path: hand the live work to the background runner.
  const outcome = deps.onThreshold(kind, promise);
  if (!outcome.detached) {
    return { background: false, kind, message: outcome.reason };
  }
  return {
    background: true,
    jobId: outcome.jobId,
    kind,
    message:
      `Outran the ${Math.round(thresholdMs / 1000)}s foreground window; backgrounded — ` +
      `still running, not cancelled. The settled result will wake you.`,
  };
}

/**
 * withSpawnDetach — the spawn-shaped sibling of {@link withBackgroundThreshold}.
 *
 * The threshold race is a heuristic for tools whose duration is UNKNOWN: wait a
 * bit, and detach only work that proved slow. A fork is not unknown — it spawns
 * a process that is long by construction, and its completion arrives as a wake
 * event, not as a result this turn is blocked on. So it does not ride the
 * timer: the tool announces the moment its spawn is validated and in flight
 * (the {@link SPAWN_STARTED_OPTION} callback), and the call detaches right
 * then. Work that settles WITHOUT announcing — a validation error, an action
 * the spawn gate does not cover — returns inline exactly as before.
 */
export async function withSpawnDetach<T>(
  kind: string,
  exec: (spawnStarted: () => void) => Promise<T>,
  deps: Pick<ThresholdDeps, 'onThreshold'>,
): Promise<T | BackgroundHandle | BackgroundRefusal> {
  const SPAWNED = Symbol('spawned');
  let announce!: () => void;
  const started = new Promise<typeof SPAWNED>((resolve) => { announce = () => resolve(SPAWNED); });
  const promise = exec(announce);
  // Wrap with both handlers so the abandoned branch never throws unhandled.
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  const winner = await Promise.race([settled, started]);

  if (winner !== SPAWNED) {
    if ('error' in winner) throw winner.error;
    return winner.value;
  }

  const outcome = deps.onThreshold(kind, promise);
  if (!outcome.detached) {
    return { background: false, kind, message: outcome.reason };
  }
  return {
    background: true,
    jobId: outcome.jobId,
    kind,
    message: `Spawned; the settled result will wake you.`,
  };
}

/** Options-bag key the background wrapper sets on spawn-shaped tool calls: a
 *  callback the tool invokes once its spawn is validated and in flight, which
 *  is the moment {@link withSpawnDetach} detaches. Absent on inline surfaces
 *  (codemode `agents.*`, resume re-drives, the raw eval toolset), where the
 *  same tool simply runs to completion. */
export const SPAWN_STARTED_OPTION = 'kinuSpawnStarted';

const SpawnStartedOptionsSchema = v.object({
  [SPAWN_STARTED_OPTION]: v.optional(v.function()),
});

/** The spawn announcement out of a tool-call options bag, if the background
 *  wrapper armed one. */
export function readSpawnStarted<T>(toolOptions: T): (() => void) | undefined {
  const parsed = v.safeParse(SpawnStartedOptionsSchema, toolOptions);
  const fn = parsed.success ? parsed.output[SPAWN_STARTED_OPTION] : undefined;
  return fn;
}

/**
 * Options-bag key the RESUME path sets: this call is an evict/exit re-drive of a
 * durable job row, not a fresh call from a model.
 *
 * The distinction is load-bearing and nothing else carries it. A re-drive replays the
 * stored input verbatim, so the input cannot say which it is — and only a re-drive may
 * RE-ENTER an interrupted search: a fresh `agents.swarm` whose task happens to match a
 * run still expanding must get its own tree, or two live searches would grow one
 * (`mcts/search-store.ts` findRunningSwarms states the whole rule). Absent everywhere
 * else, which is what makes a first call structurally unable to adopt a sibling's tree.
 *
 * Set on the options bag rather than on the input for {@link SPAWN_STARTED_OPTION}'s
 * reason: the input is the durable row, and a field this path added to it would be
 * persisted on the next detach and re-read as if the model had sent it.
 */
export const RESUME_REDRIVE_OPTION = 'kinuResumeRedrive';

const ResumeRedriveOptionsSchema = v.object({
  [RESUME_REDRIVE_OPTION]: v.optional(v.boolean()),
});

/** Whether this tool call is a job re-drive. False for every other caller. */
export function readResumeRedrive<T>(toolOptions: T): boolean {
  const parsed = v.safeParse(ResumeRedriveOptionsSchema, toolOptions);
  return parsed.success && parsed.output[RESUME_REDRIVE_OPTION] === true;
}
