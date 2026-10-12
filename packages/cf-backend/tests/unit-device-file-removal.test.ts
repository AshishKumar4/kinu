/**
 * Deleting on a device, as the file manager does it (`deleteExecutorPathOp`), against the real daemon
 * (`packages/pc-agent/src/index.js`): a link is removed as a link, never what it leads to, and a directory goes whole.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteExecutorPathOp, deviceFiles, type DeviceStatus, type DeviceTransport } from '@kinu.run/core';
import { scratchDir } from '@kinu.run/test-utils';
import { pcAgentDaemon } from './helpers/pc-agent-daemon';

/** Every frame to the daemon as the hub sends it, the owner's Sandbox switch off. */
function tunnelToDaemon(): DeviceTransport {
  const daemon = pcAgentDaemon();
  const connected: DeviceStatus = { connected: true, registered: true, toolchain: null };
  let next = 0;

  return {
    status: () => connected,
    refreshStatus: async () => connected,
    rpc: async (method, params) => await daemon.answer({ id: `rpc-removal-${String(next += 1)}`, method, params, sandbox: { tier: 'raw', agentHome: '', roots: [] } }),
  };
}

const files = deviceFiles(tunnelToDaemon(), { consentedRoot: async () => '/', deviceHome: async () => '/', scope: async () => 'unconfined' });

const router = { getProvider: () => ({ files, homeDir: async () => '/' }) };

/** A directory holding one file, and a link to it beside it. */
function linkedDirectory(name: string) {
  const root = scratchDir(name);
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'kept.txt'), 'the target keeps this');
  const link = join(root, 'link');
  symlinkSync(target, link);

  return { root, target, link };
}

describe('deleting on a device', () => {
  test('a link to a directory is removed as the link, and what it leads to stays', async () => {
    const { target, link } = linkedDirectory('device-remove-link');

    expect(await deleteExecutorPathOp(router, 'device', link)).toEqual({ ok: true });
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readdirSync(target)).toEqual(['kept.txt']);
  });

  test('a link that leads nowhere is removed', async () => {
    const root = scratchDir('device-remove-dangling');
    const link = join(root, 'gone');
    symlinkSync(join(root, 'never-made'), link);

    expect(await deleteExecutorPathOp(router, 'device', link)).toEqual({ ok: true });
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('a directory is removed whole, with what is under it', async () => {
    const root = scratchDir('device-remove-dir');
    const dir = join(root, 'build');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'a.js'), 'a');
    writeFileSync(join(dir, 'nested', 'b.js'), 'b');

    expect(await deleteExecutorPathOp(router, 'device', dir)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
  });

  test('a directory holding a link to another directory takes the link, not the other directory', async () => {
    const { root, target } = linkedDirectory('device-remove-dir-with-link');
    const dir = join(root, 'holder');
    mkdirSync(dir);
    symlinkSync(target, join(dir, 'into-target'));

    expect(await deleteExecutorPathOp(router, 'device', dir)).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(target)).toEqual(['kept.txt']);
  });
});
