// A fixture's teardown deletes every snapshot its application made, against a registry with the semantics measured on
// 2026-10-09: the catalog pages its names and lists every manifest by digest, tagged or not, and a DELETE of a manifest
// a tag still names answers 204 and keeps it.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { deleteApplicationSnapshots } from './fixtures/application-snapshots';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const BASE = 'acct/cloudchamber-snapshots/base';

/** A manifest in `repository` (the base image's snapshots repository unless named): a snapshot of `app`, or, with
 *  `image`, an image whose config names no snapshot. */
interface Manifest { readonly id: string; readonly app: string; readonly parent: string; readonly tagged: boolean; readonly repository?: string; readonly image?: boolean }

function registry(entries: readonly Manifest[], pageSize = 3) {
  const repo = (each: Manifest) => each.repository ?? BASE;
  const digest = (id: string) => `sha256:${sha(`manifest-${id}`)}`;
  const manifests = new Map(entries.map((each) => [`${repo(each)}@${digest(each.id)}`, each]));
  const tags = new Map<string, string>();

  for (const each of entries.filter((one) => one.tagged)) {
    const names = each.image === true ? ['latest'] : [`rootfs-snapshot-${sha(each.id)}`, `rootfs-set-${sha(`set-${each.id}`)}`];

    for (const name of names) tags.set(`${repo(each)}:${name}`, digest(each.id));
  }

  const deleted: string[] = [];

  /** `repository<sep>name` split at its separator. */
  const split = (key: string, separator: string) => [key.slice(0, key.indexOf(separator)), key.slice(key.indexOf(separator) + 1)] as const;

  const catalog = (url: URL): Response => {
    const names = [['acct/other', 'x'] as const, ...[...tags.keys()].map((key) => split(key, ':')), ...[...manifests.keys()].map((key) => split(key, '@'))]
      .sort(([left, leftName], [right, rightName]) => left.localeCompare(right) || leftName.localeCompare(rightName));

    const last = url.searchParams.get('last');
    const from = last === null ? 0 : names.findIndex(([, name]) => name === last) + 1;
    const page = names.slice(from, from + pageSize);
    const repositories = new Map<string, string[]>();

    for (const [repository, name] of page) repositories.set(repository, [...repositories.get(repository) ?? [], name]);
    const more = from + page.length < names.length;
    // The registry's own link: no angle brackets, the cursor the page's last name.
    const headers = more ? { link: `${url.origin}/v2/_catalog?n=1000&last=${page.at(-1)?.[1] ?? ''}&tags=true; rel=next` } : undefined;

    return Response.json({ repositories: Object.fromEntries(repositories) }, { headers });
  };

  const config = (url: URL): Response => {
    const id = url.pathname.split('/blobs/config-')[1] ?? '';
    const each = entries.find((one) => one.id === id);

    // An image's config is an OCI image config: no snapshot or application.
    if (each?.image === true) return Response.json({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } });

    return Response.json({ application_id: each?.app ?? '', snapshot_id: id, snapshot_set_id: `set-${id}`, parent_snapshot_id: each?.parent ?? '' });
  };

  const manifest = (url: URL, method: string): Response => {
    const [repository = '', ref = ''] = url.pathname.slice('/v2/'.length).split('/manifests/');
    const named = ref.startsWith('sha256:') ? ref : tags.get(`${repository}:${ref}`);
    const each = named === undefined ? undefined : manifests.get(`${repository}@${named}`);

    if (named === undefined || each === undefined) return new Response(null, { status: 404 });

    if (method === 'GET') return Response.json({ config: { digest: `config-${each.id}` } });
    deleted.push(ref.startsWith('sha256:') ? `digest ${each.id}` : `tag ${each.id}`);

    if (!ref.startsWith('sha256:')) tags.delete(`${repository}:${ref}`);
    else if (![...tags.entries()].some(([key, value]) => key.startsWith(`${repository}:`) && value === ref)) manifests.delete(`${repository}@${ref}`);

    return new Response(null, { status: 204 });
  };

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.host === 'api.cloudflare.com') return Response.json({ success: true, errors: [], result: { username: 'u', password: 'p' } });

    if (url.pathname === '/v2/_catalog') return catalog(url);

    return url.pathname.includes('/blobs/') ? config(url) : manifest(url, init?.method ?? 'GET');
  };

  return { fetcher, deleted, left: () => [...manifests.values()].map((each) => each.id).sort() };
}

test('every snapshot of the application goes, tags before the manifest and a child before its parent; no other is touched', async () => {
  const fake = registry([
    { id: 'root', app: 'aaaa-bbbb', parent: '', tagged: true },
    { id: 'child', app: 'aaaa-bbbb', parent: 'root', tagged: false },
    { id: 'grandchild', app: 'aaaa-bbbb', parent: 'child', tagged: true },
    { id: 'other', app: 'cccc', parent: '', tagged: true },
  ]);

  const swept = await deleteApplicationSnapshots({ account: 'acct', token: 't', applicationId: 'aaaabbbb', fetch: fake.fetcher });

  expect({ swept, left: fake.left(), deleted: fake.deleted }).toEqual({
    swept: { deleted: 3, left: [] }, left: ['other'],
    deleted: ['tag grandchild', 'tag grandchild', 'digest grandchild', 'digest child', 'tag root', 'tag root', 'digest root'],
  });
});

// 2026-10-09: an application on an image of ours keeps its snapshots in that image's repository, not under
// cloudchamber-snapshots; `<account>/kinu-devbox-native` held 313 of deleted applications, which a sweep of the
// cloudchamber repositories alone never saw. The image's own manifest beside them is no snapshot and stays.
test('a snapshot in its image\'s own repository is found by its config and deleted, and the image beside it stays', async () => {
  const fake = registry([
    { id: 'own-root', app: 'dddd', parent: '', tagged: true, repository: 'acct/kinu-devbox-native' },
    { id: 'own-child', app: 'dddd', parent: 'own-root', tagged: false, repository: 'acct/kinu-devbox-native' },
    { id: 'image', app: '', parent: '', tagged: true, repository: 'acct/kinu-devbox-native', image: true },
    { id: 'base-one', app: 'dddd', parent: '', tagged: true },
  ]);

  const swept = await deleteApplicationSnapshots({ account: 'acct', token: 't', applicationId: 'dddd', fetch: fake.fetcher });

  expect({ swept, left: fake.left() }).toEqual({ swept: { deleted: 3, left: [] }, left: ['image'] });
});

