/**
 * The containers the Worker runs. Devbox's managed base comes from its tools artifact record and starts directly, with
 * no Wrangler image preparation (D72); release-config holds the tools sources. deploy.sh builds no image. The devbox
 * tools tarball: packages/devbox/block-lower/README.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

export interface ContainerImage {
  readonly repository: string;
  /** Tracked directory holding what the image is built from. */
  readonly source: string;
}

const BLOCK_LOWER = 'packages/devbox/block-lower';

const SandboxArtifact = v.object({ base: v.literal('cloudflare/debian-trixie') });

const SANDBOX = v.parse(SandboxArtifact, JSON.parse(readFileSync(join(import.meta.dir, '..', BLOCK_LOWER, 'upstream.json'), 'utf8')));

export const CONTAINER_IMAGES = {
  KinuDevbox: {
    repository: SANDBOX.base,
    source: BLOCK_LOWER,
  },
} satisfies Record<string, ContainerImage>;
