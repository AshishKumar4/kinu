// The cloud eval arm's preflight, tested on the four states a deployment can be
// in. Every case is RED-directional: each asserts a distinct refusal or pass,
// and the `current` case is the only one that lets a spending run proceed.
//
// Testable because the verdict is a function over values. The network read and
// the git read are separate and thin on purpose — a preflight whose decision can
// only be exercised by deploying is a preflight nobody re-checks after changing
// it.
import { describe, expect, test } from 'bun:test';

import {
  describeStagingVerdict, stagingDeploymentVerdict, type DeployedHealth,
} from './staging-preflight';

const ORIGIN = 'https://staging.kinu.run';

function health(sha: string | null): DeployedHealth {
  return sha === null
    ? { ok: false, build: null }
    : { ok: true, build: { version: `0.2.0+${sha}`, sha, builtAt: '2026-08-24T00:00:00.000Z' } };
}

describe('the staging preflight', () => {
  test('a deployment on this checkout is current, and says which build', () => {
    const verdict = stagingDeploymentVerdict({ localSha: 'abc1234', health: health('abc1234') });
    expect(verdict.kind).toBe('current');
    expect(describeStagingVerdict(verdict, ORIGIN)).toContain('abc1234');
  });

  test('a deployment on another build is stale and names both shas plus the fix', () => {
    const verdict = stagingDeploymentVerdict({ localSha: 'ffff999', health: health('17abc2980') });
    expect(verdict.kind).toBe('stale');
    const line = describeStagingVerdict(verdict, ORIGIN);
    // Both shas, because "stale" without the pair leaves a reader unable to tell
    // how far behind it is or whether they are looking at the right branch. This
    // is the exact 2026-08-24 shape: deployed 17abc2980, checkout 27 ahead.
    expect(line).toContain('17abc2980');
    expect(line).toContain('ffff999');
    expect(line).toContain('bun run deploy:staging');
    expect(line).toContain('--allow-stale');
  });

  test('a deployment with no build stamp is unstamped, not merely unknown', () => {
    // `ok: false` with `build: null` is the health route's own way of saying the
    // asset bundle is incomplete. Reporting that as "stale" would send someone
    // comparing shas that do not exist.
    const verdict = stagingDeploymentVerdict({ localSha: 'abc1234', health: health(null) });
    expect(verdict.kind).toBe('unstamped');
    expect(describeStagingVerdict(verdict, ORIGIN)).toContain('incomplete');
  });

  test('an unanswered health endpoint carries the transport failure verbatim', () => {
    const verdict = stagingDeploymentVerdict({
      localSha: 'abc1234', health: null, failure: 'HTTP 503',
    });
    expect(verdict.kind).toBe('unreachable');
    // The status is the whole evidence for calling it infrastructure. A verdict
    // that dropped it would be asking to be trusted instead.
    expect(describeStagingVerdict(verdict, ORIGIN)).toContain('HTTP 503');
  });

  test('every verdict names a command or a flag a reader can act on', () => {
    const verdicts = [
      stagingDeploymentVerdict({ localSha: 'a', health: health('a') }),
      stagingDeploymentVerdict({ localSha: 'a', health: health('b') }),
      stagingDeploymentVerdict({ localSha: 'a', health: health(null) }),
      stagingDeploymentVerdict({ localSha: 'a', health: null, failure: 'boom' }),
    ];
    for (const verdict of verdicts) {
      const line = describeStagingVerdict(verdict, ORIGIN);
      // `current` states the build it verified; the other three must name the
      // remedy. A state reported without either has moved the problem.
      const actionable = verdict.kind === 'current'
        ? line.includes('runs this checkout')
        : line.includes('deploy:staging') || line.includes('--allow-stale');
      expect(actionable, `${verdict.kind}: ${line}`).toBe(true);
    }
  });
});
