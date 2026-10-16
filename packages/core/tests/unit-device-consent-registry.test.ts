/** The device-consent registry through its public seam; `announce` and `wake` are the only platform-shaped pieces. */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import {
  DeviceConsentRegistry, DeviceConsentStore, deviceConsentOutcome, DENIAL_STANDING_MS, RESUMED_SURFACE,
  type AgentSignal, type DeviceConsentNotice, type DeviceConsentRequest,
} from '../src/index';
import { KinuError } from '../src/obs/index';
import { initDeviceConsentAsksTable } from '../src/safety/device-consent';
import { createTestActors } from '@kinu.run/test-utils';
import { makeExecRaw, makeSql } from './helpers';

const T0 = 1_700_000_000_000;

const LABEL = "ashish's device";

/**
 * One registry over an in-memory database, in the DO workspace schema's shape: its asks come from the workspace's
 * main agent (`root`) and one hire (`hire`), and its clock and wakes are in the test's hands.
 */
function registry(failWakes = false) {
  const db = new Database(':memory:');
  const execRaw = makeExecRaw(db);
  initDeviceConsentAsksTable(execRaw);
  const actors = createTestActors(makeSql(db), execRaw);
  const root = actors.main.actorId;
  const hire = actors.sibling('courier').actorId;
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

      return failWakes && actorId === hire ? Effect.fail(new KinuError('unavailable', 'the hire is retired')) : Effect.void;
    },
    now: () => clock.now,
  });

  /** `git status` on the device by the main agent, under the hub's first epoch, unless overridden. */
  const req = (over: Partial<DeviceConsentRequest> = {}): DeviceConsentRequest => ({
    deviceId: 'dev-1', deviceLabel: LABEL, method: 'exec', command: 'git status', actorId: root, epoch: 0, ...over,
  });

  const retire = (actorId: string) => {
    db.query('UPDATE workspace_actors SET retiring_at = ? WHERE actor_id = ?').run(T0, actorId);
  };

  return { reg, notices, woken, clock, root, hire, req, retire };
}

