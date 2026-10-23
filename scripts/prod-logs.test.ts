import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { ALERT_THRESHOLDS } from '@kinu.run/core/analytics';
import { KinuError } from '@kinu.run/core/obs';
import { activationDisruptions, canaryActivations } from './durability-canary-telemetry';
import { resetCause, ROLLOVER_SPAN_MS } from './worker-deployments';
import {
  alarmsThatRan, deletionTimes, idleWakeHours, lostAlarmRows, ordinalHours, QueryBudget, REFUSALS_IN_A_ROW, readAgainWhile, settledRead, Telemetry, terminalEffectStates, type VersionRead, versionFindings, versionNotices,
  versionRead, versionSignals, workWindow,
} from './prod-logs';

const HOUR = 3_600_000;

const quiet: VersionRead = { ended: [], thrown: [], deployResets: [], effects: { failed: 0, failedTurns: 0, terminal: { observations: 0, settled: [], owed: [], parked: [], deleted: [] } }, startups: [], idleWakes: [], lostRows: [] };

const HUNG = 'The Workers runtime canceled this request because it detected that your Worker\'s code had hung and would never generate a response.';

describe('what one deployed version did, as a deploy reports it', () => {
  test('the last event classifies each sequence: settled after owing or still owed, not the number of observations', () => {
    const event = (timestamp: number, sequence: string, settled = false, object = 'object-a') => ({
      timestamp, $workers: { durableObjectId: object },
      source: { event: settled ? 'turn.terminal_effects_settled' : 'turn.terminal_effects_owed', code: '', cause: '', fields: { sequence, owed: 'v1:sleep_time:answer' } },
    });

    const read = terminalEffectStates([
      event(20, 'recovered', true), event(5, 'recovered'),
      event(15, 'still-owed'), event(10, 'recovered'), event(18, 'still-owed'),
      event(30, 'never-owed', true),
    ]);

    expect(read.observations).toBe(4);
    expect(read.settled.map((sample) => sample.sequence)).toEqual(['recovered']);
    expect(read.owed.map((sample) => sample.sequence)).toEqual(['still-owed']);

    const findings = versionFindings({ ...quiet, effects: { ...quiet.effects, terminal: read } });

    expect(findings.map((found) => found.what)).toEqual(['owed terminal effects']);
    expect(findings[0]?.finding).toContain('still-owed');
    expect(findings[0]?.finding).not.toContain('recovered');
  });

  // Staging beaf28a46, 2026-10-08: both "still owed" sequences were task reminders in eval workspaces deleted 1.6 s
  // later; an effect parked on an owner-fixable refusal is owed by design (T1-T3) until the owner acts.
  test('a sequence parked on the owner or ended by its workspace\'s deletion is not owed work; a parked effect that failed since is', () => {
    const at = (timestamp: number, event: string, sequence: string, fields: Record<string, string> = {}) => ({
      timestamp, $workers: { durableObjectId: fields.object ?? 'object-a' }, source: { event, code: '', cause: '', fields: { sequence, ...fields } },
    });

    const read = terminalEffectStates([
      at(10, 'turn.terminal_effect_parked', 'quota', { effect: 'v1:turn_lessons:a' }),
      at(11, 'turn.terminal_effects_owed', 'quota', { owed: 'v1:turn_lessons:a' }),
      at(10, 'turn.terminal_effect_parked', 'refused-then-broke', { effect: 'v1:turn_lessons:b' }),
      at(20, 'turn.terminal_effect_failed', 'refused-then-broke', { effect: 'v1:turn_lessons:b' }),
      at(21, 'turn.terminal_effects_owed', 'refused-then-broke', { owed: 'v1:turn_lessons:b' }),
      at(30, 'turn.terminal_effects_owed', 'reminder', { owed: 'v1:task_reminder:c', object: 'deleted-workspace' }),
      at(30, 'turn.terminal_effects_owed', 'reminder', { owed: 'v1:task_reminder:d', object: 'live-workspace' }),
    ], new Map([['deleted-workspace', 32]]));

    expect(read.parked.map((sample) => sample.sequence)).toEqual(['quota']);
    expect(read.deleted.map((sample) => `${sample.object}/${sample.sequence}`)).toEqual(['deleted-workspace/reminder']);
    expect(read.owed.map((sample) => `${sample.object}/${sample.sequence}`)).toEqual(['object-a/refused-then-broke', 'live-workspace/reminder']);
  });

  // Staging c6dc27da1, 2026-10-13: both "still owed" task reminders had settled, their eval workspaces deleted 1.9 s
  // later; their owed rows were an agent isolate's lines its workspace's tail relayed, a row no object's invocation
  // wrote, so the workspace they name is the object a deletion matches.
  test("a relayed line is its named workspace's, so that workspace's deletion ends its sequence", () => {
    const relayed = (timestamp: number, event: string, sequence: string, object: string) => ({
      timestamp, $workers: {}, source: { event, code: '', cause: '', fields: { sequence, owed: 'v1:task_reminder:a', workspace: 'eval-first-run', actor: 'agent-1', object } },
    });

    const read = terminalEffectStates([
      relayed(10, 'turn.terminal_effects_owed', 'reminder', 'deleted-workspace'),
      relayed(10, 'turn.terminal_effects_owed', 'reminder', 'live-workspace'),
    ], new Map([['deleted-workspace', 12]]));

    expect(read.deleted.map((sample) => `${sample.object}/${sample.sequence}`)).toEqual(['deleted-workspace/reminder']);
    expect(read.owed.map((sample) => `${sample.object}/${sample.sequence}`)).toEqual(['live-workspace/reminder']);
  });

  // Staging f9c17ac7b, 2026-10-14: an eval workspace's agent owed its turn's task reminder at 16:43:52.770 (relayed), the
  // reminder turn ran by 53.146, and the owner's object destroyed the workspace at 54.578, before the reminder's 5 s
  // re-check would settle it. None of the destroyed object's own rows of the destroy were stored, and the workspace's own
  // ledger had settled the same sequence at 52.157.
  test("a workspace's own settle stands for none of its agent's owed effects, and a destroy its owner logged ends them", () => {
    const row = (timestamp: number, event: string, fields: Record<string, string>, object = '') => ({
      timestamp, $workers: object === '' ? {} : { durableObjectId: object },
      source: { event, code: '', cause: '', fields: { sequence: 'turn-3/96e9', ...fields } },
    });

    const agent = { owed: 'v1:task_reminder:96e9', workspace: 'eval-first-run', actor: 'agent-1' };

    const events = [
      row(52_157, 'turn.terminal_effects_settled', {}, 'workspace-a'),
      row(52_770, 'turn.terminal_effects_owed', { ...agent, object: 'workspace-a' }),
      row(52_770, 'turn.terminal_effects_owed', { ...agent, object: 'workspace-b' }),
      row(52_800, 'turn.terminal_effects_settled', {}, 'workspace-b'),
    ];

    const destroyedAt = deletionTimes([], [row(55_811, 'workspace.destroyed', { workspace: 'eval-first-run', object: 'workspace-a' })]);
    const read = terminalEffectStates(events, destroyedAt);

    expect(read.deleted.map((sample) => `${sample.object}/${sample.sequence}`)).toEqual(['workspace-a/turn-3/96e9']);
    expect(read.owed.map((sample) => `${sample.object}/${sample.sequence}`)).toEqual(['workspace-b/turn-3/96e9']);
    expect(read.settled).toEqual([]);
  });

  test("an object's deletion is the earliest of its own abort and the destroy its owner logged", () => {
    const aborted = [{ timestamp: 30, $workers: { durableObjectId: 'a' } }, { timestamp: 20, $workers: { durableObjectId: 'a' } }];

    const tornDown = [
      { timestamp: 25, source: { event: 'workspace.destroyed', code: '', cause: '', fields: { object: 'a' } } },
      { timestamp: 40, source: { event: 'workspace.destroyed', code: '', cause: '', fields: { object: 'b' } } },
    ];

    expect([...deletionTimes(aborted, tornDown)]).toEqual([['a', 20], ['b', 40]]);
  });

  // Staging's versions f62dfcb9 and b39035fc, 2026-09-30: 19 hung SupervisorRPC calls made by one orchestrator, and a
  // sleep_time effect failed and left owed, while 609 canceled sandbox calls were callers going away.
  test('an uncaught exception, a platform kill and a failed or owed effect are each a finding, with what a fixer starts from', () => {
    const findings = versionFindings({
      ...quiet,
      ended: [
        { outcome: 'exception', entrypoint: 'SupervisorRPC', count: 19, objects: 1 },
        { outcome: 'exceededMemory', entrypoint: 'OrchestratorAgent', count: 2, objects: 1 },
        { outcome: 'canceled', entrypoint: 'KinuSandbox', count: 609, objects: 4 },
        { outcome: 'aborted', entrypoint: 'OrchestratorAgent', count: 77, objects: 64 },
      ],
      thrown: [{ entrypoint: 'SupervisorRPC', message: HUNG, object: '8adb8bd8b1db454f', request: '8a6c0e1485460f2a' }],
      effects: {
        failed: 2, failedTurns: 2,
        failedSample: { object: '5c7e7ea536ffeb1e', sequence: 'dd25fbbb/42219f95', detail: 'v1:sleep_time:42219f95 (unavailable): the sleep-time compute returned no usable update' },
        terminal: { observations: 3, settled: [], owed: [{ object: '5c7e7ea536ffeb1e', sequence: 'dd25fbbb/42219f95', detail: 'owed v1:sleep_time:42219f95' }], parked: [], deleted: [] },
      },
    });

    expect(findings.map((found) => found.what)).toEqual(['uncaught exceptions in SupervisorRPC', 'OrchestratorAgent ended by the platform (exceededMemory)', 'failed terminal effects', 'owed terminal effects']);
    expect(findings[0]?.finding).toContain(HUNG);
    expect(findings[0]?.finding).toContain('8a6c0e1485460f2a');
    expect(findings[0]?.finding).toContain('8adb8bd8b1db454f');
    expect(findings[3]?.finding).toMatch(/^1\b/);
    expect(versionFindings(quiet)).toEqual([]);
  });

  // Staging df49f4cc5, 2026-10-01: a deploy rolled over a devbox mid-call and the runtime ended the call with "Durable Object
  // reset because its code was updated.", which the report counted as the version's own uncaught exception.
  test('an invocation a code update reset is the deploy rolling over, not the version failing', () => {
    const findings = versionFindings({
      ...quiet,
      ended: [
        { outcome: 'exception', entrypoint: 'KinuDevbox', count: 3, objects: 1 },
        { outcome: 'exception', entrypoint: 'SupervisorRPC', count: 19, objects: 1 },
      ],
      thrown: [{ entrypoint: 'SupervisorRPC', message: HUNG, object: '8adb8bd8b1db454f', request: '8a6c0e1485460f2a' }],
      deployResets: [{ entrypoint: 'KinuDevbox', count: 3 }, { entrypoint: 'SupervisorRPC', count: 1 }],
    });

    expect(findings).toEqual([
      { what: 'uncaught exceptions in SupervisorRPC', finding: `18 invocation(s) of SupervisorRPC ended in an uncaught exception: "${HUNG}", in request 8a6c0e1485460f2a of object 8adb8bd8b1db454f` },
    ]);
  });

  // Staging under the tiers and the evals, 2026-09-30: at most 3 startups in an object-hour.
  // What a later deploy compares when it reads this window again (telemetry-windows.ts): counters late rows only raise.
  test('a later read compares counters late rows only raise: throws beside resets, owed sequences by name, a loop by its hour', () => {
    const loop = ALERT_THRESHOLDS.startupsPerHour;

    const signals = versionSignals({
      ...quiet,
      ended: [{ outcome: 'exception', entrypoint: 'KinuDevbox', count: 3, objects: 1 }, { outcome: 'canceled', entrypoint: 'KinuSandbox', count: 9, objects: 2 }],
      deployResets: [{ entrypoint: 'KinuDevbox', count: 3 }],
      effects: { ...quiet.effects, terminal: { ...quiet.effects.terminal, owed: [{ object: 'o', sequence: 'a/1', detail: 'owed' }, { object: 'o', sequence: 'b/2', detail: 'owed' }] } },
      startups: [{ object: 'looping', hour: HOUR + 60_000, startups: loop }, { object: 'looping', hour: HOUR + 120_000, startups: 1 }, { object: 'quiet', hour: HOUR, startups: 3 }],
    });

    expect(signals.map(({ key, count, offset }) => ({ key, count, offset }))).toEqual([
      { key: 'exceptions:KinuDevbox', count: 3, offset: 3 },
      { key: 'owed:a/1', count: 1, offset: undefined },
      { key: 'owed:b/2', count: 1, offset: undefined },
      { key: `startups:looping:${String(HOUR)}`, count: loop + 1, offset: undefined },
    ]);
  });

  test('an object started as often as the product calls a wake loop is a finding, and the measured busiest is none', () => {
    const loop = ALERT_THRESHOLDS.startupsPerHour;

    const findings = versionFindings({
      ...quiet,
      startups: [{ object: 'looping', hour: 0, startups: loop }, { object: 'busiest-measured', hour: 0, startups: 3 }],
    });

    expect(findings).toEqual([{ what: 'a wake loop', finding: `object looping started ${String(loop)} times in an hour, 1 such hour(s)` }]);
  });

  // Staging 36acc5de2 and fb848438c, 2026-10-08: a failed drain re-armed a second ahead after its eval ended (1,816 alarms
  // in an hour, nothing else of its object), while live turns took 30-122 alarms an hour beside their own model calls.
  test('an alarm with nothing to watch is an idle wake, however few; an alarm beside its object\'s own work is none', () => {
    const minute = 60_000;

    const minutes = (object: string, from: number, to: number, count = 1) =>
      Array.from({ length: to - from }, (_, at) => ({ object, minute: HOUR + (from + at) * minute, count }));

    const alarms = [...minutes('storming', 0, 60, 30), ...minutes('live-turn', 0, 60, 2), ...minutes('turn-ended', 0, 12)];
    const work = [...minutes('storming', 0, 1), ...minutes('live-turn', 0, 60).filter((_, at) => at % 4 === 0), ...minutes('turn-ended', 0, 3)];
    const idle = idleWakeHours(alarms, work);

    expect(idle).toEqual([{ object: 'storming', hour: HOUR, count: 54 * 30 }, { object: 'turn-ended', hour: HOUR, count: 4 }]);
    expect(versionFindings({ ...quiet, idleWakes: idle })).toEqual([
      { what: 'idle wakes', finding: 'object storming woke 1620 time(s) with nothing to watch in the hour from 1970-01-01T01:00:00Z' },
      { what: 'idle wakes', finding: 'object turn-ended woke 4 time(s) with nothing to watch in the hour from 1970-01-01T01:00:00Z' },
    ]);
  });

  // Staging fdf995c70, 2026-10-17: the version's window ended at 04:54:12.9, 7 s after a devbox's heartbeat, and the
  // workspace's agent called that box at 04:56; read only up to the window's end, the heartbeat had nothing to watch.
  test("an alarm near its window's end is judged by the version's work in the minutes after it", () => {
    const minute = 60_000;
    const window = { from: Date.parse('2026-10-17T04:48:08Z'), to: Date.parse('2026-10-17T04:54:12.915Z') };
    const heartbeat = [{ object: 'devbox', minute: Date.parse('2026-10-17T04:54:00Z'), count: 1 }];
    const calls = [{ object: 'devbox', minute: Date.parse('2026-10-17T04:56:00Z'), count: 109 }];
    const within = ({ from, to }: { readonly from: number; readonly to: number }) => calls.filter((row) => row.minute + minute > from && row.minute < to);

    expect(workWindow(window)).toEqual({ from: window.from, to: window.to + 5 * minute });
    expect(idleWakeHours(heartbeat, within(workWindow(window)))).toEqual([]);
    expect(idleWakeHours(heartbeat, within(window))).toEqual([{ object: 'devbox', hour: Date.parse('2026-10-17T04:00:00Z'), count: 1 }]);
  });

  // Staging c6dc27da1, 2026-10-13: 13 deleted eval workspaces each got one alarm delivery 10 minutes after `destroyed`,
  // which workerd answered `canceled` before any of their code ran (no stored alarm), and each read as an idle wake.
  test("a delivery cancelled for an object deleted before it is no wake; an alarm that ran after a deletion is", () => {
    const minute = 60_000;
    const deleted = HOUR + 5 * minute;
    const late = HOUR + 15 * minute;
    const destroyedAt = new Map([['deleted', deleted], ['re-armed', deleted]]);

    const alarms = [
      { object: 'deleted', minute: late, count: 1 },
      { object: 're-armed', minute: late, count: 1 },
      // Cancelled, but never deleted: whatever moved its alarm is the object's own, and its wake still counts.
      { object: 'live', minute: late, count: 1 },
    ];

    const canceled = [{ object: 'deleted', minute: late, count: 1 }, { object: 'live', minute: late, count: 1 }];
    const ran = alarmsThatRan(alarms, canceled, destroyedAt);

    expect(ran).toEqual([{ object: 're-armed', minute: late, count: 1 }, { object: 'live', minute: late, count: 1 }]);
    expect(idleWakeHours(ran, []).map((idle) => idle.object)).toEqual(['re-armed', 'live']);
    // The one that was: before the cancelled deliveries were taken away, the deleted object read as woken too.
    expect(idleWakeHours(alarms, []).map((idle) => idle.object)).toEqual(['deleted', 're-armed', 'live']);
  });
});

