// A snapshot is two tags on one manifest in some repository of the account's registry; the API has no delete (D65).
import { createHash } from 'node:crypto';
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt, settle } from './errors';

/** `left`: the manifest's digest, once its tags are gone and its own delete was refused; delete that next time. */
export type SnapshotDeletion = { readonly kind: 'deleted' | 'absent' } | { readonly kind: 'refused'; readonly reason: string; readonly left?: string };

export interface SnapshotRegistry {
  /** A snapshot id, or a manifest digest (`sha256:…`) an earlier delete left. */
  delete(ref: string): Promise<SnapshotDeletion>;
}

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Manifest = v.pipe(v.string(), v.parseJson(), v.object({ annotations: v.optional(v.record(v.string(), v.string()), {}) }));

const Catalog = v.object({ repositories: v.record(v.string(), v.nullable(v.array(v.string()))) });

const ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

const CATALOG = 'https://registry.cloudflare.com/v2/_catalog?tags=true';

/** The catalog answers a page of names across repositories, so a snapshot past the first is on a later one. */
const CATALOG_PAGES = 100;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The next page's cursor: the registry's link names it as `last`, without the angle brackets RFC 8288 gives it. */
const nextCursor = (link: string | null): string | undefined => /[?&]last=([^&;>\s]+)/.exec(link ?? '')?.[1];

export function snapshotRegistry(input: {
  readonly token: string;
  readonly account: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): SnapshotRegistry {
  const { account } = input;

  const call = (doing: string, url: string, init: RequestInit) => attempt('io', () => input.fetch(url, init), doing);

  const credentials = Effect.gen(function* () {
    const minted = yield* call('minting registry credentials', `https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`, {
      method: 'POST', headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expiration_minutes: 5, permissions: ['pull', 'push'] }),
    });

    const answer = v.safeParse(Minted, yield* attempt('io', () => minted.json()));

    if (!answer.success || !answer.output.success || answer.output.result == null) {
      const words = answer.success ? answer.output.errors.map((error) => error.message).join('; ') : 'an unreadable answer';

      return yield* Effect.fail(new DevboxError('refused', `minting registry credentials answered ${String(minted.status)}: ${words}`));
    }

    return `Basic ${btoa(`${answer.output.result.username}:${answer.output.result.password}`)}`;
  });

  /** The repository whose catalog entry lists `name`, a tag or a digest, page by page. */
  const repositoryOf = (authorization: string, name: string) => Effect.gen(function* () {
    let cursor: string | undefined;

    for (let page = 0; page < CATALOG_PAGES; page += 1) {
      const listed = yield* call('listing the registry', cursor === undefined ? CATALOG : `${CATALOG}&last=${cursor}`, { headers: { authorization } });
      const catalog = v.safeParse(Catalog, yield* attempt('io', () => listed.json()));

      if (!catalog.success) return yield* Effect.fail(new DevboxError('refused', `listing the registry answered ${String(listed.status)}`));
      const found = Object.entries(catalog.output.repositories).find(([, names]) => names?.includes(name) === true)?.[0];
      const next = nextCursor(listed.headers.get('link'));

      if (found !== undefined || next === undefined || next === cursor) return found;
      cursor = next;
    }

    return yield* Effect.fail(new DevboxError('refused', `the registry's catalog ran past ${String(CATALOG_PAGES)} pages`));
  });

  const deleting = (authorization: string, url: string, what: string) => Effect.gen(function* () {
    const deleted = yield* call(`deleting ${what}`, url, { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

    if (!deleted.ok && deleted.status !== 404) {
      return yield* Effect.fail(new DevboxError('refused', `deleting ${what} answered ${String(deleted.status)}: ${yield* attempt('io', () => deleted.text())}`));
    }
  });

  /** A manifest is deleted by its digest, and only once no tag names it: the registry answers 204 to a tagged one and
   *  keeps it. The snapshot tag goes last of the tags, so a refusal before it leaves the snapshot findable by id. */
  const remove = (ref: string): Effect.Effect<SnapshotDeletion, DevboxError> => Effect.gen(function* () {
    const authorization = yield* credentials;

    if (ref.startsWith('sha256:')) {
      const repository = yield* repositoryOf(authorization, ref);

      if (repository === undefined) return { kind: 'absent' };
      yield* deleting(authorization, `https://registry.cloudflare.com/v2/${repository}/manifests/${ref}`, ref);

      return { kind: 'deleted' };
    }

    const snapshot = `rootfs-snapshot-${sha256(ref)}`;
    const repository = yield* repositoryOf(authorization, snapshot);

    if (repository === undefined) return { kind: 'absent' };
    const manifest = (name: string) => `https://registry.cloudflare.com/v2/${repository}/manifests/${name}`;
    const read = yield* call('reading the snapshot\'s manifest', manifest(snapshot), { headers: { authorization, accept: ACCEPT } });

    if (read.status === 404) return { kind: 'absent' };

    if (!read.ok) return yield* Effect.fail(new DevboxError('refused', `reading ${snapshot} answered ${String(read.status)}: ${yield* attempt('io', () => read.text())}`));
    const body = yield* attempt('io', () => read.text());
    const digest = read.headers.get('docker-content-digest') ?? `sha256:${sha256(body)}`;
    // An unreadable body has no set tag to find; its snapshot tag and digest still go.
    const parsed = v.safeParse(Manifest, body);
    const set = parsed.success ? parsed.output.annotations['io.cloudflare.cloudchamber.snapshot_set_id'] : undefined;

    for (const tag of set === undefined ? [snapshot] : [`rootfs-set-${sha256(set)}`, snapshot]) yield* deleting(authorization, manifest(tag), tag);

    const freed = yield* Effect.result(deleting(authorization, manifest(digest), digest));

    return Result.isSuccess(freed) ? { kind: 'deleted' } : { kind: 'refused', reason: freed.failure.message, left: digest };
  });

  return {
    delete: (ref) => settle(remove(ref).pipe(Effect.catchTag('DevboxError', (failure) => Effect.succeed<SnapshotDeletion>({ kind: 'refused', reason: failure.message })))),
  };
}
