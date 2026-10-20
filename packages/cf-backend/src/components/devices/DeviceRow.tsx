import { buttonClass } from "@/components/ui/Button";
import { Effect } from 'effect';
import { useState } from "react";
import { startTransition } from "react";
import {
  DesktopTowerIcon, PencilSimpleIcon, TrashIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import {
  renameDevice, revokeDeviceConsent, setDeviceSandboxTier,
  type DeviceConsent, type UserDevice,
} from "@/lib/user-api";
import { DEVICE_UPDATE_COPY } from "@/hooks/use-device-roster";
import { describeGpuNodes, effectiveDeviceMode, type DeviceMode } from "@kinu.run/core";
import { renderThrownChain, showing, detach, settle } from "@kinu.run/core/obs";
import { composing, inputCls } from "@/components/ui/form";
import { PluginTile } from "@/components/plugins/PluginRow";
import { RowMenu } from "@/components/ui/RowMenu";
import { Switch } from "@/components/ui/Switch";
import { Status } from "@/components/ui/Status";
import { useConfirmation } from "@/components/ui/ConfirmDialog";

/** The hub enforces the same `effectiveDeviceMode`, so this word matches what it does. */
const SANDBOX_WORD = {
  sandboxed: "Sandboxed",
  raw: "Sandbox off",
  files_only: "Files only",
} satisfies Record<DeviceMode, string>;

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
      <div data-device-incident={device.id} role="alert"
        className="p-notice-danger rounded-none border-0 px-4 py-3 text-xs">
        <div className="flex items-start gap-2">
          <WarningIcon size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium">{device.label}</div>
            {device.reuseDetectedAt !== null && (
              <>
                <p>Kinu revoked this device: its key was used after it had been replaced, so a copy of this machine&apos;s ~/.kinu/device.json exists somewhere else.</p>
                <p>Run kinu connect on the machine you trust to link it again.</p>
              </>
            )}
            {unstopped && (
              <>
                <p>Kinu could not confirm that every command stopped after revocation.</p>
                <p>{countLine}</p>
              </>
            )}
            <p className="p-meta">{unstopped ? "Acknowledge clears this warning. It does not stop commands." : "Acknowledge clears this warning."}</p>
          </div>
          <button type="button" disabled={acknowledging}
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
            }}
            className={buttonClass({ size: "sm" })}>
            {acknowledging ? "Acknowledging…" : "Acknowledge"}
          </button>
        </div>
      </div>
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

  const where = [device.hostname === null ? null : `${device.hostname}${device.os ? ` · ${device.os}` : ""}`, SANDBOX_WORD[mode]];

  // A row as Plugins draws a connected server (design review 2026-10-20): its tile, name, one meta line, its status and
  // its controls; what it reaches is under it.
  return (
    <div data-device={device.id} className="py-3">
      <div className="flex items-center gap-3">
        <PluginTile icon={DesktopTowerIcon} />
        <div className="min-w-0 flex-1">
          {editing === null ? (
            <div className="truncate p-row-text font-medium p-text">{device.label}</div>
          ) : (
            <input
              autoFocus
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onBlur={(...args: Parameters<typeof save>) => detach(Effect.promise(async () => save(...args)))}
              onKeyDown={(e) => detach(Effect.promise(async () => {
                if (composing(e.nativeEvent)) return;

                if (e.key === "Enter") {
                  e.preventDefault();
                  setEditing(null);
                  await save();
                }

                if (e.key === "Escape") setEditing(null);
              }))}
              aria-label="Device name"
              className={`${inputCls} h-7 w-52`}
            />
          )}
          <div className="truncate p-meta p-text-3" data-sandbox-mode={mode} data-whole-machine={device.wholeMachine || undefined}>
            {where.filter((part) => part !== null).join(" · ")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {device.update === "required"
            ? <span role="status" data-device-update="required"><Status tone="warning">{DEVICE_UPDATE_COPY.required}</Status></span>
            : <Status tone={device.connected ? "success" : "neutral"}>{device.connected ? "Connected" : "Offline"}</Status>}
          <UpdateBadge device={device} />
          <Switch on={sandboxOn} label={`Sandbox on ${device.label}`} disabled={switching || device.wholeMachine}
            onChange={() => detach(sandboxOn ? Effect.sync(sandboxOff) : sandboxOnAgain())} />
          <RowMenu label={`${device.label} options`} items={[
            { label: "Rename", title: "Rename this device", icon: PencilSimpleIcon, run: () => setEditing(device.label) },
            { label: "Revoke", title: "Revoke device", icon: TrashIcon, run: onRevoke, danger: true },
          ]} />
        </div>
      </div>
      <div className="mt-1.5 space-y-1 pl-[52px] p-meta p-text-3">
        {device.update === "refused" && <p>Update to {device.servedVersion} refused: {device.updateRefusal}</p>}
        {device.wholeMachine && <p>{WHOLE_MACHINE_COPY}</p>}
        {cannotSandbox && <p><Status tone="warning">Cannot sandbox</Status></p>}
        {mode === "sandboxed" && <p>GPU: {describeGpuNodes(sandbox.gpu)}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          {grants.length === 0 ? (
            <span>No workspace uses it yet.</span>
          ) : (
            <>
              <span>Workspace access:</span>
              {grants.map((g) => (
                <span key={g.agentName} className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 p-fill">
                  {g.agentName}
                  <span className={g.policy === "allow" ? "p-text-3" : "p-danger"}>{g.policy === "allow" ? "Allowed" : "Denied"}</span>
                  <button onClick={() => detach(dropGrant(g.agentName))}
                    title={g.policy === "allow" ? `Revoke ${g.agentName}'s access` : `Remove the saved denial for ${g.agentName}`}
                    className="p-text-3 hover:p-danger">
                    <XIcon size={10} />
                  </button>
                </span>
              ))}
            </>
          )}
        </div>
      </div>
      {dialog}
    </div>
  );
}
