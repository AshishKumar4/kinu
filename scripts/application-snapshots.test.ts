// A fixture's teardown deletes every snapshot its application made, against a registry with the semantics measured on
// 2026-10-09: the catalog pages its names and lists every manifest by digest, tagged or not, and a DELETE of a manifest
// a tag still names answers 204 and keeps it.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { deleteApplicationSnapshots } from './fixtures/application-snapshots';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const REPO = 'acct/cloudchamber-snapshots/base';

interface Snapshot { readonly id: string; readonly app: string; readonly parent: string; readonly tagged: boolean }

function registry(snapshots: readonly Snapshot[], pageSize = 3) {
  const digest = (id: string) => `sha256:${sha(`manifest-${id}`)}`;
  const manifests = new Map(snapshots.map((each) => [digest(each.id), each]));
  const tags = new Map<string, string>();

  for (const each of snapshots.filter((one) => one.tagged)) {
    tags.set(`rootfs-snapshot-${sha(each.id)}`, digest(each.id));
    tags.set(`rootfs-set-${sha(`set-${each.id}`)}`, digest(each.id));
  }

  const deleted: string[] = [];

  const catalog = (url: URL): Response => {
    const names: (readonly [string, string])[] = [['acct/other', 'x'], ...[...tags.keys(), ...manifests.keys()].sort().map((name) => [REPO, name] as const)];
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
    const each = snapshots.find((one) => one.id === id);

    return Response.json({ application_id: each?.app ?? '', snapshot_id: id, snapshot_set_id: `set-${id}`, parent_snapshot_id: each?.parent ?? '' });
  };

  const manifest = (url: URL, method: string): Response => {
    const ref = url.pathname.split('/manifests/')[1] ?? '';
    const named = ref.startsWith('sha256:') ? ref : tags.get(ref);
    const each = named === undefined ? undefined : manifests.get(named);

    if (named === undefined || each === undefined) return new Response(null, { status: 404 });

    if (method === 'GET') return Response.json({ config: { digest: `config-${each.id}` } });
    deleted.push(ref.startsWith('sha256:') ? `digest ${each.id}` : `tag ${each.id}`);

    if (!ref.startsWith('sha256:')) tags.delete(ref);
    else if (![...tags.values()].includes(ref)) manifests.delete(ref);

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
