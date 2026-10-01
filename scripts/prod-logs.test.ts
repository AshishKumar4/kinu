import { describe, expect, test } from 'bun:test';
import { ALERT_THRESHOLDS } from '@kinu.run/core/analytics';
import { type VersionRead, versionFindings } from './prod-logs';

const HOUR = 3_600_000;

const quiet: VersionRead = { ended: [], effects: { failed: 0, failedTurns: 0, owed: 0 }, startups: [], alarms: [] };

describe('what one deployed version did, as a deploy reports it', () => {
  // Staging's version f62dfcb9, 2026-09-30: 19 uncaught exceptions in SupervisorRPC and 609 canceled sandbox calls,
  // while every test of that deploy passed.
  test('an uncaught exception, a platform kill and a failed or owed terminal effect are each a finding; a caller going away is none', () => {
    const findings = versionFindings({
      ...quiet,
      ended: [
        { outcome: 'exception', entrypoint: 'SupervisorRPC', count: 19, objects: 1 },
        { outcome: 'exceededMemory', entrypoint: 'OrchestratorAgent', count: 2, objects: 1 },
        { outcome: 'canceled', entrypoint: 'KinuSandbox', count: 609, objects: 4 },
        { outcome: 'aborted', entrypoint: 'OrchestratorAgent', count: 77, objects: 64 },
      ],
      effects: { failed: 2, failedTurns: 2, owed: 3 },
    });

    expect(findings.map((found) => found.what)).toEqual([
      'uncaught exceptions in SupervisorRPC', 'OrchestratorAgent ended by the platform (exceededMemory)',
      'failed terminal effects', 'owed terminal effects',
    ]);
    expect(versionFindings(quiet)).toEqual([]);
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
