import type { Revalidate, AsyncResourceControl } from "./use-async-resource";
import { useAsyncResource } from "./use-async-resource";
import { listDevices, type UserDevice } from "@/lib/user-api";
import type { DeviceUpdateState } from "@kinu.run/core";

/** `behind` is the hub's own reading and triggers its push; `unstamped` is a source install. */
export const DEVICE_UPDATE_COPY = {
  behind: "update available",
  off: "update off",
  unstamped: "dev build",
} satisfies Partial<Record<DeviceUpdateState, string>>;

/** The connect panel waits on a daemon's `connected` flip, so the roster keeps one live cadence. */
export const DEVICE_ROSTER_POLL_MS = 5_000;

/** Module scope: `useAsyncResource` keys its timer effect on this identity. */
const keepPolling: Revalidate<UserDevice[]> = () => DEVICE_ROSTER_POLL_MS;

export function useDeviceRoster(): AsyncResourceControl<UserDevice[]> {
  return useAsyncResource(listDevices, keepPolling);
}
