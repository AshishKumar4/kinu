/**
 * Session recovery policy — the client half of surviving a deploy supersede.
 *
 * A deploy kills the workspace's isolate mid-session. When the browser learns
 * about it (a close event), partysocket redials and React re-runs the loads
 * keyed on connection status. When it does NOT learn — the close frame lost,
 * hibernation reattach gone quiet, laptop network transitioned — the socket
 * becomes a CORPSE: `readyState` says OPEN, every send vanishes, every RPC
 * dies at the agents SDK's `DEFAULT_CALL_TIMEOUT_MS` backstop, the degraded
 * banner sets, and nothing ever forces a redial. That is the shape behind
 * "Network connection lost … Showing last known data." that a manual reload
 * used to be the only way out of.
 *
 * This module owns the whole policy as a plain controller the hook wires to
 * real events:
 *
 *   - every non-initial WS 'open' re-runs the full initial load, so recovery
 *     never depends on React observing an intermediate disconnected state
 *     (close and open can coalesce into one render);
 *   - consecutive RPC timeouts while the socket claims OPEN are evidence of a
 *     corpse; enough of them inside a short window forces a redial, with a
 *     growing minimum spacing so a genuinely down origin is not hammered;
 *   - any success, and any FAST rejection (the transport answered), restores
 *     trust and the base spacing;
 *   - the public /api/health build sha, compared per reconnect against the
 *     session's baseline, turns a supersede the client DID ride through into
 *     a one-time "new version — reload" affordance instead of silent chunk
 *     404s on the next dynamic import.
 */

import * as v from "valibot";
import { diagnostics, renderThrownChain } from '@kinu.run/core/obs';

/* ── timeout classification ─────────────────────────────────────────────────── */

/** The agents SDK's verbatim rejection when no response arrives in time
 *  (`node_modules/agents/dist/react.js`, the `defaultCallTimeout` backstop).
 *  A fast rejection — any server answer, even an error — is proof of life and
 *  must not feed the corpse detector. */
const RPC_TIMEOUT_PATTERN = /^RPC call to .+ timed out after \d+ms$/;

function isRpcTimeoutError<ErrorValue>(error: ErrorValue): boolean {
  const parsed = v.safeParse(v.instance(Error), error);
  return parsed.success
    && RPC_TIMEOUT_PATTERN.test(renderThrownChain({ cause: parsed.output }));
}

/* ── corpse detection and forced redial ─────────────────────────────────────── */

/** Consecutive timed-out RPCs (while the socket claims OPEN) that condemn the
 *  transport. One timeout is a slow method; three inside the window, with zero
 *  successes between, is a peer that is not there. */
const TIMEOUTS_TO_REDIAL = 3;

/** How long a streak may take to accumulate and still count as ONE outage. */
const REDIAL_WINDOW_MS = 90_000;

/** Minimum spacing between forced redials — doubles per redial up to the cap,
 *  so a long-dead origin is probed at a heartbeat, not with a hammer. */
const REDIAL_MIN_INTERVAL_MS = 15_000;
const REDIAL_MAX_INTERVAL_MS = 60_000;

export interface SessionRecoveryCallbacks {
  /** Re-run the initial load and the live-data refresh. */
  refetch(): void;
  /** Force the underlying partysocket to close and dial again. */
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
  /** A WS 'open' event. The session's FIRST open changes nothing here (the
   *  hook's mount effect already loads); every later open re-fetches, because
   *  a reconnect the UI never saw as "disconnected" still missed pushes. */
  socketOpened(isFirstForSession: boolean): void;
  /** An RPC rejected. `socketOpen` is the transport's own readyState belief. */
  rpcFailed<ErrorValue>(error: ErrorValue, socketOpen: boolean): void;
  /** An RPC succeeded — the transport is alive. */
  rpcSucceeded(): void;
  /** The user pressed Retry. */
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

