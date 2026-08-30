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
    const sibling = reg.request({ ...REQUEST, command: 'rm -rf build' });
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-1', 'cons-2']);

    reg.resolve('cons-1', 'deny');
    expect(await first).toBe('deny');
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-2']);
    expect(reg.resolve('cons-2', 'deny')).toBe(true);
    expect(await sibling).toBe('deny');
  });

  test('waiting prompts appear in the per-step dynamic context', async () => {
    const { reg } = registry();
    const pending = reg.request(REQUEST);
    expect(reg.approvals()).toEqual([{
      id: 'cons-1',
      kind: 'device consent',
      detail: "ashish's laptop: git status",
    }]);
    expect(reg.resolve('cons-1', 'deny')).toBe(true);
    expect(await pending).toBe('deny');
  });
});

/**
 * One logical grant is one card. The registry used to mint a fresh consentId on
 * every call, so a retry re-asking the identical question produced a second
 * card — and no surface could collapse the two, because every surface dedups on
 * consentId and the two ids differ. The provisioning card carried its own
 * caller-side version of this check, for one method, as a check-then-act across
 * two RPCs.
 */
describe('DeviceConsentRegistry identity', () => {
  test('an identical re-ask joins the waiting prompt: one id, one card, one answer', async () => {
    const { reg, notices } = registry();
    const first = reg.request(REQUEST);
    const retry = reg.request({ ...REQUEST });

    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-1']);
    expect(notices.filter((n) => n.kind === 'raised')).toHaveLength(1);

    expect(reg.resolve('cons-1', 'always')).toBe(true);
    expect(await first).toBe('always');
    expect(await retry).toBe('always');
    expect(notices.filter((n) => n.kind === 'settled')).toHaveLength(1);
  });

  test('a refreshed device label joins the pending action on that device', async () => {
    const { reg } = registry();
    const first = reg.request(REQUEST);
    const retry = reg.request({ ...REQUEST, deviceLabel: 'Ashish’s laptop' });

    expect(reg.list()).toHaveLength(1);
    reg.resolve('cons-1', 'once');
    expect(await first).toBe('once');
    expect(await retry).toBe('once');
  });

  test('a joined caller hears a refusal too — it asked the same question', async () => {
    const { reg } = registry();
    const first = reg.request(REQUEST);
    const retry = reg.request({ ...REQUEST });
    reg.resolve('cons-1', 'deny');
    expect(await first).toBe('deny');
    expect(await retry).toBe('deny');
  });

  test('a request differing in anything the card shows gets its own card', async () => {
    const { reg } = registry();
    const pending = [
      reg.request(REQUEST),
      reg.request({ ...REQUEST, command: 'rm -rf build' }),
      reg.request({ ...REQUEST, method: 'readFile' }),
      reg.request({ ...REQUEST, scope: 'full_filesystem' }),
      reg.request({ ...REQUEST, deviceId: 'dev-2' }),
      reg.request({ ...REQUEST, workspaceName: 'notes' }),
    ];
    // Approving one action must never approve another, so none of these join.
    expect(reg.list()).toHaveLength(6);
    for (const consent of reg.list()) {
      expect(reg.resolve(consent.consentId, 'deny')).toBe(true);
    }
    await Promise.all(pending);
  });

  test('an answer arriving with the raised notice is accepted, not called unknown', async () => {
    // A surface that resolves synchronously on the notice used to be told the
    // id was unknown: the announce ran before the id could be answered.
    const answered: boolean[] = [];
    const reg = new DeviceConsentRegistry({
      announce: (notice) => {
        if (notice.kind === 'raised') answered.push(reg.resolve(notice.consent.consentId, 'once'));
      },
      newId: () => 'cons-1',
      timeoutMs: 10_000,
    });
    const decision = await reg.request(REQUEST);
    expect(answered).toEqual([true]);
    expect(decision).toBe('once');
  });
});

/**
 * "always" is a policy, and a policy decides more than the card it arrived on.
 * A prompt the new grant already covers, left waiting, asks the owner to decide
 * again what they just decided forever.
 */
describe('DeviceConsentRegistry always-grant coverage', () => {
  test('an always grant settles the other prompts on that device it covers', async () => {
    const { reg, notices } = registry();
    const granted = reg.request(REQUEST);
    const sibling = reg.request({ ...REQUEST, command: 'rm -rf build' });
    const otherDevice = reg.request({ ...REQUEST, deviceId: 'dev-2' });

    reg.resolve('cons-1', 'always');
    expect(await granted).toBe('always');
    // Covered, so allowed — but the remembering was the one "always" answer.
    expect(await sibling).toBe('once');
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-3']);
    expect(notices.filter((n) => n.kind === 'settled').map((n) => n.kind === 'settled' && n.consentId))
      .toEqual(['cons-1', 'cons-2']);

    reg.resolve('cons-3', 'deny');
    expect(await otherDevice).toBe('deny');
  });

  test('a base-tier grant does not settle a prompt that needs the full-filesystem tier', async () => {
    const { reg } = registry();
    const base = reg.request(REQUEST);
    const wider = reg.request({ ...REQUEST, command: 'cat /etc/shadow', scope: 'full_filesystem' });

    reg.resolve('cons-1', 'always');
    expect(await base).toBe('always');
    // Still waiting: the grant the owner gave does not reach this one.
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-2']);
    reg.resolve('cons-2', 'deny');
    expect(await wider).toBe('deny');
  });

  test('a full-filesystem grant settles the base-tier prompts under it', async () => {
    const { reg } = registry();
    const fullFilesystem = reg.request({ ...REQUEST, scope: 'full_filesystem' });
    const narrower = reg.request({ ...REQUEST, command: 'ls ~' });

    reg.resolve('cons-1', 'always');
    expect(await fullFilesystem).toBe('always');
    expect(await narrower).toBe('once');
    expect(reg.list()).toEqual([]);
  });

  test('the provisioning card grants no device access, so it settles nothing else', async () => {
    const { reg } = registry();
    const provision = { deviceId: '', deviceLabel: 'this computer', method: 'connect', scope: 'all_local_actions' } as const;
    const first = reg.request({ ...provision, command: 'Connect this computer for "notes"' });
    const second = reg.request({ ...provision, command: 'Connect this computer for "inbox"' });

    reg.resolve('cons-1', 'always');
    expect(await first).toBe('always');
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-2']);
    expect(reg.resolve('cons-2', 'once')).toBe(true);
    expect(await second).toBe('once');
  });

  test('a denial settles only the card it was given on', async () => {
    const { reg } = registry();
    const first = reg.request(REQUEST);
    const sibling = reg.request({ ...REQUEST, command: 'rm -rf build' });
    reg.resolve('cons-1', 'deny');
    expect(await first).toBe('deny');
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-2']);
    reg.resolve('cons-2', 'once');
    expect(await sibling).toBe('once');
  });
});
