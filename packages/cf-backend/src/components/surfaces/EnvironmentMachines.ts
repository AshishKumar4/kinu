/**
 * The owner's machines as one workspace sees them: every machine on the account, each with whether this workspace
 * holds it. The account's devices joined with the workspace's grants (the consent rows the agent's approval box and the
 * owner's one click both write), so a machine connected anywhere shows in every workspace, granted or not.
 */
import { useCallback, useMemo } from "react";
import { Effect } from "effect";
import { attempt, type KinuError } from "@kinu.run/core/obs";
import { grantDeviceConsent, listDeviceConsents, type DeviceConsent, type DeviceDesktop } from "@/lib/user-api";
import { lastValue, useAsyncResource, type Revalidate } from "@/hooks/use-async-resource";
import { DEVICE_ROSTER_POLL_MS, useDeviceRoster } from "@/hooks/use-device-roster";

export interface AccountMachine {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  /** This workspace holds the machine: its commands and its terminal run there without asking. */
  readonly granted: boolean;
  /** Its screen, as its daemon reports it. */
  readonly desktop: DeviceDesktop;
}

export interface AccountMachines {
  /** Null until both reads answer. */
  readonly machines: readonly AccountMachine[] | null;
  readonly failure: string | null;
  /** The owner gives this workspace the machine; the grant is read back before it shows. */
  readonly grant: (id: string) => Effect.Effect<void, KinuError>;
}

/** The roster's cadence, so a grant made elsewhere (the agent's approval box) shows as soon as a connect does. */
const keepPollingGrants: Revalidate<DeviceConsent[]> = () => DEVICE_ROSTER_POLL_MS;

/** The consent policy that holds a machine (`setDeviceBinding`'s 'allow'). */
const HELD = "allow";

export function useAccountMachines(workspace: string): AccountMachines {
  const roster = useDeviceRoster();
  const grants = useAsyncResource(listDeviceConsents, keepPollingGrants);
  const devices = lastValue(roster.resource);
  const consents = lastValue(grants.resource);
  const reloadGrants = grants.reload;

  const machines = useMemo(() => (devices === null || consents === null ? null : devices
    .filter((device) => device.revokedAt === null)
    .map((device) => ({
      id: device.id,
      label: device.label,
      connected: device.connected,
      desktop: device.desktop,
      granted: consents.some((row) => row.deviceId === device.id && row.agentName === workspace && row.policy === HELD),
    }))), [devices, consents, workspace]);

  const failed = [roster.resource, grants.resource].find((resource) => resource.status === "error");

  const grant = useCallback((id: string) => attempt({ doing: "giving this workspace the machine", otherwise: "io" },
    () => grantDeviceConsent(id, workspace)).pipe(Effect.andThen(Effect.sync(reloadGrants))), [workspace, reloadGrants]);

  return { machines, failure: failed?.status === "error" ? failed.message : null, grant };
}
