/**
 * The one word the Env view puts beside a machine, as the owner reads it.
 *
 * The defect this file pins: a connected laptop the workspace holds no grant
 * on rendered as "active", so the row promised exactly what the agent could
 * not do. The row's own claim — is the machine THERE — is not in question;
 * the question is which single word tells the owner why an agent that sees
 * the machine cannot use it yet. That word is not a label on the grant model:
 * it is the row the same grid renders for every other executor, compared in
 * every direction a reader could mistake for it.
 */
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { statusOf } from '../src/components/surfaces/EnvironmentSurface';
import type { MountInfo } from '@kinu.run/core';
import type { ExecutorInfo } from '../src/lib/executors';

const LIVE: MountInfo = {
  name: 'laptop', prefix: 'laptop.*', live: true,
  policy: { readOnly: false, consistency: 'live-shared' }, reason: null,
};

const OFFLINE: MountInfo = { ...LIVE, live: false, reason: 'Device registered but offline.' };

/** The laptop row as the polled executor surface reports it. */
function exec(row: Partial<ExecutorInfo>): ExecutorInfo {
  return {
    name: 'laptop', kind: 'laptop', capabilities: [], available: true,
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
    // `granted` is only answered for a CONNECTED machine, so this pairing is a
    // stale row at worst; the machine the owner sees is not there, and the
    // word must say so. The device's own branch in the hub never answers it.
    expect(statusOf(OFFLINE, exec({ granted: false }))).toMatchObject({ word: 'offline' });
    expect(statusOf(OFFLINE, exec({ granted: true }))).toMatchObject({ word: 'offline' });
  });

  test('no grant answer to read: every executor keeps its own word', () => {
    // `granted` absent is every environment that has no consent gate — the
    // sandbox, the workspace, and a laptop row whose snapshot predates the
    // field. None of them may read as needing approval.
    expect(statusOf(LIVE, exec({}))).toMatchObject({ word: 'active' });
    expect(statusOf(LIVE, exec({ status: 'idle', active: false }))).toMatchObject({ word: 'idle' });
    expect(statusOf(LIVE, exec({ status: 'error', active: false }))).toMatchObject({ word: 'error' });
  });

  test('another executor that answers granted stays on its own words', () => {
    // Only a future executor with a grant of its own could reach this; today
    // the field is the device's. The guard is the same either way: the word is
    // the device row's answer to one question, not a style applied by field.
    const sandbox: MountInfo = {
      name: 'sandbox', prefix: 'sandbox.*', live: true,
      policy: { readOnly: false, consistency: 'ephemeral' }, reason: null,
    };
    const row = exec({ name: 'sandbox', kind: 'sandbox', granted: false });
    expect(statusOf(sandbox, row)).toMatchObject({ word: 'active' });
  });
});
