// Runs the guest program at the native exec boundary: the compare and the replacement are one guest process.
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileIfDigest } from '../src/file-digest-write';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { pipeExec } from './support/native-process';
import { harness } from './support/devbox-harness';
import { TestDevbox } from './support/test-devbox';
import { settle } from '../src/errors';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}digest-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const base64 = (text: string): string => Buffer.from(text).toString('base64');

class TestBox extends TestDevbox<unknown> {
  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

/** A ready box whose digest writes run the guest program over this host's files, behind the box's own resource lane. */
async function readyBox() {
  const { box } = harness(TestBox, undefined, pipeExec);
  await box.devboxStartup();

  return box;
}

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

test('a write whose guest died after its rename and before its answer is answered landed when it is sent again', async () => {
  const path = join(root, 'cut.md');
  const write = { path, data: bytes('the rewrite'), expected: sha256('read'), operation: randomUUID() };
  writeFileSync(path, 'read');

  // The first send's guest is cut the moment its rename has published the bytes, before it records its answer.
  const cut = (argv: string[], options?: ContainerExecOptions) => pipeExec(argv.map((arg, at) => (at === 2
    ? arg.replace(/^answer\(\{'ok': True[^\n]*$/mu, 'os._exit(9)')
    : arg)), options);

  await expect(settle(writeFileIfDigest({ exec: cut }, write))).rejects.toMatchObject({ message: expect.stringContaining('exited 9') });
  expect(readFileSync(path, 'utf8')).toBe('the rewrite');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, write))).toEqual({ ok: true, sha256: sha256('the rewrite') });
});

test('saves through different names for one file order: one lands over the bytes they all read, the rest are told its bytes', async () => {
  const box = await readyBox();
  const space = mkdtempSync(join(root, 'aliased-'));
  const folder = join(space, 'folder');
  mkdirSync(folder);
  const file = join(folder, 'notes.md');

  // Each directory link is its own spelling, so the box's lane claims each apart and the eight run at once.
  const names = Array.from({ length: 8 }, (_, at) => {
    symlinkSync(folder, join(space, `alias-${String(at)}`));

    return join(space, `alias-${String(at)}`, 'notes.md');
  });

  const rounds = [];

  for (let round = 0; round < 32; round += 1) {
    writeFileSync(file, `round ${String(round)}`);
    const answers = await Promise.all(names.map((path, at) => box.writeFileIfDigest(path, base64(`round ${String(round)} by ${String(at)}`), sha256(`round ${String(round)}`), randomUUID())));
    const landed = answers.filter(answer => answer.ok);
    const now = sha256(readFileSync(file, 'utf8'));

    rounds.push({ landed: landed.length, now: landed[0]?.sha256 === now, told: answers.filter(answer => !answer.ok).every(answer => answer.sha256 === now) });
  }

  expect({ rounds, left: readdirSync(folder) }).toEqual({ rounds: rounds.map(() => ({ landed: 1, now: true, told: true })), left: ['notes.md'] });
  await box.destroy();
});

test('a save through a link replaces the file it leads to and keeps the link; a dangling link gets its file, as a plain write gives it', async () => {
  const box = await readyBox();
  const space = mkdtempSync(join(root, 'linked-'));
  const folder = join(space, 'linked');
  mkdirSync(folder);
  const target = join(folder, 'target.md');
  writeFileSync(target, 'old');
  chmodSync(target, 0o640);
  const link = join(space, 'link.md');
  symlinkSync(target, link);
  // Relative, so it resolves from the link's own directory.
  const dangling = join(space, 'dangling.md');
  symlinkSync('linked/absent.md', dangling);
  // A plain write refuses this one: its link leads into a directory that is not there.
  const nowhere = join(space, 'nowhere.md');
  symlinkSync('missing/absent.md', nowhere);

  const saved = await box.writeFileIfDigest(link, base64('new'), sha256('old'), randomUUID());
  const stale = await box.writeFileIfDigest(dangling, base64('first'), sha256('old'), randomUUID());
  const created = await box.writeFileIfDigest(dangling, base64('first'), null, randomUUID());
  const again = await box.writeFileIfDigest(dangling, base64('second'), null, randomUUID());
  const [lost] = await Promise.allSettled([box.writeFileIfDigest(nowhere, base64('first'), null, randomUUID())]);

  expect({
    saved, link: lstatSync(link).isSymbolicLink(), target: readFileSync(target, 'utf8'), mode: statSync(target).mode & 0o777,
    stale, created, again, dangling: lstatSync(dangling).isSymbolicLink(), throughDangling: readFileSync(dangling, 'utf8'),
    lost: lost.status, nowhere: lstatSync(nowhere).isSymbolicLink(), left: readdirSync(folder).sort(),
  }).toEqual({
    saved: { ok: true, sha256: sha256('new') }, link: true, target: 'new', mode: 0o640,
    stale: { ok: false, sha256: null }, created: { ok: true, sha256: sha256('first') }, again: { ok: false, sha256: sha256('first') },
    dangling: true, throughDangling: 'first', lost: 'rejected', nowhere: true, left: ['absent.md', 'target.md'],
  });
  await box.destroy();
});

// 2026-10-12 security review: the replacement dropped the file's owner, group and ACLs, and replaced a read-only file.
test('a replacement keeps the file\'s owner, group and extended attributes, and a read-only file is refused as a plain write refuses it', async () => {
  const path = join(root, 'protected.md');
  writeFileSync(path, 'v1');

  // Another user's file where this test may give one (as root): a replacement made by this process must not take it over.
  if (process.getuid?.() === 0) chownSync(path, 65534, 65534);
  const before = statSync(path);

  // An extended attribute where this file system keeps them (ACLs are kept the same way); none is asked of others.
  const xattr = async (code: string) => {
    const child = Bun.spawn(['python3', '-c', code, path], { stdout: 'pipe', stderr: 'ignore' });

    return { exitCode: await child.exited, stdout: await new Response(child.stdout).text() };
  };

  const tagged = (await xattr("import os, sys; os.setxattr(sys.argv[1], 'user.kinu', b'kept')")).exitCode === 0;
  const operation = (): string => randomUUID();

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('v2'), expected: sha256('v1'), operation: operation() })))
    .toEqual({ ok: true, sha256: sha256('v2') });
  expect(statSync(path)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode });

  if (tagged) expect((await xattr("import os, sys; print(os.getxattr(sys.argv[1], 'user.kinu').decode(), end='')")).stdout).toBe('kept');

  chmodSync(path, 0o444);

  try {
    const readOnly = settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('v3'), expected: sha256('v2'), operation: operation() }));

    // Root writes any file, as a plain write does; anyone else is refused.
    if (process.getuid?.() === 0) expect(await readOnly).toMatchObject({ ok: true });
    else await expect(readOnly).rejects.toThrow('Permission denied');
  } finally {
    chmodSync(path, 0o644);
  }
});
