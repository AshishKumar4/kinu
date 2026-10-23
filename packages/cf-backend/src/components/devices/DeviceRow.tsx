import { Button } from "@/components/ui/Button";
import { Effect } from 'effect';
import { useState } from "react";
import { startTransition } from "react";
import {
  DesktopTowerIcon, PencilSimpleIcon, TrashIcon,
} from "@phosphor-icons/react";
import {
  renameDevice, revokeDeviceConsent, setDeviceSandboxTier,
  type DeviceConsent, type UserDevice,
} from "@/lib/user-api";
import { DEVICE_UPDATE_COPY } from "@/hooks/use-device-roster";
import { describeGpuNodes, effectiveDeviceMode } from "@kinu.run/core";
import { renderThrownChain, showing, detach, settle } from "@kinu.run/core/obs";
import { composing } from "@/components/ui/form";
import { Row, RowTile } from "@/components/ui/Row";
import { Menu } from "@/components/ui/Menu";
import { Chip } from "@/components/ui/Chip";
import { Switch } from "@/components/ui/Switch";
import { Status } from "@/components/ui/Status";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { Notice } from "@/components/ui/Notice";
import { TextInput } from "@/components/ui/Field";

const WHOLE_MACHINE_COPY = "Linked from /, so the agent has this whole machine: every file you can open, and its commands "
  + "run as you. The Sandbox switch applies again once you run kinu connect in a narrower folder.";

/** An unknown count is still a warning: the hub could not confirm anything stopped. */
function unstoppedLine(count: number | undefined): string {
  if (count === undefined) return "Commands may still run.";

  if (count === 1) return "1 command has no confirmed termination and may still run.";

  return `${count} commands have no confirmed termination and may still run.`;
}

/** The daemon's version note; silent when it is current. */
function UpdateBadge({ device }: { device: UserDevice }) {
  if (device.update !== "behind" && device.update !== "off" && device.update !== "unstamped" && device.update !== "refused") return null;

  return (
    <span role="status" data-device-update={device.update} title={device.version === null ? undefined : `${device.version} installed; ${device.servedVersion ?? ""} served`}>
      <Status tone={device.update === "behind" || device.update === "refused" ? "warning" : "neutral"}>{DEVICE_UPDATE_COPY[device.update]}</Status>
    </span>
  );
}

