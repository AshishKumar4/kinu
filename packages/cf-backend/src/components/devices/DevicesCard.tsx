/** A failed poll keeps the last roster on screen and says it failed, rather than blanking to `[]`. */
import { Effect } from 'effect';
import { useCallback, useState } from "react";
import {
  acknowledgeUnstoppedDevice, listDeviceConsents, registerDevice, revokeDevice,
  type DeviceConsent,
} from "@/lib/user-api";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/form";
import { Modal } from "@/components/ui/Modal";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type Revalidate } from "@/hooks/use-async-resource";
import { DEVICE_ROSTER_POLL_MS, useDeviceRoster } from "@/hooks/use-device-roster";
import { ConnectDevicePanel, DeviceConnectFlow } from "@/components/ConnectDevicePanel";
import { DeviceRow } from "@/components/devices/DeviceRow";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { showing, settle } from "@kinu.run/core/obs";
import { Group } from "@/components/ui/Group";

/** Grants share the roster's cadence: a revoke changes both, so one clock keeps them consistent. */
const keepPollingGrants: Revalidate<DeviceConsent[]> = () => DEVICE_ROSTER_POLL_MS;

export function DevicesCard() {
  const roster = useDeviceRoster();
  const grantRoster = useAsyncResource(listDeviceConsents, keepPollingGrants);
  const [err, setErr] = useState<string | null>(null);
  /** Counts are shown only when this tab observed the revoke; the durable timestamp keeps the row across reloads. */
  const [unstoppedCounts, setUnstoppedCounts] = useState<ReadonlyMap<string, number>>(new Map());

  const reloadDevices = roster.reload;
  const publishDevices = roster.set;
  const devices = lastValue(roster.resource) ?? [];
  const grants = lastValue(grantRoster.resource) ?? [];

  const [flow] = useState(() => new DeviceConnectFlow({
    register: async (label) => registerDevice({ label }),
    onConnected: reloadDevices,
  }));

  const { ask, dialog } = useConfirmation();

  const revoke = useCallback((id: string, label: string) => ask({
    title: `Revoke "${label}"?`, body: "Agents will lose access.", action: "Revoke", failed: "Could not revoke device",
    run: async () => {
      const result = await revokeDevice(id);

      if (result.unstoppedCommands > 0) setUnstoppedCounts((current) => new Map(current).set(id, result.unstoppedCommands));
      reloadDevices();
    },
  }), [ask, reloadDevices]);

  const acknowledgeIncident = useCallback((id: string) => settle(Effect.gen(function* () {
    setErr(null);

    return yield* Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => acknowledgeUnstoppedDevice(id));
      setUnstoppedCounts((current) => {
        const next = new Map(current);
        next.delete(id);

        return next;
      });
      // The DELETE landed: publishing the row's removal retires a poll already in flight with it.
      publishDevices(devices.filter((device) => device.id !== id));
      reloadDevices();
    }), showing((chain) => {
      setErr(`Could not acknowledge the device warning: ${chain}`);
    }));
  })), [publishDevices, devices, reloadDevices]);

  const [connecting, setConnecting] = useState(false);

  return (
    <>
      <Card title="Connected devices" actions={<Button variant="secondary" size="sm" data-connect-open onClick={() => setConnecting(true)}>Connect a machine</Button>}>
        {devices.length > 0 ? (
          <Group>
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
          </Group>
        ) : roster.resource.status === "ready" && (
          <p data-devices-empty className="t-body p-text-3">
            No machine yet. Run <code className="font-mono p-text">kinu connect</code> in the folder the agent may use.
          </p>
        )}
        {roster.resource.status === "error" && (
          <LoadFailure what="your devices" message={roster.resource.message} onRetry={reloadDevices} />
        )}
        {grantRoster.resource.status === "error" && (
          <LoadFailure what="the device grants" message={grantRoster.resource.message} onRetry={grantRoster.reload} />
        )}
        {err && <p className="t-meta p-danger">{err}</p>}
      </Card>

      {connecting && (
        <Modal title="Connect a machine" onClose={() => setConnecting(false)} maxWidthClass="max-w-lg">
          <ConnectDevicePanel flow={flow} devices={lastValue(roster.resource)} />
        </Modal>
      )}
      {dialog}
    </>
  );
}
