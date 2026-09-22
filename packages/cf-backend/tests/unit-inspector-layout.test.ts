/**
 * Inspector layout policy through the hook's pure half. React is never mocked: `mock.module('react')`
 * is process-global under Bun; the effects are covered in scripts/chat-and-files-ux.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  INSPECTOR_DEFAULT_PX, INSPECTOR_MIN_PX,
  decideInspector, isInspectorInputKey, readStoredInspector, type InspectorAccount,
} from '@kinu.run/core/web/inspector-layout';

const known = (email: string): InspectorAccount => ({ kind: 'known', email });

/* Another unit file installs a read-only `localStorage`, so define it configurable per test and restore it. */

let store: Record<string, string> = {};

let previousLocalStorage: PropertyDescriptor | undefined;

function installStore(): void {
  previousLocalStorage ??= Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    } satisfies Storage,
  });
}

afterEach(() => {
  store = {};

  if (previousLocalStorage !== undefined) {
    Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    previousLocalStorage = undefined;
  }
});

describe('the persisted layout, through the decision', () => {
  test('an account with nothing stored reads as absent, never a default', () => {
    installStore();

    expect(readStoredInspector(known('a@b'), 'ws-1')?.choice).toBeNull();
    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false).widthPx).toBe(INSPECTOR_DEFAULT_PX);
  });

  test('a stored value in no shape the reader accepts is absent, not a width', () => {
    installStore();
    store['kinu.inspector.a@b'] = '340:0';

    // Legacy `<width>:<collapsed>` is invalid after the reset, never migrated to its width.
    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false).widthPx).toBe(INSPECTOR_DEFAULT_PX);
  });

  test('a write reads back: the stored number parses and survives rounding', () => {
    installStore();
    store['kinu.inspector.a@b'] = '340';
    store['kinu.inspector.open.a@b.ws-1'] = '0';

    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false).widthPx).toBe(340);
    expect(readStoredInspector(known('a@b'), 'ws-1')?.choice).toBe(false);

    store['kinu.inspector.open.a@b.ws-1'] = '1';
    expect(readStoredInspector(known('a@b'), 'ws-1')?.choice).toBe(true);
  });

  test('the pixel floor clamps what a stored width reads back as', () => {
    installStore();
    store['kinu.inspector.a@b'] = '120';

    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false).widthPx).toBe(INSPECTOR_MIN_PX);
  });

  test('the design band the column opens inside', () => {
    expect(INSPECTOR_MIN_PX).toBe(280);
    expect(INSPECTOR_DEFAULT_PX).toBe(340);
    expect(INSPECTOR_DEFAULT_PX).toBeGreaterThan(INSPECTOR_MIN_PX);
  });

  test('the account key is real isolation: another account reads nothing of it', () => {
    installStore();
    store['kinu.inspector.a@b'] = '340';
    store['kinu.inspector.open.a@b.ws-1'] = '0';

    expect(decideInspector(readStoredInspector(known('other@b'), 'ws-1'), false).widthPx).toBe(INSPECTOR_DEFAULT_PX);
    expect(readStoredInspector(known('other@b'), 'ws-1')?.choice).toBeNull();
    // A choice is per workspace, even within one account.
    expect(readStoredInspector(known('a@b'), 'ws-2')?.choice).toBeNull();
  });
});

describe('the decided layout', () => {
  test('nothing stored collapses the column — and a stored width alone does not open it', () => {
    installStore();

    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false)).toEqual({ collapsed: true, widthPx: INSPECTOR_DEFAULT_PX });

    store['kinu.inspector.a@b'] = '400';
    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false)).toEqual({ collapsed: true, widthPx: 400 });
  });

  test('a workspace already holding something worth seeing opens', () => {
    installStore();

    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), true)).toEqual({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });
  });

  test('a stored collapse is the user\'s: a signal does not reopen it', () => {
    installStore();
    store['kinu.inspector.a@b'] = '280';
    store['kinu.inspector.open.a@b.ws-1'] = '0';

    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), true)).toEqual({ collapsed: true, widthPx: 280 });
  });

  test('a stored open wins over the signal, and over the other workspace\'s choice', () => {
    installStore();
    store['kinu.inspector.a@b'] = '340';
    store['kinu.inspector.open.a@b.ws-1'] = '1';
    store['kinu.inspector.open.a@b.ws-2'] = '0';

    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-1'), false)).toEqual({ collapsed: false, widthPx: 340 });
    expect(decideInspector(readStoredInspector(known('a@b'), 'ws-2'), true)).toEqual({ collapsed: true, widthPx: 340 });
  });

  test('a session resolved to no account decides by signal alone: nothing is read, nothing keys', () => {
    installStore();
    // A session with no account must not see another account's keys. (`null` parks instead: pinned in
    // packages/core/tests/unit-inspector-layout.test.ts.)
    store['kinu.inspector.a@b'] = '300';
    store['kinu.inspector.open.a@b.ws-1'] = '0';

    expect(decideInspector(readStoredInspector({ kind: 'none' }, 'ws-1'), true)).toEqual({ collapsed: false, widthPx: INSPECTOR_DEFAULT_PX });
    expect(decideInspector(readStoredInspector({ kind: 'unreadable' }, 'ws-1'), false)).toEqual({ collapsed: true, widthPx: INSPECTOR_DEFAULT_PX });
  });
});

describe('the separator\'s input vocabulary', () => {
  test('the five keys the library\'s separator acts on are the marks it reads', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']) {
      expect(isInspectorInputKey(key)).toBe(true);
    }
  });

  test('every other key is not an input mark', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Tab', ' ', 'a']) {
      expect(isInspectorInputKey(key)).toBe(false);
    }
  });
});