// Staging 2026-10-08: an 08:19:16Z row was absent from a read at 10:25Z and present at 10:50Z.
describe('a read that issues a verdict', () => {
  /** Answers each count in turn, its last forever; `refused` is a read the API answered 500, `timedout` one its gateway
   *  answered 504, `rejected` one it answered 400, a query it will never take. The window ends at `windowEnd`, the first
   *  read starts at `startAt`, and each read takes `readMs`; reads settle a `holdMs` past it. */
  const reader = (counts: readonly (number | 'refused' | 'timedout' | 'rejected')[], { windowEnd = 0, startAt = 0, readMs = 0, holdMs = 10 } = {}) => {
    let clock = startAt;
    let at = 0;
    const startedAt: number[] = [];

    return {
      startedAt,
      read: () => {
        const count = counts[Math.min(at++, counts.length - 1)] ?? 0;
        startedAt.push(clock);
        clock += readMs;

        if (count === 'refused') return Promise.reject(new KinuError('unavailable', 'telemetry query answered 500'));

        if (count === 'timedout') return Promise.reject(new KinuError('timeout', 'telemetry query answered 504'));

        return count === 'rejected' ? Promise.reject(new KinuError('bad_input', 'telemetry query answered 400')) : Promise.resolve(count);
      },
      fingerprint: (count: number) => String(count), rows: (count: number) => count,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;

        return Promise.resolve();
      },
      windowEnd, pollMs: 2, holdMs, capMs: 60,
    };
  };

  // Every row of the window's events has landed `holdMs` after its end, so that read decides, once another agrees.
  test('settles at the first read a hold past the window\'s end that agrees with the one before, its reads on a grid', async () => {
    const late = reader([5, 7, 7, 7, 7], { startAt: 3, readMs: 1 });

    expect(await settledRead(late)).toEqual({ settled: true, value: 7, reads: 5, lateRows: 2 });
    expect(late.startedAt).toEqual([3, 4, 6, 8, 10]);
  });

  // Staging rc28, 2026-10-20: a hold of 3 min on a 2 min grid read at 4 min, the hold's first tick, so a deploy's verdict
  // waited a minute past the instant its telemetry was settled.
  test('reads at the hold itself when it falls between two of the grid\'s reads', async () => {
    const off = reader([5, 5, 5, 5], { holdMs: 3 });

    expect(await settledRead(off)).toEqual({ settled: true, value: 5, reads: 3, lateRows: 0 });
    expect(off.startedAt).toEqual([0, 1, 3]);
  });

  test('waits on a change that lands after the hold, and not on one before it', async () => {
    const after = reader([5, 5, 5, 5, 5, 6, 6]);
    const before = reader([5, 6, 5, 5, 5, 5]);

    expect({ after: await settledRead(after), before: await settledRead(before) }).toEqual({
      after: { settled: true, value: 6, reads: 7, lateRows: 1 },
      before: { settled: true, value: 5, reads: 6, lateRows: 0 },
    });
    expect({ after: after.startedAt.at(-1), before: before.startedAt.at(-1) }).toEqual({ after: 12, before: 10 });
  });

  test('takes two agreeing reads even when the window ended a hold ago', async () => {
    const old = reader([5, 5], { windowEnd: -100 });

    expect(await settledRead(old)).toEqual({ settled: true, value: 5, reads: 2, lateRows: 0 });
    expect(old.startedAt).toEqual([0, 2]);
  });

  // Staging 2026-10-14: the API answered 500 to 12 of 80 reads, which named nothing about the version. Staging after
  // 2fc6aa727, 2026-10-21: its gateway answered 504 to the deploy's own window, which gave up at once and was red.
  test.each(['refused', 'timedout'] as const)('reads again after a %s read, which neither agrees nor disagrees', async (refusal) => {
    // Answered at 2, 4, 8 and 10; refused at 0 and 6.
    expect(await settledRead(reader([refusal, 5, 5, refusal, 5, 5, 5, 5]))).toEqual({ settled: true, value: 5, reads: 4, lateRows: 0 });
  });

  test('fails with the refusal when no read is answered before the cap', async () => {
    await expect(settledRead(reader(['refused']))).rejects.toThrow('telemetry query answered 500');
  });

  // Staging 99a13686c, 2026-10-23: every read refused, asked again every 2 min for 20 minutes at about 80 requests a read.
  test('fails on the fifth refusal in a row, before or after an answer, and an answer starts the count again', async () => {
    const never = reader(['refused']);
    const later = reader([5, 'refused']);
    const between = reader([5, 'refused', 'refused', 'refused', 'refused', 6, 6, 6]);

    await expect(settledRead(never)).rejects.toThrow('telemetry query answered 500');
    await expect(settledRead(later)).rejects.toThrow('telemetry query answered 500');
    expect({ never: never.startedAt.length, later: later.startedAt.length, between: await settledRead(between) })
      .toEqual({ never: REFUSALS_IN_A_ROW, later: REFUSALS_IN_A_ROW + 1, between: { settled: true, value: 6, reads: 3, lateRows: 1 } });
  });

  test('fails at once on any failure but the API\'s refusal, the first read or a later one', async () => {
    const first = reader(['rejected', 5]);
    const later = reader([5, 'refused', 5, 'rejected', 5]);

    await expect(settledRead(first)).rejects.toThrow('telemetry query answered 400');
    await expect(settledRead(later)).rejects.toThrow('telemetry query answered 400');
    expect({ first: first.now(), later: later.now() }).toEqual({ first: 0, later: 6 });
  });

  test('is unsettled when its counts still move at the cap, however close they came', async () => {
    expect(await settledRead(reader(Array.from({ length: 40 }, (_, at) => at)))).toEqual({ settled: false, last: 30, reads: 31, lateRows: 30 });
  });
});

