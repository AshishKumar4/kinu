// Device presence + mid-session change notice — the per-turn awareness the
// laptop runtime feeds into the agent's context.
import { describe, expect, test } from 'bun:test';
import {
  deviceChangeNotice,
  devicePresence,
  observeDevicePresence,
  parseDevicePresence,
  type DevicePresenceStore,
} from '../src/execution/device-status.js';

function memoryStore(): DevicePresenceStore {
  const kv = new Map<string, string>();
  return { get: (k) => kv.get(k) ?? null, set: (k, v) => { kv.set(k, v); } };
}

describe('devicePresence', () => {
  test('reduces the hub snapshot to the three prompt states', () => {
    expect(devicePresence({ connected: true, registered: true })).toBe('connected');
    expect(devicePresence({ connected: false, registered: true })).toBe('offline');
    expect(devicePresence({ connected: false, registered: false })).toBe('none');
  });
});

describe('parseDevicePresence', () => {
  test('round-trips valid watermarks and rejects garbage', () => {
    expect(parseDevicePresence('connected')).toBe('connected');
    expect(parseDevicePresence('offline')).toBe('offline');
    expect(parseDevicePresence('none')).toBe('none');
    expect(parseDevicePresence(null)).toBeNull();
    expect(parseDevicePresence(undefined)).toBeNull();
    expect(parseDevicePresence('CONNECTED')).toBeNull();
    expect(parseDevicePresence('true')).toBeNull();
  });
});

describe('deviceChangeNotice', () => {
  test('announces a mid-session connect, teaching the consent prompt', () => {
    for (const prev of ['offline', 'none'] as const) {
      const notice = deviceChangeNotice(prev, 'connected');
      expect(notice).toContain('## Context update');
      expect(notice).toContain('just connected');
      expect(notice).toContain('`laptop`');
      expect(notice).toContain('Consent will be requested');
    }
  });

  test('announces a disconnect with the reconnect instruction', () => {
    const notice = deviceChangeNotice('connected', 'offline');
    expect(notice).toContain('## Context update');
    expect(notice).toContain('disconnected');
    expect(notice).toContain('proteus connect');
  });

  test('announces a revocation without the reconnect instruction', () => {
    const notice = deviceChangeNotice('connected', 'none');
    expect(notice).toContain('no longer registered');
    expect(notice).not.toContain('proteus connect');
  });

  test('stays silent when nothing changed or on the first observation', () => {
    expect(deviceChangeNotice('connected', 'connected')).toBeNull();
    expect(deviceChangeNotice('offline', 'offline')).toBeNull();
    expect(deviceChangeNotice('none', 'none')).toBeNull();
    expect(deviceChangeNotice(null, 'connected')).toBeNull();
    expect(deviceChangeNotice(null, 'none')).toBeNull();
  });

  test('stays silent for offline ↔ none (no capability change)', () => {
    expect(deviceChangeNotice('offline', 'none')).toBeNull();
    expect(deviceChangeNotice('none', 'offline')).toBeNull();
  });
});

describe('observeDevicePresence', () => {
  test('a mid-session connect is announced on exactly the next turn', () => {
    const store = memoryStore();
    // Turn 1: no device yet — first observation seeds the watermark silently.
    expect(observeDevicePresence(store, { connected: false, registered: false }))
      .toEqual({ presence: 'none', notice: null });
    // The user runs `proteus connect` between turns.
    const turn2 = observeDevicePresence(store, { connected: true, registered: true });
    expect(turn2.presence).toBe('connected');
    expect(turn2.notice).toContain('just connected');
    // Turn 3: same state — no repeat notice.
    expect(observeDevicePresence(store, { connected: true, registered: true }).notice).toBeNull();
  });

  test('disconnect then reconnect produces one notice per transition', () => {
    const store = memoryStore();
    observeDevicePresence(store, { connected: true, registered: true });
    expect(observeDevicePresence(store, { connected: false, registered: true }).notice)
      .toContain('disconnected');
    expect(observeDevicePresence(store, { connected: false, registered: true }).notice).toBeNull();
    expect(observeDevicePresence(store, { connected: true, registered: true }).notice)
      .toContain('just connected');
  });
});
