// A snapshot is two tags in some repository of the account's registry; the API has no delete (D65).
import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt, settle } from './errors';

export type SnapshotDeletion = { readonly kind: 'deleted' | 'absent' } | { readonly kind: 'refused'; readonly reason: string };

export interface SnapshotRegistry {
  delete(id: string): Promise<SnapshotDeletion>;
}

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Manifest = v.object({ annotations: v.optional(v.record(v.string(), v.string()), {}) });

const Catalog = v.object({ repositories: v.record(v.string(), v.nullable(v.array(v.string()))) });

const ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function snapshotRegistry(input: {
  readonly token: string;
  readonly account: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): SnapshotRegistry {
  const { account } = input;

  const call = (doing: string, url: string, init: RequestInit) => attempt('io', () => input.fetch(url, init), doing);

  const remove = (id: string): Effect.Effect<SnapshotDeletion, DevboxError> => Effect.gen(function* () {
    const minted = yield* call('minting registry credentials', `https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`, {
      method: 'POST', headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expiration_minutes: 5, permissions: ['pull', 'push'] }),
    });

    const answer = v.safeParse(Minted, yield* attempt('io', () => minted.json()));

    if (!answer.success || !answer.output.success || answer.output.result == null) {
      const words = answer.success ? answer.output.errors.map((error) => error.message).join('; ') : 'an unreadable answer';

      return yield* Effect.fail(new DevboxError('refused', `minting registry credentials answered ${String(minted.status)}: ${words}`));
    }

    const authorization = `Basic ${btoa(`${answer.output.result.username}:${answer.output.result.password}`)}`;
    const snapshot = `rootfs-snapshot-${sha256(id)}`;
    const listed = yield* call('listing the registry', 'https://registry.cloudflare.com/v2/_catalog?tags=true', { headers: { authorization } });
    const catalog = v.safeParse(Catalog, yield* attempt('io', () => listed.json()));

    if (!catalog.success) return yield* Effect.fail(new DevboxError('refused', `listing the registry answered ${String(listed.status)}`));
    const repository = Object.entries(catalog.output.repositories).find(([, tags]) => tags?.includes(snapshot) === true)?.[0];

    if (repository === undefined) return { kind: 'absent' };
    const manifest = (tag: string) => `https://registry.cloudflare.com/v2/${repository}/manifests/${tag}`;
    const read = yield* call('reading the snapshot\'s manifest', manifest(snapshot), { headers: { authorization, accept: ACCEPT } });

    if (read.status === 404) return { kind: 'absent' };

    if (!read.ok) return yield* Effect.fail(new DevboxError('refused', `reading ${snapshot} answered ${String(read.status)}: ${yield* attempt('io', () => read.text())}`));
    const parsed = v.safeParse(Manifest, yield* attempt('io', () => read.json()));
    const set = parsed.success ? parsed.output.annotations['io.cloudflare.cloudchamber.snapshot_set_id'] : undefined;

    for (const tag of set === undefined ? [snapshot] : [snapshot, `rootfs-set-${sha256(set)}`]) {
      const deleted = yield* call(`deleting ${tag}`, manifest(tag), { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

      if (!deleted.ok && deleted.status !== 404) {
        return yield* Effect.fail(new DevboxError('refused', `deleting ${tag} answered ${String(deleted.status)}: ${yield* attempt('io', () => deleted.text())}`));
      }
    }

    return { kind: 'deleted' };
  });

  return {
    delete: (id) => settle(remove(id).pipe(Effect.catchTag('DevboxError', (failure) => Effect.succeed<SnapshotDeletion>({ kind: 'refused', reason: failure.message })))),
  };
}