// Staging 2026-10-08: the canary's workspace started six times, and analytics kept two of its startup rows.
test('activations are the ordinals\' deltas, so a dropped startup row loses no count', () => {
  const hour = (at: number, first: number, last: number, object = 'canary') => ({ object, name: 'eval-canary', hour: at * HOUR, first, last });

  expect(ordinalHours([hour(1, 4, 6), hour(2, 9, 9), hour(1, 1, 1, 'quiet')]).map((row) => [row.object, row.startups])).toEqual([
    ['canary', 3], ['canary', 3], ['quiet', 1],
  ]);
});

const startup = (timestamp: number, activation: number) => ({
  timestamp, source: { event: 'actor.startup', code: '', cause: '', fields: { activation } }, $workers: { scriptVersion: { id: 'v' } }, $metadata: {},
});

// 2026-10-22: a code update's reset with no deploy is the build's own (platform-catalog.ts do.storage.write_await_reset);
// the canary filed every one as a deploy's.
test('the canary files a code-updated reset as a deploy\'s only when a deploy landed at or before it', () => {
  const reset = { timestamp: 15, source: { event: '', code: '', cause: '', fields: {} }, $workers: {}, $metadata: { type: 'cf-worker', error: 'Durable Object reset because its code was updated.' } };
  const activations = [{ ordinal: 1, at: 10, version: 'v' }, { ordinal: 2, at: 20, version: 'v' }];

  const endedBy = (deployedAt: number) => activationDisruptions([startup(10, 1), startup(20, 2), reset], activations, {
    window: { from: 0, to: 100 }, touches: [], deployments: [{ at: deployedAt, versions: ['w'] }],
  }).map((row) => row.endedBy);

  // The reset is at 15: a deploy at 12 caused it; one at 18, later in the same gap, did not.
  expect({ deployed: endedBy(12), none: endedBy(50), later: endedBy(18) }).toEqual({ deployed: ['deploy'], none: ['reset'], later: ['reset'] });
});

