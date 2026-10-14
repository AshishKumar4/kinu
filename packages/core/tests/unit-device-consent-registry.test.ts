/** The device-consent registry through its public seam; `announce` and `wake` are the only platform-shaped pieces. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import {
  DeviceConsentRegistry, DeviceConsentStore, deviceConsentOutcome, DENIAL_STANDING_MS,
  type AgentSignal, type DeviceConsentNotice, type DeviceConsentRequest,
} from '../src/index';
import { KinuError } from '../src/obs/index';
import { initDeviceConsentAsksTable } from '../src/safety/device-consent';
import { makeExecRaw, makeSql } from './helpers';

const REQUEST: DeviceConsentRequest = {
  deviceId: 'dev-1',
  deviceLabel: "ashish's device",
  method: 'exec',
  command: 'git status',
  actorId: 'actor-root',
};

const T0 = 1_700_000_000_000;

/** One registry over an in-memory database, in the DO workspace schema's shape, its clock and wakes in the test's hands. */
function registry(failWakesOf: readonly string[] = []) {
  const db = new Database(':memory:');
  initDeviceConsentAsksTable(makeExecRaw(db));
  const notices: DeviceConsentNotice[] = [];
  const woken: Array<{ readonly actorId: string; readonly signal: AgentSignal }> = [];
  const clock = { now: T0 };
  let n = 0;

  const reg = new DeviceConsentRegistry({
    store: new DeviceConsentStore(makeSql(db)),
    announce: (notice) => { notices.push(notice); },
    newId: () => `cons-${++n}`,
    wake: (actorId, signal) => {
      woken.push({ actorId, signal });

      return failWakesOf.includes(actorId) ? Effect.fail(new KinuError('unavailable', `${actorId} is retired`)) : Effect.void;
    },
    now: () => clock.now,
  });

  return { reg, notices, woken, clock };
}

describe('an ask parks on the owner, as a deferred approval does', () => {
  test('the call that raises it is NOT RUN at once, and the card is announced and listed until answered', async () => {
    const { reg, notices, woken } = registry();

    expect(reg.ask(REQUEST)).toBe('queued');

    const { actorId: _actorId, ...card } = REQUEST;

    expect(notices).toEqual([{ kind: 'raised', consent: { ...card, consentId: 'cons-1', createdAt: T0 } }]);
    expect(reg.list()).toEqual([{ ...card, consentId: 'cons-1', createdAt: T0 }]);
    expect(await reg.resolve('cons-1', 'once')).toBe(true);
    expect(notices.at(-1)).toEqual({ kind: 'settled', consentId: 'cons-1' });
    // Answered asks leave the list, so a reloading client re-renders nothing.
    expect(reg.list()).toEqual([]);
    expect(woken.map(({ actorId, signal }) => [actorId, signal.kind, signal.text])).toEqual([
      ['actor-root', 'device_consent', "Device use APPROVED, still not run: re-issue once:\n  ashish's device: git status"],
    ]);
  });

  test('no ask lapses: it waits on the owner however long they take', () => {
    const { reg, clock } = registry();

    reg.ask(REQUEST);
    clock.now += 30 * 24 * 60 * 60 * 1000;

    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-1']);
    expect(reg.ask(REQUEST)).toBe('queued');
  });

  test('a re-issue before the answer joins its ask: one id, one card', () => {
    const { reg, notices } = registry();

    expect([reg.ask(REQUEST), reg.ask({ ...REQUEST, deviceLabel: 'renamed' })]).toEqual(['queued', 'queued']);
    expect(notices.filter((notice) => notice.kind === 'raised')).toHaveLength(1);
  });

  test("the re-issue an approval wakes runs on it once; the next call asks again", async () => {
    const { reg } = registry();

    reg.ask(REQUEST);
    await reg.resolve('cons-1', 'once');

    expect(reg.ask(REQUEST)).toBe('once');
    expect(reg.ask(REQUEST)).toBe('queued');
    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-2']);
  });

  test('a denial stands for its re-issues, then is swept and asked again', async () => {
    const { reg, woken, clock } = registry();

    reg.ask(REQUEST);
    await reg.resolve('cons-1', 'deny');

    expect(woken.map(({ signal }) => signal.text)).toEqual(["Device use DENIED: do not re-issue:\n  ashish's device: git status"]);
    expect(reg.ask(REQUEST)).toBe('denied');
    clock.now += DENIAL_STANDING_MS;
    expect(reg.ask(REQUEST)).toBe('queued');
  });

  test('a second answer, or an answer to an unknown id, decides nothing', async () => {
    const { reg, woken } = registry();

    reg.ask(REQUEST);

    expect(await reg.resolve('cons-1', 'once')).toBe(true);
    expect(await reg.resolve('cons-1', 'deny')).toBe(false);
    expect(await reg.resolve('cons-404', 'once')).toBe(false);
    expect(woken).toHaveLength(1);
  });

  test("the owner's own call is asked like any other, and its answer wakes nobody", async () => {
    const { reg, woken } = registry();
    const { actorId: _actorId, ...owners } = REQUEST;

    reg.ask(owners);

    expect(await reg.resolve('cons-1', 'once')).toBe(true);
    expect(woken).toEqual([]);
    expect(reg.ask(owners)).toBe('once');
  });

  test('waiting asks appear in the per-step dynamic context', () => {
    const { reg } = registry();

    reg.ask(REQUEST);

    expect(reg.approvals()).toEqual([{ id: 'cons-1', kind: 'device consent', detail: "ashish's device: git status" }]);
  });
});

