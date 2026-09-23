/**
 * The image's `sync.js` (D30), bundled from this tree. `bun packages/devbox/block-lower/bundle-sync.ts`
 * writes `.build/sync.js` for the Docker build; `tests/block-image.test.ts` bundles it again and
 * holds the pinned image to these bytes, so the container never runs a sync its box does not speak.
 * Whitespace minification drops the bundler's per-module path comments, which name the install
 * layout rather than the code.
 */
import { join } from 'node:path';

const PACKAGE_DIR = join(import.meta.dir, '..');

export async function bundleSync(): Promise<Uint8Array> {
  const built = await Bun.build({
    entrypoints: [join(PACKAGE_DIR, 'src/sync-main.ts')],
    root: PACKAGE_DIR,
    target: 'bun',
    minify: { whitespace: true },
  });

  const [bundle] = built.outputs;

  if (!built.success || bundle === undefined) {
    throw new AggregateError(built.logs, 'the sync bundle did not build');
  }

  return new Uint8Array(await bundle.arrayBuffer());
}

if (import.meta.main) await Bun.write(join(import.meta.dir, '.build/sync.js'), await bundleSync());
