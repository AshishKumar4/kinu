// Runs the guest program at the native exec boundary: the compare and the replacement are one guest process.
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileIfDigest } from '../src/file-digest-write';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { pipeExec } from './support/native-process';
import { settle } from '../src/errors';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}digest-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('a write lands only over the bytes it names, in one guest process, keeping the mode', async () => {
  const path = join(root, 'notes.md');
  writeFileSync(path, 'read by the agent');
  chmodSync(path, 0o640);
  let calls = 0;

  const container = {
    exec: (argv: string[], options?: ContainerExecOptions) => {
      calls += 1;

      return pipeExec(argv, options);
    },
  };

  // Saved over after the agent read it.
  writeFileSync(path, 'saved by the owner');
  const stale = await settle(writeFileIfDigest(container, { path, data: bytes('the rewrite'), expected: sha256('read by the agent'), operation: randomUUID() }));

  expect({ stale, now: readFileSync(path, 'utf8') }).toEqual({ stale: { ok: false, sha256: sha256('saved by the owner') }, now: 'saved by the owner' });

  const fresh = await settle(writeFileIfDigest(container, { path, data: bytes('the rewrite'), expected: sha256('saved by the owner'), operation: randomUUID() }));

  expect({ fresh, now: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777, calls, left: readdirSync(root) })
    .toEqual({ fresh: { ok: true, sha256: sha256('the rewrite') }, now: 'the rewrite', mode: 0o640, calls: 2, left: ['notes.md'] });
});

test('with no digest it creates the file, parents too, only where none is', async () => {
  const path = join(root, 'deep', 'er', 'new.md');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('first'), expected: null, operation: randomUUID() }))).toEqual({ ok: true, sha256: sha256('first') });
  expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('second'), expected: null, operation: randomUUID() }))).toEqual({ ok: false, sha256: sha256('first') });
  expect(readFileSync(path, 'utf8')).toBe('first');
});

test('a repeated operation is answered what its first send did: a landed write stays landed though the file moved since', async () => {
  const path = join(root, 'landed.md');
  const write = { path, data: bytes('the rewrite'), expected: sha256('read'), operation: randomUUID() };
  writeFileSync(path, 'read');

  const first = await settle(writeFileIfDigest({ exec: pipeExec }, write));

  // Saved over after the first send landed and before its resend.
  writeFileSync(path, 'saved by the owner');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, write))).toEqual(first);
  expect({ first, now: readFileSync(path, 'utf8') }).toEqual({ first: { ok: true, sha256: sha256('the rewrite') }, now: 'saved by the owner' });
});

test('a repeated operation is answered what its first send did: a refused write stays refused though the file now holds its bytes', async () => {
  const path = join(root, 'refused.md');
  // Already the bytes the write carries, but not the ones it was read as.
  writeFileSync(path, 'the rewrite');
  const write = { path, data: bytes('the rewrite'), expected: sha256('read'), operation: randomUUID() };

  const first = await settle(writeFileIfDigest({ exec: pipeExec }, write));

  writeFileSync(path, 'read');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, write))).toEqual(first);
  expect({ first, now: readFileSync(path, 'utf8') }).toEqual({ first: { ok: false, sha256: sha256('the rewrite') }, now: 'read' });
});
