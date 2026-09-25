/**
 * Every container image the Worker runs, declared ONCE: where it is pushed, the digest wrangler.jsonc runs, and the
 * tracked directory it is built from with a hash of that directory's tracked files. `release-config.test.ts` holds
 * wrangler.jsonc to these digests and each directory to its hash, so a source change with no new digest fails there;
 * `gate:egress-interception` reads the same record to admit a forwarding container.
 *
 * A new digest, for either image:
 *   bunx wrangler containers build -p -t <image>:<first 12 of the source hash> <source>
 *   (the block layer runs `bun <source>/bundle-sync.ts` first, see its README), then
 *   `docker buildx imagetools inspect registry.cloudflare.com/<account>/<image>:<tag>` for the digest, and move the
 *   digest here, in wrangler.jsonc, and the hash `bun scripts/container-images.ts` prints. deploy.sh builds no image.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedFiles } from './sources';

export interface ContainerImage {
  readonly repository: string;
  readonly digest: string;
  /** Tracked directory holding the Dockerfile the image is built from. */
  readonly source: string;
  /** {@link sourceHash} of `source` when `digest` was pushed. */
  readonly sourceHash: string;
}

const REGISTRY = 'registry.cloudflare.com/f44999d1ddda7012e9a87729eba250f1';

export const CONTAINER_IMAGES = {
  KinuSandbox: {
    repository: `${REGISTRY}/kinu-devbox-block-layer`,
    digest: 'sha256:c2c03bdf3b46d22633ffdeab545953d7c0caa0fb562d36e70ebdd4618898c718',
    source: 'packages/devbox/block-lower',
    sourceHash: 'sha256:056ba02fe6ef15819393f0e9c98ad4011d40e9388ca6f9025b303fcfb2352b85',
  },
  CodexEgress: {
    repository: `${REGISTRY}/kinu-codex-egress`,
    digest: 'sha256:b68674fa627a77f7320b2f07db824264cca9d1d7699f636d9571c2e53ba99c28',
    source: 'packages/cf-backend/containers/codex-egress',
    sourceHash: 'sha256:9b2fcf2df21673a0722534095f4f05d7c4d77677dae653875d409c60e3368ec3',
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
