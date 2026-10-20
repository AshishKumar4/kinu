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
  /** This publication, by a name no other has, even one in the same millisecond; what a public mark names. */
  publication: v.optional(v.string()),
});

type Exposure = v.InferOutput<typeof EXPOSURE_SCHEMA>;

/**
 * The owner made one publication a public link, named by its `publication`: anyone holding the URL opens it. A key of
 * its own, so a listing's refresh, which rewrites the exposure from what it read, never writes the owner's decision
 * back over a later one; and a new publication of the port is never public by an old mark.
 */
const PUBLIC_SCHEMA = v.object({ publication: v.string() });

function marked(exposure: Exposure, mark: v.InferOutput<typeof PUBLIC_SCHEMA> | null): boolean {
  return exposure.publication !== undefined && mark?.publication === exposure.publication;
}

/** Longer than any publication lives between refreshes: a mark outlasts its exposure, never the other way round. */
const PUBLIC_MARK_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** The key families a sandbox's ports are recorded under, each `<family>:<sandbox>:<port>`. */
const PORT_FAMILIES = { exposure: 'sandbox-preview', public: 'sandbox-preview-public', withdrawal: 'sandbox-preview-withdrawn' } as const;

function portPrefix(family: keyof typeof PORT_FAMILIES, sandboxId: string): string {
  return `${PORT_FAMILIES[family]}:${sandboxId.toLowerCase()}:`;
}

function publicKey(sandboxId: string, port: number): string {
  return `${portPrefix('public', sandboxId)}${String(port)}`;
}

const REVOCATION_SCHEMA = v.object({ revokedBefore: v.number() });

function exposureKey(sandboxId: string, port: number): string {
  return `${portPrefix('exposure', sandboxId)}${String(port)}`;
}

function revocationKey(sandboxId: string): string {
  return `sandbox-preview-revoked:${sandboxId.toLowerCase()}`;
}

function withdrawalKey(sandboxId: string, port: number): string {
  return `${portPrefix('withdrawal', sandboxId)}${String(port)}`;
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
  const [exposure, withdrawn, mark] = await Promise.all([
    readKvJson(kv, exposureKey(claim.sandboxId, claim.port), EXPOSURE_SCHEMA),
    withdrawnBefore(kv, claim.sandboxId, claim.port),
    readKvJson(kv, publicKey(claim.sandboxId, claim.port), PUBLIC_SCHEMA),
  ]);

  if (exposure === null) return null;

  if (withdrawn !== null && exposure.publishedAt <= withdrawn) return null;

  return timingSafeEqual(exposure.tokenHash, await sha256Hex(claim.token)) ? { public: marked(exposure, mark) } : null;
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
  /** Whether the edge admits this sandbox's label at all ({@link sandboxPreviewExposure}). */
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
        yield* Effect.promise(async () => write(port, { tokenHash: await sha256Hex(token), publishedAt: Date.now(), publication: crypto.randomUUID() }));
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
      const [held, mark] = await Promise.all([live(port), readKvJson(kv, publicKey(sandboxId, port), PUBLIC_SCHEMA)]);

      return held === null ? null : marked(held, mark);
    },
    async setPublic(port, open) {
      const held = await live(port);

      // A publication from before marks were named is the owner's alone until the port is exposed again.
      if (held?.publication === undefined) return false;

      if (open) await writeKvJson(kv, publicKey(sandboxId, port), { publication: held.publication }, PUBLIC_MARK_TTL_MS);
      else await kv.delete(publicKey(sandboxId, port));

      return true;
    },
    async withdraw(port) {
      await writeKvJson(kv, withdrawalKey(sandboxId, port), { revokedBefore: Date.now() }, PREVIEW_EXPOSURE_TTL_MS);
      await kv.delete(exposureKey(sandboxId, port));
      await kv.delete(publicKey(sandboxId, port));
    },
    exposed: async (port, token) => (await sandboxPreviewExposure(kv, { sandboxId, port, token })) !== null,
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

/** A KV namespace that lists its keys, as Cloudflare's does. */
export interface ListedKv extends KvStore {
  list(options: { readonly prefix: string }): Promise<{ readonly keys: readonly { readonly name: string }[] }>;
}

/**
 * A deleted workspace's preview records, deleted: its exposures, public marks and withdrawals, every port. The
 * revocation watermark (`revokeAll`) stays until it expires, a time alone, so a write still in flight publishes nothing.
 */
export async function forgetSandboxPreviews(kv: ListedKv, sandboxId: string): Promise<void> {
  for (const prefix of (['exposure', 'public', 'withdrawal'] as const).map((family) => portPrefix(family, sandboxId))) {
    for (let page = await kv.list({ prefix }); page.keys.length > 0; page = await kv.list({ prefix })) {
      for (const { name } of page.keys) await kv.delete(name);
    }
  }
}