// Staging 2026-10-08: the canary's object started six times and telemetry kept four of the startup rows.
test('a dropped startup row is an activation still: the ordinals count it, at an unknown time', () => {
  const read = canaryActivations(null, [startup(10, 3), startup(40, 6), startup(20, 4)]);

  expect(read.map((activation) => [activation.ordinal, activation.at])).toEqual([[3, 10], [4, 20], [5, null], [6, 40]]);
  expect(canaryActivations([{ ordinal: 9, at: 5, version: null }], [startup(10, 3)])).toEqual([{ ordinal: 9, at: 5, version: null }]);
});

// Staging deploy of 001f6d749, 2026-10-19: thirty reads of a window no row landed in never agreed, because the API lists
// groups of equal count in a different order each time and the idle wakes kept that order (measured on that window:
// the same 16 objects, swapped in place, between reads a minute apart).
test('a window that does not change reads the same however the API orders its tied groups', async () => {
  const tied = [['b', 3], ['a', 3], ['c', 1]] as const;
  let reads = 0;

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
    const body = v.parse(v.looseObject({ granularity: v.optional(v.number()) }), await request.json());

    const rows = reads++ % 2 === 0 ? tied : [tied[1], tied[0], tied[2]];
    const data = rows.map(([object, value]) => ({ groups: [{ key: '$workers.durableObjectId', value: object }], value }));

    const calculation = body.granularity === undefined
      ? { alias: 'count', aggregates: data }
      : { alias: 'count', series: [{ time: '2026-10-19 12:10:00', data }, { time: '2026-10-19 12:11:00', data: [...data].reverse() }] };

    return Response.json({ success: true, result: { calculations: [calculation], statistics: { abr_level: 1 } } });
  } });

  try {
    const t = new Telemetry('token', { worker: 'kinu-staging', from: Date.parse('2026-10-19T12:03:13Z'), to: Date.parse('2026-10-19T12:24:01Z') }, server.url.origin);
    const counted = [await t.count({ filters: [], groupBy: ['$workers.durableObjectId'] }), await t.count({ filters: [], groupBy: ['$workers.durableObjectId'] })];
    const minutes = [await t.buckets({ filters: [], groupBy: ['$workers.durableObjectId'] }, 60_000), await t.buckets({ filters: [], groupBy: ['$workers.durableObjectId'] }, 60_000)];

    expect(counted[1]).toEqual(counted[0]);
    expect(minutes[1]).toEqual(minutes[0]);
    expect(counted[0]?.map((row) => row.groups[0])).toEqual(['a', 'b', 'c']);
  } finally {
    await server.stop(true);
  }
});

