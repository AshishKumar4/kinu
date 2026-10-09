/**
 * Every container snapshot an application made, found in the registry by the application its config names, and
 * deleted: the fixtures that deploy a throwaway application delete their snapshots with it.
 *
 * Deleting an application leaves its snapshots: 801 of the 923 orphans removed on 2026-10-09 were of deleted
 * applications, most deleted by these fixtures' teardowns. A snapshot is a manifest a snapshot tag and a set tag name,
 * in its image's own repository: `<account>/cloudchamber-snapshots/<digest>` for an application on Cloudflare's base
 * image, the image's repository for one on an image of ours (`<account>/kinu-devbox-native` held 313 snapshots of
 * deleted applications, 673 GB, on 2026-10-09). So a snapshot is told by its config, which names `snapshot_id` and
 * `application_id`, in any repository. The registry keeps a manifest any tag names, so the tags go first and then the
 * manifest by its digest (packages/devbox/src/snapshot-registry.ts). The catalog lists every manifest by its digest,
 * tagged or not, so a snapshot whose tags an earlier delete took is still found.
 */
import { createHash } from 'node:crypto';
import * as v from 'valibot';

const Minted = v.object({
  success: v.boolean(),
  errors: v.optional(v.array(v.object({ message: v.string() })), []),
  result: v.optional(v.nullable(v.object({ username: v.string(), password: v.string() }))),
});

const Catalog = v.object({ repositories: v.record(v.string(), v.nullable(v.array(v.string()))) });

/** An image index has no config: it is no snapshot. */
const Manifest = v.object({ config: v.object({ digest: v.string() }) });

/** A snapshot's config; an image's config names neither id, so it is none. */
const Config = v.object({
  application_id: v.pipe(v.string(), v.minLength(1)), snapshot_id: v.pipe(v.string(), v.minLength(1)),
  snapshot_set_id: v.optional(v.string(), ''), parent_snapshot_id: v.optional(v.string(), ''),
});

const ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';

const REGISTRY = 'https://registry.cloudflare.com/v2';

/** A bound on the catalog's pages, past any account's: 100,000 names. */
const CATALOG_PAGES = 100;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const bare = (id: string): string => id.replaceAll('-', '');

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface Found {
  readonly repository: string;
  readonly digest: string;
  readonly snapshot: string;
  readonly set: string;
  readonly parent: string;
}

async function credentials(account: string, token: string, fetcher: Fetch): Promise<string> {
  const minted = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ expiration_minutes: 30, permissions: ['pull', 'push'] }),
  });

  const answer = v.parse(Minted, await minted.json());

  if (!answer.success || answer.result == null) {
    throw new Error(`minting registry credentials answered ${String(minted.status)}: ${answer.errors.map((error) => error.message).join('; ')}`);
  }

  return `Basic ${btoa(`${answer.result.username}:${answer.result.password}`)}`;
}

/** Every repository's manifests by digest, page by page: the registry's link names the next page's cursor as `last`,
 *  without the angle brackets RFC 8288 gives a link. */
async function manifests(authorization: string, fetcher: Fetch): Promise<{ readonly repository: string; readonly digest: string }[]> {
  const found: { repository: string; digest: string }[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < CATALOG_PAGES; page += 1) {
    const listed = await fetcher(`${REGISTRY}/_catalog?tags=true${cursor === undefined ? '' : `&last=${cursor}`}`, { headers: { authorization } });
    const catalog = v.parse(Catalog, await listed.json());

    for (const [repository, names] of Object.entries(catalog.repositories)) {
      for (const name of names ?? []) if (name.startsWith('sha256:')) found.push({ repository, digest: name });
    }

    const next = /[?&]last=([^&;>\s]+)/u.exec(listed.headers.get('link') ?? '')?.[1];

    if (next === undefined || next === cursor) return found;
    cursor = next;
  }

  throw new Error(`the registry's catalog ran past ${String(CATALOG_PAGES)} pages`);
}

async function ofApplication(authorization: string, applicationId: string, fetcher: Fetch): Promise<Found[]> {
  const found: Found[] = [];

  for (const { repository, digest } of await manifests(authorization, fetcher)) {
    const read = await fetcher(`${REGISTRY}/${repository}/manifests/${digest}`, { headers: { authorization, accept: ACCEPT } });

    if (read.status === 404) continue;
    const manifest = v.safeParse(Manifest, await read.json());

    if (!manifest.success) continue;
    const config = v.safeParse(Config, await (await fetcher(`${REGISTRY}/${repository}/blobs/${manifest.output.config.digest}`, { headers: { authorization } })).json());

    if (!config.success || bare(config.output.application_id) !== bare(applicationId)) continue;
    found.push({ repository, digest, snapshot: config.output.snapshot_id, set: config.output.snapshot_set_id, parent: config.output.parent_snapshot_id });
  }

  return found;
}

/** Deletes every snapshot `applicationId` made, a child before its parent, and answers the digests still listed for it
 *  after: an empty list is the proof the application left none. */
export async function deleteApplicationSnapshots(input: {
  readonly account: string;
  readonly token: string;
  readonly applicationId: string;
  readonly fetch?: Fetch;
}): Promise<{ readonly deleted: number; readonly left: readonly string[] }> {
  const fetcher = input.fetch ?? ((request, init) => fetch(request, init));
  const authorization = await credentials(input.account, input.token, fetcher);
  const found = await ofApplication(authorization, input.applicationId, fetcher);
  const ids = new Set(found.map((each) => each.snapshot));
  const depth = (each: Found): number => (ids.has(each.parent) ? 1 + depth(found.find((other) => other.snapshot === each.parent) ?? each) : 0);
  let deleted = 0;

  for (const each of [...found].sort((left, right) => depth(right) - depth(left))) {
    const tags = [each.set === '' ? '' : `rootfs-set-${sha256(each.set)}`, each.snapshot === '' ? '' : `rootfs-snapshot-${sha256(each.snapshot)}`].filter((tag) => tag !== '');

    for (const ref of [...tags, each.digest]) {
      const answered = await fetcher(`${REGISTRY}/${each.repository}/manifests/${ref}`, { method: 'DELETE', headers: { authorization, accept: ACCEPT } });

      if (!answered.ok && answered.status !== 404) throw new Error(`deleting ${ref} answered ${String(answered.status)}: ${await answered.text()}`);
    }

    deleted += 1;
  }

  return { deleted, left: (await ofApplication(authorization, input.applicationId, fetcher)).map((each) => each.digest) };
}
