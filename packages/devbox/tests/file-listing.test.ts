// Runs the guest program at the native exec boundary, against Linux metadata rather than mocked file results.
// The same program and call-count contract run on Cloudflare golden containers at gate:devbox-e2e (D81).
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles } from '../src/file-listing';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { pipeExec } from './support/native-process';
import { settle } from '../src/errors';
import { Devbox, harness } from './support/devbox-harness';

const root = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}listing-`));

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('listing metadata costs one native exec for an empty, small or wide directory', async () => {
  for (const width of [0, 1, 72, 1_024]) {
    const path = join(root, String(width));
    mkdirSync(path);

    for (let entry = 0; entry < width; entry += 1) writeFileSync(join(path, String(entry)), String(entry));

    let calls = 0;

    const container = {
      exec: (argv: string[], options?: ContainerExecOptions) => {
        calls += 1;

        return pipeExec(argv, options);
      },
    };

    const listed = await settle(listFiles(container, path));
    expect({ count: listed.files.length, calls }).toEqual({ count: width, calls: 1 });

    for (const entry of listed.files) {
      const actual = lstatSync(entry.path);
      expect({ size: entry.size, mode: entry.mode, mtimeMs: entry.mtimeMs }).toEqual({ size: actual.size, mode: actual.mode, mtimeMs: Math.floor(actual.mtimeMs) });
    }
  }
});

test('types, private modes, mtimes and unusual names survive a recursive listing without following links', async () => {
  const path = join(root, 'types');
  mkdirSync(path);
  const name = 'quote\' newline\n雪';
  writeFileSync(join(path, name), 'bytes');
  chmodSync(join(path, name), 0o600);
  utimesSync(join(path, name), 1_700_000_000, 1_700_000_000);
  mkdirSync(join(path, 'private'), { mode: 0o700 });
  writeFileSync(join(path, 'private', 'child'), 'child');
  symlinkSync('private', join(path, 'directory-link'));
  symlinkSync('missing', join(path, 'dangling'));

  const listed = await settle(listFiles({ exec: pipeExec }, path, { recursive: true }));
  const entries = new Map(listed.files.map(entry => [entry.name, entry]));
  expect(listed.files.length).toBe(5);
  expect(entries.get(name)).toMatchObject({ size: 5, type: 'file', mode: 0o100600, mtimeMs: 1_700_000_000_000 });
  expect(entries.get('private')).toMatchObject({ type: 'directory', mode: 0o40700 });
  expect(entries.get('directory-link')).toMatchObject({ type: 'symlink', size: 7, isDirectory: false });
  expect(entries.get('dangling')).toMatchObject({ type: 'symlink', size: 7, isDirectory: false });
});

test('directory failures retain their POSIX errno rather than becoming an empty listing', async () => {
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'file');
  const loop = join(root, 'loop');
  symlinkSync('loop', loop);

  for (const [path, code] of [[join(root, 'absent'), 'ENOENT'], [file, 'ENOTDIR'], [loop, 'ELOOP']]) {
    await expect(settle(listFiles({ exec: pipeExec }, path))).rejects.toMatchObject({ code: 'file', cause: { kind: 'devbox.file', code, path, operation: 'readDirectory' } });
  }
});

test('a native stat reads one entry without listing any of its siblings, including the root', async () => {
  const { box, container, state } = harness(Devbox);
  await box.start();
  const native = state.container;

  if (native === undefined) throw new Error('the test box has no native container');
  const exec = native.exec.bind(native);
  let calls = 0;
  native.exec = (argv: string[], options?: ContainerExecOptions) => {
    calls += 1;

    return exec(argv, options);
  };

  container.files.set('/workspace/kept', 'bytes');

  for (let entry = 0; entry < 72; entry += 1) container.files.set(`/workspace/sibling-${String(entry)}`, 'sibling');

  try {
    for (const follow of [true, false]) {
      calls = 0;
      expect(await box.statFile('/workspace/kept', { follow })).toMatchObject({ type: 'file', size: 5, mode: 0o100644 });
      expect(calls).toBe(1);
    }

    calls = 0;
    expect(await box.statFile('/')).toMatchObject({ type: 'directory' });
    expect(calls).toBe(1);
    await expect(box.statFile('/workspace/absent')).rejects.toMatchObject({ cause: { kind: 'devbox.file', code: 'ENOENT' } });
  } finally { await box.destroy(); }
});

test('a listing keeps its directory claimed until the guest metadata read settles', async () => {
  const path = join(root, 'claimed');
  mkdirSync(path);
  writeFileSync(join(path, 'item'), 'before');
  const { box, state } = harness(Devbox);
  await box.start();
  const native = state.container;

  if (native === undefined) throw new Error('the test box has no native container');
  const exec = native.exec.bind(native);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  native.exec = async (argv: string[], options?: ContainerExecOptions) => {
    calls += 1;

    if (calls === 1) {
      entered.resolve();
      await release.promise;

      return pipeExec(argv, options);
    }

    return exec(argv, options);
  };

  const listing = box.listFiles(path);
  await entered.promise;
  const writing = box.writeFile(`${path}/item`, 'after');

  try {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(calls).toBe(1);
  } finally {
    release.resolve();

    try { await Promise.all([listing, writing]); }
    finally { await box.destroy(); }
  }
});
