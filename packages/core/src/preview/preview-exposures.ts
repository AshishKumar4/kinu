// KV projection of published sandbox previews: `proxyToSandbox` creates the Durable Object before checking the
// token, so the edge must prove the label was published without touching any per-name object. Tokens stored hashed.
//
// Only a publish establishes an exposure: a listing of the container is no authority, so it keeps a published record
// alive and never creates one. A withdrawal deletes the record, which only a later publish recreates, whatever the
// container still reports and however long its own revoke stays undone. A withdrawal mark, of one port or of the whole
// sandbox, outranks every generation at or before it, so a listing in flight across the withdrawal does not renew the
// record it read before.

import { Effect } from 'effect';
import { settle } from '../obs/effect';
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
  /** When a listing last kept it alive; its generation stays `publishedAt`. */
  refreshedAt: v.optional(v.number()),
  /** The owner made it a public link: anyone holding the URL opens it, signed in or not. A publish never sets it. */
  public: v.optional(v.literal(true)),
});

type Exposure = v.InferOutput<typeof EXPOSURE_SCHEMA>;

const REVOCATION_SCHEMA = v.object({ revokedBefore: v.number() });

function exposureKey(sandboxId: string, port: number): string {
  return `sandbox-preview:${sandboxId.toLowerCase()}:${String(port)}`;
}

function revocationKey(sandboxId: string): string {
  return `sandbox-preview-revoked:${sandboxId.toLowerCase()}`;
}

function withdrawalKey(sandboxId: string, port: number): string {
  return `sandbox-preview-withdrawn:${sandboxId.toLowerCase()}:${String(port)}`;
}

/** The latest withdrawal over this port: the sandbox's, or the port's own. */
async function withdrawnBefore(kv: KvStore, sandboxId: string, port: number): Promise<number | null> {
  const marks = await Promise.all([
    readKvJson(kv, revocationKey(sandboxId), REVOCATION_SCHEMA),
    readKvJson(kv, withdrawalKey(sandboxId, port), REVOCATION_SCHEMA),
  ]);

  const at = marks.flatMap((mark) => (mark === null ? [] : [mark.revokedBefore]));

  return at.length === 0 ? null : Math.max(...at);
}

export interface SandboxPreviewClaim {
  readonly sandboxId: string;
  readonly port: number;
  readonly token: string;
}

/**
 * The published exposure `claim` names, and whether its owner made it public; null for one never published, withdrawn
 * or under another token. A record stamped in the same millisecond as the revocation watermark reads as revoked (fail
 * closed).
 */
export async function sandboxPreviewExposure(
  kv: KvStore,
  claim: SandboxPreviewClaim,
): Promise<{ readonly public: boolean } | null> {
  const [exposure, withdrawn] = await Promise.all([
    readKvJson(kv, exposureKey(claim.sandboxId, claim.port), EXPOSURE_SCHEMA),
    withdrawnBefore(kv, claim.sandboxId, claim.port),
  ]);

  if (exposure === null) return null;

  if (withdrawn !== null && exposure.publishedAt <= withdrawn) return null;

  return timingSafeEqual(exposure.tokenHash, await sha256Hex(claim.token)) ? { public: exposure.public === true } : null;
}

export async function sandboxPreviewExposed(kv: KvStore, claim: SandboxPreviewClaim): Promise<boolean> {
  return (await sandboxPreviewExposure(kv, claim)) !== null;
}

/** Authenticated-path writer. Every write checks the watermark: in-flight calls during `destroyAgent` must
 *  not restore a record whose object is gone. */
export interface SandboxPreviewExposures {
  /** Throws once this writer's workspace has been destroyed. */
  publish(port: number, token: string): Promise<void>;
  /** Keeps a published exposure a listing still reports alive: rewritten past half-life, at its own generation. Never
   *  creates one. */
  refresh(port: number, token: string): Promise<void>;
  /** Outranks every generation of this port so far; only a later publish exposes it again. */
  withdraw(port: number): Promise<void>;
  /** What the edge answers for this sandbox's label: {@link sandboxPreviewExposed}. */
  exposed(port: number, token: string): Promise<boolean>;
  /** Whether the port's published preview is a public link, or opens only for the workspace's owner; null, unpublished. */
  isPublic(port: number): Promise<boolean | null>;
  /** Makes the port's published preview a public link, or its owner's alone again; false when none is published. */
  setPublic(port: number, open: boolean): Promise<boolean>;
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

  const write = async (port: number, exposure: Exposure): Promise<void> => {
    await writeKvJson(kv, exposureKey(sandboxId, port), { ...exposure, refreshedAt: Date.now() }, PREVIEW_EXPOSURE_TTL_MS);
  };

  /** The port's record as it stands for this writer: none once withdrawn, or once its workspace was destroyed. */
  const live = async (port: number): Promise<Exposure | null> => {
    const [held, withdrawn, revocation] = await Promise.all([
      readKvJson(kv, exposureKey(sandboxId, port), EXPOSURE_SCHEMA),
      withdrawnBefore(kv, sandboxId, port),
      readRevocation(),
    ]);

    if (held === null || (revocation !== null && revocation.revokedBefore >= born) || (withdrawn !== null && held.publishedAt <= withdrawn)) return null;

    return held;
  };

  return {
    publish(port, token) {
      return settle(Effect.gen(function* () {
        const revocation = yield* Effect.promise(() => readRevocation());

        if (revocation !== null && revocation.revokedBefore >= born) {
          return yield* Effect.die(new Error(`sandbox previews for ${sandboxId} were revoked: the workspace is being destroyed`));
        }

        // A new publication opens for the owner alone, whatever an earlier one of this port was.
        yield* Effect.promise(async () => write(port, { tokenHash: await sha256Hex(token), publishedAt: Date.now() }));
      }));
    },
    async refresh(port, token) {
      const held = await live(port);

      // Nothing published it, its token is not this one, or it was withdrawn since: a listing vouches for nothing.
      if (held === null || !timingSafeEqual(held.tokenHash, await sha256Hex(token))) return;

      if ((held.refreshedAt ?? held.publishedAt) > Date.now() - REFRESH_AFTER_MS) return;
      await write(port, held);
    },
    async isPublic(port) {
      const held = await live(port);

      return held === null ? null : held.public === true;
    },
    async setPublic(port, open) {
      const held = await live(port);

      if (held === null) return false;
      await write(port, { tokenHash: held.tokenHash, publishedAt: held.publishedAt, ...(open && { public: true as const }) });

      return true;
    },
    async withdraw(port) {
      await writeKvJson(kv, withdrawalKey(sandboxId, port), { revokedBefore: Date.now() }, PREVIEW_EXPOSURE_TTL_MS);
      await kv.delete(exposureKey(sandboxId, port));
    },
    exposed: (port, token) => sandboxPreviewExposed(kv, { sandboxId, port, token }),
    async revokeAll() {
      const now = Date.now();
      await writeKvJson(
        kv,
        revocationKey(sandboxId),
        { revokedBefore: now },
        PREVIEW_EXPOSURE_TTL_MS,
      );
    },
  };
}