// 2026-10-22: the words of a code update's reset came from awaited writes between dense CPU with no deploy
// (platform-catalog.ts do.storage.write_await_reset), and the report excused every one of them as the deploy's.
describe('a code update\'s reset in a version\'s window', () => {
  const RESET = 'Durable Object reset because its code was updated.';
  const from = Date.parse('2026-10-21T20:31:52Z');
  const to = Date.parse('2026-10-21T20:41:12Z');

  /** One KinuDevbox invocation that ended in an exception, its request's line the reset's words at `resetAt`;
   *  `deployedAt` is when the one deploy after the version's own landed. */
  const resetAt = from + 5000;

  const deployment = async (deployedAt: number) => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
      if (request.method === 'GET') {
        return Response.json({ success: true, result: { deployments: [
          { created_on: new Date(deployedAt).toISOString(), versions: [{ version_id: 'next' }] },
          { created_on: new Date(from + 1000).toISOString(), versions: [{ version_id: 'v1' }] },
          { created_on: '2026-10-21T19:00:00Z', versions: [{ version_id: 'v0' }] },
        ] } });
      }

      const body = JSON.stringify(await request.json());
      const has = (text: string) => body.includes(text);

      if (has('"view":"calculations"') && !has('granularity') && has('"operation":"neq","value":"ok"')) {
        const groups = [{ key: '$workers.outcome', value: 'exception' }, { key: '$workers.entrypoint', value: 'KinuDevbox' }];

        return Response.json({ success: true, result: { calculations: [{ alias: 'count', aggregates: [{ groups, value: 1 }] }, { alias: 'distinct', aggregates: [{ groups, value: 1 }] }] } });
      }

      if (has('"view":"events"') && has(RESET)) {
        return Response.json({ success: true, result: { events: { events: [{ $metadata: { type: 'cf-worker', error: RESET }, $workers: { entrypoint: 'KinuDevbox' }, timestamp: resetAt }] } } });
      }

      if (has('"view":"events"') && has('"value":"exception"')) {
        return Response.json({ success: true, result: { events: { events: [{ $metadata: { requestId: 'r1' }, $workers: { durableObjectId: 'box-1', entrypoint: 'KinuDevbox' }, timestamp: resetAt }] } } });
      }

      if (has('"view":"events"') && has('"value":"r1"')) {
        return Response.json({ success: true, result: { events: { events: [{ $metadata: { requestId: 'r1', error: RESET }, timestamp: resetAt }] } } });
      }

      return Response.json({ success: true, result: {} });
    } });

    try {
      const window = { worker: 'kinu-staging', from, to };
      const read = await versionRead(new Telemetry('token', window, server.url.origin), new Telemetry('token', window, server.url.origin), 'v1');

      return versionFindings(read).map((finding) => finding.finding);
    } finally {
      await server.stop(true);
    }
  };

  const own = [`1 invocation(s) of KinuDevbox ended in an uncaught exception: "${RESET}", in request r1 of object box-1`];

  test('is the deploy\'s when a deploy landed just before it, and no finding', async () => {
    expect(await deployment(resetAt - 2000)).toEqual([]);
  });

  test('is the version\'s own uncaught exception, with its words, when no deploy landed in the window', async () => {
    expect(await deployment(to + 60_000)).toEqual(own);
  });

  // A write-await reset, then a real deploy later in the same window: the deploy cannot have caused what came first.
  test('is the version\'s own when the window\'s deploy landed after it', async () => {
    expect(await deployment(resetAt + 60_000)).toEqual(own);
  });
});

