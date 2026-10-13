// Runs the guest program at the native exec boundary: the compare and the write are one guest process.
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { chownSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('a write lands only over the bytes it names, keeping the mode', async () => {
  const path = join(root, 'notes.md');
  writeFileSync(path, 'read by the agent');
  chmodSync(path, 0o640);
  const container = { exec: pipeExec };

  // Saved over after the agent read it.
  writeFileSync(path, 'saved by the owner');
  const stale = await settle(writeFileIfDigest(container, { path, data: bytes('the rewrite'), expected: sha256('read by the agent'), operation: randomUUID(), settled: [] }));

  expect({ stale, now: readFileSync(path, 'utf8') }).toEqual({ stale: { ok: false, sha256: sha256('saved by the owner') }, now: 'saved by the owner' });

  const fresh = await settle(writeFileIfDigest(container, { path, data: bytes('the rewrite'), expected: sha256('saved by the owner'), operation: randomUUID(), settled: [] }));

  expect({ fresh, now: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 })
    .toEqual({ fresh: { ok: true, sha256: sha256('the rewrite') }, now: 'the rewrite', mode: 0o640 });
});

test('with no digest it creates the file, parents too, only where none is', async () => {
  const path = join(root, 'deep', 'er', 'new.md');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('first'), expected: null, operation: randomUUID(), settled: [] }))).toEqual({ ok: true, sha256: sha256('first') });
  expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('second'), expected: null, operation: randomUUID(), settled: [] }))).toEqual({ ok: false, sha256: sha256('first') });
  expect(readFileSync(path, 'utf8')).toBe('first');
});

test('a repeated operation is answered what its first send did: a landed write stays landed though the file moved since', async () => {
  const path = join(root, 'landed.md');
  const write = { path, data: bytes('the rewrite'), expected: sha256('read'), operation: randomUUID(), settled: [] };
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
  const write = { path, data: bytes('the rewrite'), expected: sha256('read'), operation: randomUUID(), settled: [] };

  const first = await settle(writeFileIfDigest({ exec: pipeExec }, write));

  writeFileSync(path, 'read');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, write))).toEqual(first);
  expect({ first, now: readFileSync(path, 'utf8') }).toEqual({ first: { ok: false, sha256: sha256('the rewrite') }, now: 'read' });
});

/**
 * The guest's own process, cut at the first file it opens once `path` holds `published`: past the write, before the
 * answer is recorded. A Python audit hook loaded at the guest's start (`sitecustomize`), so the program runs unchanged.
 */
function cutOnceLanded(path: string, published: string): Container['exec'] {
  const hook = mkdtempSync(join(root, 'cut-'));
  writeFileSync(join(hook, 'sitecustomize.py'), [
    'import hashlib, os, sys',
    'busy = False',
    'def cut(event, args):',
    '    global busy',
    "    if event != 'open' or busy:",
    '        return',
    '    busy = True',
    '    try:',
    `        with open(${JSON.stringify(path)}, 'rb') as held:`,
    `            if hashlib.sha256(held.read()).hexdigest() == ${JSON.stringify(sha256(published))}:`,
    '                os._exit(9)',
    '    except FileNotFoundError:',
    '        pass',
    '    finally:',
    '        busy = False',
    'sys.addaudithook(cut)',
  ].join('\n'));

  return (argv, options) => pipeExec(argv, { ...options, env: { ...options?.env, PYTHONPATH: hook } });
}

// 2026-10-13 review: the replay of a send cut between its write and its answer had lost its coverage.
test('a send cut after its write landed and before its answer is answered that it landed, and a later save stays', async () => {
  const path = join(root, 'cut.md');
  const write = { path, data: bytes('the rewrite'), expected: sha256('read'), operation: randomUUID(), settled: [] };
  writeFileSync(path, 'read');

  await expect(settle(writeFileIfDigest({ exec: cutOnceLanded(path, 'the rewrite') }, write))).rejects.toMatchObject({ message: expect.stringContaining('exited 9') });
  expect(readFileSync(path, 'utf8')).toBe('the rewrite');

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, write))).toEqual({ ok: true, sha256: sha256('the rewrite') });
  writeFileSync(path, 'saved by the owner');
  expect(await settle(writeFileIfDigest({ exec: pipeExec }, write))).toEqual({ ok: true, sha256: sha256('the rewrite') });
  expect(readFileSync(path, 'utf8')).toBe('saved by the owner');
});

