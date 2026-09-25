/**
 * Every container image the Worker runs: where it is pushed and the digest wrangler.jsonc runs. The sandbox's is read
 * from its own artifact record, packages/devbox/block-lower/upstream.json, whose per-file hashes release-config's A8
 * holds; the Codex forwarder's is declared here with a hash of its tracked source directory, so a source change with
 * no new digest fails release-config, and `gate:egress-interception` reads the same record to admit it.
 *
 * A new Codex forwarder digest:
 *   bunx wrangler containers build -p -t kinu-codex-egress:<first 12 of the source hash> <source>, then
 *   `docker buildx imagetools inspect registry.cloudflare.com/<account>/kinu-codex-egress:<tag>` for the digest, and
 *   move the digest here, in wrangler.jsonc, and the hash `bun scripts/container-images.ts` prints. deploy.sh builds
 *   no image. The sandbox image: packages/devbox/block-lower/README.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { trackedFiles } from './sources';

export interface ContainerImage {
  readonly repository: string;
  readonly digest: string;
  /** Tracked directory holding the Dockerfile the image is built from. */
  readonly source: string;
  /** {@link sourceHash} of `source` when `digest` was pushed; absent where the source has its own artifact record. */
  readonly sourceHash?: string;
}

const BLOCK_LOWER = 'packages/devbox/block-lower';

const SandboxArtifact = v.object({ image: v.string(), digest: v.string() });

const SANDBOX = v.parse(SandboxArtifact, JSON.parse(readFileSync(join(import.meta.dir, '..', BLOCK_LOWER, 'upstream.json'), 'utf8')));

const REGISTRY = 'registry.cloudflare.com/f44999d1ddda7012e9a87729eba250f1';

export const CONTAINER_IMAGES = {
  KinuSandbox: {
    repository: SANDBOX.image.slice(0, SANDBOX.image.lastIndexOf('@')),
    digest: SANDBOX.digest,
    source: BLOCK_LOWER,
  },
  CodexEgress: {
    repository: `${REGISTRY}/kinu-codex-egress`,
    digest: 'sha256:6e64016f2d96aafdbe7129181b5579d7222d5d6240c86b7a5da7f40e0e0a5110',
    source: 'packages/cf-backend/containers/codex-egress',
    sourceHash: 'sha256:686ed63b2f83afec02e8b14b3cbfce234414d77e0bb3f16ed1fec3f790877f07',
  },
} satisfies Record<string, ContainerImage>;

export const imageReference = (image: ContainerImage): string => `${image.repository}@${image.digest}`;

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