// Staging 613467d1a, 2026-10-23: three eval workspaces destroyed at 02:15-02:16Z under the version before, their sleep-time
// wakes delivered `canceled` at 02:25Z in this version's window, and each read as an idle wake: the deletions were read
// only under this version and in its window.
// Staging's CliAuthDO, 2026-10-23: telemetry lost 21 alarms' lines and 24 lines' alarm rows in one burst, and the gate
// read each of the 21 as a red idle wake (kinu-probe-logloss measured the platform's loss; see lostAlarmRows).
describe('an idle wake in a window whose telemetry lost rows', () => {
  const at = (minute: number) => Date.parse('2026-10-23T13:00:00Z') + minute * 60_000;
  const row = (object: string, minute: number, eventType = 'alarm') => ({ object, minute: at(minute), count: 1, eventType });
  const idleWakes = [{ object: 'a', hour: at(0), count: 1 }];
  const IDLE = 'object a woke 1 time(s) with nothing to watch in the hour from 2026-10-23T13:00:00Z';

  test('a line an alarm logged by an object with no alarm row is a lost row; one of an alarm that ran long, or in no alarm, is not', () => {
    const alarms = [row('a', 45), row('b', 50)];

    expect(lostAlarmRows(alarms, [row('b', 58), row('x', 45), row('y', 46), row('y', 47), row('z', 45, 'fetch')])).toEqual(['x', 'y']);
  });

  test('beside lost rows on other objects, an idle wake is a notice, unreadable, and no red', () => {
    const read = { ...quiet, idleWakes, lostRows: ['b'] };

    expect({ findings: versionFindings(read), signals: versionSignals(read), notices: versionNotices(read) }).toEqual({
      findings: [], signals: [],
      notices: [{ what: 'idle wakes', finding: `unreadable (telemetry lost rows): ${IDLE}; 1 object(s) logged in an alarm with no row of it, e.g. b` }],
    });
  });

  test('in a window that lost no rows an idle wake is red, and lost rows with no idle wake say nothing', () => {
    expect({
      clean: { findings: versionFindings({ ...quiet, idleWakes }), notices: versionNotices({ ...quiet, idleWakes }) },
      lostOnly: { findings: versionFindings({ ...quiet, lostRows: ['b'] }), notices: versionNotices({ ...quiet, lostRows: ['b'] }) },
    }).toEqual({
      clean: { findings: [{ what: 'idle wakes', finding: IDLE }], notices: [] },
      lostOnly: { findings: [], notices: [] },
    });
  });
});

