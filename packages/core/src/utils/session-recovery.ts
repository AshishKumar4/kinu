/**
 * Client policy for surviving a deploy supersede. A silently dead socket (OPEN, but every RPC times out)
 * is detected by consecutive timeouts and force-redialed with growing spacing; every non-initial 'open'
 * re-runs the initial load; a changed /api/health build sha offers a one-time reload.
 */

import * as v from "valibot";
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

/** The agents SDK's verbatim timeout rejection. A fast rejection is proof of life. */
const RPC_TIMEOUT_PATTERN = /^RPC call to .+ timed out after \d+ms$/;

function isRpcTimeoutError(input: { cause: unknown }): boolean {
  const parsed = v.safeParse(v.instance(Error), input.cause);

  return parsed.success
    && RPC_TIMEOUT_PATTERN.test(renderThrownChain({ cause: parsed.output }));
}

/** Consecutive timed-out RPCs (socket claims OPEN) that condemn the transport. */
const TIMEOUTS_TO_REDIAL = 3;

const REDIAL_WINDOW_MS = 90_000;

/** Minimum spacing between forced redials; doubles per redial up to the cap. */
const REDIAL_MIN_INTERVAL_MS = 15_000;

const REDIAL_MAX_INTERVAL_MS = 60_000;

export interface SessionRecoveryCallbacks {
  refetch(): void;
  forceRedial(): void;
}

export interface SessionRecoveryOptions {
  now?: () => number;
  timeoutsToRedial?: number;
  redialWindowMs?: number;
  minRedialIntervalMs?: number;
  maxRedialIntervalMs?: number;
}

export interface SessionRecovery {
  /** A WS 'open'. The first changes nothing; later opens re-fetch because missed pushes are lost. */
  socketOpened(isFirstForSession: boolean): void;
  rpcFailed(thrown: { cause: unknown }, socketOpen: boolean): void;
  rpcSucceeded(): void;
  manualRetry(forceRedial?: boolean): void;
}

export function createSessionRecovery(
  callbacks: SessionRecoveryCallbacks,
  options: SessionRecoveryOptions = {},
): SessionRecovery {
  const now = options.now ?? Date.now;
  const timeoutsToRedial = options.timeoutsToRedial ?? TIMEOUTS_TO_REDIAL;
  const redialWindowMs = options.redialWindowMs ?? REDIAL_WINDOW_MS;
  const baseMinIntervalMs = options.minRedialIntervalMs ?? REDIAL_MIN_INTERVAL_MS;
  const maxRedialIntervalMs = options.maxRedialIntervalMs ?? REDIAL_MAX_INTERVAL_MS;

  let timeoutStreak = 0;
  let streakStartMs = 0;
  let lastRedialMs = Number.NEGATIVE_INFINITY;
  let minRedialIntervalMs = baseMinIntervalMs;

  /** Proof of life clears the streak and the redial spacing. */
  function restoreTrust(): void {
    timeoutStreak = 0;
    lastRedialMs = Number.NEGATIVE_INFINITY;
    minRedialIntervalMs = baseMinIntervalMs;
  }

  return {
    socketOpened(isFirstForSession) {
      if (!isFirstForSession) callbacks.refetch();
    },

    rpcFailed(thrown, socketOpen) {
      // Closing a corpse rejects other in-flight RPCs with `Connection closed`; that is not peer evidence.
      if (!socketOpen) return;

      if (!isRpcTimeoutError(thrown)) {
        restoreTrust();

        return;
      }

      const at = now();

      if (timeoutStreak === 0 || at - streakStartMs > redialWindowMs) {
        streakStartMs = at;
        timeoutStreak = 1;
      } else {
        timeoutStreak += 1;
      }

      if (
        timeoutStreak >= timeoutsToRedial
        && at - lastRedialMs >= minRedialIntervalMs
      ) {
        lastRedialMs = at;
        timeoutStreak = 0;
        minRedialIntervalMs = Math.min(minRedialIntervalMs * 2, maxRedialIntervalMs);
        callbacks.forceRedial();
      }
    },

    rpcSucceeded() {
      restoreTrust();
    },

    manualRetry(forceRedial = false) {
      if (forceRedial) callbacks.forceRedial();
      callbacks.refetch();
    },
  };
}

const HealthBuildSchema = v.object({ sha: v.pipe(v.string(), v.trim(), v.minLength(1)) });

/** Bound on the best-effort health read; independent of monitor/probes.ts TIMEOUT_MS. */
const HEALTH_READ_TIMEOUT_MS = 10_000;

const HealthBodySchema = v.object({ build: v.nullable(HealthBuildSchema) });

/** Tolerated failures of a best-effort read: AbortError, TypeError, SyntaxError. Anything else propagates. */
function isTolerableHealthFailure(input: { cause: unknown }): boolean {
  return input.cause instanceof TypeError
    || input.cause instanceof DOMException
    || input.cause instanceof SyntaxError;
}

/** The deployed build sha from the health endpoint, or null when none is stamped or the read failed tolerably. */
export async function fetchDeployedBuildSha(): Promise<string | null> {
  try {
    const res = await fetch("/api/health", { signal: AbortSignal.timeout(HEALTH_READ_TIMEOUT_MS) });

    if (!res.ok) return null;
    const parsed = v.safeParse(HealthBodySchema, await res.json());

    return parsed.success ? parsed.output.build?.sha ?? null : null;
  } catch (cause) {
    if (!isTolerableHealthFailure({ cause })) throw cause;

    return null;
  }
}

let pageBuild: Promise<string | null> | null = null;

/** The memoized baseline task, retained through settlement so all readers share one answer. */
async function loadPageBuildSha(): Promise<string | null> {
  let thrown: { cause: unknown } | null = null;

  try {
    // A missing stamp or tolerated transport failure is an expected null, not a defect.
    return await fetchDeployedBuildSha();
  } catch (cause) {
    thrown = { cause };
  }

  // Only untolerated defects reach here; they are recorded with a class before resolving to null.
  diagnostics.failure('session_recovery.build_baseline_failed', toKinuError({
    doing: "reading this page's deployed build sha",
    cause: thrown.cause,
    otherwise: 'unavailable',
  }));

  return null;
}

/**
 * The build this page loaded, read once per document and shared by the skew notice and the render-failure
 * report. Primed eagerly by `index.tsx` at load.
 */
export function pageDeployedBuildSha(): Promise<string | null> {
  pageBuild ??= loadPageBuildSha();

  return pageBuild;
}

/** Start the shared baseline at page load. */
export function primePageDeployedBuildSha(): void {
  pageBuild ??= loadPageBuildSha();
}

/** Skew needs both a baseline and a live stamp. */
export function isNewerDeployedBuild(baseline: string | null, live: string | null): boolean {
  return baseline !== null && live !== null && baseline !== live;
}
