/** A device hub's answer for tests: the fleet is the status, each machine its own entry. */
import type { DeviceFleetEntry, DeviceStatus } from '@kinu.run/core';

/** One machine as the hub lists it, live unless said otherwise. */
export function machine(entry: Partial<DeviceFleetEntry> = {}): DeviceFleetEntry {
  return { id: 'device-1', name: 'laptop', os: null, hostname: null, connected: true, ...entry };
}

/** A fleet of one machine, `machine`'s entry. */
export function oneMachine(entry?: Partial<DeviceFleetEntry>): DeviceStatus {
  return { devices: [machine(entry)] };
}
