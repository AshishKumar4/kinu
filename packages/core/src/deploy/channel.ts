// Release channel reader for every door (docs/SELF-DEPLOY.md). The digest is checked
// against the channel's `.sha256` before any byte is decompressed.
import { TarArtifact } from './artifact';
import { sha256Hex } from '../safety/argument-digest';
import { RELEASE_MANIFEST_PATH, parseReleaseManifest, workerArtifactPath, type ReleaseManifest } from './manifest';

export async function fetchReleaseManifest(origin: string, fetchImpl: typeof fetch = fetch): Promise<ReleaseManifest> {
  const url = new URL(RELEASE_MANIFEST_PATH, origin);
  const response = await fetchImpl(url);

  if (!response.ok) throw new Error(`the release channel answered HTTP ${String(response.status)} for ${url.href}`);

  return parseReleaseManifest(await response.text());
}

export async function fetchReleaseArtifact(
  manifest: ReleaseManifest,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TarArtifact> {
  const url = new URL(workerArtifactPath(manifest.version), origin);
  const response = await fetchImpl(url);

  if (!response.ok) throw new Error(`${url.href} answered HTTP ${String(response.status)}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const published = await fetchImpl(new URL(`${workerArtifactPath(manifest.version)}.sha256`, origin));
  const expected = (await published.text()).trim().split(/\s+/u)[0] ?? '';
  const actual = await sha256Hex(bytes);

  if (expected !== actual) {
    throw new Error(`the release artifact's checksum is ${actual}, and the channel publishes ${expected || '<none>'}`);
  }

  return TarArtifact.open(bytes);
}
