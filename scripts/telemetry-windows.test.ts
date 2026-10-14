// A row that lands after a deploy's 3-minute hold is read by a later deploy, never lost: what each later read reports,
// and which windows it keeps.
import { describe, expect, test } from 'bun:test';
import {
  LATE_HORIZON_MS, LOGS_RETENTION_MS, type KeptWindow, type Reread, type TelemetryWindow, type WindowSignal, type WindowStore,
  afterRereads, keepWindows, rereadWindows, windowKey,
} from './telemetry-windows';

const END = Date.parse('2026-10-14T21:26:15.524Z');

const window = (version: string, measures: Record<string, number> | null): TelemetryWindow => ({
  worker: 'kinu-staging', version, from: '2026-10-14T21:16:57.000Z', to: new Date(END).toISOString(), measures,
});

const failed = (count: number, sample: string): WindowSignal => ({
  key: 'failed-effects', count, what: 'failed terminal effects', finding: `${String(count)} terminal effect run(s) failed; e.g. ${sample}`,
});

const uncaught: WindowSignal = { key: 'exceptions:UserDO', count: 2, what: 'uncaught exceptions in UserDO', finding: '2 invocation(s) of UserDO ended in an uncaught exception' };

const reread = (kept: TelemetryWindow, found: readonly WindowSignal[], readAt = END + 30 * 60_000): Reread => ({ key: windowKey(kept.version), window: kept, readAt, found });

/** R2 as a map of objects, read and written only through the store's calls. */
function memoryStore(objects: Map<string, string>): WindowStore {
  return {
    list: async () => [...objects.keys()],
    get: async (key) => objects.get(key) ?? '',
    put: async ({ key, window: kept }: KeptWindow) => { objects.set(key, JSON.stringify(kept)); },
    remove: async (keys) => { for (const key of keys) objects.delete(key); },
  };
}

describe('a kept window read again', () => {
  test('reports a signal its earlier reads did not hold, and one whose count grew, named for its version', () => {
    const { late } = afterRereads([reread(window('9d317781', { 'failed-effects': 1 }), [failed(2, 'object a'), uncaught])]);

    expect(late.map((each) => each.what)).toEqual(['late, version 9d317781: failed terminal effects', 'late, version 9d317781: uncaught exceptions in UserDO']);
  });

  test('reports nothing for a count that held or fell, whatever sample its words show', () => {
    // Its earlier read showed object a; this one shows object b of the same two failures.
    const held = afterRereads([reread(window('9d317781', { 'failed-effects': 2 }), [failed(2, 'object b')])]);
    // A reset row that landed late takes one of three exceptions back.
    const fell = afterRereads([reread(window('9d317781', { 'exceptions:UserDO': 3 }), [uncaught])]);

    expect({ held: held.late, fell: fell.late, kept: fell.puts[0]?.window.measures }).toEqual({ held: [], fell: [], kept: { 'exceptions:UserDO': 3 } });
  });

  test('reports everything a window holds that its own deploy never read to a settled answer', () => {
    expect(afterRereads([reread(window('9d317781', null), [failed(1, 'object a'), uncaught])]).late).toHaveLength(2);
  });

  test('is retired by the time its own read began, not by when the deploy finished', () => {
    const kept = window('9d317781', {});
    const early = afterRereads([reread(kept, [], END + LATE_HORIZON_MS - 1)]);
    const past = afterRereads([reread(kept, [], END + LATE_HORIZON_MS)]);

    expect({ early: early.removes, earlyKept: early.puts.length, past: past.removes }).toEqual({ early: [], earlyKept: 1, past: [windowKey('9d317781')] });
  });

  test('that cannot be read is a finding, and stays kept as it was for the next deploy', () => {
    const kept = window('9d317781', { 'failed-effects': 1 });
    const { late, puts, removes } = afterRereads([{ key: windowKey('9d317781'), window: kept, readAt: END + LATE_HORIZON_MS * 2, failed: 'the token could not be read' }]);

    expect({ what: late.map((each) => each.what), puts, removes }).toEqual({ what: ["version 9d317781's kept window"], puts: [], removes: [] });
  });

  test('past the logs\' retention is not read, and is reported lost rather than read as empty', async () => {
    const objects = new Map([[windowKey('9d317781'), JSON.stringify(window('9d317781', {}))]]);
    const reads: string[] = [];

    const read = async (kept: TelemetryWindow): Promise<WindowSignal[]> => {
      reads.push(kept.version);

      return [];
    };

    const rereads = await rereadWindows(memoryStore(objects), read, () => END + LOGS_RETENTION_MS);
    const { late, removes } = afterRereads(rereads);

    expect({ reads, lost: late[0]?.finding.includes('is lost'), removes }).toEqual({ reads: [], lost: true, removes: [windowKey('9d317781')] });
  });
});

describe('two deploys that read the kept windows at once', () => {
  test('each keep their own window, and neither erases the other\'s', async () => {
    const objects = new Map([[windowKey('earlier'), JSON.stringify(window('earlier', {}))]]);
    const store = memoryStore(objects);
    const read = async (): Promise<WindowSignal[]> => [];
    const [first, second] = await Promise.all([rereadWindows(store, read, () => END + 60_000), rereadWindows(store, read, () => END + 60_000)]);
    const one = afterRereads(first);
    const two = afterRereads(second);

    await keepWindows(store, [...one.puts, { key: windowKey('first'), window: window('first', {}) }], one.removes);
    await keepWindows(store, [...two.puts, { key: windowKey('second'), window: window('second', {}) }], two.removes);

    expect([...objects.keys()].toSorted()).toEqual([windowKey('earlier'), windowKey('first'), windowKey('second')]);
  });
});
