import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  CAPTURE_CAPABILITIES,
  decideCaptureMechanism,
  type CaptureCapabilityId,
  type CaptureCheckStatus,
} from '../packages/devbox/src/capture/index';
import { MECHANISM_GATES, parseReport, renderPlan } from './bench-capture-probe';

const PROBE_SOURCE = readFileSync(
  new URL('./fixtures/capture-probe/probe.ts', import.meta.url),
  'utf8',
);

function sampleReport(checks: Partial<Record<CaptureCapabilityId, CaptureCheckStatus>>) {
  return {
    probeVersion: 1,
    platform: 'fixture-container',
    kernel: '6.0.0-fixture',
    checks: CAPTURE_CAPABILITIES.map((id) => ({
      id,
      status: checks[id] ?? 'absent',
      detail: `${id}: ${checks[id] ?? 'absent'} (fixture)`,
    })),
  };
}

describe('the capture-probe instrument', () => {
  test('the deployed probe measures exactly the closed capability set', () => {
    // Drift runs both ways: an id measured but not modeled poisons the report
    // schema; an id modeled but never measured gates fail-closed forever.
    for (const id of CAPTURE_CAPABILITIES) {
      expect(PROBE_SOURCE).toContain(`'${id}'`);
    }
    expect(PROBE_SOURCE).toContain('probeVersion: 1');
  });

  test('the plan names only real capabilities and covers both mechanisms', () => {
    const plan = renderPlan();
    expect(plan).toContain('freeze-drain');
    expect(plan).toContain('mutation-journal');
    expect(MECHANISM_GATES.flatMap((gate) => gate.requires)).toEqual([
      'pid-namespace',
      'process-freeze',
      'cgroup-freezer',
      'fork-proof-window',
      '(fuse-mount | fanotify-cap-sys-admin)',
    ]);
  });

  test('a saved probe report parses through the contract and decides', () => {
    const capable = parseReport(JSON.stringify(sampleReport({
      'pid-namespace': 'present',
      'process-freeze': 'present',
      'cgroup-freezer': 'present',
      'fork-proof-window': 'present',
      syncfs: 'present',
    })));
    expect(decideCaptureMechanism(capable)).toEqual({
      verdict: 'capable',
      mechanism: 'freeze-drain',
      cutSemantics: 'freeze-barrier',
      caveats: [],
    });

    const stranded = parseReport(JSON.stringify(sampleReport({ 'pid-namespace': 'unknown' })));
    expect(decideCaptureMechanism(stranded)).toEqual({
      verdict: 'no-go',
      reasons: ['no-writer-quiesce', 'no-journal-interception'],
    });
  });

  test('garbage probe output is rejected loudly, not parsed hopefully', () => {
    expect(() => parseReport('not json at all')).toThrow();
    expect(() => parseReport(JSON.stringify({ probeVersion: 1 }))).toThrow();
  });
});
