/**
 * `GET /downloads/kinu-worker-<version>.tar.gz` — the worker release artifact.
 *
 * It is served from a bucket rather than published as a static asset because
 * it is larger than Cloudflare's per-file static-asset limit; a deploy that
 * staged it in `dist/client` would fail at asset upload.
 * `scripts/deploy.test.ts` holds the limit and measures both halves.
 * Everything small about a release — `release.json` and the artifact's
 * `.sha256` — stays an asset, so the manifest and the checksum a downloader
 * verifies against are published beside the build stamp and signed with it.
 *
 * Public, like the rest of `/downloads/*`: a person deploying their own Kinu
 * has no account here, and the bytes are the bytes kinu.run runs.
 */
import { RELEASE_ARTIFACT_ROUTE } from '../deploy/manifest';
import { err } from './http';

/** The slice of an R2 bucket this route needs, declared structurally so the
 *  handler compiles in either backend closure: `env.RELEASES_BUCKET` on
 *  Cloudflare satisfies it, and so does any object store shaped like it. */
export interface ReleaseArtifactObject {
  readonly size: number;
  readonly httpEtag: string;
  readonly body?: ReadableStream | null;
}

export interface ReleaseArtifactStore {
  get(key: string): Promise<ReleaseArtifactObject | null>;
  head(key: string): Promise<ReleaseArtifactObject | null>;
}

function metadata(object: ReleaseArtifactObject): Headers {
  return new Headers({
    'content-type': 'application/gzip',
    'content-length': String(object.size),
    etag: object.httpEtag,
    // A release artifact is immutable: its name carries the version, and a
    // deployment that has one never needs to ask whether it changed.
    'cache-control': 'public, max-age=31536000, immutable',
  });
}

export async function handleReleaseArtifactRequest(
  request: Request,
  store: ReleaseArtifactStore | undefined,
): Promise<Response | null> {
  const match = RELEASE_ARTIFACT_ROUTE.exec(new URL(request.url).pathname);

  if (match === null) return null;

  if (request.method !== 'GET' && request.method !== 'HEAD') return err(405, 'Method not allowed.');

  if (store === undefined) return err(404, 'This deployment publishes no worker release artifacts.');

  const key = match[1] ?? '';

  if (request.method === 'HEAD') {
    const head = await store.head(key);

    return head === null ? err(404, 'No such release artifact.') : new Response(null, { headers: metadata(head) });
  }

  const object = await store.get(key);

  if (object === null || object.body === null || object.body === undefined) {
    return err(404, 'No such release artifact.');
  }

  return new Response(object.body, { headers: metadata(object) });
}
