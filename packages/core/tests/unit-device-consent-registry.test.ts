/**
 * The device-consent registry, through its public seam.
 *
 * The registry parks a device call on a promise until the owner answers or the
 * prompt expires. It was Durable Object state; the only platform-shaped piece
 * left is `announce`, which these tests record.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  DeviceConsentRegistry, DeviceConsentStore, initDeviceConsentRequestsTable,
  type DeviceConsentNotice,
  type DeviceConsentRequest,
} from '../src/index';
import { makeExecRaw, makeSql } from './helpers';

const REQUEST: DeviceConsentRequest = {
  deviceId: 'dev-1',
  deviceLabel: "ashish's laptop",
  method: 'exec',
  command: 'git status',
};

/** One registry's durable half over its own in-memory database — the same
 *  store shape the DO's workspace schema hands the real one. */
function consentStore(): DeviceConsentStore {
  const db = new Database(':memory:');
  initDeviceConsentRequestsTable(makeExecRaw(db));

  return new DeviceConsentStore(makeSql(db));
}

function registry(timeoutMs = 10_000) {
  const notices: DeviceConsentNotice[] = [];
  let n = 0;

  const reg = new DeviceConsentRegistry({
    store: consentStore(),
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
 * The hub's half of a card: `connected` is not an owner's click, it is the
 * machine arriving — and it settles the prompt exactly like one.
 */
describe('DeviceConsentRegistry non-owner settlement', () => {
  test('a `connected` settle resolves the waiter with it, and a second settle is a no-op', async () => {
    const { reg, notices } = registry();
    const pending = reg.request(REQUEST);

    expect(reg.settle('cons-1', 'connected')).toBe(true);
    expect(await pending).toBe('connected');
    // The card is gone: a reloading client re-renders nothing, and surfaces
    // heard the same `settled` an answered card produces.
    expect(reg.list()).toEqual([]);
    expect(notices.map((n) => n.kind)).toEqual(['raised', 'settled']);

    // One row, one settle: the id is spent, so the repeat takes nothing.
    expect(reg.settle('cons-1', 'connected')).toBe(false);
    expect(reg.resolve('cons-1', 'once')).toBe(false);
  });

  test('raise answers the card id without parking, and waitSettled joins it', async () => {
    const { reg } = registry();
    const consentId = reg.raise(REQUEST);

    expect(consentId).toBe('cons-1');
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-1']);

    // The join keeps the ONE card: a second raise of the identical ask
    // answers with the same id rather than minting a second.
    expect(reg.raise(REQUEST)).toBe('cons-1');

    const settled = reg.waitSettled('cons-1');
    expect(reg.settle('cons-1', 'connected')).toBe(true);
    // The wait carries no decision — it resolves only to say the card is gone.
    await settled;
    expect(reg.list()).toEqual([]);
  });

  test('waitSettled resolves at once when the card is already gone, or was never raised', async () => {
    const { reg } = registry();
    const consentId = reg.raise(REQUEST);
    expect(reg.settle(consentId, 'connected')).toBe(true);

    // The connect that lands between the hub's two calls: the card is already
    // gone, and the wait still ends — a provisioning ask carries no decision
    // worth remembering, only the fact the card is down.
    await reg.waitSettled(consentId);
    await reg.waitSettled('cons-never');
  });
});

/**
 * One logical grant is one card. A fresh consentId per call gives a retry
 * re-asking the identical question a second card, and no surface can collapse
 * the two: every surface dedups on consentId, and the two ids differ. So the
 * registry decides identity, rather than each caller carrying its own
 * check-then-act across two RPCs.
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
      reg.request({ ...REQUEST, deviceId: 'dev-2' }),
      reg.request({ ...REQUEST, workspaceName: 'notes' }),
    ];

    // One card per question the owner would read differently, so none join.
    expect(reg.list()).toHaveLength(5);

    for (const consent of reg.list()) {
      expect(reg.resolve(consent.consentId, 'deny')).toBe(true);
    }

    await Promise.all(pending);
  });

  test('an answer arriving with the raised notice is accepted, not called unknown', async () => {
    // A surface that resolves synchronously on the notice must not be told the
    // id is unknown, which is what announcing before the id can be answered
    // would do.
    const answered: boolean[] = [];

    const reg = new DeviceConsentRegistry({
      store: consentStore(),
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

  test('an always grant settles every other prompt for that machine, whatever the command', async () => {
    // ONE rule: same machine, same workspace, one answer — whatever the command
    // or the method. There is no consent SCOPE to compare, so a `full_filesystem`
    // prompt cannot be left waiting behind a base-tier grant, and a narrow
    // prompt cannot be settled by a wide grant it never asked about.
    const { reg } = registry();
    const asked = reg.request(REQUEST);
    const wider = reg.request({ ...REQUEST, command: 'cat /etc/shadow' });
    const readFile = reg.request({ ...REQUEST, method: 'readFile', command: 'readFile(/etc/shadow)' });

    reg.resolve('cons-1', 'always');
    expect(await asked).toBe('always');
    // Bound, so allowed — but the remembering was the one "always" answer.
    expect(await wider).toBe('once');
    expect(await readFile).toBe('once');
    expect(reg.list()).toEqual([]);
  });

  test('one workspace\'s binding never settles another workspace\'s card', async () => {
    const { reg } = registry();
    const mine = reg.request({ ...REQUEST, workspaceName: 'notes' });
    const sibling = reg.request({ ...REQUEST, workspaceName: 'inbox' });

    reg.resolve('cons-1', 'always');
    expect(await mine).toBe('always');
    // A binding is per (workspace, device). The sibling still has to be asked.
    expect(reg.list().map((c) => c.consentId)).toEqual(['cons-2']);
    reg.resolve('cons-2', 'deny');
    expect(await sibling).toBe('deny');
  });

  test('the provisioning card grants no device access, so it settles nothing else', async () => {
    const { reg } = registry();
    const provision = { deviceId: '', deviceLabel: 'this computer', method: 'connect' } as const;
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