export function DeviceRow({
  device, grants, onDeviceChanged, onGrantsChanged, onError, onRevoke,
  unstoppedCommands, onAcknowledge,
}: {
  device: UserDevice;
  grants: DeviceConsent[];
  onDeviceChanged: () => void;
  onGrantsChanged: () => void;
  onError: (message: string) => void;
  onRevoke: () => void;
  unstoppedCommands: number | undefined;
  onAcknowledge: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [switching, setSwitching] = useState(false);
  const { ask, dialog } = useConfirmation();

  if (device.revokedAt !== null) {
    const countLine = unstoppedLine(unstoppedCommands);
    const unstopped = device.unstoppedAt !== null;

    return (
      <Notice tone="danger" data-device-incident={device.id} className="m-2" action={
        <Button size="sm" disabled={acknowledging}
          onClick={() => {
            setAcknowledging(true);
            startTransition(() => settle(Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
              yield* Effect.promise(async () => onAcknowledge());
            }), showing((chain) => {
              // A rejection escaping `onError` still leaves the row visibly unacknowledged.
              onError(`Could not acknowledge the device warning: ${chain}`);
            })), Effect.sync(() => {
              setAcknowledging(false);
            }))));
          }}>
          {acknowledging ? "Acknowledging…" : "Acknowledge"}
        </Button>}>
          <div className="space-y-1">
            <div className="t-item">{device.label}</div>
            {device.cloneDetectedAt !== null && (
              <>
                <p>Kinu revoked this device because two machines used its key, so a copy of this machine&apos;s ~/.kinu exists somewhere else.</p>
                <p>Run kinu connect on the machine you trust to link it again.</p>
              </>
            )}
            {unstopped && (
              <>
                <p>Kinu could not confirm that every command stopped after revocation.</p>
                <p>{countLine}</p>
              </>
            )}
            <p className="t-meta">{unstopped ? "Acknowledge clears this warning. It does not stop commands." : "Acknowledge clears this warning."}</p>
          </div>
      </Notice>
    );
  }

  const save = async () => {
    const name = (editing ?? "").trim();
    setEditing(null);

    if (!name || name === device.label) return;

    try { await renameDevice(device.id, name); }
    catch (e) { onError(`Could not rename device: ${renderThrownChain({ cause: e })}`); }

    onDeviceChanged();
  };

  const dropGrant = (agentName: string) => Effect.gen(function* () {
    yield* Effect.catchCause(Effect.promise(async () => revokeDeviceConsent(device.id, agentName)), showing((chain) => {
      onError(`Could not revoke the grant: ${chain}`);
    }));

    onGrantsChanged();
  });

  const { sandbox } = device;
  const sandboxOn = sandbox.tier === "sandboxed";
  const mode = device.wholeMachine ? "raw" : effectiveDeviceMode(sandbox);
  const cannotSandbox = sandbox.capability !== "sandboxed";

  // Only turning off asks; on only narrows what a command reaches.
  const sandboxOff = () => ask({
    title: `Turn Sandbox off for "${device.label}"?`, body: "The agent will run as you with full access.", action: "Turn off",
    failed: "Could not change the Sandbox setting", run: async () => { await setDeviceSandboxTier(device.id, "raw"); onDeviceChanged(); },
  });

  const sandboxOnAgain = () => Effect.gen(function* () {
    setSwitching(true);

    yield* Effect.ensuring(Effect.catchCause(Effect.promise(async () => setDeviceSandboxTier(device.id, "sandboxed")), showing((chain) => {
      onError(`Could not change the Sandbox setting: ${chain}`);
    })), Effect.sync(() => { setSwitching(false); }));

    onDeviceChanged();
  });

  // The switch says whether it is sandboxed; the meta says what the machine is, its GPU included when a sandbox passes one.
  const gpu = mode === "sandboxed" && sandbox.gpu.length > 0 ? describeGpuNodes(sandbox.gpu) : null;
  const where = [device.hostname, device.os].filter((part) => part !== null && part !== "").join(" · ");

  const nameField = (
    <TextInput size="sm" className="w-52" autoFocus value={editing ?? ""} onChange={(e) => setEditing(e.target.value)} onBlur={(...args: Parameters<typeof save>) => detach(Effect.promise(async () => save(...args)))} onKeyDown={(e) => detach(Effect.promise(async () => {
        if (composing(e.nativeEvent)) return;

        if (e.key === "Enter") {
          e.preventDefault();
          setEditing(null);
          await save();
        }

        if (e.key === "Escape") setEditing(null);
      }))} aria-label="Device name" />
  );

  const notes = [
    device.update === "refused" && <p key="refused">Update to {device.servedVersion} refused: {device.updateRefusal}</p>,
    device.wholeMachine && <p key="whole">{WHOLE_MACHINE_COPY}</p>,
    cannotSandbox && <p key="cannot"><Status tone="warning">Cannot sandbox</Status></p>,
    grants.length > 0 && (
      <div key="grants" className="flex flex-wrap items-center gap-2" data-device-grants>
        {grants.map((g) => (
          <Chip key={g.agentName} tone={g.policy === "allow" ? "neutral" : "danger"} onRemove={() => detach(dropGrant(g.agentName))}
            removeLabel={g.policy === "allow" ? `Revoke ${g.agentName}'s access` : `Remove the saved denial for ${g.agentName}`}>
            {g.policy === "allow" ? g.agentName : `${g.agentName} · denied`}
          </Chip>
        ))}
      </div>
    ),
  ].filter(Boolean);

  // Plugins' row grid (design review 2026-10-20, A3), the Sandbox switch a track of its own; what it reaches is under it.
  return (
    <>
      <Row attributes={{ "data-device": device.id }} tile={<RowTile icon={DesktopTowerIcon} />}
        title={editing === null ? device.label : nameField}
        meta={(
          <span data-sandbox-mode={mode} data-whole-machine={device.wholeMachine ? "true" : undefined}>
            {where}
            {gpu !== null && <>{where === "" ? "" : " · "}<span data-device-gpu>{gpu}</span></>}
          </span>
        )}
        status={device.update === "required"
          ? <span role="status" data-device-update="required"><Status tone="warning">{DEVICE_UPDATE_COPY.required}</Status></span>
          : <Status tone={device.connected ? "success" : "neutral"}>{device.connected ? "Connected" : "Offline"}</Status>}
        control={(
          <>
            <UpdateBadge device={device} />
            {/* Named beside it, so it reads as the sandbox and not as the connection the status before it names. */}
            <span className="t-item p-text-2" aria-hidden>Sandbox</span>
            <Switch on={sandboxOn} label={`Sandbox on ${device.label}`} disabled={switching || device.wholeMachine}
              onChange={() => detach(sandboxOn ? Effect.sync(sandboxOff) : sandboxOnAgain())} />
          </>
        )}
        action={(
          <Menu name={device.label} items={[
            { label: "Rename", title: "Rename this device", icon: <PencilSimpleIcon size={16} />, onSelect: () => setEditing(device.label) },
            { label: "Revoke", title: "Revoke device", icon: <TrashIcon size={16} />, onSelect: onRevoke, danger: true },
          ]} />
        )}
        below={notes.length === 0 ? undefined : <div className="t-meta space-y-1 p-text-3">{notes}</div>} />
      {dialog}
    </>
  );
}
