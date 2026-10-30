// A snapshot is two tags on one manifest in some repository of the account's registry; the API has no delete (D65).
// The one authority for that lifecycle: a box's dead snapshots, retired goldens, and every snapshot an application
// made, which the fixtures and reset delete when they delete the application.
import { createHash } from 'node:crypto';
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { DevboxError, attempt, settle } from './errors';

/** A box's own lineage wakes for this long from its root, a golden for this long from its last renewal. */
export const SNAPSHOT_LIFE_MS = 29 * 24 * 60 * 60 * 1000;

/** A snapshot owed a deletion, from when: a box's dead lineage at once, a retired golden once nothing can wake on it. */
export const OwedSchema = v.object({ ref: v.string(), at: v.number() });

export type Owed = v.InferOutput<typeof OwedSchema>;

/** One owner's deletion debt, as it keeps it. */
export interface Debt {
  readonly read: () => readonly Owed[];
  readonly write: (owed: readonly Owed[]) => void;
  /** Deletes `ref`, telling `owe` the manifest's digest before any tag goes; undefined with no authority to delete. */
  readonly delete: (ref: string, owe: (digest: string) => void) => Promise<SnapshotDeletion> | undefined;
  readonly now: () => number;
  /** What the log calls an entry: the dead snapshot, the retired golden. */
  readonly called: string;
}

/**
 * Every entry whose time has come, deleted or kept owed. Once its tags go a manifest is found by its digest alone, so
 * the debt becomes the digest before the first tag goes: a delete cut off midway still owes what is left. A refusal is
 * logged in the registry's words and waits for the next payment.
 */
export async function payDebt(debt: Debt): Promise<void> {
  const now = debt.now();

  for (const due of debt.read().filter((owed) => owed.at <= now)) {
    let owing = due.ref;

    const pending = debt.delete(due.ref, (digest) => {
      debt.write(debt.read().map((owed) => owed.ref === owing ? { ...owed, ref: digest } : owed));
      owing = digest;
    });

    if (pending === undefined) return;
    const outcome = await pending;

    if (outcome.kind === 'refused') console.error(`[devbox] ${debt.called} ${due.ref} was not deleted: ${outcome.reason}`);
    const kept = outcome.kind === 'refused' ? [{ ...due, ref: outcome.left ?? owing }] : [];

    debt.write(debt.read().flatMap((owed) => owed.ref === owing ? kept : [owed]));
  }
}

/** `left`: the manifest's digest, once its tags are gone and its own delete was refused; delete that next time. */
export type SnapshotDeletion = { readonly kind: 'deleted' | 'absent' } | { readonly kind: 'refused'; readonly reason: string; readonly left?: string };

/** What deleting an application's snapshots did: how many went, and the digests still listed for it after, which an
 *  empty list proves none are. */
export type ApplicationSweep = { readonly kind: 'swept'; readonly deleted: number; readonly left: readonly string[] } | { readonly kind: 'refused'; readonly reason: string };

export interface SnapshotRegistry {
  /** A snapshot id, or a manifest digest (`sha256:…`) an earlier delete left. `owe` hears the manifest's digest before
   *  any tag goes: once they are gone the id finds nothing, so a delete cut off after them is owed as the digest. */
  delete(ref: string, owe?: (digest: string) => void): Promise<SnapshotDeletion>;
  /** Every snapshot the application made, in any repository, a child before its parent; deleting the application
   *  leaves them all. */
  deleteApplication(applicationId: string): Promise<ApplicationSweep>;
}

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Manifest = v.pipe(v.string(), v.parseJson(), v.object({ annotations: v.optional(v.record(v.string(), v.string()), {}) }));

const Catalog = v.object({ repositories: v.record(v.string(), v.nullable(v.array(v.string()))) });

/** A manifest with a config; an image index has none and is no snapshot. */
const Configured = v.object({ config: v.object({ digest: v.string() }) });

/** A snapshot's config, which names its id and its application; an image's names neither. */
const SnapshotConfig = v.object({
  application_id: v.pipe(v.string(), v.minLength(1)), snapshot_id: v.pipe(v.string(), v.minLength(1)),
  snapshot_set_id: v.optional(v.string(), ''), parent_snapshot_id: v.optional(v.string(), ''),
});