describe('an ask parks on the owner, as a deferred approval does', () => {
  test('the call that raises it is NOT RUN at once, and the card is announced and listed until answered', async () => {
    const { reg, notices, woken, root, req } = registry();

    expect(reg.ask(req())).toBe('queued');

    const card = { deviceId: 'dev-1', deviceLabel: LABEL, method: 'exec', command: 'git status', consentId: 'cons-1', createdAt: T0 };

    expect(notices).toEqual([{ kind: 'raised', consent: card }]);
    expect(reg.list()).toEqual([card]);
    expect(await reg.resolve('cons-1', 'once')).toBe(true);
    expect(notices.at(-1)).toEqual({ kind: 'settled', consentId: 'cons-1' });
    // Answered asks leave the list, so a reloading client re-renders nothing.
    expect(reg.list()).toEqual([]);
    expect(woken.map(({ actorId, signal }) => [actorId, signal.kind, signal.text])).toEqual([
      [root, 'device_consent', `Device use APPROVED, still not run: re-issue once:\n  ${LABEL}: git status`],
    ]);
  });

  test('no ask lapses: it waits on the owner however long they take', () => {
    const { reg, clock, req } = registry();

    reg.ask(req());
    clock.now += 30 * 24 * 60 * 60 * 1000;

    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-1']);
    expect(reg.ask(req())).toBe('queued');
  });

  test('a re-issue before the answer joins its ask: one id, one card', () => {
    const { reg, notices, req } = registry();

    expect([reg.ask(req()), reg.ask(req({ deviceLabel: 'renamed' }))]).toEqual(['queued', 'queued']);
    expect(notices.filter((notice) => notice.kind === 'raised')).toHaveLength(1);
  });

  test('the re-issue an approval wakes runs on it once; the next call asks again', async () => {
    const { reg, req } = registry();

    reg.ask(req());
    await reg.resolve('cons-1', 'once');

    expect(reg.ask(req())).toBe('once');
    expect(reg.ask(req())).toBe('queued');
    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-2']);
  });

  test('an approval is its own asker\'s: another agent\'s identical call asks for itself', async () => {
    const { reg, hire, req } = registry();

    reg.ask(req());
    await reg.resolve('cons-1', 'once');

    expect(reg.ask(req({ actorId: hire }))).toBe('queued');
    expect(reg.ask(req())).toBe('once');
  });

  test('a denial stands for its re-issues, then is swept and asked again', async () => {
    const { reg, woken, clock, req } = registry();

    reg.ask(req());
    await reg.resolve('cons-1', 'deny');

    expect(woken.map(({ signal }) => signal.text)).toEqual([`Device use DENIED: do not re-issue:\n  ${LABEL}: git status`]);
    expect(reg.ask(req())).toBe('denied');
    clock.now += DENIAL_STANDING_MS;
    expect(reg.ask(req())).toBe('queued');
  });

  test('a second answer, or an answer to an unknown id, decides nothing', async () => {
    const { reg, woken, req } = registry();

    reg.ask(req());

    expect(await reg.resolve('cons-1', 'once')).toBe(true);
    expect(await reg.resolve('cons-1', 'deny')).toBe(false);
    expect(await reg.resolve('cons-404', 'once')).toBe(false);
    expect(woken).toHaveLength(1);
  });

  test("the owner's own call is asked like any other, and its answer wakes nobody", async () => {
    const { reg, woken, req } = registry();
    const { actorId: _actorId, ...owners } = req();

    reg.ask(owners);

    expect(await reg.resolve('cons-1', 'once')).toBe(true);
    expect(woken).toEqual([]);
    expect(reg.ask(owners)).toBe('once');
  });

  test('waiting asks appear in the per-step dynamic context', () => {
    const { reg, req } = registry();

    reg.ask(req());

    expect(reg.approvals()).toEqual([{ id: 'cons-1', kind: 'device consent', detail: `${LABEL}: git status` }]);
  });

  test("a retired agent's ask leaves the owner's list: nobody it could wake is left; the owner's own stays", () => {
    const { reg, hire, req, retire } = registry();
    const { actorId: _actorId, ...owners } = req({ command: 'ls' });

    reg.ask(req({ actorId: hire }));
    reg.ask(owners);
    retire(hire);

    expect(reg.list().map((pending) => pending.command)).toEqual(['ls']);
  });
});

describe('the re-issue an answer wakes for runs under the surface its call was parked from', () => {
  test('the wake opens its turn on the surface the call was made on, which the card does not show', async () => {
    const { reg, woken, req } = registry();

    reg.ask(req({ surface: 'interactive' }));
    expect(reg.list()[0]).not.toHaveProperty('surface');
    await reg.resolve('cons-1', 'once');
    reg.ask(req({ command: 'ls', surface: 'one-shot' }));
    await reg.resolve('cons-2', 'once');

    expect(woken.map(({ signal }) => signal.metadata?.[RESUMED_SURFACE])).toEqual(['interactive', 'one-shot']);
  });

  test('calls parked from both surfaces are re-issued as interactive; a denial, or a call made in no turn, names none', async () => {
    const { reg, woken, req } = registry();

    reg.ask(req({ workspaceName: 'ws', surface: 'one-shot' }));
    reg.ask(req({ workspaceName: 'ws', command: 'ls', surface: 'interactive' }));
    await reg.resolve('cons-1', 'always');
    reg.ask(req({ command: 'pwd', surface: 'interactive' }));
    await reg.resolve('cons-3', 'deny');
    reg.ask(req({ command: 'whoami' }));
    await reg.resolve('cons-4', 'once');

    expect(woken.map(({ signal }) => [signal.metadata?.ids, signal.metadata?.[RESUMED_SURFACE] ?? null])).toEqual([
      [['cons-1', 'cons-2'], 'interactive'],
      [['cons-3'], null],
      [['cons-4'], null],
    ]);
  });
});

