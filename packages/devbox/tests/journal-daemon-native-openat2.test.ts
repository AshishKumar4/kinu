import { closeSync, fstatSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { BeneathRoot, MAX_NAME_BYTES, MAX_RANGE_BYTES, RENAME_NOREPLACE } from '../src/native-openat2';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))));

async function rootFixture(): Promise<{ root: string; fs: BeneathRoot }> {
  const root = await mkdtemp(join(tmpdir(), 'beneath-root-'));
  roots.push(root);
  return { root, fs: new BeneathRoot(root) };
}

describe('BeneathRoot', () => {
  test('refuses hostile paths before any syscall', async () => {
    const { fs } = await rootFixture();
    try {
      for (const path of ['', '/etc/passwd', '../outside', 'a/../b', 'a//b', 'a/./b', `a/${'x'.repeat(MAX_NAME_BYTES + 1)}`, `a\0b`]) {
        expect(() => fs.openRead(path)).toThrow('non-relative path');
      }
      expect(() => fs.readRange('a', 0, MAX_RANGE_BYTES + 1)).toThrow('range exceeds');
    } finally {
      fs.close();
    }
  });

  test('creates all ancestry fd-relatively and never follows a swapped symlink', async () => {
    const { root, fs } = await rootFixture();
    try {
      fs.mkdir('safe/deep');
      const fd = fs.createFile('safe/deep/file', undefined, 0o640);
      closeSync(fd);
      await symlink('/tmp', join(root, 'safe', 'swap'));
      // The swapped symlink is refused at open, not followed out of the
      // root: errno 40 names the symlink traversal the flags forbid.
      expect(() => fs.createFile('safe/swap/escape')).toThrow('openat2 refused safe/swap/escape: errno 40');
      expect(() => fs.openRead('safe/swap/escape')).toThrow('openat2 refused safe/swap/escape: errno 40');
    } finally {
      fs.close();
    }
  });

  test('preserves inode identity for hardlinks and supports atomic rename flags', async () => {
    const { fs } = await rootFixture();
    try {
      fs.mkdir('dir');
      const fd = fs.createFile('dir/source');
      closeSync(fd);
      fs.writeRange('dir/source', 0, new TextEncoder().encode('payload'));
      fs.hardlink('dir/source', 'dir/link');
      const source = fs.openRead('dir/source');
      const link = fs.openRead('dir/link');
      try {
        expect(fstatSync(source).ino).toBe(fstatSync(link).ino);
      } finally {
        closeSync(link);
        closeSync(source);
      }
      const existing = fs.createFile('dir/existing');
      expect(() => fs.rename('dir/source', 'dir/existing', RENAME_NOREPLACE))
        .toThrow('renameat2 refused dir/source: errno 17');
      closeSync(existing);
      expect(() => fs.rename('dir/source', 'dir/existing', RENAME_NOREPLACE))
        .toThrow('renameat2 refused dir/source: errno 17');
      fs.rename('dir/source', 'dir/renamed');
      expect(new TextDecoder().decode(fs.readRange('dir/renamed', 0, 7))).toBe('payload');
    } finally {
      fs.close();
    }
  });

  test('bounds robust positioned I/O and reports sparse data extents', async () => {
    const { fs } = await rootFixture();
    try {
      const fd = fs.createFile('sparse');
      closeSync(fd);
      fs.writeRange('sparse', 1_048_576, new Uint8Array([1, 2, 3, 4]));
      const extents = fs.sparseExtents('sparse');
      expect(extents.some((extent) => extent.offset <= 1_048_576 && extent.offset + extent.length >= 1_048_580)).toBe(true);
      fs.truncate('sparse', 1_048_580);
      fs.fallocate('sparse', 2_097_152, 4);
      expect(fs.readRange('sparse', 1_048_576, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    } finally {
      fs.close();
    }
  });


  test('changes metadata and xattrs through an fd without resolving a final symlink', async () => {
    const { fs } = await rootFixture();
    try {
      const fd = fs.createFile('metadata');
      closeSync(fd);
      fs.chmod('metadata', 0o640);
      fs.chown('metadata', process.getuid?.() ?? 0, process.getgid?.() ?? 0);
      fs.utimens('metadata', 1_700_000_000_000_000_000n, 1_700_000_001_000_000_000n);
      fs.setxattr('metadata', 'user.kinu.test', new Uint8Array([7, 8, 9]));
      expect(fs.listxattr('metadata')).toContain('user.kinu.test');
      expect(fs.getxattr('metadata', 'user.kinu.test')).toEqual(new Uint8Array([7, 8, 9]));
      fs.removexattr('metadata', 'user.kinu.test');
      expect(() => fs.getxattr('metadata', 'user.kinu.test')).toThrow('fgetxattr refused metadata: errno 61');
    } finally {
      fs.close();
    }
  });
  test('supports final symlinks but never traverses them and rejects use after close', async () => {
    const { fs } = await rootFixture();
    fs.symlink('target', 'link');
    expect(() => fs.openRead('link')).toThrow('openat2 refused link: errno 40');
    fs.unlink('link');
    fs.close();
    expect(() => fs.openRead('anything')).toThrow('BeneathRoot is closed');
  });

  // THE PATH BYTES REACH THE KERNEL, EVERY CALL. A bounded restore creates a
  // file, truncates it, awaits its bytes from the store and writes them; the
  // third openat2 of `k/f0268.txt` once answered ENOENT because the kernel
  // read `"\200\0357\313\270\3"`, a freelist link, at the address the path
  // buffer had been freed from (strace, 2026-09-02). Measured on the unfixed
  // code with a runner-sized heap: 1 ENOENT per 20,000 of these cycles, so
  // 200,000 cycles miss the defect once in e^-10 runs. The heap is what makes
  // the collector run mid-call; a bare loop measured 0 in 60,000.
  test('a path just created opens for writing after an await, 200,000 times', async () => {
    const { root, fs } = await rootFixture();
    const heap = Array.from({ length: 1002 }, (_, index) => ({
      key: `obj/${'a'.repeat(64)}${index}`, sha256: 'b'.repeat(64), doc: { path: `k/f${index}`, chunks: [{ hash: 'c'.repeat(64), size: 16 }] },
    }));
    const object = join(root, 'object.bin');
    await Bun.write(object, 'file bytes');
    try {
      fs.mkdir('k');
      for (let index = 0; index < 200_000; index += 1) {
        const path = `k/f${String(index % 1000).padStart(4, '0')}.txt`;
        closeSync(fs.createFile(path, undefined, 0o644));
        fs.truncate(path, 10);
        const bytes = new Uint8Array(await Bun.file(object).slice(0, 10).arrayBuffer());
        expect(fs.writeRange(path, 0, bytes)).toBe(10);
      }
      expect(heap).toHaveLength(1002);
    } finally {
      fs.close();
    }
  }, 60_000);
});