describe('an alarm in a version\'s window, beside a deletion under the version before', () => {
  const from = Date.parse('2026-10-23T02:24:40Z');
  const to = Date.parse('2026-10-23T03:31:20Z');
  const destroyedAt = Date.parse('2026-10-23T02:15:15.408Z');

  /** The version's read, its alarms those `alarms` names at `delivered`, those of `canceled` the platform's `canceled`,
   *  and `deleted-before` destroyed at 02:15:15Z under the version before: only a read of its own rows, unscoped, finds
   *  it, and only one that reaches back to it. `sampledWork`: the API sampled the reads of the version's calls;
   *  `sampledAlarms`: its alarm rows each carry interval 10. `lostAt`: the minute a CliAuthDO's alarm logged
   *  `cli.auth_retired` with no invocation row of it in the window; `earlyAlarm`: that alarm began 5 min before it. */
  let deletionReads = 0;

  const read = async (alarms: readonly string[], canceled: readonly string[], { delivered = '2026-10-23 02:25:00', sampledWork = false, sampledAlarms = false, lostAt = '', earlyAlarm = false } = {}) => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
      const asked = v.parse(v.looseObject({ timeframe: v.optional(v.object({ from: v.number() })) }), await request.json());
      const body = JSON.stringify(asked);
      const has = (text: string) => body.includes(text);
      const interval = sampledAlarms ? 10 : 1;
      const groups = (object: string) => [{ key: '$workers.durableObjectId', value: object }, { key: '$workers.eventType', value: 'alarm' }, { key: 'event', value: 'cli.auth_retired' }];
      const data = (objects: readonly string[]) => objects.map((object) => ({ groups: groups(object), value: interval, interval }));
      const early = earlyAlarm && (asked.timeframe?.from ?? from) < from ? [{ time: '2026-10-23 02:20:00', data: data(['row-lost']) }] : [];

      if (has('"granularity"') && has('"operation":"eq","value":"alarm"')) {
        return Response.json({ success: true, result: { calculations: [{ alias: 'count', series: [{ time: delivered, data: data(has('"value":"canceled"') ? canceled : alarms) }, ...early] }] } });
      }

      if (has('"granularity"') && /"operation":"in","value":"[^"]*\bcli\.auth_retired\b/u.test(body) && lostAt !== '') {
        return Response.json({ success: true, result: { calculations: [{ alias: 'count', series: [{ time: lostAt, data: [{ groups: groups('row-lost'), value: 1 }] }] }] } });
      }

      if (has('"granularity"') && has('"operation":"neq","value":"alarm"') && sampledWork) return Response.json({ success: true, result: { statistics: { abr_level: 10 } } });

      const reaches = (asked.timeframe?.from ?? Infinity) <= destroyedAt;

      if (has('"view":"events"') && has('"operation":"in"')) deletionReads += 1;

      if (has('"view":"events"') && has('"value":"workspace.destroyed"') && /"key":"fields\.object","operation":"(?:eq|in)","value":"[^"]*\bdeleted-before\b/u.test(body) && !has('scriptVersion') && reaches) {
        const row = { timestamp: destroyedAt, source: { event: 'workspace.destroyed', fields: { workspace: 'eval-killn-kimi-0-xrstnt', object: 'deleted-before' } } };

        return Response.json({ success: true, result: { events: { events: [row] } } });
      }

      return Response.json({ success: true, result: {} });
    } });

    try {
      const window = { worker: 'kinu-staging', from, to };

      return await versionRead(new Telemetry('token', window, server.url.origin), new Telemetry('token', window, server.url.origin), 'v1');
    } finally {
      await server.stop(true);
    }
  };

  const idleWakes = async (...args: Parameters<typeof read>) => (await read(...args)).idleWakes.map((idle) => idle.object);

  test('a delivery cancelled after an earlier version deleted its object is no wake', async () => {
    expect(await idleWakes(['deleted-before'], ['deleted-before'])).toEqual([]);
  });

  // Staging 99a13686c's window, 2026-10-23: two reads for each of 29 objects were 58 of a version read's 77 requests.
  test('the deletions of every object a delivery was cancelled for are read together, 200 objects a read', async () => {
    const others = Array.from({ length: 200 }, (_, at) => `moved-${String(at)}`);

    deletionReads = 0;
    const wakes = await idleWakes(['deleted-before', ...others], ['deleted-before', ...others]);

    expect({ wakes: wakes.length, deleted: wakes.includes('deleted-before'), reads: deletionReads }).toEqual({ wakes: 200, deleted: false, reads: 4 });
  });

  test('an alarm that ran with no work is a wake, and so is a cancelled one of an object never deleted', async () => {
    expect(await idleWakes(['idle', 'moved'], ['moved'])).toEqual(['idle', 'moved']);
  });

  // 04603ec96's deploy read a day before each such delivery, for every kept window at once, and the API answered 500.
  test('a deletion is read back an hour from its delivery, and no further', async () => {
    expect({
      within: await idleWakes(['deleted-before'], ['deleted-before'], { delivered: '2026-10-23 03:14:00' }),
      past: await idleWakes(['deleted-before'], ['deleted-before'], { delivered: '2026-10-23 03:16:00' }),
    }).toEqual({ within: [], past: ['deleted-before'] });
  });

  // 04603ec96's deploy, its own read sampled at level 1,000,000, read alarms beside dropped calls as idle wakes.
  test('a read whose answers of the version\'s work were sampled is asked again, never read as idle', async () => {
    await expect(read(['idle'], [], { sampledWork: true })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('sampled the reads of the version\'s work') });
  });

  // bc4ab809's deploy: one delivery, its row's interval 10 in an answer at abr_level 1, read as 10 idle wakes.
  test('a per-minute row Cloudflare sampled counts the events it stored, never its estimate', async () => {
    expect((await read(['idle'], [], { sampledAlarms: true })).idleWakes.map((idle) => idle.count)).toEqual([1]);
  });

  test('an alarm\'s line whose own row was lost is read as a lost row, and the idle wakes beside it are kept', async () => {
    const answer = await read(['idle'], [], { lostAt: '2026-10-23 02:26:00' });

    expect({ lost: answer.lostRows, idle: answer.idleWakes.map((idle) => idle.object) }).toEqual({ lost: ['row-lost'], idle: ['idle'] });
  });

  // The window ends at 03:31:20: a line in its 03:31 minute may be of an alarm after it, and one of an alarm that began
  // before the window is that alarm's.
  test('a line in the window\'s last, partly read minute, or of an alarm that began before the window, is no lost row', async () => {
    expect({
      lastMinute: (await read(['idle'], [], { lostAt: '2026-10-23 03:31:00' })).lostRows,
      lastWhole: (await read(['idle'], [], { lostAt: '2026-10-23 03:30:00' })).lostRows,
      early: (await read(['idle'], [], { lostAt: '2026-10-23 02:25:00', earlyAlarm: true })).lostRows,
    }).toEqual({ lastMinute: [], lastWhole: ['row-lost'], early: [] });
  });
});

