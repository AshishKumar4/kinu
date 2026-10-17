import { describe, expect, test } from 'bun:test';
import { ALERT_THRESHOLDS } from '@kinu.run/core/analytics';
import { KinuError } from '@kinu.run/core/obs';
import { canaryActivations } from './durability-canary-telemetry';
import {
  alarmsThatRan, deletionTimes, idleWakeHours, ordinalHours, settledRead, terminalEffectStates, type VersionRead, versionFindings, versionSignals,
  workWindow,
} from './prod-logs';

const HOUR = 3_600_000;

const quiet: VersionRead = { ended: [], thrown: [], deployResets: [], effects: { failed: 0, failedTurns: 0, terminal: { observations: 0, settled: [], owed: [], parked: [], deleted: [] } }, startups: [], idleWakes: [] };

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
  /** Answers each count in turn, its last forever; `refused` is a read the API answered 500, `rejected` one it answered
   *  400, a query it will never take. */
  /** Answers each count in turn, its last forever; `refused` is a read the API answered 500, `rejected` one it answered
   *  400, a query it will never take. The window ends at `windowEnd`, the first read starts at `startAt`, and each read
   *  takes `readMs`. */
  const reader = (counts: readonly (number | 'refused' | 'rejected')[], { windowEnd = 0, startAt = 0, readMs = 0 } = {}) => {
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

        return count === 'rejected' ? Promise.reject(new KinuError('bad_input', 'telemetry query answered 400')) : Promise.resolve(count);
      },
      fingerprint: (count: number) => String(count), rows: (count: number) => count,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;

        return Promise.resolve();
      },
      windowEnd, pollMs: 2, holdMs: 10, capMs: 60,
    };
  };

  // Every row of the window's events has landed `holdMs` after its end, so that read decides, once another agrees.
  test('settles at the first read a hold past the window\'s end that agrees with the one before, its reads on a grid', async () => {
    const late = reader([5, 7, 7, 7, 7], { startAt: 3, readMs: 1 });

    expect(await settledRead(late)).toEqual({ settled: true, value: 7, reads: 5, lateRows: 2 });
    expect(late.startedAt).toEqual([3, 4, 6, 8, 10]);
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

  // Staging 2026-10-14: the API answered 500 to 12 of 80 reads, which named nothing about the version.
  test('reads again after a refused read, which neither agrees nor disagrees', async () => {
    // Answered at 2, 4, 8 and 10; refused at 0 and 6.
    expect(await settledRead(reader(['refused', 5, 5, 'refused', 5, 5, 5, 5]))).toEqual({ settled: true, value: 5, reads: 4, lateRows: 0 });
  });

  test('fails with the refusal when no read is answered before the cap', async () => {
    await expect(settledRead(reader(['refused']))).rejects.toThrow('telemetry query answered 500');
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

// Staging 2026-10-08: the canary's object started six times and telemetry kept four of the startup rows.
test('a dropped startup row is an activation still: the ordinals count it, at an unknown time', () => {
  const read = canaryActivations(null, [startup(10, 3), startup(40, 6), startup(20, 4)]);

  expect(read.map((activation) => [activation.ordinal, activation.at])).toEqual([[3, 10], [4, 20], [5, null], [6, 40]]);
  expect(canaryActivations([{ ordinal: 9, at: 5, version: null }], [startup(10, 3)])).toEqual([{ ordinal: 9, at: 5, version: null }]);
});
