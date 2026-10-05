/** The served /downloads/kinu-version.json stamp is the only version source; every entry point is fail-soft. */
import { VERSION } from './display';
import { loadConfigFile, updateConfigFile, type KinuConfig } from './config';
import { spawnBackgroundRefresh } from './self-update';
import * as v from 'valibot';
import { isSameBuild } from '@kinu.run/core';
import { Cause, Effect } from 'effect';
import { classify, classifyErrorCode, renderThrownChain, settle, tolerateAsync } from '@kinu.run/core/obs';

const CLI_VERSION_PATH = '/downloads/kinu-version.json';

/** Bounds only the startup notice's probe; 1_500 ms is unmeasured, and missing it costs one day's notice. `update`/`doctor` pass no bound. */
const STARTUP_PROBE_TIMEOUT_MS = 1_500;

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

const ServedVersionSchema = v.object({
  version: v.pipe(v.string(), v.trim(), v.nonEmpty()),
});

type ServedVersion = v.InferOutput<typeof ServedVersionSchema>;

type FetchVersion = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** `timeoutMs` is caller-requested only. */
export function fetchServedVersion(
  origin: string,
  fetchImpl: FetchVersion = fetch,
  timeoutMs?: number,
): Promise<ServedVersion | null> {
  return settle(servedVersion(origin, fetchImpl, timeoutMs));
}

function servedVersion(origin: string, fetchImpl: FetchVersion, timeoutMs: number | undefined): Effect.Effect<ServedVersion | null> {
  // No bound: the probe ends only on the origin's answer or a network failure.
  const controller = timeoutMs === undefined ? undefined : new AbortController();
  const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);

  return Effect.ensuring(Effect.gen(function* () {
    const res = yield* Effect.catchCause(Effect.promise(() => fetchImpl(`${origin}${CLI_VERSION_PATH}`, { cache: 'no-store', signal: controller?.signal })), (failed) => {
      const error = Cause.squash(failed);

      // A malformed origin is ours and propagates, or the check would never fire again.
      return classify({ cause: error }) === 'malformed-input' ? Effect.die(error) : Effect.succeed(null);
    });

    if (res === null || !res.ok) return null;
    const parsed = v.safeParse(ServedVersionSchema, yield* Effect.promise(() => tolerateAsync(() => res.json(), 'malformed-input')));

    return parsed.success ? parsed.output : null;
  }), Effect.sync(() => clearTimeout(timer)));
}

interface NoticeContext {
  config: Pick<KinuConfig, 'origin' | 'updateCheck' | 'updateCheckedAt'>;
  isTTY: boolean;
  now: number;
}

/** Pure so suppression rules test without clock, terminal, or server. */
function shouldCheckForUpdate(ctx: NoticeContext): boolean {
  if (!ctx.isTTY) return false;                       // CI, pipes, --json

  if (ctx.config.updateCheck === false) return false; // explicit opt-out

  if (!ctx.config.origin) return false;               // not signed in anywhere
  const last = ctx.config.updateCheckedAt ?? 0;

  return ctx.now - last >= CHECK_INTERVAL_MS;
}

function updateNotice(installed: string, served: ServedVersion | null): string | null {
  if (!served || isSameBuild(installed, served.version)) return null;

  return `Installing Kinu ${served.version} in the background; it applies on the next launch.`;
}

/** Never awaited, never throws. See {@link STARTUP_PROBE_TIMEOUT_MS}. */
export function runStartupUpdateCheck(opts: {
  log: (line: string) => void;
  isTTY?: boolean;
  now?: number;
  fetchImpl?: FetchVersion;
  spawnRefresh?: () => void;
} ): Promise<string | null> {
  return settle(Effect.catchCause(Effect.gen(function* () {
    const config = loadConfigFile();

    const ctx: NoticeContext = {
      config,
      isTTY: opts.isTTY ?? Boolean(process.stdout.isTTY),
      now: opts.now ?? Date.now(),
    };

    if (!shouldCheckForUpdate(ctx)) return null;
    const origin = config.origin;

    // `shouldCheckForUpdate` already refused a config with no origin.
    if (origin === undefined) return null;

    const served = yield* servedVersion(origin, opts.fetchImpl ?? fetch, STARTUP_PROBE_TIMEOUT_MS);
    // Record the attempt either way so an unreachable origin does not retry every invocation.
    yield* Effect.promise(() => updateConfigFile((c) => {
      c.updateCheckedAt = ctx.now;

      if (served) c.updateLatestSeen = served.version;
    }));

    const notice = updateNotice(VERSION, served);

    if (notice === null) return null;
    (opts.spawnRefresh ?? spawnBackgroundRefresh)();
    opts.log(notice);

    return notice;
  }), (failed) => Effect.sync(() => {
    // Expected probe failures (aborted, timed out, unreachable) stay silent until the next daily window; a check that can
    // never succeed (unwritable config, malformed origin) still reports.
    const error = Cause.squash(failed);
    const code = classifyErrorCode({ cause: error });

    if (code === 'cancelled' || code === 'timeout' || code === 'unavailable') return null;
    opts.log(`Update check failed: ${renderThrownChain({ cause: error })}`);

    return null;
  })));
}
