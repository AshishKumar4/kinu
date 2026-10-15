// What a staging deploy's upgrade fixtures say of the previous seed: the manifest to check where the fixture account
// holds it, a loss where only the sender's copy is left, and nothing to check where no seed ever completed.
import { expect, test } from 'bun:test';
import { previousSeed, type Manifest } from './upgrade-fixtures';

const MANIFEST: Manifest = {
  seededAt: '20261015t110722z', workspace: 'upgrade-fixture', note: { path: 'notes/upgrade.md', text: 'written\n' }, said: 'upgrade fixture',
  senderWorkspace: 'upgrade-sender', share: 'share-1', device: 'device-1', fresh: 'upgrade-fresh-1',
};

test('the fixture account\'s manifest is what the deploy checks', () => {
  expect(previousSeed({ workspace: 'upgrade-fixture', manifest: MANIFEST }, { workspace: 'upgrade-sender', manifest: MANIFEST }))
    .toEqual({ kind: 'seeded', manifest: MANIFEST });
});

test('the sender\'s copy alone is a loss, named by what the fixture account no longer holds', () => {
  expect(previousSeed({ manifest: null }, { workspace: 'upgrade-sender', manifest: MANIFEST }))
    .toEqual({ kind: 'lost', why: 'upgrade-fixture@kinu.run\'s roster no longer names its fixture workspace, which upgrade-sender@kinu.run still records' });
  expect(previousSeed({ workspace: 'upgrade-fixture', manifest: null }, { workspace: 'upgrade-sender', manifest: MANIFEST }))
    .toEqual({ kind: 'lost', why: 'upgrade-fixture no longer holds notes/upgrade-manifest.json, which upgrade-sender@kinu.run still holds' });
});

test('no manifest in either account is a deployment that never completed a seed', () => {
  expect(previousSeed({ workspace: 'upgrade-fixture', manifest: null }, { manifest: null })).toEqual({ kind: 'none' });
});