describe('a revocation voids the approvals given before it', () => {
  test('an approval answers no call made under a later epoch, which asks again', async () => {
    const { reg, req } = registry();

    reg.ask(req());
    await reg.resolve('cons-1', 'always');

    expect(reg.ask(req({ epoch: 1 }))).toBe('queued');
    expect(reg.ask(req())).toBe('queued');
    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-2']);
  });

  test('an always that answered a waiting sibling restores nothing after the binding is revoked', async () => {
    const { reg, req } = registry();

    reg.ask(req());
    reg.ask(req({ command: 'ls' }));
    await reg.resolve('cons-1', 'always');

    // The first re-issue spends its always and binds; the owner then revokes the binding.
    expect(reg.ask(req())).toBe('always');
    expect(reg.ask(req({ command: 'ls', epoch: 1 }))).toBe('queued');
  });
});

describe('an always answer binds the device for the workspace', () => {
  test('it answers every other ask waiting on that device for that workspace, whatever the command, and each asker once', async () => {
    const { reg, woken, root, hire, req } = registry();

    reg.ask(req({ workspaceName: 'ws' }));
    reg.ask(req({ workspaceName: 'ws', command: 'ls' }));
    reg.ask(req({ workspaceName: 'ws', actorId: hire, command: 'pwd' }));
    reg.ask(req({ workspaceName: 'other' }));
    reg.ask(req({ workspaceName: 'ws', deviceId: 'dev-2' }));

    expect(await reg.resolve('cons-1', 'always')).toBe(true);
    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-4', 'cons-5']);
    expect(woken.map(({ actorId, signal }) => [actorId, signal.metadata?.ids])).toEqual([
      [root, ['cons-1', 'cons-2']],
      [hire, ['cons-3']],
    ]);
    expect(reg.ask(req({ workspaceName: 'ws', command: 'ls' }))).toBe('always');
  });

  test('a denial answers only the ask it was given on', async () => {
    const { reg, req } = registry();

    reg.ask(req());
    reg.ask(req({ command: 'ls' }));
    await reg.resolve('cons-1', 'deny');

    expect(reg.list().map((pending) => pending.consentId)).toEqual(['cons-2']);
  });

  test("one asker's failed wake is the answer's failure, after every other asker is told", async () => {
    const { reg, woken, root, hire, req } = registry(true);

    reg.ask(req({ actorId: hire }));
    reg.ask(req({ command: 'ls' }));

    await expect(reg.resolve('cons-1', 'always')).rejects.toThrow('the hire is retired');
    expect(woken.map(({ actorId }) => actorId).sort()).toEqual([root, hire].sort());
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

  const refused = { allowed: false, code: 'denied', reason: 'device use was not approved: the owner declined' } as const;

  test('a standing binding decides without asking', async () => {
    expect(await outcome('allow', 'queued')).toEqual({ answer: { allowed: true }, bound: [] });
    expect(await outcome('deny', 'once')).toEqual({ answer: refused, bound: [] });
  });

  test('an always the call spends is bound, a once runs this call alone, and a parked ask did not start', async () => {
    expect(await outcome(null, 'always')).toEqual({ answer: { allowed: true }, bound: ['bound'] });
    expect(await outcome(null, 'once')).toEqual({ answer: { allowed: true }, bound: [] });
    expect((await outcome(null, 'queued')).answer).toMatchObject({ allowed: false, code: 'unavailable', reason: expect.stringContaining('NOT RUN') });
    expect(await outcome(null, 'denied')).toEqual({ answer: refused, bound: [] });
  });

  test('an ask that could not be raised is unanswered, never a refusal', async () => {
    expect((await outcome(null, new KinuError('unavailable', 'the workspace is gone'))).answer)
      .toMatchObject({ allowed: false, code: 'unavailable', reason: expect.stringContaining('nobody decided') });
  });
});
