// The registry client that deletes a dead snapshot (D65): a fake of the Cloudflare API and the
// managed registry, holding the tags a live snapshot had (`bench-artifacts/hybrid-live/tags.ts`).
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { snapshotRegistry } from '../src/snapshot-registry';

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

/** One snapshot of run `sbs10021734nhsw`, its set id, and the two tags the registry held for it (D65). */
const SNAPSHOT = '998912a6-67f9-47dc-aa2b-d31dea160676';

const SET = 'ef2f907b-d646-46ad-9679-00e360590122';

const SNAPSHOT_TAG = 'rootfs-snapshot-a2a4c4129b5a0b172edf8278cab85f57bd6e89c77213a10b1a18fe6e0aef2c42';

const SET_TAG = 'rootfs-set-6f679050ddc96734589070085cce379146ead2d8c2f5c26590609557209654f1';

const DIGEST = 'sha256:5abee7866948080f99c93170b21bb5cccddad89b903b1eb0d223f36645ae8f73';

/**
 * The registry as measured on 2026-10-09: tags and digests share the catalog's names, which it pages 1000 at a time with
 * a `last` cursor; a manifest's DELETE by digest answers 204 and keeps it while a tag names it, and takes it from the
 * catalog once none does. `pageSize` pages the fake smaller; `refuseDigest` refuses the next digest delete.
 */
function platform(options: { readonly pageSize?: number; readonly filler?: number } = {}) {
  const tags = new Map<string, string>([[SNAPSHOT_TAG, DIGEST], [SET_TAG, DIGEST], ['kept', 'sha256:other']]);
  const manifests = new Set<string>([DIGEST, 'sha256:other']);
  const calls: string[] = [];
  let refuseDigest = false;
  const repository = `${ACCOUNT}/kinu-devbox-native`;
  const before = Array.from({ length: options.filler ?? 0 }, (_, index) => `aaa-${String(index).padStart(5, '0')}`);

  const names = () => [...before, ...[...tags.keys(), ...manifests].sort()].map((name) => [before.includes(name) ? `${ACCOUNT}/a-filler` : repository, name] as const);

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const authorization = v.parse(v.optional(v.record(v.string(), v.string()), {}), init?.headers)['authorization'];
    calls.push(`${method} ${url.host}${url.pathname}`);

    if (url.host === 'api.cloudflare.com') {
      if (authorization !== 'Bearer token-1') return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });

      return Response.json({ success: true, errors: [], result: { username: 'v1', password: 'pw' } });
    }

    if (authorization !== `Basic ${btoa('v1:pw')}`) return new Response('unauthorized', { status: 401 });

    if (url.pathname === '/v2/_catalog') {
      const all = names();
      const last = url.searchParams.get('last');
      const from = last === null ? 0 : all.findIndex(([, name]) => name === last) + 1;
      const page = all.slice(from, from + (options.pageSize ?? 1000));
      const repositories = new Map<string, string[] | null>([[`${ACCOUNT}/other`, null]]);

      for (const [repo, name] of page) repositories.set(repo, [...repositories.get(repo) ?? [], name]);
      const more = from + page.length < all.length;
      // The registry's own link: no angle brackets, and the cursor is the page's last name.
      const headers = more ? { link: `https://registry.cloudflare.com/v2/_catalog?n=1000&last=${page.at(-1)?.[1] ?? ''}&tags=true; rel=next` } : undefined;

      return Response.json({ repositories: Object.fromEntries(repositories) }, { headers });
    }

    const ref = url.pathname.split('/manifests/')[1] ?? '';
    const named = ref.startsWith('sha256:') ? ref : tags.get(ref);
    const digest = named !== undefined && manifests.has(named) ? named : undefined;

    if (digest === undefined) return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });

    if (method === 'DELETE') {
      if (!ref.startsWith('sha256:')) tags.delete(ref);
      else if (refuseDigest) {
        refuseDigest = false;

        return new Response('busy', { status: 503 });
      } else if (![...tags.values()].includes(ref)) manifests.delete(ref);

      return new Response(null, { status: 204 });
    }

    return Response.json({ annotations: { 'io.cloudflare.cloudchamber.snapshot_set_id': SET } }, { headers: { 'docker-content-digest': digest } });
  };

  return { tags, manifests, calls, fetcher, refuseNextDigest: () => { refuseDigest = true; } };
}

