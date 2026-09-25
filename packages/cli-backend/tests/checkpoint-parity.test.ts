/** Store-format parity: the TS engine and the pc-agent daemon engine (which pins the format as literals) restore each other's snapshots. */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

import { join } from 'node:path';
import { createHostCheckpoints } from '../src/checkpoints';
import { present } from '@kinu.run/test-utils';
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
    ensure: async (hint: DeviceCheckpointHint, fallbackDir?: string) =>
      v.parse(v.nullable(v.string()), await raw.ensure(hint, fallbackDir)),
    list: async (agent: string, limit?: number) =>
      v.parse(v.array(checkpointEntrySchema), await raw.list(agent, limit)),
    plan: async (agent: string, dir: string, id: string) =>
      v.parse(checkpointPlanSchema, await raw.plan(agent, dir, id)),
    restore: async (agent: string, dir: string, id: string) =>
      v.parse(checkpointRestoreSchema, await raw.restore(agent, dir, id)),
  };
}

const AGENT = 'parity-agent';

function setup() {
  const root = scratchDir('parity');
  const work = join(root, 'project');
  mkdirSync(work, { recursive: true });
  const base = join(root, 'shadow');
  const host = createHostCheckpoints({ agent: AGENT, base });
  const device = createDeviceCheckpoints({ base });

  return { root, work, host, device };
}

describe('shadow-git store parity (TS engine ↔ pc-agent daemon)', () => {
  test('a host-engine snapshot is listed, planned, and restored by the daemon', async () => {
    const { work, host, device } = setup();

    writeFileSync(join(work, 'a.txt'), 'host wrote this');
    host.beginTurn({ turnId: 'turn-ts', sessionId: 'sess-1' });
    const id = present(await host.ensureCheckpoint(work), 'the host engine snapshot id');
    expect(id).toBeTruthy();

    const listed = await device.list(AGENT);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id, dir: work, turnId: 'turn-ts', sessionId: 'sess-1', reason: 'pre-mutation',
    });

    writeFileSync(join(work, 'a.txt'), 'damage');
    writeFileSync(join(work, 'junk.txt'), 'extra');
    const plan = await device.plan(AGENT, work, id);
    expect(plan.files.map((f) => `${f.kind}:${f.path}`).sort())
      .toEqual(['delete:junk.txt', 'modify:a.txt']);

    const result = await device.restore(AGENT, work, id);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('host wrote this');
    expect(existsSync(join(work, 'junk.txt'))).toBe(false);
    // Both pre-restore safety snapshots are null-turn, so /undo grouping matches.
    const preRestore = (await device.list(AGENT)).find((e) => e.id === result.preRestoreId);
    expect(preRestore).toMatchObject({ turnId: null, sessionId: null, reason: 'pre-restore' });
  });

  test('a daemon snapshot is listed, planned, and restored by the host engine', async () => {
    const { work, host, device } = setup();

    writeFileSync(join(work, 'b.txt'), 'daemon wrote this');
    const id = present(await device.ensure({ agent: AGENT, dir: work, turnId: 'turn-js', sessionId: 'sess-2' }), 'the daemon engine snapshot id');
    expect(id).toBeTruthy();

    const listed = await host.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id, dir: work, turnId: 'turn-js', sessionId: 'sess-2', reason: 'pre-mutation',
    });

    writeFileSync(join(work, 'b.txt'), 'damage');
    const plan = await host.plan(work, id);
    expect(plan.files).toEqual([{ path: 'b.txt', kind: 'modify' }]);

    await host.restore(work, id);
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('daemon wrote this');
  });

  test('both engines write byte-identical store scaffolding (marker + excludes)', async () => {
    const { root, work, host, device } = setup();

    const workB = join(root, 'project-b');
    mkdirSync(workB);
    writeFileSync(join(work, 'x'), '1');
    writeFileSync(join(workB, 'x'), '1');
    host.beginTurn({ turnId: 't', sessionId: 's' });
    await host.ensureCheckpoint(work);
    await device.ensure({ agent: AGENT, dir: workB, turnId: 't', sessionId: 's' });

    const stores = (await import('node:fs')).readdirSync(join(root, 'shadow', AGENT));
    expect(stores).toHaveLength(2);
    const [a, b] = stores.map((name) => join(root, 'shadow', AGENT, name));
    expect(readFileSync(join(a, 'info', 'exclude'), 'utf8')).toBe(readFileSync(join(b, 'info', 'exclude'), 'utf8'));
    // Each marker names exactly the project its store shadows; a wrong-tree marker fails here.
    const markers = [a, b].map((s) => readFileSync(join(s, 'KINU_WORKDIR'), 'utf8').trim()).sort();
    expect(markers).toEqual([work, workB].sort());
  });

  test('both engines skip a path they may not read and record it identically', async () => {
    // /undo reads this record, so an incomplete snapshot must be described identically by both engines.
    const { root, work, host, device } = setup();
    const workB = join(root, 'project-b');
    const foreign = [join(work, 'systemd-private-1'), join(workB, 'systemd-private-1')];

    try {
      mkdirSync(workB);

      for (const [index, dir] of [work, workB].entries()) {
        writeFileSync(join(dir, 'mine.txt'), 'kept');
        mkdirSync(foreign[index]);
        writeFileSync(join(foreign[index], 'theirs.txt'), 'not mine');
        chmodSync(foreign[index], 0o000);
      }

      host.beginTurn({ turnId: 't', sessionId: 's' });
      const hostId = present(await host.ensureCheckpoint(work, 'file write'), 'the host engine snapshot id');
      const deviceId = present(await device.ensure({ agent: AGENT, dir: workB, turnId: 't', sessionId: 's' }, undefined), 'the daemon engine snapshot id');
      expect(hostId).toBeTruthy();
      expect(deviceId).toBeTruthy();

      const byId = new Map((await device.list(AGENT)).map((e) => [e.id, e.reason]));
      expect(byId.get(hostId)).toBe('file write [skipped 1 unreadable: systemd-private-1]');
      expect(byId.get(deviceId)).toBe('pre-mutation [skipped 1 unreadable: systemd-private-1]');

      writeFileSync(join(work, 'mine.txt'), 'damaged');
      expect((await host.plan(work, hostId)).files).toEqual([{ path: 'mine.txt', kind: 'modify' }]);
      expect((await device.plan(AGENT, workB, deviceId)).files).toEqual([]);
    } finally {
      for (const dir of foreign) chmodSync(dir, 0o700);

    }
  });
});
