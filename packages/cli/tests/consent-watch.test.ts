// Behavior tests for the shared device-consent watcher: present-once
// semantics across poll ticks that race the server-side resolution, pruning
// of departed ids, print-once non-interactive consents, and clean
// cancellation (best-effort deny) when the turn settles mid-question.
import { describe, expect, test } from 'bun:test';
import type {
  DeviceConsentDecision,
  DeviceConsentSurface,
  PendingDeviceConsent,
} from '../src/agent-client';
import { watchDeviceConsents, type ConsentNoteKind } from '../src/consent-watch';

const POLL_MS = 5;

function consent(id: string): PendingDeviceConsent {
  return { consentId: id, deviceLabel: 'laptop', method: 'exec', command: 'ls' };
}

function makeSurface(initial: PendingDeviceConsent[] = []) {
  const resolved: Array<{ consentId: string; decision: DeviceConsentDecision }> = [];
  let pending = initial;
  let resolveOk = true;
  const surface: DeviceConsentSurface = {
    listPending: async () => pending,
    resolve: async (consentId, decision) => {
      resolved.push({ consentId, decision });
      return { ok: resolveOk };
    },
  };
  return {
    surface,
    resolved,
    setPending(next: PendingDeviceConsent[]) { pending = next; },
    setResolveOk(ok: boolean) { resolveOk = ok; },
  };
}

function collectNotes() {
  const notes: Array<{ kind: ConsentNoteKind; message: string }> = [];
  return { notes, note: (kind: ConsentNoteKind, message: string) => { notes.push({ kind, message }); } };
}

const ticks = (n = 4) => Bun.sleep(POLL_MS * n);

describe('watchDeviceConsents', () => {
  test('presents a pending consent, resolves the decision, and reports feedback', async () => {
    const { surface, resolved } = makeSurface([consent('c1')]);
    const { notes, note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      present: async (item) => { presented.push(item.consentId); return 'always'; },
      note,
    });
    await ticks();
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(resolved).toEqual([{ consentId: 'c1', decision: 'always' }]);
    expect(notes).toEqual([{ kind: 'resolved', message: 'Approved (always).' }]);
  });

  test('an answered consent still listed pending is never re-presented', async () => {
    const { surface, resolved } = makeSurface([consent('c1')]);
    const { note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      present: async (item) => { presented.push(item.consentId); return 'once'; },
      note,
    });
    // c1 stays in the pending list across many polls (server-side race).
    await ticks(8);
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(resolved).toEqual([{ consentId: 'c1', decision: 'once' }]);
  });

  test('a new consent is presented after the previous one leaves the list', async () => {
    const { surface, setPending } = makeSurface([consent('c1')]);
    const { note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      present: async (item) => { presented.push(item.consentId); return 'deny'; },
      note,
    });
    await ticks();
    setPending([consent('c2')]);
    await ticks();
    watcher.stop();

    expect(presented).toEqual(['c1', 'c2']);
  });

  test('print-once consents (present resolves null) are not resolved and not re-presented', async () => {
    const { surface, resolved } = makeSurface([consent('c1')]);
    const { notes, note } = collectNotes();
    const presented: string[] = [];

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      present: async (item) => { presented.push(item.consentId); return null; },
      note,
    });
    await ticks(8);
    watcher.stop();

    expect(presented).toEqual(['c1']);
    expect(resolved).toEqual([]);
    expect(notes).toEqual([]);
  });

  test('stop() mid-question cancels the prompt and best-effort denies, silently', async () => {
    const { surface, resolved } = makeSurface([consent('c1')]);
    const { notes, note } = collectNotes();

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      // Hang until the abort signal fires — like a user staring at a y/a/n prompt.
      present: (_item, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
      }),
      note,
    });
    await ticks();
    watcher.stop();
    await ticks();

    expect(resolved).toEqual([{ consentId: 'c1', decision: 'deny' }]);
    expect(notes).toEqual([]);
  });

  test('a stale resolution (ok:false) is reported as no-longer-pending', async () => {
    const { surface, setResolveOk } = makeSurface([consent('c1')]);
    setResolveOk(false);
    const { notes, note } = collectNotes();

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      present: async () => 'once',
      note,
    });
    await ticks();
    watcher.stop();

    expect(notes).toEqual([{ kind: 'stale', message: 'That PC access request is no longer pending.' }]);
  });

  test('listPending failures are swallowed and polling continues', async () => {
    let failures = 2;
    const presented: string[] = [];
    const surface: DeviceConsentSurface = {
      listPending: async () => {
        if (failures-- > 0) throw new Error('transient');
        return [consent('c1')];
      },
      resolve: async () => ({ ok: true }),
    };
    const { note } = collectNotes();

    const watcher = watchDeviceConsents(surface, {
      pollMs: POLL_MS,
      present: async (item) => { presented.push(item.consentId); return 'once'; },
      note,
    });
    await ticks(8);
    watcher.stop();

    expect(presented).toEqual(['c1']);
  });
});
