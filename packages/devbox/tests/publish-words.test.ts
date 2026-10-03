// A publication that fails says why: the publisher's reason is on stderr, and the 10 GB base failed as
// "publishing …/base.sqsh failed (1): 1" without it (runs sbs10031034nr110, sbs10031046nr210).
import { expect, test } from 'bun:test';
import { diskChain, type DiskChainPorts } from '../src/disk-chain';
import { settle } from '../src/errors';

test('a publication the store refused fails with the publisher\'s own words', async () => {
  const words = 'PUT part 7 answered 503: Reduce your concurrent request rate for the same object.; multipart upload-1 aborted';

  const ports: DiskChainPorts = {
    exec: async (command) => command.includes('devbox-stream.mjs')
      ? { exitCode: 0, stdout: '1 ', stderr: `${words}\n` }
      : { exitCode: 0, stdout: '', stderr: '' },
    readState: async () => null,
    writeState: async () => undefined,
    storeRoot: () => 'boxes/b/backups',
    storeObjectUrl: (key) => `http://store.invalid/${key}`,
    objectBytes: async () => undefined,
    deleteObjects: async () => undefined,
    mountStore: async () => undefined,
    excludes: () => [],
    checkpointIntervalMs: () => 0,
    now: () => 1_000,
    log: () => undefined,
  };

  const failed = await settle(diskChain(ports).commit('quiesce')).then(() => 'committed', String);

  expect(failed).toContain(words);
});
