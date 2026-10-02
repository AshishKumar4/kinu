/** A failed poll keeps the last roster on screen and says it failed, rather than blanking to `[]`. */
import { Effect } from 'effect';
import { useCallback, useState } from "react";
import { DesktopTowerIcon, PlugIcon } from "@phosphor-icons/react";
import {
  acknowledgeUnstoppedDevice, listDeviceConsents, registerDevice, revokeDevice,
  type DeviceConsent,
} from "@/lib/user-api";
import { Card } from "@/components/ui/form";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type Revalidate } from "@/hooks/use-async-resource";
import { DEVICE_ROSTER_POLL_MS, useDeviceRoster } from "@/hooks/use-device-roster";
import { ConnectDevicePanel, DeviceConnectFlow } from "@/components/ConnectDevicePanel";
import { DeviceRow } from "@/components/devices/DeviceRow";
import { showing, detach, settle } from "@kinu.run/core/obs";

/** Grants share the roster's cadence: a revoke changes both, so one clock keeps them consistent. */
const keepPollingGrants: Revalidate<DeviceConsent[]> = () => DEVICE_ROSTER_POLL_MS;

export function DevicesCard() {
  const roster = useDeviceRoster();
  const grantRoster = useAsyncResource(listDeviceConsents, keepPollingGrants);
  const [err, setErr] = useState<string | null>(null);
  /** Counts are shown only when this tab observed the revoke; the durable timestamp keeps the row across reloads. */
  const [unstoppedCounts, setUnstoppedCounts] = useState<ReadonlyMap<string, number>>(new Map());
  /** The DELETE already succeeded; this keeps the row gone across the poll that confirms it. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());

  const reloadDevices = roster.reload;
  const devices = (lastValue(roster.resource) ?? []).filter((device) => !acknowledged.has(device.id));
  const grants = lastValue(grantRoster.resource) ?? [];

  const [flow] = useState(() => new DeviceConnectFlow({
    register: registerDevice,
    onConnected: reloadDevices,
  }));

  const revoke = useCallback((id: string, label: string) => detach(Effect.gen(function* () {
    if (!confirm(`Revoke "${label}"? Agents will lose access.`)) return;
    setErr(null);

    yield* Effect.catchCause(Effect.gen(function* () {
      const result = yield* Effect.promise(async () => revokeDevice(id));

      if (result.unstoppedCommands > 0) {
        setUnstoppedCounts((current) => new Map(current).set(id, result.unstoppedCommands));
      }
    }), showing((chain) => {
      setErr(`Could not revoke device: ${chain}`);
    }));

    reloadDevices();
  })), [reloadDevices]);

  const acknowledgeIncident = useCallback((id: string) => settle(Effect.gen(function* () {
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => acknowledgeUnstoppedDevice(id));
      setUnstoppedCounts((current) => {
        const next = new Map(current);
        next.delete(id);

        return next;
      });
      setAcknowledged((current) => new Set(current).add(id));
      reloadDevices();
    }), showing((chain) => {
      setErr(`Could not acknowledge the device warning: ${chain}`);
    }));
  })), [reloadDevices]);

  return (
    <>
      <Card title="Connected devices" icon={DesktopTowerIcon}>
        {devices.length > 0 ? (
          <div className="p-group text-xs">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                grants={grants.filter((g) => g.deviceId === d.id)}
                onDeviceChanged={reloadDevices}
                onGrantsChanged={grantRoster.reload}
                onError={setErr}
                onRevoke={() => revoke(d.id, d.label)}
                unstoppedCommands={unstoppedCounts.get(d.id)}
                onAcknowledge={() => acknowledgeIncident(d.id)}
              />
            ))}
          </div>
        ) : roster.resource.status === "ready" && (
          <p data-devices-empty className="p-row-text p-text-3 leading-relaxed">
            No machine is linked yet. On the computer you want to link, run{" "}
            <code className="font-mono p-text">kinu connect</code> in the folder the agent may use. No Kinu CLI
            there yet? Get the one-line install command below.
          </p>
        )}
        {roster.resource.status === "error" && (
          <LoadFailure what="your devices" message={roster.resource.message} onRetry={reloadDevices} />
        )}
        {grantRoster.resource.status === "error" && (
          <LoadFailure what="the device grants" message={grantRoster.resource.message} onRetry={grantRoster.reload} />
        )}
        {err && <p className="text-xs p-danger">{err}</p>}
      </Card>

      <Card title="Connect a machine" icon={PlugIcon}>
        <ConnectDevicePanel flow={flow} devices={lastValue(roster.resource)} />
      </Card>
    </>
  );
}
