import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { bundleSync } from '../block-lower/bundle-sync';
import artifact from '../block-lower/upstream.json';

test('the pinned image carries the sync this tree bundles, so no container runs a sync its box does not speak', async () => {
  expect(createHash('sha256').update(await bundleSync()).digest('hex')).toBe(artifact.binaries['sync.js']);
});
