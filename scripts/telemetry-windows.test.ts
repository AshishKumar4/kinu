// A row that lands after a deploy's 3-minute hold is read by a later deploy, never lost: what each later read reports,
// and which windows it keeps.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { KinuError } from '@kinu.run/core/obs';
import {
  LATE_HORIZON_MS, LOGS_RETENTION_MS, TelemetryWindowSchema, type KeptWindow, type Reread, type TelemetryWindow, type WindowSignal,
  type WindowStore, afterRereads, keepWindows, rereadWindows, windowKey,
} from './telemetry-windows';

const END = Date.parse('2026-10-14T21:26:15.524Z');

type Measures = Record<string, { count: number; offset: number }>;

const window = (version: string, measures: Measures | null): TelemetryWindow => ({
  worker: 'kinu-staging', version, from: '2026-10-14T21:16:57.000Z', to: new Date(END).toISOString(), measures,
});

const failed = (count: number): WindowSignal => ({ key: 'failed-effects', count, what: 'failed terminal effects', finding: `${String(count)} terminal effect run(s) failed` });

const thrown = (count: number, offset: number): WindowSignal => ({
  key: 'exceptions:UserDO', count, offset, what: 'uncaught exceptions in UserDO', finding: `${String(count - offset)} invocation(s) of UserDO ended in an uncaught exception`,
});

const owed = (sequence: string): WindowSignal => ({ key: `owed:${sequence}`, count: 1, what: 'owed terminal effects', finding: `sequence ${sequence} still owed` });

const reread = (kept: TelemetryWindow, found: readonly WindowSignal[], readAt = END + 30 * 60_000): Reread => ({ key: windowKey(kept), window: kept, readAt, found });

/** R2 as a map of objects, read and written only through the store's calls; a missing key answers as the API does. */
function memoryStore(objects: Map<string, string>): WindowStore {
  return {
    list: async () => [...objects.keys()],
    get: async (key) => {
      const text = objects.get(key);

      if (text === undefined) throw new KinuError('missing', `GET ${key} answered 404`);

      return text;
    },
    put: async ({ key, window: kept }: KeptWindow) => { objects.set(key, JSON.stringify(kept)); },
    remove: async (keys) => { for (const key of keys) objects.delete(key); },
  };
}

describe('a kept window read again', () => {
  test('reports a signal its earlier reads did not hold, and one whose count grew, named for its version', () => {
    const { late } = afterRereads([reread(window('9d317781', { 'failed-effects': { count: 1, offset: 0 } }), [failed(2), owed('b')])]);

    expect(late.map((each) => each.what)).toEqual(['late, version 9d317781: failed terminal effects', 'late, version 9d317781: owed terminal effects']);
  });

  test('reads a reset row that landed late as an exception taken back, and an exception after it as late', () => {
    const before = window('9d317781', { 'exceptions:UserDO': { count: 3, offset: 0 } });
    const corrected = afterRereads([reread(before, [thrown(3, 2)])]);
    const after = window('9d317781', corrected.puts[0]?.window.measures ?? null);

    expect({ corrected: corrected.late, later: afterRereads([reread(after, [thrown(4, 2)])]).late.length }).toEqual({ corrected: [], later: 1 });
  });

  test('names each owed sequence, so one that settles cannot hide one that landed late', () => {
    expect(afterRereads([reread(window('9d317781', { 'owed:a': { count: 1, offset: 0 } }), [owed('b')])]).late).toHaveLength(1);
  });

  test('reports everything a window holds that its own deploy never read to a settled answer', () => {
    expect(afterRereads([reread(window('9d317781', null), [failed(1), owed('a')])]).late).toHaveLength(2);
  });

  test('is retired by the time its own read began, not by when the deploy finished', () => {
    const kept = window('9d317781', {});
    const early = afterRereads([reread(kept, [], END + LATE_HORIZON_MS - 1)]);
    const past = afterRereads([reread(kept, [], END + LATE_HORIZON_MS)]);

    expect({ early: early.removes, earlyKept: early.puts.length, past: past.removes }).toEqual({ early: [], earlyKept: 1, past: [windowKey(kept)] });
  });

  test('that cannot be read is a finding, and stays kept as it was for the next deploy', () => {
    const kept = window('9d317781', {});
    const { late, puts, removes } = afterRereads([{ key: windowKey(kept), window: kept, readAt: END + LATE_HORIZON_MS * 2, failed: 'the token could not be read' }]);

    expect({ what: late.map((each) => each.what), puts, removes }).toEqual({ what: ["version 9d317781's kept window"], puts: [], removes: [] });
  });

  test('past the logs\' retention is not read, and is reported lost rather than read as empty', async () => {
    const kept = window('9d317781', {});
    const objects = new Map([[windowKey(kept), JSON.stringify(kept)]]);
    const reads: string[] = [];

    const read = async (each: TelemetryWindow): Promise<WindowSignal[]> => {
      reads.push(each.version);

      return [];
    };

    const { late, removes } = afterRereads(await rereadWindows(memoryStore(objects), read, () => END + LOGS_RETENTION_MS));

    expect({ reads, lost: late[0]?.finding.includes('is lost'), removes }).toEqual({ reads: [], lost: true, removes: [windowKey(kept)] });
  });

  test('another deploy retired since the listing is passed over; one that cannot be read is a finding', async () => {
    const objects = new Map([[windowKey(window('broken', {})), 'not json']]);
    const store = memoryStore(objects);
    const listed = { ...store, list: async () => [...await store.list(), windowKey(window('retired', {}))] };
    const { late, puts, removes } = afterRereads(await rereadWindows(listed, async () => [], () => END + 60_000));

    expect({ what: late.map((each) => each.what), puts, removes }).toEqual({ what: ['a kept telemetry window'], puts: [], removes: [] });
  });
});

describe('two deploys that read the kept windows at once', () => {
  test('each keep their own window, and neither erases the other\'s', async () => {
    const earlier = window('earlier', {});
    const objects = new Map([[windowKey(earlier), JSON.stringify(earlier)]]);
    const store = memoryStore(objects);
    const read = async (): Promise<WindowSignal[]> => [];
    const [first, second] = await Promise.all([rereadWindows(store, read, () => END + 60_000), rereadWindows(store, read, () => END + 60_000)]);
    const one = afterRereads(first);
    const two = afterRereads(second);

    await keepWindows(store, [...one.puts, { key: windowKey(window('first', {})), window: window('first', {}) }], one.removes);
    await keepWindows(store, [...two.puts, { key: windowKey(window('second', {})), window: window('second', {}) }], two.removes);

    expect([...objects.keys()].toSorted()).toEqual([windowKey(earlier), windowKey(window('first', {})), windowKey(window('second', {}))].toSorted());
  });

  test('never lower a counter the other wrote, so what one reported is not reported again', async () => {
    const earlier = window('earlier', { 'failed-effects': { count: 1, offset: 0 } });
    const objects = new Map([[windowKey(earlier), JSON.stringify(earlier)]]);
    const store = memoryStore(objects);
    const fast = afterRereads([reread(earlier, [failed(2)])]);
    const slow = afterRereads([reread(earlier, [failed(1)])]);

    await keepWindows(store, fast.puts, fast.removes);
    await keepWindows(store, slow.puts, slow.removes);
    const kept = v.parse(TelemetryWindowSchema, JSON.parse(objects.get(windowKey(earlier)) ?? '{}'));

    expect(afterRereads([reread(kept, [failed(2)])]).late).toEqual([]);
  });
});
