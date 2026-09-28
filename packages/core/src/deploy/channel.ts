// Release channel reader for every door (docs/SELF-DEPLOY.md). The digest is checked
// against the channel's `.sha256` before any byte is decompressed.
import { Effect } from 'effect';
import { settle } from '../obs/index';
import { TarArtifact } from './artifact';
import { sha256Hex } from '../safety/argument-digest';
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

    if (!response.ok) return yield* Effect.die(new Error(`${url.href} answered HTTP ${String(response.status)}`));

    const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()));
    const published = yield* Effect.promise(() => fetchImpl(new URL(`${workerArtifactPath(manifest.version)}.sha256`, origin)));
    const expected = (yield* Effect.promise(() => published.text())).trim().split(/\s+/u)[0] ?? '';
    const actual = sha256Hex(bytes);

    if (expected !== actual) {
      return yield* Effect.die(new Error(`the release artifact's checksum is ${actual}, and the channel publishes ${expected || '<none>'}`));
    }

    return TarArtifact.open(bytes);
  }));
}
