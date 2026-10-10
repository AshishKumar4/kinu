/**
 * A slate's build is its source compiled with one caller's file authority: an import resolves only where that caller
 * may read. The last build that worked is kept for a later edit that does not, and is served only to a caller with the
 * same authority, never to one whose own build was refused what the kept image read.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { VfsCred } from '@nimbus-sh/core/vfs/vfs.js';
import { sqlStorageOver } from '@kinu.run/core/identity';
import { initSlateBuildTable, SlateBuilds, slateImage } from '../src/slates/builds';

const OWNER: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const VIEWER: VfsCred = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };

const COMPILED = { modules: { 'index.js': 'image-read-the-owners-secrets' } };

function builds(): SlateBuilds {
  const db = new Database(':memory:');
  const exec = sqlStorageOver(db);

  initSlateBuildTable((sql) => { db.exec(sql); });

  return new SlateBuilds(exec);
}

test('a build another caller\'s authority made is not served to one whose own build was refused', async () => {
  const slates = builds();

  await slateImage({ builds: slates, slate: 'board', key: 'src-1', cred: OWNER, build: async () => COMPILED });

  const viewer = slateImage({
    builds: slates, slate: 'board', key: 'src-1', cred: VIEWER,
    build: async () => ({ failed: 'import /home/owner/secrets.ts: permission denied' }),
  });

  await expect(viewer).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('permission denied') });
});

test('the same caller keeps its own last working build past an edit that does not compile', async () => {
  const slates = builds();

  await slateImage({ builds: slates, slate: 'board', key: 'src-1', cred: OWNER, build: async () => COMPILED });
  const later = await slateImage({ builds: slates, slate: 'board', key: 'src-2', cred: OWNER, build: async () => ({ failed: 'syntax error' }) });

  expect(later).toEqual({ image: COMPILED, key: 'src-1', broken: 'syntax error' });
});

test('a restricted caller\'s refused build does not say the slate the owner is served is broken', async () => {
  const slates = builds();

  await expect(slateImage({
    builds: slates, slate: 'board', key: 'src-1', cred: VIEWER,
    build: async () => ({ failed: 'import /home/owner/secrets.ts: permission denied' }),
  })).rejects.toMatchObject({ code: 'bad_input' });
  await slateImage({ builds: slates, slate: 'board', key: 'src-1', cred: OWNER, build: async () => COMPILED });

  expect(slates.failing(OWNER)).toEqual([]);
  expect(slates.failing(VIEWER)).toEqual([{ slate: 'board', failure: 'import /home/owner/secrets.ts: permission denied' }]);
});
