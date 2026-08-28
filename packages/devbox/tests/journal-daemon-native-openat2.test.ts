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
      expect(() => fs.createFile('safe/swap/escape')).toThrow();
      expect(() => fs.openRead('safe/swap/escape')).toThrow();
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
      closeSync(existing);
      expect(() => fs.rename('dir/source', 'dir/existing', RENAME_NOREPLACE)).toThrow();
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
      expect(() => fs.getxattr('metadata', 'user.kinu.test')).toThrow();
    } finally {
      fs.close();
    }
  });
  test('supports final symlinks but never traverses them and rejects use after close', async () => {
    const { fs } = await rootFixture();
    fs.symlink('target', 'link');
    expect(() => fs.openRead('link')).toThrow();
    fs.unlink('link');
    fs.close();
    expect(() => fs.openRead('anything')).toThrow('BeneathRoot is closed');
  });
});
