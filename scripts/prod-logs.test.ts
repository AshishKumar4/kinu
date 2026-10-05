import { describe, expect, test } from 'bun:test';
import { ALERT_THRESHOLDS } from '@kinu.run/core/analytics';
import { terminalEffectStates, type VersionRead, versionFindings } from './prod-logs';

const HOUR = 3_600_000;

const quiet: VersionRead = { ended: [], thrown: [], deployResets: [], effects: { failed: 0, failedTurns: 0, terminal: { observations: 0, settled: [], owed: [] } }, startups: [], alarms: [] };

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
        terminal: { observations: 3, settled: [], owed: [{ object: '5c7e7ea536ffeb1e', sequence: 'dd25fbbb/42219f95', detail: 'owed v1:sleep_time:42219f95' }] },
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

  // Staging under the tiers and the evals, 2026-09-30: at most 16 alarms in an object-hour, and at most 3 startups.
  test('an object woken as often as the product calls a wake loop, by startups or alarms, is a finding, and the measured busiest is none', () => {
    const loop = ALERT_THRESHOLDS.startupsPerHour;

    const findings = versionFindings({
      ...quiet,
      startups: [{ object: 'looping', hour: 0, startups: loop }, { object: 'busiest-measured', hour: 0, startups: 3 }],
      alarms: [{ object: 'storming', hour: HOUR, count: loop }, { object: 'busiest-measured', hour: HOUR, count: 16 }],
    });

    expect(findings).toEqual([
      { what: 'a wake loop', finding: `object looping started ${String(loop)} times in an hour, 1 such hour(s)` },
      { what: 'an alarm storm', finding: `object storming took ${String(loop)} alarms in the hour from 1970-01-01T01:00:00Z` },
    ]);
  });
});