// worker-deployments.ts, which the version read and the canary ask: each reset is attributed by its own time.
test('a reset is a deploy\'s only when another version\'s deploy landed at or before it, within the rollover\'s span', () => {
  const resetAt = Date.parse('2026-10-21T20:35:00Z');
  const own = { at: resetAt - 120_000, versions: ['v1'] };
  const before = { at: resetAt - 30_000, versions: ['v2'] };
  const after = { at: resetAt + 60_000, versions: ['v2'] };
  const long = { at: resetAt - ROLLOVER_SPAN_MS - 1, versions: ['v0'] };

  expect({
    rolled: resetCause([after, before, own], resetAt, 'v1'),
    laterOnly: resetCause([after, own, long], resetAt, 'v1'),
    ownOnly: resetCause([own], resetAt, 'v1'),
  }).toEqual({ rolled: 'deploy', laterOnly: 'own', ownOnly: 'own' });
});

test('a full list that does not reach back past the span cannot say', () => {
  const resetAt = Date.parse('2026-10-21T20:35:00Z');
  const newer = Array.from({ length: 10 }, (_, index) => ({ at: resetAt + 60_000 + index * 60_000, versions: [`n${String(index)}`] }));

  expect({ full: resetCause(newer, resetAt, 'v1'), short: resetCause(newer.slice(0, 3), resetAt, 'v1') }).toEqual({ full: 'unknown', short: 'own' });
});


// Staging after 2fc6aa727, 2026-10-21: one 502 on each kept window's single read kept all five and reported each red.
describe('a kept window read beside the deploy\'s own', () => {
  /** A read answering each of `answers` in turn: a number, the gateway's 502, or a 400 the API will never take. */
  const answering = (answers: readonly (number | 'gateway' | 'rejected')[]) => {
    let at = 0;

    return {
      asked: () => at,
      read: async () => {
        const answer = answers[Math.min(at++, answers.length - 1)] ?? 0;

        if (answer === 'gateway') throw new KinuError('unavailable', 'telemetry query answered 502');

        if (answer === 'rejected') throw new KinuError('bad_input', 'telemetry query answered 400');

        return answer;
      },
    };
  };

  const reading = () => {
    const ended = Promise.withResolvers<void>();

    return { ended: false, done: ended.promise, end: ended.resolve };
  };

  test('is read again after the gateway\'s refusal while the own read lasts, and answers', async () => {
    const own = reading();
    const kept = answering(['gateway', 'gateway', 7]);

    expect({ read: await readAgainWhile(own, kept.read, async () => {}), asked: kept.asked() }).toEqual({ read: 7, asked: 3 });
  });

  test('keeps the fifth refusal in a row however long the own read lasts', async () => {
    const kept = answering(['gateway']);

    await expect(readAgainWhile(reading(), kept.read, async () => {})).rejects.toThrow('answered 502');
    expect(kept.asked()).toBe(REFUSALS_IN_A_ROW);
  });

  test('keeps its last refusal once the own read has ended, and fails at once on any other failure', async () => {
    const own = reading();
    const kept = answering(['gateway', 7]);
    const rejected = answering(['rejected', 7]);

    own.ended = true;
    own.end();

    await expect(readAgainWhile(own, kept.read, async () => {})).rejects.toThrow('answered 502');
    await expect(readAgainWhile(reading(), rejected.read, async () => {})).rejects.toThrow('answered 400');
    expect({ kept: kept.asked(), rejected: rejected.asked() }).toEqual({ kept: 1, rejected: 1 });
  });

  test('stops asking when the own read ends during its wait, keeping the refusal', async () => {
    const own = reading();
    const kept = answering(['gateway', 7]);
    const waiting = readAgainWhile(own, kept.read, async () => new Promise<void>(() => {}));

    own.ended = true;
    own.end();

    await expect(waiting).rejects.toThrow('answered 502');
    expect(kept.asked()).toBe(1);
  });
});

// Staging 99a13686c, 2026-10-23: a deploy's reads spent about 80 requests every 2 min for 20 minutes, and the account's
// API answered 403. The query API states the user's budget on each answer (1,200 requests a 300 s window).
describe('the API budget every telemetry read spends from', () => {
  const answer = (status: number, left: number, endsIn: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers: {
    'ratelimit-policy': '"default";q=1200;w=300', ratelimit: `"default";r=${String(left)};t=${String(endsIn)}`, ...headers,
  } });

  const budget = () => {
    const slept: number[] = [];

    return { slept, budget: new QueryBudget(async (ms) => { slept.push(ms); }, () => 1_000_000) };
  };

  test('a read waits for the window\'s end rather than spend the half kept for the account\'s other calls, and every read waits with it', async () => {
    const half = budget();
    const above = budget();

    half.budget.heard(answer(200, 599, 40));
    above.budget.heard(answer(200, 600, 40));
    await Promise.all([half.budget.spend(), half.budget.spend(), above.budget.spend()]);
    await half.budget.spend();

    expect({ half: half.slept, above: above.slept }).toEqual({ half: [40_000], above: [] });
  });

  test('a 429 leaves nothing to spend until its retry-after', async () => {
    const limited = budget();

    limited.budget.heard(answer(429, 0, 200, { 'retry-after': '30' }));
    await limited.budget.spend();

    expect(limited.slept).toEqual([30_000]);
  });
});
