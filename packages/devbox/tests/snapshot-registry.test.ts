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

/** The tags the registry holds, the calls it saw, and how the API answers a mint. */
function platform() {
  const tags = new Map<string, string>([[SNAPSHOT_TAG, SET], [SET_TAG, SET], ['kept', 'other']]);
  const calls: string[] = [];

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

    if (url.pathname === '/v2/_catalog') return Response.json({ repositories: { [`${ACCOUNT}/kinu-devbox-native`]: [...tags.keys()], [`${ACCOUNT}/other`]: null } });
    const tag = url.pathname.split('/manifests/')[1] ?? '';
    const set = tags.get(tag);

    if (set === undefined) return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });

    if (method === 'DELETE') {
      tags.delete(tag);

      return new Response(null, { status: 202 });
    }

    return Response.json({ annotations: { 'io.cloudflare.cloudchamber.snapshot_set_id': set } });
  };

  return { tags, calls, fetcher };
}

test('a snapshot\'s two tags are deleted, and nothing else', async () => {
  const fake = platform();
  const outcome = await snapshotRegistry({ token: 'token-1', account: ACCOUNT, fetch: fake.fetcher }).delete(SNAPSHOT);

  expect({ outcome, left: [...fake.tags.keys()] }).toEqual({ outcome: { kind: 'deleted' }, left: ['kept'] });
  // Only the snapshot's own repository is written to.
  expect(fake.calls.filter((call) => call.startsWith('DELETE'))).toEqual([
    `DELETE registry.cloudflare.com/v2/${ACCOUNT}/kinu-devbox-native/manifests/${SNAPSHOT_TAG}`,
    `DELETE registry.cloudflare.com/v2/${ACCOUNT}/kinu-devbox-native/manifests/${SET_TAG}`,
  ]);
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
