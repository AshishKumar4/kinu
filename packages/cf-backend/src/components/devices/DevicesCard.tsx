/**
 * The connected-devices card and the connect panel beneath it — the account's
 * machine roster with its live link states and every per-workspace grant,
 * denied included, and the panel that links a new one.
 *
 * The roster and the grants are `useAsyncResource` reads. A failed poll leaves
 * the last known roster on screen AND says it failed — blanking it to `[]`
 * flashed "register a device" over devices that are registered and running,
 * and swallowing the rejection made an unreachable UserDO look exactly like an
 * account with no devices.
 */
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
import { renderThrownChain } from "@kinu.run/core/obs";

/** Grants ride the SAME cadence as the roster: revoking one changes both what
 *  a machine may do and who has reach, so one clock keeps them honest. */
const keepPollingGrants: Revalidate<DeviceConsent[]> = () => DEVICE_ROSTER_POLL_MS;

export function DevicesCard() {
  const roster = useDeviceRoster();
  const grantRoster = useAsyncResource(listDeviceConsents, keepPollingGrants);
  const [err, setErr] = useState<string | null>(null);
  /** Counts come from the revoke response. The durable incident timestamp
   * keeps the row across reloads; count is shown when this tab observed it. */
  const [unstoppedCounts, setUnstoppedCounts] = useState<ReadonlyMap<string, number>>(new Map());
  /** An incident this tab acknowledged. The DELETE has already succeeded, so
   *  the row is gone; this keeps it gone across the poll that confirms it. */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());

  const reloadDevices = roster.reload;
  const devices = (lastValue(roster.resource) ?? []).filter((device) => !acknowledged.has(device.id));
  const grants = lastValue(grantRoster.resource) ?? [];

  const [flow] = useState(() => new DeviceConnectFlow({
    register: registerDevice,
    // Nothing to close here: the machine is now a row in the list above.
    onConnected: reloadDevices,
  }));

  const revoke = useCallback(async (id: string, label: string) => {
    if (!confirm(`Revoke "${label}"? Agents will lose access.`)) return;
    setErr(null);

    try {
      const result = await revokeDevice(id);

      if (result.unstoppedCommands > 0) {
        setUnstoppedCounts((current) => new Map(current).set(id, result.unstoppedCommands));
      }
    } catch (e) {
      setErr(`Could not revoke device: ${renderThrownChain({ cause: e })}`);
    }

    reloadDevices();
  }, [reloadDevices]);

  const acknowledgeIncident = useCallback(async (id: string) => {
    setErr(null);

    try {
      await acknowledgeUnstoppedDevice(id);
      setUnstoppedCounts((current) => {
        const next = new Map(current);
        next.delete(id);

        return next;
      });
      setAcknowledged((current) => new Set(current).add(id));
      reloadDevices();
    } catch (e) {
      setErr(`Could not acknowledge the command warning: ${renderThrownChain({ cause: e })}`);
    }
  }, [reloadDevices]);

  return (
    <>
      {/* What a link MEANS is stated once, by the connect panel below, in the
          words `kinu connect` prints. This card is about the list. */}
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
          <span className="p-row-text p-text-3">No machine is linked yet.</span>
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
