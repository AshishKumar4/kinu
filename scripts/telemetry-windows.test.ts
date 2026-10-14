// A row that lands after a deploy's 3-minute hold is read by a later deploy, never lost: what each later read reports,
// and which windows it keeps.
import { describe, expect, test } from 'bun:test';
import { LATE_HORIZON_MS, afterRereads, type TelemetryWindow } from './telemetry-windows';

const END = Date.parse('2026-10-14T21:26:15.524Z');

const window = (findings: string[] | null): TelemetryWindow => ({
  worker: 'kinu-staging', version: '9d317781', from: '2026-10-14T21:16:57.000Z', to: new Date(END).toISOString(), findings,
});

const failedEffect = { what: 'failed terminal effects', finding: '1 terminal effect run(s) failed' };

const uncaught = { what: 'uncaught exceptions in UserDO', finding: '2 invocation(s) of UserDO ended in an uncaught exception' };

describe('a kept window read again', () => {
  test('reports what its own deploy did not read, named for its version, and not what it did', () => {
    const { late } = afterRereads([{ window: window([failedEffect.finding]), found: [failedEffect, uncaught] }], END + 30 * 60_000);

    expect(late.map((each) => each.what)).toEqual(['late, version 9d317781: uncaught exceptions in UserDO']);
    expect(late[0]?.finding).toStartWith(uncaught.finding);
  });

  test('reports a finding whose count grew, since its rows are the late ones', () => {
    const grown = { ...failedEffect, finding: '2 terminal effect run(s) failed' };

    expect(afterRereads([{ window: window([failedEffect.finding]), found: [grown] }], END + 30 * 60_000).late).toHaveLength(1);
  });

  test('reports everything a window holds that its own deploy never read to a settled answer', () => {
    expect(afterRereads([{ window: window(null), found: [failedEffect, uncaught] }], END + 30 * 60_000).late).toHaveLength(2);
  });

  test('stays kept with what it holds now until a read past the horizon, which is its last', () => {
    const young = afterRereads([{ window: window([]), found: [failedEffect] }], END + LATE_HORIZON_MS - 1);
    const old = afterRereads([{ window: window([]), found: [failedEffect] }], END + LATE_HORIZON_MS);

    expect(young.kept.map((each) => each.findings)).toEqual([[failedEffect.finding]]);
    expect({ late: old.late.length, kept: old.kept }).toEqual({ late: 1, kept: [] });
  });

  test('that cannot be read is a finding, and stays kept as it was for the next deploy', () => {
    const kept = window([failedEffect.finding]);
    const { late, kept: after } = afterRereads([{ window: kept, failed: 'the API answered 500' }], END + LATE_HORIZON_MS * 2);

    expect(late.map((each) => each.what)).toEqual(["version 9d317781's kept window"]);
    expect(after).toEqual([kept]);
  });
});
