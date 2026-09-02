/**
 * "Is there a newer Kinu?" — the shared logic behind `kinu update`,
 * `kinu doctor`, and the once-a-day startup notice.
 *
 * The served build publishes its version at /downloads/kinu-version.json,
 * written by scripts/build-cli-dist.sh from the same stamped
 * packages/cli/package.json the built CLI carries. That stamp is the only
 * version source; nothing here invents one.
 *
 * Every entry point is fail-soft: a version check must never slow down, block,
 * or break the CLI.
 */
import { VERSION } from './display';
import { loadConfigFile, updateConfigFile, type KinuConfig } from './config';
import * as v from 'valibot';
import { classify, classifyErrorCode, renderThrownChain, tolerateAsync } from '@kinu.run/core/obs';

export const CLI_VERSION_PATH = '/downloads/kinu-version.json';
const FETCH_TIMEOUT_MS = 1_500;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const ServedVersionSchema = v.object({
  version: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  sha: v.optional(v.string()),
  builtAt: v.optional(v.string()),
});

export interface ServedVersion {
  version: string;
  sha?: string;
  builtAt?: string;
}

type FetchVersion = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Build metadata is significant here: 0.1.0+aaa and 0.1.0+bbb are different
 *  builds even though semver treats the suffix as ignorable. */
export function isSameBuild(installed: string, served: string): boolean {
  return installed.trim() === served.trim();
}

/** Fetch the served build's version, or null when the origin could not be asked (unreachable,
 *  past the timeout, no such endpoint, or a payload that is not a served version). */
export async function fetchServedVersion(
  origin: string,
  fetchImpl: FetchVersion = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<ServedVersion | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${CLI_VERSION_PATH}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (error) {
      // Could not ask: unreachable origin, or this probe's own cap firing. A malformed origin is
      // OURS — swallowed here, the update check would silently never fire again.
      if (classify({ cause: error }) === 'malformed-input') throw error;
      return null;
    }
    if (!res.ok) return null;
    // The payload belongs to the server: unparseable JSON is a probe that learned nothing.
    const parsed = v.safeParse(ServedVersionSchema, await tolerateAsync(() => res.json(), 'malformed-input'));
    if (!parsed.success) return null;
    const served: ServedVersion = { version: parsed.output.version };
    if (parsed.output.sha !== undefined) served.sha = parsed.output.sha;
    if (parsed.output.builtAt !== undefined) served.builtAt = parsed.output.builtAt;
    return served;
  } finally {
    clearTimeout(timer);
  }
}

export interface NoticeContext {
  config: Pick<KinuConfig, 'origin' | 'updateCheck' | 'updateCheckedAt'>;
  isTTY: boolean;
  now: number;
}

/** Whether to spend a network round-trip on the startup notice. Pure so the
 *  suppression rules are testable without a clock, a terminal, or a server. */
export function shouldCheckForUpdate(ctx: NoticeContext): boolean {
  if (!ctx.isTTY) return false;                       // CI, pipes, --json
  if (ctx.config.updateCheck === false) return false; // explicit opt-out
  if (!ctx.config.origin) return false;               // not signed in anywhere
  const last = ctx.config.updateCheckedAt ?? 0;
  return ctx.now - last >= CHECK_INTERVAL_MS;
}

/** The one muted line, or null when the installed build is current. */
export function updateNotice(installed: string, served: ServedVersion | null): string | null {
  if (!served || isSameBuild(installed, served.version)) return null;
  return `A newer Kinu is available (${served.version}) — run: kinu update`;
}

/**
 * Fire-and-forget startup check. Resolves to the notice line (already printed
 * by the caller's `log`) or null. Never throws, never blocks past the timeout.
 */
export async function runStartupUpdateCheck(opts: {
  log: (line: string) => void;
  isTTY?: boolean;
  now?: number;
  fetchImpl?: FetchVersion;
} ): Promise<string | null> {
  try {
    const config = loadConfigFile();
    const ctx: NoticeContext = {
      config,
      isTTY: opts.isTTY ?? Boolean(process.stdout.isTTY),
      now: opts.now ?? Date.now(),
    };
    if (!shouldCheckForUpdate(ctx)) return null;

    const served = await fetchServedVersion(config.origin!, opts.fetchImpl ?? fetch);
    // Record the attempt either way so a persistently unreachable origin does
    // not retry on every single invocation.
    updateConfigFile((c) => {
      c.updateCheckedAt = ctx.now;
      if (served) c.updateLatestSeen = served.version;
    });

    const notice = updateNotice(VERSION, served);
    if (notice) opts.log(notice);
    return notice;
  } catch (error) {
    // Expected probe conditions stay silent: the check is throttled to once a
    // day, so an aborted, timed-out or unreachable probe says nothing until
    // the next window opens — a user mid-command saw "Update check failed: The
    // operation was aborted." for exactly this path. The classification is the
    // same map every other seam reads: AbortError is `cancelled`, and it
    // cannot carry a `doing` frame. A check that can NEVER succeed — an
    // unwritable config, a malformed origin — still has to say so instead of
    // skipping every run.
    const code = classifyErrorCode({ cause: error });
    if (code === 'cancelled' || code === 'timeout' || code === 'unavailable') return null;
    opts.log(`Update check failed: ${renderThrownChain({ cause: error })}`);
    return null;
  }
}