describe('an always answer binds the device for the workspace', () => {
  test('it answers every other ask waiting on that device for that workspace, whatever the command, and each asker once', async () => {
    const { reg, woken } = registry();

    reg.ask({ ...REQUEST, workspaceName: 'ws' });
    reg.ask({ ...REQUEST, workspaceName: 'ws', command: 'ls' });
    reg.ask({ ...REQUEST, workspaceName: 'ws', actorId: 'actor-hire', command: 'pwd' });
    reg.ask({ ...REQUEST, workspaceName: 'other' });
    reg.ask({ ...REQUEST, workspaceName: 'ws', deviceId: 'dev-2' });

    expect(await reg.resolve('cons-1', 'always')).toBe(true);
    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-4', 'cons-5']);
    expect(woken.map(({ actorId, signal }) => [actorId, signal.metadata?.ids])).toEqual([
      ['actor-root', ['cons-1', 'cons-2']],
      ['actor-hire', ['cons-3']],
    ]);
    expect(reg.ask({ ...REQUEST, workspaceName: 'ws', command: 'ls' })).toBe('always');
  });

  test('a denial answers only the ask it was given on', async () => {
    const { reg } = registry();

    reg.ask(REQUEST);
    reg.ask({ ...REQUEST, command: 'ls' });
    await reg.resolve('cons-1', 'deny');

    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-2']);
  });

  test("one asker's failed wake is the answer's failure, after every other asker is told", async () => {
    const { reg, woken } = registry(['actor-hire']);

    reg.ask({ ...REQUEST, actorId: 'actor-hire' });
    reg.ask({ ...REQUEST, command: 'ls' });

    expect(reg.resolve('cons-1', 'always')).rejects.toThrow('actor-hire is retired');
    await Promise.resolve();
    expect(woken.map(({ actorId }) => actorId).sort()).toEqual(['actor-hire', 'actor-root']);
    expect(reg.list()).toEqual([]);
  });
});

describe("a device call's consent, as the binding rule decides it", () => {
  const outcome = async (bound: 'allow' | 'deny' | null, verdict: ReturnType<DeviceConsentRegistry['ask']> | KinuError) => {
    const bindings: string[] = [];

    const answer = await Effect.runPromise(deviceConsentOutcome({
      bound, deviceLabel: 'the laptop',
      ask: verdict instanceof KinuError ? Effect.fail(verdict) : Effect.succeed(verdict),
      bind: Effect.sync(() => { bindings.push('bound'); }),
    }));

    return { answer, bound: bindings };
  };

  test('a standing binding decides without asking', async () => {
    expect(await outcome('allow', 'queued')).toEqual({ answer: { allowed: true }, bound: [] });
    expect(await outcome('deny', 'once')).toEqual({ answer: { allowed: false, code: 'denied', reason: 'device use was not approved: the owner declined' }, bound: [] });
  });

  test('an always the call spends is bound, a once runs this call alone, and a parked ask did not start', async () => {
    expect(await outcome(null, 'always')).toEqual({ answer: { allowed: true }, bound: ['bound'] });
    expect(await outcome(null, 'once')).toEqual({ answer: { allowed: true }, bound: [] });
    expect((await outcome(null, 'queued')).answer).toMatchObject({ allowed: false, code: 'unavailable', reason: expect.stringContaining('NOT RUN') });
  });

  test('an ask that could not be raised is unanswered, never a refusal', async () => {
    expect((await outcome(null, new KinuError('unavailable', 'the workspace is gone'))).answer)
      .toMatchObject({ allowed: false, code: 'unavailable', reason: expect.stringContaining('nobody decided') });
  });
});
