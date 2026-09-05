import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';


import {
  CAPTURE_CAPABILITIES,
  CaptureCapabilityReportSchema,
  decideCaptureMechanism,
  type CaptureCapabilityId,
  type CaptureCheckStatus,
  type CaptureNoGoReason,
} from '../src/capture';

function report(checks: Partial<Record<CaptureCapabilityId, CaptureCheckStatus>>) {
  return v.parse(CaptureCapabilityReportSchema, {
    probeVersion: 1,
    platform: 'test-container',
    kernel: '6.0.0-test',
    checks: CAPTURE_CAPABILITIES.map((id) => ({
      id,
      status: checks[id] ?? 'absent',
      detail: `${id}: ${checks[id] ?? 'absent'} (fixture)`,
    })),
  });
}

const NO_GO_MATRIX: Array<{
  readonly name: string;
  readonly checks: Partial<Record<CaptureCapabilityId, CaptureCheckStatus>>;
  readonly reasons: readonly CaptureNoGoReason[];
}> = [
  {
    name: 'nothing works: both failure families are named',
    checks: {},
    reasons: ['no-writer-quiesce', 'no-journal-interception'],
  },
  {
    name: 'the complete freezer lacks its born-frozen proof and there is no interception either',
    checks: {
      'pid-namespace': 'present',
      'process-freeze': 'present',
      'cgroup-freezer': 'present',
      syncfs: 'present',
    },
    reasons: ['no-fork-proof', 'no-journal-interception'],
  },
  {
    name: 'unknown counts as absent: an unmeasured premise gates fail-closed',
    checks: { 'process-freeze': 'unknown', 'fuse-mount': 'unknown', 'inotify-overflow-visible': 'unknown' },
    reasons: ['no-writer-quiesce', 'no-journal-interception'],
  },
];

describe('the capability decision', () => {
  test('a fully measured container picks freeze-drain with no caveats', () => {
    const decision = decideCaptureMechanism(report({
      'process-freeze': 'present',
      'cgroup-freezer': 'present',
      'fork-proof-window': 'present',
      syncfs: 'present',
      'fanotify-cap-sys-admin': 'present',
      'fuse-mount': 'present',
      'inotify-overflow-visible': 'present',
      'pid-namespace': 'present',
    }));
    expect(decision).toEqual({
      verdict: 'capable',
      mechanism: 'freeze-drain',
      cutSemantics: 'freeze-barrier',
      caveats: [],
    });
  });

  test('missing syncfs degrades to a named staging caveat, not failure', () => {
    const decision = decideCaptureMechanism(report({
      'pid-namespace': 'present',
      'process-freeze': 'present',
      'cgroup-freezer': 'present',
      'fork-proof-window': 'present',
    }));
    expect(decision.verdict).toBe('capable');
    if (decision.verdict !== 'capable' || decision.mechanism !== 'freeze-drain') return;
    expect(decision.caveats).toEqual(['no whole-filesystem flush: staging falls back to per-file fsync']);
  });

  test('without a provable freeze but with full interception, the journal wins', () => {
    const decision = decideCaptureMechanism(report({
      'process-freeze': 'absent',
      'fork-proof-window': 'absent',
      'fuse-mount': 'present',
    }));
    expect(decision).toEqual({
      verdict: 'capable',
      mechanism: 'mutation-journal',
      cutSemantics: 'journal-seq',
      caveats: [],
    });
  });

  test('fanotify permission events substitute for FUSE coverage', () => {
    const decision = decideCaptureMechanism(report({
      'fanotify-cap-sys-admin': 'present',
    }));
    expect(decision.verdict).toBe('capable');
    if (decision.verdict !== 'capable') return;
    expect(decision.mechanism).toBe('mutation-journal');
  });

  test.each(NO_GO_MATRIX)('$name', ({ checks, reasons }) => {
    expect(decideCaptureMechanism(report(checks))).toEqual({ verdict: 'no-go', reasons });
  });

  test('an empty report is unusable rather than a quiet no-go', () => {
    const empty = v.parse(CaptureCapabilityReportSchema, {
      probeVersion: 1,
      platform: 'test-container',
      kernel: '6.0.0-test',
      checks: [],
    });
    expect(decideCaptureMechanism(empty)).toEqual({ verdict: 'no-go', reasons: ['probe-unusable'] });
  });

  test('the report schema is strict about shape and closed about ids', () => {
    // An unknown capability id is refused by name, so a probe reporting a
    // capability nothing reads cannot pass as a measured one.
    expect(() => v.parse(CaptureCapabilityReportSchema, {
      probeVersion: 1,
      platform: 'x',
      kernel: 'k',
      checks: [{ id: 'teleportation', status: 'present', detail: 'nope' }],
    })).toThrow('but received "teleportation"');
    // A report version this code does not speak is refused, not parsed
    // against a shape its checks may not satisfy.
    expect(() => v.parse(CaptureCapabilityReportSchema, {
      probeVersion: 2,
      platform: 'x',
      kernel: 'k',
      checks: [],
    })).toThrow('Expected 1 but received 2');
  });
});
