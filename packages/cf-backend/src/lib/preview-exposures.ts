/**
 * The sandbox previews this deployment has published, as state the WORKER owns.
 *
 * ── Why this exists ──────────────────────────────────────────────
 * A sandbox preview hostname is `<port>-<sandbox>-<token>.<suffix>`, and the
 * Sandbox SDK's `proxyToSandbox` resolves the sandbox id into a Durable Object
 * stub — `getContainer` is `idFromName` then `get`, which is the act that
 * CREATES one — before the port token is looked at; the token travels onward as
 * a header for the object to validate. The preview host is also the first step
 * of the route table, ahead of authentication. So without a check here, one
 * anonymous GET to a guessed hostname instantiates a `KinuSandbox` object and
 * its SQLite (Devbox writes storage from its constructor's init gate), and each
 * distinct guess creates another.
 *
 * The check has to prove the label names an exposure THIS deployment published,
 * and it has to do so without touching any per-name Durable Object — asking the
 * object whether it minted the label would create exactly the object the
 * question is about. So the proof reads a projection: one KV record per exposed
 * port, written when the port is exposed, deleted when it is unexposed, and
 * cut off wholesale by a watermark when the workspace is destroyed. KV has no
 * object behind a key, so a lookup for a label nobody minted allocates nothing.
 *
 * ── Why the token is hashed and not stored ───────────────────────
 * The token in the hostname IS the preview's credential — the same value the
 * container object compares. Keeping only its SHA-256 means a dump of this
 * namespace hands out no working preview URL, which is the rule `auth/store.ts`
 * already applies to session tokens.
 *
 * ── What this is NOT ─────────────────────────────────────────────
 * Not a second authority over previews. The container object still validates
 * the port token and its runtime activation on every forward, and still answers
 * 404/410 when its own state disagrees. This record only decides whether the
 * SDK is handed the request at all, which is the only decision that has to be
 * made before an object exists.
 *
 * ── Residuals, stated ────────────────────────────────────────────
 *   1. KV is eventually consistent. A preview is published before the URL is
 *      handed back, so the write precedes any click; a read in a colo that has
 *      never seen the key still crosses to central storage, and Cloudflare
 *      bounds that at 60 seconds. The failure direction is a refusal, never an
 *      admission, and a reload resolves it.
 *   2. One record per (sandbox, port) rather than one per sandbox: distinct keys
 *      cannot lose each other's writes, and KV's same-key write limit (one per
 *      second) is never reached by exposing several ports at once.
 *   3. A record lives {@link PREVIEW_EXPOSURE_TTL_MS} and is refreshed whenever
 *      an authenticated path observes the port as still exposed
 *      (`getExposedPorts`, or a re-expose). An exposure nothing has observed
 *      for that long stops resolving at the edge until the owner lists or
 *      re-exposes the port. The refusal is the same one a forged label gets, so
 *      it is not an existence oracle either.
 */

import * as v from 'valibot';
import { isWorkspaceName } from '../user/validate';
import { sha256Hex, timingSafeEqual } from './crypto';
import { readKvJson, writeKvJson, type KvStore } from './kv';

/** Every container this deployment addresses is `kinu-<workspace>`. One
 *  spelling, in one place, because the edge refuses every id that is not it. */
const SANDBOX_ID_PREFIX = 'kinu-';

/**
 * The container id that serves a workspace's sandbox executor.
 *
 * The SDK lowercases ids it resolves (`normalizeId`), and hostnames are
 * lower-case, so every read of this record normalizes too — a workspace named
 * `Hello` and the label `kinu-hello` are one container.
 */
export function sandboxIdForWorkspace(workspaceName: string): string {
  return `${SANDBOX_ID_PREFIX}${workspaceName}`;
}

/**
 * Whether a hostname's sandbox id is the shape this deployment mints.
 *
 * The SDK admits any id of up to 63 characters, so without this the guess space
 * is every such string; with it, the space is the workspace namespace, and the
 * record below is what narrows that to exposures that exist.
 */
export function isKinuSandboxId(sandboxId: string): boolean {
  if (!sandboxId.startsWith(SANDBOX_ID_PREFIX)) return false;
  return isWorkspaceName(sandboxId.slice(SANDBOX_ID_PREFIX.length));
}

/**
 * How long a published exposure resolves without being observed again.
 *
 * Thirty days is longer than any container lifetime — a recycle re-exposes each
 * port on its stored token, so a live preview is re-observed long before this —
 * and short enough that an abandoned record cannot outlive its workspace by a
 * season. It is a bound on the projection's staleness, not a rate limit.
 */
export const PREVIEW_EXPOSURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Half a life: past this, an observation refreshes the record, so a preview in
 *  use is never refused for age and a busy Ports panel writes ~nothing. */
const REFRESH_AFTER_MS = PREVIEW_EXPOSURE_TTL_MS / 2;

const EXPOSURE_SCHEMA = v.object({
  /** SHA-256 of the port token this preview URL carries. */
  tokenHash: v.string(),
  publishedAt: v.number(),
});

const REVOCATION_SCHEMA = v.object({ revokedBefore: v.number() });

function exposureKey(sandboxId: string, port: number): string {
  return `sandbox-preview:${sandboxId.toLowerCase()}:${String(port)}`;
}

