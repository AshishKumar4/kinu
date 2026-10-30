// Release channel reader for every door (docs/SELF-DEPLOY.md). The artifact is read as it downloads, each file checked
// against the manifest's digest (`TarArtifact`).
import { Effect } from 'effect';
import { settle } from '../obs/index';
import { TarArtifact } from './artifact';
import { RELEASE_MANIFEST_PATH, parseReleaseManifest, workerArtifactPath, type ReleaseManifest } from './manifest';

export function fetchReleaseManifest(origin: string, fetchImpl: typeof fetch = fetch): Promise<ReleaseManifest> {
  return settle(Effect.gen(function* () {
    const url = new URL(RELEASE_MANIFEST_PATH, origin);
    const response = yield* Effect.promise(() => fetchImpl(url));

    if (!response.ok) return yield* Effect.die(new Error(`the release channel answered HTTP ${String(response.status)} for ${url.href}`));
    const text = yield* Effect.promise(() => response.text());

    return parseReleaseManifest(text);
  }));
}

export function fetchReleaseArtifact(
  manifest: ReleaseManifest,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TarArtifact> {
  return settle(Effect.gen(function* () {
    const url = new URL(workerArtifactPath(manifest.version), origin);
    const response = yield* Effect.promise(() => fetchImpl(url));

    if (!response.ok || response.body === null) return yield* Effect.die(new Error(`${url.href} answered HTTP ${String(response.status)}`));

    return TarArtifact.open(response.body, manifest.files);
  }));
}