test('a snapshot\'s two tags are deleted, then its manifest by digest, and nothing else', async () => {
  const fake = platform();
  const outcome = await snapshotRegistry({ token: 'token-1', account: ACCOUNT, fetch: fake.fetcher }).delete(SNAPSHOT);

  expect({ outcome, tags: [...fake.tags.keys()], manifests: [...fake.manifests] }).toEqual({ outcome: { kind: 'deleted' }, tags: ['kept'], manifests: ['sha256:other'] });
  // Only the snapshot's own repository is written to, the set tag first and the digest once no tag names it.
  expect(fake.calls.filter((call) => call.startsWith('DELETE'))).toEqual([
    `DELETE registry.cloudflare.com/v2/${ACCOUNT}/kinu-devbox-native/manifests/${SET_TAG}`,
    `DELETE registry.cloudflare.com/v2/${ACCOUNT}/kinu-devbox-native/manifests/${SNAPSHOT_TAG}`,
    `DELETE registry.cloudflare.com/v2/${ACCOUNT}/kinu-devbox-native/manifests/${DIGEST}`,
  ]);
});

// The catalog answered 3 pages for one repository's 1705 names on 2026-10-09; a first-page lookup called most absent.
test('a snapshot past the catalog\'s first page is found and deleted, not called absent', async () => {
  const fake = platform({ pageSize: 2, filler: 5 });
  const outcome = await snapshotRegistry({ token: 'token-1', account: ACCOUNT, fetch: fake.fetcher }).delete(SNAPSHOT);

  expect({ outcome, tags: [...fake.tags.keys()], pages: fake.calls.filter((call) => call.includes('_catalog')).length > 2 }).toEqual({ outcome: { kind: 'deleted' }, tags: ['kept'], pages: true });
});

test('a digest delete refused once the tags are gone leaves the digest, which a later delete takes', async () => {
  const fake = platform();
  const registry = snapshotRegistry({ token: 'token-1', account: ACCOUNT, fetch: fake.fetcher });
  fake.refuseNextDigest();
  const first = await registry.delete(SNAPSHOT);
  const byId = await registry.delete(SNAPSHOT);
  const byDigest = await registry.delete(DIGEST);

  expect({ first, byId, byDigest, manifests: [...fake.manifests] }).toEqual({
    first: { kind: 'refused', reason: `deleting ${DIGEST} answered 503: busy`, left: DIGEST }, byId: { kind: 'absent' }, byDigest: { kind: 'deleted' }, manifests: ['sha256:other'],
  });
});

test('a snapshot already gone is absent, not a failure', async () => {
  const fake = platform();
  const outcome = await snapshotRegistry({ token: 'token-1', account: ACCOUNT, fetch: fake.fetcher }).delete('never-taken');

  expect(outcome).toEqual({ kind: 'absent' });
});

test('a refusal carries the platform\'s own words', async () => {
  const wrong = await snapshotRegistry({ token: 'token-2', account: ACCOUNT, fetch: platform().fetcher }).delete(SNAPSHOT);
  const unreachable = await snapshotRegistry({ token: 'token-1', account: ACCOUNT, fetch: () => Promise.reject(new TypeError('fetch failed')) }).delete(SNAPSHOT);

  expect({ wrong, unreachable: unreachable.kind, words: unreachable.kind === 'refused' && unreachable.reason.includes('fetch failed') })
    .toEqual({ wrong: { kind: 'refused', reason: 'minting registry credentials answered 403: Authentication error' }, unreachable: 'refused', words: true });
});