/** A snapshot manifest found by its config. */
interface Found {
  readonly repository: string;
  readonly digest: string;
  readonly snapshot: string;
  readonly set: string;
  readonly parent: string;
}

const bare = (id: string): string => id.replaceAll('-', '');

const ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

const CATALOG = 'https://registry.cloudflare.com/v2/_catalog?tags=true';

/** The catalog answers a page of names across repositories, so a snapshot past the first is on a later one. */
const CATALOG_PAGES = 100;

/**
 * Calls asked before an endpoint's own failure (429 or 5xx) is the answer. The credentials endpoint answered 500 to one
 * of a staging run's cleanup mints (2026-10-22, request 132bf737-f395-434e-a2ee-cd6165d4f377) and the catalog 500 to
 * one listing (staging b347e7dd4, 2026-10-30), each while every other call of the run answered; a cleanup that left a
 * snapshot for it kept the run's bucket and failed the tier. A 4xx is the caller's, and final.
 */
const ATTEMPTS = 3;

/** Between calls an endpoint refused for itself. */
const RETRY_MS = 2_000;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The next page's cursor: the registry's link names it as `last`, without the angle brackets RFC 8288 gives it. */
const nextCursor = (link: string | null): string | undefined => /[?&]last=([^&;>\s]+)/.exec(link ?? '')?.[1];

