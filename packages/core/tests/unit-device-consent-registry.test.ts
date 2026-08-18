/**
 * The device-consent registry, through its public seam.
 *
 * The registry parks a device call on a promise until the owner answers or the
 * prompt expires. It was Durable Object state; the only platform-shaped piece
 * left is `announce`, which these tests record.
 */

import { describe, test, expect } from 'bun:test';
import {
  DeviceConsentRegistry,
  type DeviceConsentNotice,
  type DeviceConsentRequest,
} from '../src/index';

const REQUEST: DeviceConsentRequest = {
  deviceId: 'dev-1',
  deviceLabel: "ashish's laptop",
  method: 'exec',
  command: 'git status',
  scope: 'all_local_actions',
};

function registry(timeoutMs = 10_000) {
  const notices: DeviceConsentNotice[] = [];
  let n = 0;
  const reg = new DeviceConsentRegistry({
    announce: (notice) => { notices.push(notice); },
    newId: () => `cons-${++n}`,
    timeoutMs,
    now: () => 1_700_000_000_000,
  });
  return { reg, notices };
}

describe('DeviceConsentRegistry', () => {
  test('a raised prompt is announced, listed, and settles on the answer', async () => {
    const { reg, notices } = registry();
    const pending = reg.request(REQUEST);

    expect(notices).toEqual([{
      kind: 'raised',
      consent: { ...REQUEST, consentId: 'cons-1', createdAt: 1_700_000_000_000 },
    }]);
    expect(reg.list()).toEqual([{ ...REQUEST, consentId: 'cons-1', createdAt: 1_700_000_000_000 }]);

    expect(reg.resolve('cons-1', 'always')).toBe(true);
    expect(await pending).toBe('always');
    expect(notices[1]).toEqual({ kind: 'settled', consentId: 'cons-1' });
    // Settled prompts leave the list, so a reloading client re-renders nothing.
    expect(reg.list()).toEqual([]);
  });

  test('an unanswered prompt expires as `timeout`, never as `deny`', async () => {
    // A refusal is policy the agent will remember; an absence is not. Telling
    // the model it was refused turns the owner stepping away into a permanent,
    // self-imposed capability loss.
    const { reg, notices } = registry(1);
    const decision = await reg.request(REQUEST);
    expect(decision).toBe('timeout');
    expect(reg.list()).toEqual([]);
    expect(notices.map((n) => n.kind)).toEqual(['raised', 'settled']);
  });

  test('an answer that arrives after the prompt expired is refused, not double-settled', async () => {
    const { reg } = registry(1);
    const decision = await reg.request(REQUEST);
    expect(decision).toBe('timeout');
    expect(reg.resolve('cons-1', 'once')).toBe(false);
  });

  test('an unknown consent id is refused', () => {
    const { reg } = registry();
    expect(reg.resolve('cons-nope', 'once')).toBe(false);
  });

  test('resolving one prompt leaves its siblings waiting', async () => {
    const { reg } = registry();
    const first = reg.request(REQUEST);
    reg.request({ ...REQUEST, command: 'rm -rf build' });
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-1', 'cons-2']);

    reg.resolve('cons-1', 'deny');
    expect(await first).toBe('deny');
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-2']);
  });

  test('waiting prompts appear in the per-step dynamic context', () => {
    const { reg } = registry();
    void reg.request(REQUEST);
    expect(reg.approvals()).toEqual([{
      id: 'cons-1',
      kind: 'device consent',
      detail: "ashish's laptop: git status",
    }]);
  });
});
