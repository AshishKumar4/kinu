// withBackgroundThreshold: races a tool's work against the surface's detach threshold. Inline if it
// finishes first; otherwise `deps.onThreshold` takes the live promise. A refused detach keeps waiting.
import { Effect } from 'effect';
import { settle } from '../obs/effect';
import * as v from 'valibot';
import { tolerate } from '../obs/index';
import { DeviceRequestOwnership, type DeviceRequestChannel } from './device-ownership';
import { REAL_CLOCK, type Clock } from '../types/clock';
import {
  BACKGROUND_POLICY, type BackgroundPolicy, type InvocationSurface,
} from '../types/jobs';

export {
  BACKGROUND_POLICY, type BackgroundPolicy, type InvocationSurface,
} from '../types/jobs';

/** The surface owns the foreground half (`detachAfterMs`, `settleGraceMs`); session durability owns
 *  `wakesAfterTurn` (a Durable Object delivers wakes unwatched; a CLI one-shot does not). */
export function invocationBackgroundPolicy(
  surface: InvocationSurface,
  wakesAfterTurn: boolean,
): BackgroundPolicy {
  const base = BACKGROUND_POLICY[surface];

  return base.wakesAfterTurn === wakesAfterTurn ? base : { ...base, wakesAfterTurn };
}

export interface BackgroundHandle {
  readonly background: true;
  readonly jobId: string;
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

/** Same discriminator over the serialized result, the only form the tool-result extension seam carries. */
export function isBackgroundOutcomeText(result: string): boolean {
  const text = result.trimStart();

  if (!text.startsWith('{')) return false;
  const parsed: unknown = tolerate(() => JSON.parse(text), 'malformed-input');
  const base = v.safeParse(v.object({ background: v.boolean(), kind: v.string() }), parsed);

  if (!base.success) return false;

  if (base.output.background) {
    return v.safeParse(v.object({ jobId: v.string() }), parsed).success;
  }

  return true;
}

export type DetachOutcome =
  | { readonly detached: true; readonly jobId: string }
  | { readonly detached: false; readonly reason: string };

export interface ThresholdDeps {
  thresholdMs?: number;
  clock?: Clock;
  /** Mint a background job that keeps `promise` alive durably, or refuse; a refusal leaves it foreground-owned. */
  onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome | Promise<DetachOutcome>;
}

/** Outcome is a value either way, so the race's loser is observed and never an unhandled rejection. */
function settlement<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return (async () => {
    try {
      return { value: await promise };
    } catch (cause) {
      return { error: cause };
    }
  })();
}

/** `promise` settles inline unless `trigger` fires first, when `onThreshold` detaches or keeps it. */
function detachOn<T>(input: {
  readonly kind: string;
  readonly promise: Promise<T>;
  /** Resolves null to detach; resolved already, it beats same-tick work. */
  readonly trigger: Promise<null>;
  readonly release?: () => void;
  readonly onThreshold: ThresholdDeps['onThreshold'];
  readonly message: string;
}): Effect.Effect<T | BackgroundHandle> {
  return Effect.gen(function* () {
    const settled = settlement(input.promise);
    const winner = yield* Effect.promise(() => Promise.race([settled, input.trigger]));

    input.release?.();

    const answered = winner === null ? yield* Effect.promise(async () => input.onThreshold(input.kind, input.promise)) : null;

    if (answered?.detached === true) return { background: true, jobId: answered.jobId, kind: input.kind, message: input.message };
    const foreground = winner ?? (yield* Effect.promise(() => settled));

    return 'error' in foreground ? yield* Effect.die(foreground.error) : foreground.value;
  });
}

export function withBackgroundThreshold<T>(
  kind: string,
  exec: () => Promise<T>,
  deps: ThresholdDeps,
): Promise<T | BackgroundHandle> {
  const thresholdMs = deps.thresholdMs ?? BACKGROUND_POLICY.interactive.detachAfterMs;
  const promise = exec();
  const { promise: trigger, resolve: expire } = Promise.withResolvers<null>();
  const cancel = (deps.clock ?? REAL_CLOCK).after(thresholdMs, () => { expire(null); });

  return settle(detachOn({
    kind, promise, trigger, release: cancel, onThreshold: deps.onThreshold,
    message: `Outran the ${Math.round(thresholdMs / 1000)}s foreground window; backgrounded: still running, not cancelled. The settled result will wake you.`,
  }));
}

/** Spawn-shaped sibling of {@link withBackgroundThreshold}: detaches when the tool announces its spawn
 *  via {@link SPAWN_STARTED_OPTION}, not on a timer. Work that settles without announcing returns inline. */
export function withSpawnDetach<T>(
  kind: string,
  exec: (spawnStarted: () => void) => Promise<T>,
  deps: Pick<ThresholdDeps, 'onThreshold'>,
): Promise<T | BackgroundHandle> {
  const { promise: trigger, resolve: announce } = Promise.withResolvers<null>();

  return settle(detachOn({
    kind, promise: exec(() => { announce(null); }), trigger, onThreshold: deps.onThreshold, message: 'Spawned; the settled result will wake you.',
  }));
}

/** Callback a tool invokes once its spawn is validated and in flight. Absent on inline surfaces. */
export const SPAWN_STARTED_OPTION = 'kinuSpawnStarted';

const SpawnStartedOptionsSchema = v.object({
  [SPAWN_STARTED_OPTION]: v.optional(v.function()),
});

export function readSpawnStarted(input: { toolOptions: unknown }): (() => void) | undefined {
  const parsed = v.safeParse(SpawnStartedOptionsSchema, input.toolOptions);
  const fn = parsed.success ? parsed.output[SPAWN_STARTED_OPTION] : undefined;

  return fn;
}

/** Per-invocation ownership holder for durable external requests (see ./device-ownership).
 *  Per invocation, not per turn: only the detaching call's requests change hands. */
export const DEVICE_REQUEST_OPTION = 'kinuDeviceRequest';

const DeviceRequestOptionsSchema = v.object({
  [DEVICE_REQUEST_OPTION]: v.optional(v.instance(DeviceRequestOwnership)),
});

/** Narrowed to the two members a tool may use, so the claim stays the runner's. */
export function readDeviceRequestChannel(input: { toolOptions: unknown }): DeviceRequestChannel | undefined {
  const parsed = v.safeParse(DeviceRequestOptionsSchema, input.toolOptions);

  return parsed.success ? parsed.output[DEVICE_REQUEST_OPTION] : undefined;
}

/** Set only by the resume path; only a re-drive may re-enter an interrupted search (`mcts/search-store.ts`).
 *  On the options bag, not the input, because the input is the durable row. */
export const RESUME_REDRIVE_OPTION = 'kinuResumeRedrive';

const ResumeRedriveOptionsSchema = v.object({
  [RESUME_REDRIVE_OPTION]: v.optional(v.boolean()),
});

export function readResumeRedrive(input: { toolOptions: unknown }): boolean {
  const parsed = v.safeParse(ResumeRedriveOptionsSchema, input.toolOptions);

  return parsed.success && parsed.output[RESUME_REDRIVE_OPTION] === true;
}