  /** Proof of life — a success or any fast rejection — clears the streak AND
   *  the redial spacing: the growing interval spaces probes inside ONE
   *  continuous outage, while a transport that demonstrably answered since the
   *  last dial has earned an immediate re-examination when it dies again. The
   *  three-timeout streak itself bounds how fast that can happen (~30s per
   *  timed-out call). */
  function restoreTrust(): void {
    timeoutStreak = 0;
    lastRedialMs = Number.NEGATIVE_INFINITY;
    minRedialIntervalMs = baseMinIntervalMs;
  }

  return {
    socketOpened(isFirstForSession) {
      if (!isFirstForSession) callbacks.refetch();
    },

    rpcFailed(error, socketOpen) {
      // Closing a corpse rejects every other in-flight RPC with
      // `Connection closed`. That is not peer evidence and must not erase the
      // redial spacing this outage already earned.
      if (!socketOpen) return;
      if (!isRpcTimeoutError(error)) {
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

/* ── version-skew signal ────────────────────────────────────────────────────── */

const HealthBuildSchema = v.object({ sha: v.pipe(v.string(), v.trim(), v.minLength(1)) });
const HealthBodySchema = v.object({ build: v.nullable(HealthBuildSchema) });

/** Transport-level failures of a best-effort public read: the request timed
 *  out (AbortError travels as DOMException), never left the process
 *  (TypeError), or the answer was not JSON (SyntaxError). Anything else
 *  propagates — silence must not eat real breakage. */
function isTolerableHealthFailure<ErrorValue>(cause: ErrorValue): boolean {
  return cause instanceof TypeError
    || cause instanceof DOMException
    || cause instanceof SyntaxError;
}

/** The deployed build's sha from the public health endpoint, or null when this
 *  deployment carries none (a dev server has no stamp — correctly no signal).
 *  Never rejects: both callers fire and forget, so every tolerated outcome
 *  folds into "no signal". */
export async function fetchDeployedBuildSha(): Promise<string | null> {
  try {
    const res = await fetch("/api/health", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const parsed = v.safeParse(HealthBodySchema, await res.json());
    return parsed.success ? parsed.output.build?.sha ?? null : null;
  } catch (cause) {
    if (!isTolerableHealthFailure(cause)) throw cause;
    return null;
  }
}

/** This page's baseline, read at most once. */
let pageBuild: Promise<string | null> | null = null;

/**
 * The build this PAGE loaded, read once and shared.
 *
 * One read per document, memoised, because a baseline that is re-read is not a
 * baseline. Two callers need the same answer and would otherwise each capture
 * their own: the version-skew notice, whose per-workspace hook is remounted on
 * every navigation and so re-baselined itself onto whatever was live at the time
 * — hiding the very skew it exists to report — and the render-failure report,
 * which is asked for a sha at the moment of a fault and must not answer with the
 * deployment now serving instead of the one that produced the stack.
 *
 * Called eagerly by `index.tsx` at load, so the read happens while the page is
 * still the page it says it is. Never rejects — see `fetchDeployedBuildSha`.
 */
export function pageDeployedBuildSha(): Promise<string | null> {
  pageBuild ??= fetchDeployedBuildSha();
  return pageBuild;
}

/**
 * Prime the baseline the way {@link pageDeployedBuildSha}'s eager callers do,
 * without letting a rejection die in a `void`.
 *
 * The read itself already folds every tolerable transport failure into
 * "no signal" ({@link fetchDeployedBuildSha}); what can still reject is a
 * non-transport defect — the memoised promise is shared, so the one
 * rejection would otherwise surface as an unhandled rejection on every
 * page that primed eagerly and again at whichever reader awaited it. Those
 * are named on the shared diagnostics sink: there is no UI state to attach
 * them to, and the two consumers re-read through the same memo.
 */
export function primePageDeployedBuildSha(): void {
  pageDeployedBuildSha().catch((cause: unknown) => {
    diagnostics.event('session_recovery.build_baseline_failed', {
      reason: renderThrownChain({ cause }),
    });
  });
}

/** Skew needs BOTH ends identified: without a baseline (the health read failed
 *  at mount) or a live stamp (dev) there is nothing to compare, and no claim
 *  about versions is honest. */
export function isNewerDeployedBuild(baseline: string | null, live: string | null): boolean {
  return baseline !== null && live !== null && baseline !== live;
}
