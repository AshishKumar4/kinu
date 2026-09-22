/**
 * `GET /downloads/kinu-worker-<version>.tar.gz`, served from a bucket because the artifact exceeds the
 * static-asset per-file limit (held in `scripts/deploy.test.ts`). Public, like the rest of `/downloads/*`.
 */
import { RELEASE_ARTIFACT_ROUTE } from '../deploy/manifest';
import { err } from './http';

/** Structural slice of an R2 bucket, so the handler compiles in either backend. */
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
    // Immutable: the name carries the version.
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
