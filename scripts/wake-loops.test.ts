import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  AGENT_METRICS_SCHEMA, analyticsDigest, recordStartupRow, type AnalyticsDataPoint,
} from '@kinu.run/core/analytics';
import { WAKE_LOOP_STARTUPS_PER_HOUR, findWakeLoops, type StartupHour } from './wake-loops';

const HOUR = 3_600_000;

const T0 = Date.parse('2026-09-25T00:00:00Z');

const hour = (object: string, at: number, startups: number): StartupHour => ({ object, hour: T0 + at * HOUR, startups });

const slot = (name: string): number => AGENT_METRICS_SCHEMA.blobs.findIndex((b) => b.name === name);

describe('the startup boundary feeds the loop verdict', () => {
  test('57 activations of one workspace in an hour, written as rows, read back as a loop', () => {
    const points: AnalyticsDataPoint[] = [];
    const env = { AGENT_METRICS: { writeDataPoint: (point?: AnalyticsDataPoint) => { if (point !== undefined) points.push(point); } } };

    for (let i = 0; i < 57; i += 1) recordStartupRow(env, { workspace: 'warm-forge-4d6acc02' });
    recordStartupRow(env, { workspace: 'quiet-owner' });

    // What the `startups` panel selects: `event` rows named `actor.startup`, keyed by the index.
    const startups = points.filter((p) => p.blobs?.[slot('kind')] === 'event' && p.blobs[slot('event')] === 'actor.startup');
    const perWorkspace = new Map<string, number>();

    for (const p of startups) {
      const workspace = v.parse(v.string(), p.indexes?.[0]);
      perWorkspace.set(workspace, (perWorkspace.get(workspace) ?? 0) + 1);
    }

    const loops = findWakeLoops([...perWorkspace].map(([object, n]) => ({ object, hour: T0, startups: n })));

    expect(loops.map((l) => l.object)).toEqual([analyticsDigest('warm-forge-4d6acc02')]);
    expect(loops[0].peakPerHour).toBe(57);
  });
});

describe('findWakeLoops', () => {
  test('a reset storm (warm-forge-4d6acc02, 57 startups in an hour) trips; a busy normal workspace does not', () => {
    const loops = findWakeLoops([
      hour('warm-forge', 0, 3),
      hour('warm-forge', 1, 57),
      hour('warm-forge', 2, 4),
      hour('busy-owner', 0, 12),
      hour('busy-owner', 1, 9),
    ]);

    expect(loops.map((l) => l.object)).toEqual(['warm-forge']);
    expect(loops[0]).toMatchObject({ peakPerHour: 57, loopHours: 1, sustained: false, startups: 64, firstLoopHour: T0 + HOUR });
  });

  test('the threshold hour counts and the hour under it does not', () => {
    expect(findWakeLoops([hour('a', 0, WAKE_LOOP_STARTUPS_PER_HOUR - 1)])).toEqual([]);
    expect(findWakeLoops([hour('a', 0, WAKE_LOOP_STARTUPS_PER_HOUR)])).toHaveLength(1);
  });

  test('only consecutive loop hours make a loop sustained', () => {
    const [apart] = findWakeLoops([hour('a', 0, 40), hour('a', 2, 40)]);
    const [adjacent] = findWakeLoops([hour('a', 0, 40), hour('a', 1, 40), hour('a', 3, 40)]);

    expect(apart).toMatchObject({ loopHours: 2, longestRunHours: 1, sustained: false });
    expect(adjacent).toMatchObject({ loopHours: 3, longestRunHours: 2, sustained: true, lastLoopHour: T0 + 3 * HOUR });
  });

  test('rows for one hour add up before the threshold is read, whatever instant inside the hour they carry', () => {
    const [loop] = findWakeLoops([
      { object: 'a', hour: T0 + 5 * 60_000, startups: 20 },
      { object: 'a', hour: T0 + 50 * 60_000, startups: 20 },
    ]);

    expect(loop).toMatchObject({ loopHours: 1, peakPerHour: 40, firstLoopHour: T0 });
  });

  test('the longest-running loop ranks first', () => {
    const loops = findWakeLoops([
      hour('burst', 0, 200),
      hour('steady', 0, 60), hour('steady', 1, 60), hour('steady', 2, 60),
    ]);

    expect(loops.map((l) => l.object)).toEqual(['steady', 'burst']);
  });
});
