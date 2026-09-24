import { useState } from "react";
import { startTransition } from "react";
import {
  PencilSimpleIcon, TrashIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import {
  renameDevice, revokeDeviceConsent, setDeviceSandboxTier,
  type DeviceConsent, type UserDevice,
} from "@/lib/user-api";
import { DEVICE_UPDATE_COPY } from "@/hooks/use-device-roster";
import { describeGpuNodes, effectiveDeviceMode, type DeviceMode } from "@kinu.run/core";
import { renderThrownChain } from "@kinu.run/core/obs";

/** The hub enforces the same `effectiveDeviceMode`, so this line matches what it does. */
const SANDBOX_MODE_COPY = {
  sandboxed: "Sandboxed.",
  raw: "Off.",
  files_only: "Files only.",
} satisfies Record<DeviceMode, string>;

const WHOLE_MACHINE_COPY = "Linked from /, so the agent has this whole machine: every file you can open, and its commands "
  + "run as you. The Sandbox switch applies again once you run kinu connect in a narrower folder.";

/** An unknown count is still a warning: the hub could not confirm anything stopped. */
function unstoppedLine(count: number | undefined): string {
  if (count === undefined) return "Commands may still run.";

  if (count === 1) return "1 command has no confirmed termination and may still run.";

  return `${count} commands have no confirmed termination and may still run.`;
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
              startTransition(async () => {
                try {
                  await onAcknowledge();
                } catch (cause) {
                  // A rejection escaping `onError` still leaves the row visibly unacknowledged.
                  onError(`Could not acknowledge the device warning: ${renderThrownChain({ cause })}`);
                } finally {
                  setAcknowledging(false);
                }
              });
            }}
            className="p-btn-quiet inline-flex h-6.5 shrink-0 items-center px-2 text-xs">
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

  const dropGrant = async (agentName: string) => {
    try { await revokeDeviceConsent(device.id, agentName); }
    catch (e) { onError(`Could not revoke the grant: ${renderThrownChain({ cause: e })}`); }

    onGrantsChanged();
  };

  const { sandbox } = device;
  const sandboxOn = sandbox.tier === "sandboxed";
  const mode = device.wholeMachine ? "raw" : effectiveDeviceMode(sandbox);
  const cannotSandbox = sandbox.capability !== "sandboxed";

  // Only turning off asks; on only narrows what a command reaches.
  const setSandbox = async (on: boolean) => {
    if (!on && !confirm(`Turn Sandbox off for "${device.label}"? The agent will run as you with full access.`)) return;
    setSwitching(true);

    try { await setDeviceSandboxTier(device.id, on ? "sandboxed" : "raw"); }
    catch (e) { onError(`Could not change the Sandbox setting: ${renderThrownChain({ cause: e })}`); }
    finally { setSwitching(false); }

    onDeviceChanged();
  };

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={`size-1.5 rounded-full shrink-0 ${device.connected ? "p-dot-success" : "p-dot-neutral"}`} />
        {editing === null ? (
          <>
            <span className="p-row-text font-medium p-text">{device.label}</span>
            <button onClick={() => setEditing(device.label)} title="Rename this device" className="p-text-3 hover:p-text">
              <PencilSimpleIcon size={12} />
            </button>
          </>
        ) : (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={save}
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setEditing(null);
                await save();
              }

              if (e.key === "Escape") setEditing(null);
            }}
            aria-label="Device name"
            className="px-1.5 py-0.5 rounded-sm border p-border p-fill p-text text-xs w-44"
          />
        )}
        {device.hostname && <span className="p-annotation p-text-3">{device.hostname}{device.os ? ` · ${device.os}` : ""}</span>}
        <span className={`ml-auto px-2 py-0.5 ${device.connected ? "p-badge-success" : "p-badge-neutral"}`}>{device.connected ? "connected" : "offline"}</span>
        {/* Daemon version note: behind, updates off, or source install; silent when current. */}
        {(device.update === "behind" || device.update === "off" || device.update === "unstamped") && (
          <span role="status" data-device-update={device.update} title={device.version === null ? undefined : `${device.version} installed; ${device.servedVersion ?? ""} served`}
            className={`px-2 py-0.5 ${device.update === "behind" ? "p-badge-warning" : "p-badge-neutral"}`}>
            {DEVICE_UPDATE_COPY[device.update]}
          </span>
        )}
        <button onClick={onRevoke} title="Revoke device" className="ml-1 border-l p-border pl-3 p-text-3 hover:p-danger"><TrashIcon size={13} /></button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 p-text">
          <button
            type="button"
            role="switch"
            aria-checked={sandboxOn}
            aria-label={`Sandbox on ${device.label}`}
            disabled={switching || device.wholeMachine}
            onClick={async () => { await setSandbox(!sandboxOn); }}
            className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
              sandboxOn ? "border-[var(--c-accent)] bg-[var(--c-accent)]" : "border-[var(--c-border-strong)] bg-[var(--c-fill)]"
            }`}
          >
            <span className={`size-3 rounded-full transition-transform ${
              sandboxOn ? "translate-x-3 bg-[var(--c-accent-on)]" : "translate-x-0.5 bg-[var(--c-text-3)]"
            }`} />
          </button>
          <span className="font-medium">Sandbox</span>
        </label>
        {cannotSandbox && <span className="p-badge-warning px-1.5 py-0.5">Cannot sandbox</span>}
        {mode === "sandboxed" && <span className="p-text-3">GPU: {describeGpuNodes(sandbox.gpu)}</span>}
      </div>
      <span className="mt-1.5 p-meta p-text-3" data-sandbox-mode={mode} data-whole-machine={device.wholeMachine || undefined}>
        {device.wholeMachine ? WHOLE_MACHINE_COPY : SANDBOX_MODE_COPY[mode]}
      </span>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 p-meta p-text-3">
        {grants.length === 0 ? (
          <span>No workspace uses it yet.</span>
        ) : (
          <>
            <span>Workspace access:</span>
            {grants.map((g) => (
              <span key={g.agentName} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm p-fill">
                {g.agentName}
                <span className={g.policy === "allow" ? "p-text-3" : "p-danger"}>{g.policy === "allow" ? "Allowed" : "Denied"}</span>
                <button onClick={async () => { await dropGrant(g.agentName); }}
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
  );
}
