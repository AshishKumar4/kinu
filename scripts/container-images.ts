/**
 * Custom images carry a registry digest and source hash. Devbox's managed base comes from its tools artifact
 * record and starts directly, with no Wrangler image preparation (D72); release-config holds the tools sources.
 * The Codex forwarder's tracked source and digest are also read by `gate:egress-interception`.
 *
 * A new Codex forwarder digest:
 *   bunx wrangler containers build -p -t kinu-codex-egress:<first 12 of the source hash> <source>, then
 *   `docker buildx imagetools inspect registry.cloudflare.com/<account>/kinu-codex-egress:<tag>` for the digest, and
 *   move the digest here, in wrangler.jsonc, and the hash `bun scripts/container-images.ts` prints. deploy.sh builds
 *   no image. The devbox tools tarball: packages/devbox/block-lower/README.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { trackedFiles } from './sources';

export interface ContainerImage {
  readonly repository: string;
  readonly digest?: string;
  /** Tracked directory holding the Dockerfile the image is built from. */
  readonly source: string;
  /** {@link sourceHash} of `source` when `digest` was pushed; absent where the source has its own artifact record. */
  readonly sourceHash?: string;
}

const BLOCK_LOWER = 'packages/devbox/block-lower';

const SandboxArtifact = v.object({ base: v.literal('cloudflare/debian-trixie') });

const SANDBOX = v.parse(SandboxArtifact, JSON.parse(readFileSync(join(import.meta.dir, '..', BLOCK_LOWER, 'upstream.json'), 'utf8')));

const REGISTRY = 'registry.cloudflare.com/f44999d1ddda7012e9a87729eba250f1';

export const CONTAINER_IMAGES = {
  KinuDevbox: {
    repository: SANDBOX.base,
    source: BLOCK_LOWER,
  },
  CodexEgress: {
    repository: `${REGISTRY}/kinu-codex-egress`,
    digest: 'sha256:de0f028f7f84e93a9164ea99540e06c8756038a3ca0ec7f7cf1d38a47822817e',
    source: 'packages/cf-backend/containers/codex-egress',
    sourceHash: 'sha256:93b5afb384c6b115e31505d9bbb14bf6dc1f07f30710ef74ab6a7deb896e349b',
  },
} satisfies Record<string, ContainerImage>;

export const imageReference = (image: ContainerImage): string => image.digest === undefined ? image.repository : `${image.repository}@${image.digest}`;

/** The tracked files under `source`, relative to the repository, in order. */
export function sourceFiles(source: string, tracked: readonly string[] = trackedFiles()): string[] {
  return tracked.filter((file) => file.startsWith(`${source}/`)).sort();
}

/** One hash over each tracked file's path and bytes: any edit, add or removal moves it. */
export function sourceHash(files: ReadonlyMap<string, string | Uint8Array>): string {
  const hash = createHash('sha256');

  for (const path of [...files.keys()].sort()) {
    hash.update(`${path}\n`);
    hash.update(createHash('sha256').update(files.get(path) ?? '').digest('hex'));
    hash.update('\n');
  }

  return `sha256:${hash.digest('hex')}`;
}

export function readSource(root: string, source: string): Map<string, Uint8Array> {
  return new Map(sourceFiles(source).map((file) => [file, readFileSync(join(root, file))]));
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');

  for (const [name, image] of Object.entries(CONTAINER_IMAGES)) {
    process.stdout.write(`${name} ${image.source} ${sourceHash(readSource(root, image.source))}\n`);
  }
}
