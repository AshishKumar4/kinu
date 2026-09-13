import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import artifact from '../block-lower/upstream.json';

test('the pinned block-lower artifact names the source and the image both hosts run', () => {
  const root = join(import.meta.dir, '../block-lower');
  expect(Object.keys(artifact.files).sort()).toEqual(['Cargo.toml', 'Cargo.lock', 'Dockerfile',
    ...readdirSync(join(root, 'src')).filter(name => name.endsWith('.rs')).map(name => `src/${name}`)].sort());

  for (const [path, expected] of Object.entries(artifact.files)) {
    expect(createHash('sha256').update(readFileSync(join(root, path))).digest('hex'), path).toBe(expected);
  }

  expect(artifact.image).toEndWith(`@${artifact.digest}`);

  for (const path of ['../../cf-backend/wrangler.jsonc', '../bench/wrangler.jsonc']) {
    const config = readFileSync(join(import.meta.dir, path), 'utf8');
    expect(config).toContain(`"image": "${artifact.image}"`);
  }
});
