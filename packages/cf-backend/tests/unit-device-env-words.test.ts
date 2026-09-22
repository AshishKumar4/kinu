/** Defends: a connected device with no workspace grant rendered as "active" in the Env view. */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { statusOf } from '../src/components/surfaces/EnvironmentSurface';
import type { MountInfo } from '@kinu.run/core';
import type { ExecutorInfo } from '@kinu.run/core';

const LIVE: MountInfo = {
  name: 'device', prefix: 'device.*', live: true,
  policy: { readOnly: false, consistency: 'live-shared' }, reason: null,
};

const OFFLINE: MountInfo = { ...LIVE, live: false, reason: 'Device registered but offline.' };

/** The device row as the polled executor surface reports it. */
function exec(row: Partial<ExecutorInfo>): ExecutorInfo {
  return {
    name: 'device', kind: 'device', capabilities: [], available: true,
    configured: true, active: true, status: 'active', ...row,
  };
}

describe('the environment row says needs approval only where approval is the question', () => {
  test('connected and ungranted: needs approval', () => {
    expect(statusOf(LIVE, exec({ granted: false }))).toMatchObject({ word: 'needs approval' });
  });

  test('connected and granted: the active word, not the approval one', () => {
    expect(statusOf(LIVE, exec({ granted: true })))
      .toMatchObject({ word: 'active', dotClass: 'p-success' });
  });

  test('offline: the offline word — a stale grant answer is not reach', () => {
    // `granted` is only answered for a connected machine; this pairing is a stale row.
    expect(statusOf(OFFLINE, exec({ granted: false }))).toMatchObject({ word: 'offline' });
    expect(statusOf(OFFLINE, exec({ granted: true }))).toMatchObject({ word: 'offline' });
  });

  test('no grant answer to read: every executor keeps its own word', () => {
    // `granted` absent means no consent gate; it must not read as needing approval.
    expect(statusOf(LIVE, exec({}))).toMatchObject({ word: 'active' });
    expect(statusOf(LIVE, exec({ status: 'idle', active: false }))).toMatchObject({ word: 'idle' });
    expect(statusOf(LIVE, exec({ status: 'error', active: false }))).toMatchObject({ word: 'error' });
  });

  test('another executor that answers granted stays on its own words', () => {
    const sandbox: MountInfo = {
      name: 'sandbox', prefix: 'sandbox.*', live: true,
      policy: { readOnly: false, consistency: 'ephemeral' }, reason: null,
    };

    const row = exec({ name: 'sandbox', kind: 'sandbox', granted: false });
    expect(statusOf(sandbox, row)).toMatchObject({ word: 'active' });
  });
});
