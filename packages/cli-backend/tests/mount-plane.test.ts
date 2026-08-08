// The local mount plane. The cloud backend's workspace VFS is a mount table
// with typed absence — /local, /sandbox, /nimbus, /pc, each either mounted or
// RESERVED with a reason. The local backend mounted /local alone, so every /pc
// address the cloud agent can use silently compat-routed into /local, and the
// `laptop` executor's files were unreachable by composite path. /pc is now the
// host filesystem directly (no tunnel — the agent is on that machine), and the
// two Cloudflare-only planes are reserved rather than absent.
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompositeVFS } from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshRuntime() {
  const db = new Database(':memory:');
  return createCLIRuntime(db as never, {
    dbPath: `/tmp/proteus-mount-${Math.floor(performance.now())}.db`,
    llm: { name: 'x', baseURL: 'http://localhost:0', headers: {}, model: 'm' },
  });
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-mount-'));
  tempDirs.push(dir);
  return dir;
}

describe('the local mount table', () => {
  test('mounts /local and /pc, and reserves the Cloudflare-only planes', () => {
    const vfs = freshRuntime().storage.vfs as CompositeVFS;
    const byName = new Map(vfs.listMounts().map((m) => [m.name, m]));
    expect([...byName.keys()].sort()).toEqual(['local', 'nimbus', 'pc', 'sandbox']);

    expect(byName.get('pc')).toMatchObject({
      prefix: '/pc', live: true, reason: null,
      policy: { readOnly: false, rootPath: '/', consistency: 'live-shared' },
    });
    // Typed absence, not silence: the agent is told WHY, exactly as cf reports
    // an unconfigured binding.
    for (const name of ['sandbox', 'nimbus']) {
      expect(byName.get(name)!.live).toBe(false);
      expect(byName.get(name)!.reason).toContain('Cloudflare binding');
    }
  });

  test('/pc reads and writes the real host filesystem', async () => {
    const vfs = freshRuntime().storage.vfs;
    const dir = scratch();
    writeFileSync(join(dir, 'existing.txt'), 'from the host');

    expect(await vfs.readFile(`/pc${join(dir, 'existing.txt')}`, { encoding: 'utf8' }))
      .toBe('from the host');
    expect(await vfs.readdir(`/pc${dir}`)).toEqual(['existing.txt']);

    await vfs.writeFile(`/pc${join(dir, 'nested', 'written.txt')}`, 'from the agent');
    expect(readFileSync(join(dir, 'nested', 'written.txt'), 'utf8')).toBe('from the agent');

    const stat = await vfs.stat(`/pc${join(dir, 'nested')}`);
    expect(stat?.isDir).toBe(true);
    // Core VFS contract: a missing path stats as null rather than throwing.
    expect(await vfs.stat(`/pc${join(dir, 'absent')}`)).toBeNull();

    await vfs.unlink(`/pc${join(dir, 'existing.txt')}`);
    expect(await vfs.exists(`/pc${join(dir, 'existing.txt')}`)).toBe(false);
  });

  test('a reserved plane fails with its reason instead of hitting /local', async () => {
    const vfs = freshRuntime().storage.vfs;
    await expect(vfs.readFile('/sandbox/workspace/x.txt')).rejects.toThrow(/Cloudflare binding/);
  });

  test('/pc addresses stay distinct from /local addresses', async () => {
    const vfs = freshRuntime().storage.vfs;
    const dir = scratch();
    await vfs.writeFile('/workspace/notes.md', 'durable');
    await vfs.writeFile(`/pc${join(dir, 'notes.md')}`, 'host');
    expect(await vfs.readFile('/workspace/notes.md', { encoding: 'utf8' })).toBe('durable');
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('host');
  });

  // The codemode write path end-to-end: workspace.writeFile creates parent
  // directories first, and mkdir of a top-level non-mount name used to be
  // refused as a mount-table entry — EROFS on a path whose write works.
  test('REGRESSION: codemode workspace.writeFile survives its own parent mkdir', async () => {
    const rt = freshRuntime();
    const workspace = rt.executionRouter?.getProvider('workspace');
    expect(workspace).toBeDefined();

    const written = await workspace!.tools.writeFile.execute('/workspace/x.md', 'from codemode');
    expect(String(written)).toContain('Written');
    expect(await rt.storage.vfs.readFile('/local/workspace/x.md', { encoding: 'utf8' })).toBe('from codemode');

    // The host plane (/pc) is a live mount, so its root needs no mkdir either.
    const dir = scratch();
    expect(String(await workspace!.tools.writeFile.execute(`/pc${join(dir, 'y.md')}`, 'on the host')))
      .toContain('Written');
    expect(readFileSync(join(dir, 'y.md'), 'utf8')).toBe('on the host');
  });
});
