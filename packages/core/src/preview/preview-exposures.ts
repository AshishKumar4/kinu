// KV projection of published sandbox previews: `proxyToSandbox` creates the Durable Object before checking the
// token, so the edge must prove the label was published without touching any per-name object. Tokens stored hashed.

import * as v from 'valibot';
import { timingSafeEqual } from '../utils/crypto';
import { sha256Hex } from '../safety/argument-digest';
import { readKvJson, writeKvJson, type KvStore } from '@kinu.run/agent-utils';

/** Staleness bound, longer than any container lifetime; equal to `SESSION_TTL_MS` by coincidence, not policy. */
const PREVIEW_EXPOSURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const REFRESH_AFTER_MS = PREVIEW_EXPOSURE_TTL_MS / 2;

const EXPOSURE_SCHEMA = v.object({
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

export interface SandboxPreviewClaim {
  readonly sandboxId: string;
  readonly port: number;
  readonly token: string;
}

/** A record stamped in the same millisecond as the revocation watermark reads as revoked (fail closed). */
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

/** Authenticated-path writer. Every write checks the watermark: in-flight calls during `destroyAgent` must
 *  not restore a record whose object is gone. */
export interface SandboxPreviewExposures {
  /** Throws once this writer's workspace has been destroyed. */
  publish(port: number, token: string): Promise<void>;
  /** Writes only when missing or past half-life, never under a withdrawing watermark. */
  refresh(port: number, token: string): Promise<void>;
  withdraw(port: number): Promise<void>;
  /** What the edge answers for this sandbox's label: {@link sandboxPreviewExposed}. */
  exposed(port: number, token: string): Promise<boolean>;
  /** Watermark outranking every earlier record; used on workspace destruction. */
  revokeAll(): Promise<void>;
}

export function sandboxPreviewExposures(
  kv: KvStore,
  sandboxId: string,
): SandboxPreviewExposures {
  // A revocation at or after `born` means this writer's own workspace was destroyed (tie fails closed).
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

      // Under a watermark, re-observation must not vouch for a withdrawn or missing record.
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
    exposed: (port, token) => sandboxPreviewExposed(kv, { sandboxId, port, token }),
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
