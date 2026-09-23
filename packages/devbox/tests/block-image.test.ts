import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { bundleSync } from '../block-lower/bundle-sync';
import artifact from '../block-lower/upstream.json';

test('the pinned block-lower artifact names the source and the image every host runs', () => {
  const root = join(import.meta.dir, '../block-lower');
  expect(Object.keys(artifact.files).sort()).toEqual(['Cargo.toml', 'Cargo.lock', 'Dockerfile',
    ...readdirSync(join(root, 'src')).filter(name => name.endsWith('.rs')).map(name => `src/${name}`)].sort());

  for (const [path, expected] of Object.entries(artifact.files)) {
    expect(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), path).toBe(expected);
  }

  expect(artifact.image).toEndWith(`@${artifact.digest}`);

  for (const path of ['../../cf-backend/wrangler.jsonc', '../bench/wrangler.jsonc', '../example/wrangler.jsonc']) {
    const config = readFileSync(join(import.meta.dir, path), 'utf8');
    expect(config).toContain(`"image": "${artifact.image}"`);
  }
});

test('the pinned image carries the sync this tree bundles, so no container runs a sync its box does not speak', async () => {
  expect(createHash('sha256').update(await bundleSync()).digest('hex')).toBe(artifact.binaries['sync.js']);
});
