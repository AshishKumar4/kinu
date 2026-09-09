/**
 * The one device-roster read for the web UI.
 *
 * Three surfaces ask the same question — Account settings → Devices, the
 * Environment tab's offline laptop, and the connect panel waiting for a
 * machine to arrive — and one read model answers all three. A `listDevices()`
 * call per surface means hand-rolled `setInterval` loops and a mount-time fetch
 * that never refreshes and swallows its rejection. On the app's own
 * `useAsyncResource`, a failed poll keeps the last roster AND says it
 * failed, which a swallowed catch cannot.
 */
import type { Revalidate, AsyncResourceControl } from "./use-async-resource";
import { useAsyncResource } from "./use-async-resource";
import { listDevices, type UserDevice } from "@/lib/user-api";

/** A daemon that starts flips `connected` within seconds, and the connect
 *  panel waits on exactly that flip, so the roster keeps one live cadence. */
export const DEVICE_ROSTER_POLL_MS = 5_000;

/** Module scope, because `useAsyncResource` keys its timer effect on this
 *  identity: a fresh closure per render would rearm the poll every render. */
const keepPolling: Revalidate<UserDevice[]> = () => DEVICE_ROSTER_POLL_MS;

export function useDeviceRoster(): AsyncResourceControl<UserDevice[]> {
  return useAsyncResource(listDevices, keepPolling);
}