/** `wait`: the pause between calls an endpoint refused for itself, a timer unless a test passes its own. */
export function snapshotRegistry(input: {
  readonly token: string;
  readonly account: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly wait?: (ms: number) => Promise<void>;
}): SnapshotRegistry {
  const { account } = input;
  const wait = input.wait ?? (async (ms: number) => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });

  /** One call, asked again while the endpoint refuses for itself, up to ATTEMPTS. */
  const call = (doing: string, url: string, init: RequestInit, asked = 1): Effect.Effect<Response, DevboxError> => Effect.gen(function* () {
    const answered = yield* attempt('io', () => input.fetch(url, init), doing);

    if ((answered.status === 429 || answered.status >= 500) && asked < ATTEMPTS) {
      yield* attempt('io', () => wait(RETRY_MS));

      return yield* call(doing, url, init, asked + 1);
    }

    return answered;
  });

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

  /** The catalog page by page, each repository's names handed to `visit` until it answers `stop`. */
  const walk = (authorization: string, visit: (repository: string, names: readonly string[]) => 'stop' | 'more') => Effect.gen(function* () {
    let cursor: string | undefined;

    for (let page = 0; page < CATALOG_PAGES; page += 1) {
      const listed = yield* call('listing the registry', cursor === undefined ? CATALOG : `${CATALOG}&last=${cursor}`, { headers: { authorization } });
      const catalog = v.safeParse(Catalog, yield* attempt('io', () => listed.json()));

      if (!catalog.success) return yield* Effect.fail(new DevboxError('refused', `listing the registry answered ${String(listed.status)}`));

      if (Object.entries(catalog.output.repositories).some(([repository, names]) => visit(repository, names ?? []) === 'stop')) return;
      const next = nextCursor(listed.headers.get('link'));

      if (next === undefined || next === cursor) return;
      cursor = next;
    }

    return yield* Effect.fail(new DevboxError('refused', `the registry's catalog ran past ${String(CATALOG_PAGES)} pages`));
  });

  /** The repository whose catalog entry lists `name`, a tag or a digest. */
  const repositoryOf = (authorization: string, name: string) => Effect.gen(function* () {
    let found: string | undefined;

    yield* walk(authorization, (repository, names) => {
      if (names.includes(name)) found = repository;

      return found === undefined ? 'more' : 'stop';
    });

    return found;
  });

  /** Every snapshot manifest `applicationId` made, told by its config, in any repository: tagged, or a digest alone. */
  const snapshotsOf = (authorization: string, applicationId: string) => Effect.gen(function* () {
    const digests: { readonly repository: string; readonly digest: string }[] = [];

    yield* walk(authorization, (repository, names) => {
      for (const name of names) if (name.startsWith('sha256:')) digests.push({ repository, digest: name });

      return 'more';
    });

    const found: Found[] = [];

    for (const { repository, digest } of digests) {
      const read = yield* call('reading a manifest', `https://registry.cloudflare.com/v2/${repository}/manifests/${digest}`, { headers: { authorization, accept: ACCEPT } });
      const manifest = read.ok ? v.safeParse(Configured, yield* attempt('io', () => read.json())) : undefined;

      if (manifest?.success !== true) continue;
      const blob = yield* call('reading a manifest\'s config', `https://registry.cloudflare.com/v2/${repository}/blobs/${manifest.output.config.digest}`, { headers: { authorization } });
      const config = v.safeParse(SnapshotConfig, yield* attempt('io', () => blob.json()));

      if (config.success && bare(config.output.application_id) === bare(applicationId)) {
        found.push({ repository, digest, snapshot: config.output.snapshot_id, set: config.output.snapshot_set_id, parent: config.output.parent_snapshot_id });
      }
    }

    return found;
  });

  const deleting = (authorization: string, url: string, what: string) => Effect.gen(function* () {
    const deleted = yield* call(`deleting ${what}`, url, { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

    if (!deleted.ok && deleted.status !== 404) {
      return yield* Effect.fail(new DevboxError('refused', `deleting ${what} answered ${String(deleted.status)}: ${yield* attempt('io', () => deleted.text())}`));
    }
  });

  /** A snapshot's tags, its set tag first and its snapshot tag last, so a refusal between leaves it findable by id. */
  const tagsOf = (snapshot: string, set: string | undefined): readonly string[] => [...set === undefined || set === '' ? [] : [`rootfs-set-${sha256(set)}`], `rootfs-snapshot-${sha256(snapshot)}`];

  /** An application's snapshots, children first: a parent a child still restores from goes after it. */
  const sweep = (applicationId: string): Effect.Effect<ApplicationSweep, DevboxError> => Effect.gen(function* () {
    const authorization = yield* credentials;
    const found = yield* snapshotsOf(authorization, applicationId);
    const byId = new Map(found.map((each) => [each.snapshot, each]));
    const depth = (each: Found, seen = 0): number => (seen < found.length && byId.has(each.parent) ? 1 + depth(byId.get(each.parent) ?? each, seen + 1) : 0);

    for (const each of [...found].sort((left, right) => depth(right) - depth(left))) {
      const manifest = (name: string) => `https://registry.cloudflare.com/v2/${each.repository}/manifests/${name}`;

      for (const tag of [...tagsOf(each.snapshot, each.set), each.digest]) yield* deleting(authorization, manifest(tag), tag);
    }

    return { kind: 'swept', deleted: found.length, left: (yield* snapshotsOf(authorization, applicationId)).map((each) => each.digest) };
  });

  /** A manifest is deleted by its digest, and only once no tag names it: the registry answers 204 to a tagged one and
   *  keeps it. The snapshot tag goes last of the tags, so a refusal before it leaves the snapshot findable by id. */
  const remove = (ref: string, owe: (digest: string) => void): Effect.Effect<SnapshotDeletion, DevboxError> => Effect.gen(function* () {
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

    owe(digest);

    for (const tag of tagsOf(ref, set)) yield* deleting(authorization, manifest(tag), tag);

    const freed = yield* Effect.result(deleting(authorization, manifest(digest), digest));

    return Result.isSuccess(freed) ? { kind: 'deleted' } : { kind: 'refused', reason: freed.failure.message, left: digest };
  });

  return {
    delete: (ref, owe = () => {}) => settle(remove(ref, owe).pipe(Effect.catchTag('DevboxError', (failure) => Effect.succeed<SnapshotDeletion>({ kind: 'refused', reason: failure.message })))),
    deleteApplication: (applicationId) => settle(sweep(applicationId).pipe(Effect.catchTag('DevboxError', (failure) => Effect.succeed<ApplicationSweep>({ kind: 'refused', reason: failure.message })))),
  };
}