test('the guest keeps a write\'s answer only until its caller says it holds it', async () => {
  const path = join(root, 'acknowledged.md');
  writeFileSync(path, 'v0');
  const operations = Array.from({ length: 4 }, () => randomUUID());

  for (const [at, operation] of operations.entries()) {
    const settled = operations.slice(at - 1, at);

    expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes(`v${String(at + 1)}`), expected: sha256(`v${String(at)}`), operation, settled })))
      .toMatchObject({ ok: true });
  }

  const kept = readdirSync('/tmp/kinu-digest-writes');

  expect(operations.map((operation) => kept.some((entry) => entry.startsWith(operation)))).toEqual([false, false, false, true]);
});

// 2026-10-13 review: a replacement through one hard link left the others on the old bytes.
test('saves through different names for one file order: one lands over the bytes they all read, the rest are told its bytes', async () => {
  const box = await readyBox();
  const space = mkdtempSync(join(root, 'aliased-'));
  const folder = join(space, 'folder');
  mkdirSync(folder);
  const file = join(folder, 'notes.md');
  writeFileSync(file, 'created');
  const inode = statSync(file).ino;

  // Each directory link and each hard link in its own directory is its own spelling, so the box's lane claims each
  // apart and the eight run at once.
  const names = Array.from({ length: 8 }, (_, at) => {
    if (at % 2 === 0) {
      symlinkSync(folder, join(space, `alias-${String(at)}`));

      return join(space, `alias-${String(at)}`, 'notes.md');
    }

    mkdirSync(join(space, `hard-${String(at)}`));
    linkSync(file, join(space, `hard-${String(at)}`, 'notes.md'));

    return join(space, `hard-${String(at)}`, 'notes.md');
  });

  const rounds = [];

  for (let round = 0; round < 32; round += 1) {
    writeFileSync(file, `round ${String(round)}`);

    const answers = await Promise.all(names.map((path, at) => box.writeFileIfDigest({
      path, contentBase64: base64(`round ${String(round)} by ${String(at)}`), expected: sha256(`round ${String(round)}`), operation: randomUUID(), settled: [],
    })));

    const landed = answers.filter(answer => answer.ok);
    const now = sha256(readFileSync(file, 'utf8'));

    rounds.push({ landed: landed.length, now: landed[0]?.sha256 === now, told: answers.filter(answer => !answer.ok).every(answer => answer.sha256 === now) });
  }

  expect({ rounds, left: readdirSync(folder), same: names.every((name) => statSync(name).ino === inode) })
    .toEqual({ rounds: rounds.map(() => ({ landed: 1, now: true, told: true })), left: ['notes.md'], same: true });
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

  const saved = await box.writeFileIfDigest({ path: link, contentBase64: base64('new'), expected: sha256('old'), operation: randomUUID(), settled: [] });
  const stale = await box.writeFileIfDigest({ path: dangling, contentBase64: base64('first'), expected: sha256('old'), operation: randomUUID(), settled: [] });
  const created = await box.writeFileIfDigest({ path: dangling, contentBase64: base64('first'), expected: null, operation: randomUUID(), settled: [] });
  const again = await box.writeFileIfDigest({ path: dangling, contentBase64: base64('second'), expected: null, operation: randomUUID(), settled: [] });
  const [lost] = await Promise.allSettled([box.writeFileIfDigest({ path: nowhere, contentBase64: base64('first'), expected: null, operation: randomUUID(), settled: [] })]);

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
test('a write keeps the file\'s owner, group and extended attributes, and a read-only file is refused as a plain write refuses it', async () => {
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

  expect(await settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('v2'), expected: sha256('v1'), operation: operation(), settled: [] })))
    .toEqual({ ok: true, sha256: sha256('v2') });
  expect(statSync(path)).toMatchObject({ uid: before.uid, gid: before.gid, mode: before.mode });

  if (tagged) expect((await xattr("import os, sys; print(os.getxattr(sys.argv[1], 'user.kinu').decode(), end='')")).stdout).toBe('kept');

  chmodSync(path, 0o444);

  try {
    const readOnly = settle(writeFileIfDigest({ exec: pipeExec }, { path, data: bytes('v3'), expected: sha256('v2'), operation: operation(), settled: [] }));

    // Root writes any file, as a plain write does; anyone else is refused.
    if (process.getuid?.() === 0) expect(await readOnly).toMatchObject({ ok: true });
    else {
      await expect(readOnly).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe('v2');
    }
  } finally {
    chmodSync(path, 0o644);
  }
});
