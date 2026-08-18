/**
 * Cross-implementation store-format parity: the TS engine (cli-backend
 * createHostCheckpoints, importing core/checkpoints/format) and the zero-dep
 * pc-agent daemon engine (which PINS the same format as literals) must read
 * and restore each other's snapshots from one shared store. This test is the
 * enforcement behind both files' "same store format" comments — real git,
 * one store directory, both engines.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostCheckpoints } from '../src/checkpoints';
import * as v from 'valibot';

const require = createRequire(import.meta.url);
const rawDaemonModule: unknown = require('../../pc-agent/src/index.js');
const daemon = v.parse(v.object({ createCheckpoints: v.function() }), rawDaemonModule);

const checkpointEntrySchema = v.object({
  id: v.string(), dir: v.string(), at: v.number(),
  turnId: v.nullable(v.string()), sessionId: v.nullable(v.string()), reason: v.string(),
});
const checkpointPlanSchema = v.object({
  dir: v.string(), id: v.string(),
  files: v.array(v.object({ path: v.string(), kind: v.string() })),
});
const checkpointRestoreSchema = v.object({
  dir: v.string(), id: v.string(), preRestoreId: v.nullable(v.string()),
});

interface DeviceCheckpointOptions {
  base?: string;
  keep?: number;
  gitBin?: string;
}

interface DeviceCheckpointHint {
  agent: string;
  dir: string;
  turnId?: string;
  sessionId?: string;
}

function createDeviceCheckpoints(options?: DeviceCheckpointOptions) {
  const raw = v.parse(v.object({
    ensure: v.function(), list: v.function(), plan: v.function(), restore: v.function(),
  }), daemon.createCheckpoints(options));
  return {
    ensure: (hint: DeviceCheckpointHint, fallbackDir?: string) =>
      v.parse(v.nullable(v.string()), raw.ensure(hint, fallbackDir)),
    list: (agent: string, limit?: number) =>
      v.parse(v.array(checkpointEntrySchema), raw.list(agent, limit)),
    plan: (agent: string, dir: string, id: string) =>
      v.parse(checkpointPlanSchema, raw.plan(agent, dir, id)),
    restore: (agent: string, dir: string, id: string) =>
      v.parse(checkpointRestoreSchema, raw.restore(agent, dir, id)),
  };
}

const AGENT = 'parity-agent';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'proteus-parity-'));
  const work = join(root, 'project');
  mkdirSync(work, { recursive: true });
  const base = join(root, 'shadow');
  const host = createHostCheckpoints({ agent: AGENT, base });
  const device = createDeviceCheckpoints({ base });
  return { root, work, host, device, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('shadow-git store parity (TS engine ↔ pc-agent daemon)', () => {
  test('a host-engine snapshot is listed, planned, and restored by the daemon', async () => {
    const { work, host, device, cleanup } = setup();
    try {
      writeFileSync(join(work, 'a.txt'), 'host wrote this');
      host.beginTurn({ turnId: 'turn-ts', sessionId: 'sess-1' });
      const id = await host.ensureCheckpoint(work);
      expect(id).toBeTruthy();

      // The daemon reads the SAME store: identical id, turn meta, and dir.
      const listed = device.list(AGENT);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id, dir: work, turnId: 'turn-ts', sessionId: 'sess-1', reason: 'pre-mutation',
      });

      writeFileSync(join(work, 'a.txt'), 'damage');
      writeFileSync(join(work, 'junk.txt'), 'extra');
      const plan = device.plan(AGENT, work, id!);
      expect(plan.files.map((f) => `${f.kind}:${f.path}`).sort())
        .toEqual(['delete:junk.txt', 'modify:a.txt']);

      const result = device.restore(AGENT, work, id!);
      expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('host wrote this');
      expect(existsSync(join(work, 'junk.txt'))).toBe(false);
      // The daemon's pre-restore safety snapshot is null-turn, same as the
      // host engine's — so /undo grouping behaves identically on both sides.
      const preRestore = device.list(AGENT).find((e) => e.id === result.preRestoreId);
      expect(preRestore).toMatchObject({ turnId: null, sessionId: null, reason: 'pre-restore' });
    } finally { cleanup(); }
  });

  test('a daemon snapshot is listed, planned, and restored by the host engine', async () => {
    const { work, host, device, cleanup } = setup();
    try {
      writeFileSync(join(work, 'b.txt'), 'daemon wrote this');
      const id = device.ensure({ agent: AGENT, dir: work, turnId: 'turn-js', sessionId: 'sess-2' });
      expect(id).toBeTruthy();

      const listed = await host.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id, dir: work, turnId: 'turn-js', sessionId: 'sess-2', reason: 'pre-mutation',
      });

      writeFileSync(join(work, 'b.txt'), 'damage');
      const plan = await host.plan(work, id!);
      expect(plan.files).toEqual([{ path: 'b.txt', kind: 'modify' }]);

      await host.restore(work, id!);
      expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('daemon wrote this');
    } finally { cleanup(); }
  });

  test('both engines write byte-identical store scaffolding (marker + excludes)', async () => {
    const { root, work, host, device, cleanup } = setup();
    try {
      // Two separate dirs so each engine inits its own store from scratch.
      const workB = join(root, 'project-b');
      mkdirSync(workB);
      writeFileSync(join(work, 'x'), '1');
      writeFileSync(join(workB, 'x'), '1');
      host.beginTurn({ turnId: 't', sessionId: 's' });
      await host.ensureCheckpoint(work);
      device.ensure({ agent: AGENT, dir: workB, turnId: 't', sessionId: 's' });

      const stores = (await import('node:fs')).readdirSync(join(root, 'shadow', AGENT));
      expect(stores).toHaveLength(2);
      const [a, b] = stores.map((name) => join(root, 'shadow', AGENT, name));
      expect(readFileSync(join(a!, 'info', 'exclude'), 'utf8')).toBe(readFileSync(join(b!, 'info', 'exclude'), 'utf8'));
      // Marker files differ only by the recorded target dir.
      expect(readFileSync(join(a!, 'PROTEUS_WORKDIR'), 'utf8').trim()).toMatch(/project(-b)?$/);
      expect(readFileSync(join(b!, 'PROTEUS_WORKDIR'), 'utf8').trim()).toMatch(/project(-b)?$/);
    } finally { cleanup(); }
  });

  test('both engines skip a path they may not read and record it identically', async () => {
    // The record is what a reader sees in /undo, so "one format regardless of
    // which side wrote it" has to cover an incomplete snapshot too — otherwise
    // the two engines describe the same tree differently.
    const { root, work, host, device, cleanup } = setup();
    const workB = join(root, 'project-b');
    const foreign = [join(work, 'systemd-private-1'), join(workB, 'systemd-private-1')];
    try {
      mkdirSync(workB);
      for (const [index, dir] of [work, workB].entries()) {
        writeFileSync(join(dir, 'mine.txt'), 'kept');
        mkdirSync(foreign[index]!);
        writeFileSync(join(foreign[index]!, 'theirs.txt'), 'not mine');
        chmodSync(foreign[index]!, 0o000);
      }

      host.beginTurn({ turnId: 't', sessionId: 's' });
      const hostId = await host.ensureCheckpoint(work, 'file write');
      const deviceId = device.ensure({ agent: AGENT, dir: workB, turnId: 't', sessionId: 's' }, undefined);
      expect(hostId).toBeTruthy();
      expect(deviceId).toBeTruthy();

      const byId = new Map(device.list(AGENT).map((e) => [e.id, e.reason]));
      expect(byId.get(hostId!)).toBe('file write [skipped 1 unreadable: systemd-private-1]');
      // The daemon's own default reason, with the same note appended by the
      // same encoding.
      expect(byId.get(deviceId!)).toBe('pre-mutation [skipped 1 unreadable: systemd-private-1]');

      // And each snapshot still holds the readable file, read back through the
      // OTHER engine.
      writeFileSync(join(work, 'mine.txt'), 'damaged');
      expect((await host.plan(work, hostId!)).files).toEqual([{ path: 'mine.txt', kind: 'modify' }]);
      expect(device.plan(AGENT, workB, deviceId!).files).toEqual([]);
    } finally {
      for (const dir of foreign) chmodSync(dir, 0o700);
      cleanup();
    }
  });
});
