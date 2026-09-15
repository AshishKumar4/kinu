/**
 * User-level settings — credentials, devices and defaults that apply across
 * ALL of this user's agents. Connect ChatGPT once → every agent sees it.
 *
 * FIVE SECTIONS, ONE AT A TIME. This was one column of eight stacked cards,
 * and the owner's report was that it is hard to navigate: the thing you came
 * for is somewhere in a scroll, and a link that lands you on it lands you
 * mid-page with no way to tell where you are. The section is now in the URL
 * hash, the rail says which one you are reading, the section head says what
 * it changes, and every deep link that existed (`/user/settings#devices`)
 * opens its section instead of scrolling to it.
 *
 * One grammar inside a section: a `Card` names a group and what it applies
 * to; a `Field` names one setting and what it does; lists are `p-group` rows;
 * anything that takes something away is a quiet button in danger ink, kept
 * apart from the facts beside it.
 *
 *   #account    profile
 *   #devices    the machines linked to this account
 *   #providers  Cloudflare AI, ChatGPT, API keys, MCP servers
 *   #models     the default model and the role/tier catalog
 *   #cli        the one command that installs the CLI
 *
 * The page's own read is the profile alone, because it decides the page's
 * loading and failure states. A section's reads belong to the section: the
 * providers panel owns the connection reads, and the devices card its own
 * roster — a section switch mounts its reads fresh rather than re-reading an
 * account that has not changed.
 */
import { startTransition, useState, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  PlugIcon, PlugsConnectedIcon, UserCircleIcon, ArrowSquareOutIcon, TrashIcon,
  ArrowLeftIcon, DesktopTowerIcon, WarningIcon, PencilSimpleIcon, XIcon,
} from "@phosphor-icons/react";
import {
  getProfile, setDisplayName,
  acknowledgeUnstoppedDevice, registerDevice, renameDevice, revokeDevice,
  listDeviceConsents, revokeDeviceConsent, setDeviceSandboxTier,
  type UserDevice, type DeviceConsent,
} from "../lib/user-api";
import { Card } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { LoadFailure } from "@/components/ui/LoadFailure";
import {
  lastValue, useAsyncResource, type Revalidate,
} from "@/hooks/use-async-resource";
import { DEVICE_ROSTER_POLL_MS, useDeviceRoster } from "@/hooks/use-device-roster";
import { ConnectDevicePanel, DeviceConnectFlow } from "@/components/ConnectDevicePanel";
import { SettingsRail, SettingsSectionHead, settingsSection } from "@/components/SettingsRail";
import { ProfileCatalogSettings } from "@/components/ProfileCatalogSettings";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { DisplayNameField } from "@/components/account/DisplayNameField";
import { CliInstallCard } from "@/components/account/CliInstallCard";
import { DeleteAccountCard } from "@/components/account/DeleteAccountCard";
import { describeGpuNodes, effectiveDeviceMode, type DeviceMode } from "@kinu.run/core";
import { renderThrownChain } from '@kinu.run/core/obs';

/** The Profile card's editable half: the shared DisplayNameField plus the
 *  quiet Save that stays asleep until the name actually changed. Kept out of
 *  the CardSlot body because it owns state. */
