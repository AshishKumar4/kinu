// Behavior tests for the shared device-consent watcher: present-once
// semantics across poll ticks that race the server-side resolution, pruning
// of departed ids, print-once non-interactive consents, and clean
// cancellation (best-effort deny) when the turn settles mid-question.
// Each case waits for the poll it needs, observed on the fake surface, so
// nothing here sleeps for a number.
import { describe, expect, test } from 'bun:test';
import type {
  DeviceConsentDecision,
  DeviceConsentSurface,
  PendingDeviceConsent,
} from '../src/agent-client';
import { watchDeviceConsents, type ConsentNoteKind } from '../src/consent-watch';

function consent(id: string): PendingDeviceConsent {
  return { consentId: id, deviceLabel: 'laptop', method: 'exec', command: 'ls' };
}

/** A pending list the test controls, plus a way to await the Nth poll and
 *  the Nth resolution instead of sleeping for them. */
function makeSurface(initial: PendingDeviceConsent[] = []) {
  const resolved: Array<{ consentId: string; decision: DeviceConsentDecision }> = [];
  let pending = initial;
  let resolveOk = true;
  let polls = 0;
  const pollWaiters: Array<{ count: number; resolve: () => void }> = [];
  const resolveWaiters: Array<{ count: number; resolve: () => void }> = [];
  const wake = (waiters: Array<{ count: number; resolve: () => void }>, reached: number) => {
    for (const waiter of waiters.splice(0)) {
      if (waiter.count <= reached) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  const surface: DeviceConsentSurface = {
    listPending: async () => {
      polls += 1;
      wake(pollWaiters, polls);
      return pending;
    },
    resolve: async (consentId, decision) => {
      resolved.push({ consentId, decision });
      wake(resolveWaiters, resolved.length);
      return { ok: resolveOk };
    },
  };
  const awaiting = (waiters: Array<{ count: number; resolve: () => void }>, reached: () => number) =>
    (count: number): Promise<void> => {
      if (reached() >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, resolve });
      return promise;
    };
  return {
    surface,
    resolved,
    /** Resolves once listPending has been asked `count` times. */
    polled: awaiting(pollWaiters, () => polls),
    /** Resolves once `count` decisions reached the surface. */
    settled: awaiting(resolveWaiters, () => resolved.length),
    setPending(next: PendingDeviceConsent[]) { pending = next; },
    setResolveOk(ok: boolean) { resolveOk = ok; },
  };
}

/** Collected notes, plus a way to await the Nth note instead of sleeping. */
function collectNotes() {
  const notes: Array<{ kind: ConsentNoteKind; message: string }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    notes,
    note: (kind: ConsentNoteKind, message: string) => {
      notes.push({ kind, message });
      for (const waiter of waiters.splice(0)) {
        if (waiter.count <= notes.length) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    noted(count: number): Promise<void> {
      if (notes.length >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ count, resolve });
      return promise;
    },
  };
}

describe('watchDeviceConsents', () => {
  test('presents a pending consent, resolves the decision, and reports feedback', async () => {
    const { surface, resolved } = makeSurface([consent('c1')]);
    const { notes, note, noted } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      present: async (item) => { presented.push(item.consentId); return 'always'; },
      note,
    });
    await noted(1);
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(resolved).toEqual([{ consentId: 'c1', decision: 'always' }]);
    expect(notes).toEqual([{ kind: 'resolved', message: 'Approved (always).' }]);
  });

  test('an answered consent still listed pending is never re-presented', async () => {
    const { surface, resolved, polled } = makeSurface([consent('c1')]);
    const { note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      present: async (item) => { presented.push(item.consentId); return 'once'; },
      note,
    });
    // c1 stays in the pending list across later polls (server-side race).
    await polled(3);
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(resolved).toEqual([{ consentId: 'c1', decision: 'once' }]);
  });

  test('a new consent is presented after the previous one leaves the list', async () => {
    const { surface, setPending, settled, polled } = makeSurface([consent('c1')]);
    const { note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      present: async (item) => { presented.push(item.consentId); return 'deny'; },
      note,
    });
    await settled(1);
    setPending([consent('c2')]);
    await settled(2);
    await polled(2);
    watcher.stop();

    expect(presented).toEqual(['c1', 'c2']);
  });

  test('print-once consents (present resolves null) are not resolved and not re-presented', async () => {
    const { surface, resolved, polled } = makeSurface([consent('c1')]);
    const { notes, note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      present: async (item) => { presented.push(item.consentId); return null; },
      note,
    });
    await polled(3);
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(resolved).toEqual([]);
    expect(notes).toEqual([]);
  });

  test('stop() mid-question cancels the prompt and best-effort denies, silently', async () => {
    const { surface, resolved, settled } = makeSurface([consent('c1')]);
    const { notes, note } = collectNotes();
    const asked = Promise.withResolvers<void>();

    const watcher = watchDeviceConsents(surface, {
      // Hang until the abort signal fires — like a user staring at a y/a/n prompt.
      present: (_item, signal) => {
        asked.resolve();
        const answer = Promise.withResolvers<'cancelled'>();
        signal.addEventListener('abort', () => answer.resolve('cancelled'), { once: true });
        return answer.promise;
      },
      note,
    });
    await asked.promise;
    watcher.stop();
    await settled(1);
    await watcher.done;

    expect(resolved).toEqual([{ consentId: 'c1', decision: 'deny' }]);
    expect(notes).toEqual([]);
  });

  test('a stale resolution (ok:false) is reported as no-longer-pending', async () => {
    const { surface, setResolveOk, settled } = makeSurface([consent('c1')]);
    setResolveOk(false);
    const { notes, note } = collectNotes();
    const noted = Promise.withResolvers<void>();

    const watcher = watchDeviceConsents(surface, {
      present: async () => 'once',
      note: (kind, message) => {
        note(kind, message);
        noted.resolve();
      },
    });
    await settled(1);
    await noted.promise;
    watcher.stop();

    expect(notes).toEqual([{ kind: 'stale', message: 'That PC access request is no longer pending.' }]);
  });

  test('listPending failures are swallowed and polling continues', async () => {
    let failures = 2;
    const presented: string[] = [];
    const presentedOnce = Promise.withResolvers<void>();
    const surface: DeviceConsentSurface = {
      listPending: async () => {
        if (failures-- > 0) throw new Error('transient');
        return [consent('c1')];
      },
      resolve: async () => ({ ok: true }),
    };
    const { notes, note } = collectNotes();

    const watcher = watchDeviceConsents(surface, {
      present: async (item) => {
        presented.push(item.consentId);
        presentedOnce.resolve();
        return 'once';
      },
      note,
    });
    await presentedOnce.promise;
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(notes.map((entry) => entry.kind)).toEqual(['error', 'error']);
  });
});
