import { describe, expect, test } from 'bun:test';
import { ALERT_THRESHOLDS } from '@kinu.run/core/analytics';
import { idleWakeHours, terminalEffectStates, type VersionRead, versionFindings } from './prod-logs';

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
});