function revocationKey(sandboxId: string): string {
  return `sandbox-preview-revoked:${sandboxId.toLowerCase()}`;
}

/** The label a preview request carries, as the edge parsed it. */
export interface SandboxPreviewClaim {
  readonly sandboxId: string;
  readonly port: number;
  readonly token: string;
}

/**
 * Whether this deployment published the exposure a preview hostname claims.
 *
 * Both reads are issued together: the record proves the exposure, the watermark
 * withdraws every record of a workspace that has since been destroyed.
 *
 * A record stamped in the SAME millisecond as the watermark reads as revoked.
 * That is the fail-closed side of the tie: an exposure published as its
 * workspace was being destroyed must not survive the destruction, and the cost
 * is that a workspace re-exposing a port inside the same millisecond has to
 * publish again.
 */
export async function sandboxPreviewExposed(
  kv: KvStore,
  claim: SandboxPreviewClaim,
): Promise<boolean> {
  const [exposure, revocation] = await Promise.all([
    readKvJson(kv, exposureKey(claim.sandboxId, claim.port), EXPOSURE_SCHEMA),
    readKvJson(kv, revocationKey(claim.sandboxId), REVOCATION_SCHEMA),
  ]);
  if (exposure === null) return false;
  if (revocation !== null && exposure.publishedAt <= revocation.revokedBefore) return false;
  return timingSafeEqual(exposure.tokenHash, await sha256Hex(claim.token));
}

/**
 * The writer for one container's exposures.
 *
 * Held by the executor lane the workspace's own Durable Object runs, so every
 * write is on an authenticated path: nothing reachable from the preview host
 * publishes anything.
 *
 * Every write consults the watermark, because the lane outlives the moment its
 * workspace is destroyed: `destroyAgent` writes the watermark and then spends
 * several awaits tearing the container object down, and a Ports listing or an
 * expose whose container call was already in flight runs in those gaps on the
 * same object. A record either would put back proves an exposure whose object
 * is gone, and the SDK's forward would create an empty one to answer it.
 */
export interface SandboxPreviewExposures {
  /** Record a port as exposed on `token`, replacing whatever it held. Throws
   *  once this writer's workspace has been destroyed: the URL the caller is
   *  about to hand out is one the edge refuses. */
  publish(port: number, token: string): Promise<void>;
  /** Re-observe an exposure the container still reports, writing only when the
   *  record is missing or halfway through its life, and never when the
   *  watermark has withdrawn it. */
  refresh(port: number, token: string): Promise<void>;
  /** Withdraw one port. The edge refuses it from the next read. */
  withdraw(port: number): Promise<void>;
  /** Withdraw every exposure of this container, without enumerating them: the
   *  watermark outranks every record published before now. For workspace
   *  destruction, where the object's own token store is about to be deleted and
   *  a surviving record would let a held URL re-create it. */
  revokeAll(): Promise<void>;
}

export function sandboxPreviewExposures(
  kv: KvStore,
  sandboxId: string,
): SandboxPreviewExposures {
  // When this writer came to be. A revocation stamped at or after it was
  // written by this writer's own workspace being destroyed, since only that
  // workspace's object writes one: every later write from here belongs to an
  // incarnation that no longer exists. A recreated same-name workspace builds a
  // new writer after the destroy finished, so it publishes again. The tie is
  // fail-closed, the same side `sandboxPreviewExposed` takes.
  const born = Date.now();
  const readRevocation = (): Promise<{ revokedBefore: number } | null> =>
    readKvJson(kv, revocationKey(sandboxId), REVOCATION_SCHEMA);
  const write = async (port: number, token: string): Promise<void> => {
    const now = Date.now();
    await writeKvJson(
      kv,
      exposureKey(sandboxId, port),
      { tokenHash: await sha256Hex(token), publishedAt: now },
      now + PREVIEW_EXPOSURE_TTL_MS,
    );
  };
  return {
    async publish(port, token) {
      const revocation = await readRevocation();
      if (revocation !== null && revocation.revokedBefore >= born) {
        throw new Error(`sandbox previews for ${sandboxId} were revoked: the workspace is being destroyed`);
      }
      await write(port, token);
    },
    async refresh(port, token) {
      const [held, revocation] = await Promise.all([
        readKvJson(kv, exposureKey(sandboxId, port), EXPOSURE_SCHEMA),
        readRevocation(),
      ]);
      // Under a watermark, the only record worth keeping alive is one
      // published after it. A withdrawn record, or none at all, means the
      // exposure the container reports is not one this projection vouches
      // for, and re-observing it must not make it so.
      if (revocation !== null
        && (revocation.revokedBefore >= born
          || held === null
          || held.publishedAt <= revocation.revokedBefore)) return;
      if (held !== null
        && held.publishedAt > Date.now() - REFRESH_AFTER_MS
        && timingSafeEqual(held.tokenHash, await sha256Hex(token))) return;
      await write(port, token);
    },
    async withdraw(port) {
      await kv.delete(exposureKey(sandboxId, port));
    },
    async revokeAll() {
      const now = Date.now();
      await writeKvJson(
        kv,
        revocationKey(sandboxId),
        { revokedBefore: now },
        now + PREVIEW_EXPOSURE_TTL_MS,
      );
    },
  };
}