function ProfileNameEditor({ profile, onSaved }: {
  profile: { email: string; displayName: string | null } | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = profile?.displayName ?? '';
  const changed = name.trim() !== stored.trim();

  const save = async () => {
    setSaving(true);
    setError(null);

    try { await setDisplayName(name); onSaved(); }
    catch (cause) { setError(renderThrownChain({ cause })); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <DisplayNameField value={name} onChange={setName} saving={saving} />
        </div>
        <Button variant="secondary" size="sm" disabled={!changed || saving} onClick={save}>
          {saving ? <Loader size="sm" /> : null} Save
        </Button>
      </div>
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

/** The page frame both states of the page share: the way back, the title,
 *  and what everything under it applies to. */
function PageHeader() {
  return (
    <header className="border-b p-border pb-6">
      <Link to="/" className="p-btn-ghost -ml-2 mb-4 inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-xs">
        <ArrowLeftIcon size={12} /> Workspaces
      </Link>
      <p className="p-eyebrow">Account</p>
      {/* Page title in the display face at 26px: above the workbench scale by design. */}
      <h1 className="p-display mt-1 text-[26px] leading-8">Account settings</h1>
      <p className="mt-1.5 p-row-text p-text-3">
        What you set here applies to every workspace you own.
      </p>
    </header>
  );
}

export default function UserSettingsPage() {
  const profile = useAsyncResource(getProfile);

  // Section state lives in the URL, so a deep link, a reload and the browser's
  // Back button all land on the same section.
  const section = settingsSection(useLocation().hash);

  // Before the profile read settles there is one quiet page loader, and when it
  // fails there is one failure — a second copy of either says nothing more.
  // The sections read for themselves: each card publishes on its own.
  if (profile.resource.status === "loading" || profile.resource.status === "error") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 px-5 py-8 sm:px-6">
          <PageHeader />
          {profile.resource.status === "loading"
            ? <div className="flex justify-center py-10"><Loader size="base" /></div>
            : <LoadFailure what="your account" message={profile.resource.message} onRetry={profile.reload} />}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-5 py-8 sm:px-6">
        <PageHeader />
        {/* A side rail needs room the workspace sidebar has already taken:
            below 64rem the same entries become a tab strip above the section. */}
        <div className="flex flex-col gap-7 lg:flex-row lg:gap-10">
          <SettingsRail active={section} />
          <div className="min-w-0 flex-1 lg:max-w-[820px]">
            <SettingsSectionHead section={section} />
            <div className="space-y-5">

        {section === "account" && (
          <>
            <Card title="Profile" icon={UserCircleIcon}>
              <CardSlot resource={profile.resource} what="your profile" onRetry={profile.reload}>
                {(p) => (
                  <div className="space-y-5">
                    <ProfileNameEditor profile={p} onSaved={profile.reload} />
                    <dl className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <dt className="p-meta p-text-3">Email</dt>
                        <dd className="mt-1 font-mono p-row-text p-text">{p?.email ?? 'Not available'}</dd>
                      </div>
                      <div>
                        <dt className="p-meta p-text-3">Member since</dt>
                        <dd className="mt-1 p-row-text p-text">{p?.createdAt ? new Date(p.createdAt).toLocaleDateString() : 'Not available'}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </CardSlot>
            </Card>

            {profile.resource.value !== null && <DeleteAccountCard email={profile.resource.value.email} />}
          </>
        )}

        {section === "cli" && <CliInstallCard />}

        {/* Devices — account-level PC/device registration; every agent can use
            a connected device (with consent). The workspace surfaces open the
            same connect panel in place; this is where the roster lives. */}
        {section === "devices" && <DevicesCard />}

        {section === "providers" && (
          <>
            <ProvidersPanel returnTo="/user/settings" />

            <Card title="MCP servers" icon={PlugsConnectedIcon}>
              <Link
                to="/user/settings/mcp"
                className="p-btn-quiet inline-flex h-6.5 items-center gap-1 px-2.5 text-xs"
              >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
            </Card>
          </>
        )}

        {section === "models" && <ProfileCatalogSettings />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Grants ride the SAME cadence as the roster: revoking one changes both what
 *  a machine may do and who has reach, so one clock keeps them honest. */
const keepPollingGrants: Revalidate<DeviceConsent[]> = () => DEVICE_ROSTER_POLL_MS;

/**
 * Register / revoke your machines here. This is account state on the user-do
 * device hub, not a per-run concern, so the roster and the revocations live on
 * this page. Linking a machine does not: the connect panel below is the same
 * component the Environment tab and the drive open in place.
 *
 * The roster and the grants are `useAsyncResource` reads. A failed poll leaves
 * the last known roster on screen AND says it failed — blanking it to `[]`
 * flashed "register a device" over devices that are registered and running,
 * and swallowing the rejection made an unreachable UserDO look exactly like an
 * account with no devices.
 */
function DevicesCard() {
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
      <Card title="Linked machines" icon={DesktopTowerIcon}>
        {devices.length > 0 ? (
          <div className="p-group text-xs">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                grants={grants.filter((g) => g.deviceId === d.id && g.policy === "allow")}
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

/** The one line under the switch, per mode. `effectiveDeviceMode` decides the
 *  mode; the hub enforces the same function, so the row explains exactly what
 *  the hub will do. The first two are the owner's own words. */
const SANDBOX_MODE_COPY = {
  sandboxed: "Sandboxed.",
  raw: "Off.",
  files_only: "Files only.",
} satisfies Record<DeviceMode, string>;

export function DeviceRow({
  device, grants, onDeviceChanged, onGrantsChanged, onError, onRevoke,
  unstoppedCommands, onAcknowledge,
}: {
  device: UserDevice;
  grants: DeviceConsent[];
  /** The roster must be re-read: this row renamed the device or moved its switch. */
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
    const countLine = unstoppedCommands === undefined
      ? "Commands may still run."
      : unstoppedCommands === 1
        ? "1 command has no confirmed termination and may still run."
        : `${unstoppedCommands} commands have no confirmed termination and may still run.`;

    return (
      <div data-device-incident={device.id} role="alert"
        className="p-notice-danger rounded-none border-0 px-4 py-3 text-xs">
        <div className="flex items-start gap-2">
          <WarningIcon size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium">{device.label}</div>
            <p>Kinu could not confirm that every command stopped after revocation.</p>
            <p>{countLine}</p>
            <p className="p-meta">Acknowledge clears this warning. It does not stop commands.</p>
          </div>
          <button type="button" disabled={acknowledging}
            onClick={() => {
              setAcknowledging(true);
              startTransition(async () => {
                try {
                  await onAcknowledge();
                } catch (cause) {
                  // `onAcknowledge` reports its own failures into this row's
                  // `onError`; a rejection that escapes that path still leaves
                  // the row visibly unacknowledged.
                  onError(`Could not acknowledge the command warning: ${renderThrownChain({ cause })}`);
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
  const mode = effectiveDeviceMode(sandbox);
  const cannotSandbox = sandbox.capability !== "sandboxed";

  // Off is the one direction that asks: it names the machine and what "off"
  // means. On needs no confirmation — it only ever narrows what a command reaches.
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
        {/* The one action here that takes something away sits apart from the
            facts, past a hairline, in danger ink. */}
        <button onClick={onRevoke} title="Revoke device" className="ml-1 border-l p-border pl-3 p-text-3 hover:p-danger"><TrashIcon size={13} /></button>
      </div>
      {/* The switch, then its consequence. One line of copy per mode; the badge
          is a machine fact the switch cannot change, so it sits beside the switch
          rather than inside the sentence. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 p-text">
          <button
            type="button"
            role="switch"
            aria-checked={sandboxOn}
            aria-label={`Sandbox on ${device.label}`}
            disabled={switching}
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
      <span className="mt-1.5 p-meta p-text-3" data-sandbox-mode={mode}>
        {SANDBOX_MODE_COPY[mode]}
      </span>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 p-meta p-text-3">
        {grants.length === 0 ? (
          <span>No workspace uses it yet.</span>
        ) : (
          <>
            <span>Granted:</span>
            {grants.map((g) => (
              <span key={g.agentName} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm p-fill">
                {g.agentName}
                <button onClick={async () => { await dropGrant(g.agentName); }} title={`Revoke ${g.agentName}'s access`} className="p-text-3 hover:p-danger">
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
