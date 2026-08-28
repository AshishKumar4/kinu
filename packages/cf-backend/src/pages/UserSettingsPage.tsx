/**
 * User-level settings — credentials + defaults that apply across ALL of
 * this user's agents. Connect ChatGPT once → every agent sees it.
 *
 * Sections:
 *   1. Profile (email read-only, displayName editable)
 *   2. Connections
 *      - ChatGPT Codex via device-code flow
 *      - BYO API keys for any models.dev catalog provider / openai-compat
 *   3. Defaults
 *      - default model new agents inherit
 */
import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Combobox, Loader } from "@cloudflare/kumo";
import {
  PlugIcon, KeyIcon, GearSixIcon, CheckIcon, CopyIcon,
  UserCircleIcon, ArrowSquareOutIcon, TrashIcon, ArrowLeftIcon,
  DesktopTowerIcon, WarningIcon, PencilSimpleIcon, XIcon,
} from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { ModelPicker } from "@/components/ModelPicker";
import {
  getProfile, listCredentials, setCredential, deleteCredential,
  codexStatus, startCodexFlow, pollCodexFlow, disconnectCodex,
  listAvailableModels, listProviderCatalog, getConfig, setConfig, getCliSetup,
  listCloudflareGateways, selectCloudflareGateway,
  listCloudflareAccounts, selectCloudflareAccount,
  acknowledgeUnstoppedDevice, listDevices, registerDevice, renameDevice, revokeDevice,
  listDeviceConsents, revokeDeviceConsent,
  type CredentialSummary, type CodexStatus,
  type ProviderCatalogEntry, type DeviceFlowStart, type CliSetup,
  type CloudflareGatewayStatus, type CloudflareAccountStatus, type UserDevice,
  type DeviceConsent,
} from "../lib/user-api";
import { Card, inputCls } from "@/components/ui/form";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { copyLabel, useCopy } from "@/hooks/use-copy";
import { CopyButton } from "@/components/ui/CopyButton";
import { ProfileCatalogSettings } from "@/components/ProfileCatalogSettings";
import * as v from "valibot";
import { renderThrownChain } from '@kinu.run/core/obs';

const ProviderCatalogEntrySchema = v.object({
  id: v.string(),
  credKey: v.string(),
  name: v.string(),
  doc: v.optional(v.string()),
  envVar: v.optional(v.string()),
  connected: v.boolean(),
});

function providerCatalogEntry<Input>(input: Input): ProviderCatalogEntry | null {
  const parsed = v.safeParse(ProviderCatalogEntrySchema, input);
  return parsed.success ? parsed.output : null;
}

/** One account read, rendered branch-locally: its card shows ITS data, ITS
 *  failure with the retry, or a quiet loader — one read stalling or rejecting
 *  never blanks the cards beside it (KINU-073). */
function CardSlot<T>({ resource, what, onRetry, children }: {
  resource: AsyncResource<T>;
  what: string;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  if (resource.status === "error") {
    return (
      <div className="contents" data-settings-resource={what} data-resource-state="error">
        <LoadFailure what={what} message={resource.message} onRetry={onRetry} />
      </div>
    );
  }
  if (resource.status === "loading") {
    return (
      <div className="flex justify-center py-4" data-settings-resource={what} data-resource-state="loading">
        <Loader size="sm" />
      </div>
    );
  }
  return (
    <div className="contents" data-settings-resource={what} data-resource-state="ready">
      {children(resource.value)}
    </div>
  );
}

export default function UserSettingsPage() {
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);

  // Every one of these reads describes what the account HAS connected, so none
  // of them may fail quietly: a swallowed rejection turned into "Connect
  // ChatGPT", no API keys and a Cloudflare OAuth CTA for an account that is
  // fully connected, walking the user into a needless re-grant. Each read is
  // its own resource so each also PUBLISHES independently: one unavailable
  // dependency stalls or fails its own card, never the seven beside it, and
  // every read runs under the api() helper's shared deadline rather than
  // waiting forever (KINU-073).
  const profile = useAsyncResource(getProfile);
  const creds = useAsyncResource(listCredentials);
  const codex = useAsyncResource(codexStatus);
  const models = useAsyncResource(listAvailableModels);
  const catalog = useAsyncResource(listProviderCatalog);
  const gateways = useAsyncResource(listCloudflareGateways);
  const accounts = useAsyncResource(listCloudflareAccounts);
  const storedDefault = useAsyncResource(useCallback(() => getConfig("default_model"), []));

  const reads = [profile, creds, codex, models, catalog, gateways, accounts, storedDefault];
  // One retry affordance: a mutation's onChanged and every card's Retry re-read
  // the whole account, because the mutators invalidate more than their own row
  // (connecting a provider changes the model menu, the catalog and the creds).
  // A plain closure: every consumer calls it from an event handler, none keys
  // an effect on it, so its per-render identity buys simplicity for free.
  const reloadAll = () => { for (const read of reads) read.reload(); };

  // The install command is derivable from the origin, so its read failing
  // costs nothing and claims nothing.
  useEffect(() => { getCliSetup().then(setCliSetup, () => setCliSetup(null)); }, []);

  // The picker is optimistic on the user's own pick; the loaded value is the
  // fallback until it is re-read.
  const selectedDefaultModel = defaultModel ?? lastValue(storedDefault.resource)?.value ?? '';

  const header = (
    <header>
      <Link to="/" className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
        <ArrowLeftIcon size={12} /> Back
      </Link>
      <h1 className="p-display text-2xl">Account settings</h1>
      <p className="text-xs p-text-3 mt-1">
        Account-level: credentials apply to every agent you own.
      </p>
    </header>
  );

  // Before ANY read settles there is one quiet page loader, and when EVERY read
  // failed there is one failure — eight stacked copies of either say nothing
  // more. Any mixed state renders the page and lets each card speak for itself.
  const failures = reads.flatMap((read) => read.resource.status === "error" ? [read.resource.message] : []);
  const allLoading = reads.every((read) => read.resource.status === "loading");
  if (allLoading || failures.length === reads.length) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
          {header}
          {allLoading
            ? <div className="flex justify-center py-10"><Loader size="base" /></div>
            : <LoadFailure what="your account" message={failures[0] ?? ""} onRetry={reloadAll} />}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        {header}

        {/* Profile */}
        <Card title="Profile" icon={UserCircleIcon}>
          <CardSlot resource={profile.resource} what="your profile" onRetry={reloadAll}>
            {(p) => (
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <div className="p-text-3">Email</div>
                  <div className="font-mono">{p?.email ?? '—'}</div>
                </div>
                <div className="space-y-1">
                  <div className="p-text-3">Member since</div>
                  <div>{p?.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}</div>
                </div>
              </div>
            )}
          </CardSlot>
        </Card>
        <ProfileCatalogSettings />


        <Card title="CLI" icon={KeyIcon}>
          <div className="space-y-3">
            <p className="text-xs p-text-2">
              Install the CLI, sign in through the browser, and configure local execution from one terminal command.
            </p>
            <CommandCopy label="Setup" command={cliSetup?.installCommand ?? `curl -fsSL '${window.location.origin}/install.sh' | bash`} />
          </div>
        </Card>

        {/* Devices — account-level PC/laptop registration; every agent can use
            a connected device (with consent). Linked from the Environment tab. */}
        <DevicesCard />

        <Card title="Cloudflare AI" icon={PlugIcon}>
          <CardSlot resource={models.resource} what="your connected models" onRetry={reloadAll}>
            {(menu) => menu.models.some((model) => model.provider === 'workers-ai') ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs p-success">
                  <CheckIcon size={13} /> Connected
                </div>
                {/* Which account serves Workers AI is upstream of which gateway
                    is reachable, so it is asked first. */}
                <CardSlot resource={accounts.resource} what="your Cloudflare accounts" onRetry={reloadAll}>
                  {(status) => <CloudflareAccountSection status={status} onChanged={reloadAll} />}
                </CardSlot>
                <CardSlot resource={gateways.resource} what="your AI gateways" onRetry={reloadAll}>
                  {(status) => <CloudflareGatewaySection status={status} onChanged={reloadAll} />}
                </CardSlot>
              </div>
            ) : (
              <CloudflareAIConnectNotice
                returnTo="/user/settings"
                message="Connect Cloudflare so your workspaces can use your Workers AI quota and your own AI Gateway."
              />
            )}
          </CardSlot>
        </Card>

        {/* Codex */}
        <Card title="ChatGPT (Codex)" icon={PlugIcon}>
          <CardSlot resource={codex.resource} what="your ChatGPT connection" onRetry={reloadAll}>
            {(status) => <CodexConnect status={status} onChanged={reloadAll} />}
          </CardSlot>
        </Card>

        {/* BYO API keys */}
        <Card title="API keys" icon={KeyIcon}>
          <CardSlot resource={creds.resource} what="your API keys" onRetry={reloadAll}>
            {(credentials) => (
              <CardSlot resource={catalog.resource} what="the provider catalog" onRetry={reloadAll}>
                {(providers) => <ApiKeyManager creds={credentials} catalog={providers} onChanged={reloadAll} />}
              </CardSlot>
            )}
          </CardSlot>
        </Card>

        {/* MCP servers */}
        <Card title="MCP servers" icon={PlugIcon}>
          <div className="space-y-2 text-xs">
            <p className="p-text-2">
              Connect Model Context Protocol servers (GitHub, Notion, your own…) so every agent
              you own can call their tools. One OAuth grant per server; shared across all your
              agents.
            </p>
            <Link
              to="/user/settings/mcp"
              className="inline-flex items-center gap-1 px-3 py-1.5 p-card p-card-hover"
            >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
          </div>
        </Card>

        {/* Defaults */}
        <Card title="Defaults" icon={GearSixIcon}>
          <CardSlot resource={models.resource} what="your connected models" onRetry={reloadAll}>
            {(menu) => (
              <CardSlot resource={storedDefault.resource} what="your default model" onRetry={reloadAll}>
                {() => (
                  <div className="space-y-2">
                    <div className="text-xs p-text-2">Default model for new workspaces</div>
                    <ModelPicker
                      models={menu.models}
                      failures={menu.failures}
                      value={selectedDefaultModel}
                      onChange={async (spec) => {
                        setDefaultModel(spec);
                        try { await setConfig('default_model', spec); }
                        catch (err) { setDefaultModel(null); alert(renderThrownChain({ cause: err })); }
                      }}
                      clearable
                      placeholder="(use system default)"
                    />
                    <p className="p-meta p-text-3">
                      New workspaces pick this up at creation. Existing workspaces keep their own choice (change per-workspace under "Workspace settings").
                    </p>
                  </div>
                )}
              </CardSlot>
            )}
          </CardSlot>
        </Card>
      </div>
    </div>
  );
}

// ── Devices — user-level PC/laptop tunnel registration ──────────────

/** Register / revoke your PCs here (moved out of the work surface — this is
 *  account state on the user-do device hub, not a per-run concern). The
 *  daemon opens one outbound WebSocket; no inbound ports, runs as your user,
 *  never root. Per-agent file-access tiers live in each workspace's settings. */
/** Device links renew themselves on every connect, so the only ones worth
 *  mentioning are the ones close enough to lapsing that the owner may need to
 *  go and start the daemon. Anything further out would be noise. */
const DEVICE_LAPSE_NOTICE_MS = 14 * 24 * 60 * 60 * 1000;

function lapsingDevices(devices: UserDevice[] | null): UserDevice[] {
  const soon = Date.now() + DEVICE_LAPSE_NOTICE_MS;
  return (devices ?? []).filter((device) =>
    device.revokedAt === null && device.expiresAt !== null && device.expiresAt <= soon);
}

function DevicesCard() {
  const [devices, setDevices] = useState<UserDevice[] | null>(null);
  const [grants, setGrants] = useState<DeviceConsent[] | null>(null);
  const [install, setInstall] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const { status: copyStatus, copy } = useCopy();
  const [err, setErr] = useState<string | null>(null);
  /** Counts come from the revoke response. The durable incident timestamp
   * keeps the row across reloads; count is shown when this tab observed it. */
  const [unstoppedCounts, setUnstoppedCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [rosterErr, setRosterErr] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // A failed poll leaves the last known roster in place. Blanking it to `[]`
  // flashed "register a device" over devices that are registered and running.
  // But it has to SAY so: dropping the rejection made an unreachable UserDO
  // look exactly like an account with no devices, and a stale roster look
  // exactly like a live one. Reported apart from `err` because this runs every
  // 5s — writing the action slot would wipe a register/revoke failure before
  // the owner could read it.
  const refreshDevices = useCallback(() => {
    listDevices().then(
      (roster) => { setDevices(roster); setRosterErr(null); },
      (e) => { setRosterErr(`Could not list devices: ${renderThrownChain({ cause: e })}`); },
    );
  }, []);
  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 5000); // running daemon flips connected within seconds
    return () => clearInterval(t);
  }, [refreshDevices]);

  // The grants themselves — which workspace may act on which device. Read
  // beside the roster because revoking one is the answer to "who has reach
  // into this machine", and that question is asked here, not per workspace.
  const refreshGrants = useCallback(() => {
    listDeviceConsents().then(
      (rows) => { setGrants(rows); },
      (e) => { setRosterErr(`Could not list device grants: ${renderThrownChain({ cause: e })}`); },
    );
  }, []);
  // Grants ride the SAME 5s cycle as the roster: revoking one changes both
  // what the machine may do and who has reach, so one clock keeps them honest.
  useEffect(() => {
    refreshGrants();
    const t = setInterval(refreshGrants, 5000);
    return () => clearInterval(t);
  }, [refreshGrants]);

  // Deep-link target: the Environment tab's "Connect your PC" CTA points at
  // /user/settings#devices.
  useEffect(() => {
    if (window.location.hash === "#devices") {
      anchorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, []);

  const issue = useCallback(async () => {
    setIssuing(true);
    setErr(null);
    try { const r = await registerDevice(); setInstall(r.installCommand); refreshDevices(); }
    catch (e) { setErr(`Could not register device: ${renderThrownChain({ cause: e })}`); }
    finally { setIssuing(false); }
  }, [refreshDevices]);

  const revoke = useCallback(async (id: string, label: string) => {
    if (!confirm(`Revoke "${label}"? Agents lose access to this device immediately.`)) return;
    setErr(null);
    try {
      const result = await revokeDevice(id);
      if (result.unstoppedCommands > 0) {
        setUnstoppedCounts((current) => new Map(current).set(id, result.unstoppedCommands));
      }
    } catch (e) {
      setErr(`Could not revoke device: ${renderThrownChain({ cause: e })}`);
    }
    refreshDevices();
  }, [refreshDevices]);

  const acknowledgeIncident = useCallback(async (id: string) => {
    setErr(null);
    try {
      await acknowledgeUnstoppedDevice(id);
      setUnstoppedCounts((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      // The acknowledged revoked row is no longer owner-visible. Remove it
      // immediately from the confirmed response, then reconcile the roster.
      setDevices((current) => current?.filter((device) => device.id !== id) ?? null);
      refreshDevices();
    } catch (e) {
      setErr(`Could not acknowledge the command warning: ${renderThrownChain({ cause: e })}`);
    }
  }, [refreshDevices]);

  return (
    <div ref={anchorRef} id="devices">
      <Card title="Devices" icon={DesktopTowerIcon}>
        <p className="text-xs p-text-2">
          Link a computer to your account and give it a name. A workspace can run commands and read
          files on it only after you grant that workspace access — once, revocably. The daemon opens
          one outbound WebSocket; no inbound ports, runs as your user, never root.
        </p>

        {devices && devices.length > 0 && (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                grants={grants?.filter((g) => g.deviceId === d.id && g.policy === "allow") ?? []}
                onRenamed={refreshDevices}
                onGrantsChanged={refreshGrants}
                onError={setErr}
                onRevoke={() => revoke(d.id, d.label)}
                unstoppedCommands={unstoppedCounts.get(d.id)}
                onAcknowledge={() => acknowledgeIncident(d.id)}
              />
            ))}
          </div>
        )}
        {rosterErr && <div className="text-xs p-danger">{rosterErr}</div>}
        {devices && devices.some((device) => device.revokedAt === null)
          && !devices.some((device) => device.revokedAt === null && device.connected) && (
          <p className="p-meta p-text-3">
            Offline device? Restart the daemon on that machine with <code className="font-mono p-fill px-1 rounded-sm">kinu connect</code>.
          </p>
        )}
        {lapsingDevices(devices).length > 0 && (
          <p className="p-meta p-text-3">
            {lapsingDevices(devices).map((d) => d.label).join(", ")} {lapsingDevices(devices).length > 1 ? "links lapse" : "link lapses"} soon.
            Connecting from {lapsingDevices(devices).length > 1 ? "those machines" : "that machine"} renews it automatically.
          </p>
        )}

        {err && <div className="text-xs p-danger">{err}</div>}

        {!install ? (
          <button
            onClick={issue}
            disabled={issuing}
            className="px-3 py-2 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 disabled:opacity-50"
          >{issuing ? "Generating…" : "Connect a device"}</button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs p-text-2">Paste this on the machine you want to connect. It installs the CLI, signs in, and starts the local daemon:</p>
            <div className="rounded-md p-fill border p-border p-3 font-mono p-meta p-text break-all select-all leading-relaxed">
              {install}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => copy(install)}
                className={`px-2 py-1 rounded-sm p-card p-card-hover flex items-center gap-1 ${copyStatus === "failed" ? "p-danger" : "p-text-2"}`}
              ><CopyIcon size={11} />{copyLabel(copyStatus)}</button>
              <button onClick={() => setInstall(null)} className="p-text-3 hover:p-text">Done</button>
            </div>
            <p className="p-meta p-text-3 mt-1 flex items-center gap-1.5">
              <WarningIcon size={11} /> Device secrets are written locally by <code className="font-mono">kinu connect</code>; they are not shown in this command.
            </p>
          </div>
        )}

        <p className="p-meta p-text-3">
          Each workspace's file-access tier on a device (consented folder vs full filesystem) is set
          in that workspace's settings.
        </p>
      </Card>
    </div>
  );
}

/**
 * One linked machine: its name (editable — this is the name every surface
 * shows, from the agent's executor row to a consent card), its platform, its
 * liveness, and the workspaces that hold a grant on it. The grants sit here
 */
function DeviceRow({
  device, grants, onRenamed, onGrantsChanged, onError, onRevoke,
  unstoppedCommands, onAcknowledge,
}: {
  device: UserDevice;
  grants: DeviceConsent[];
  onRenamed: () => void;
  onGrantsChanged: () => void;
  onError: (message: string) => void;
  onRevoke: () => void;
  unstoppedCommands: number | undefined;
  onAcknowledge: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);

  if (device.revokedAt !== null) {
    const countLine = unstoppedCommands === undefined
      ? "Commands may still run."
      : unstoppedCommands === 1
        ? "1 command has no confirmed termination and may still run."
        : `${unstoppedCommands} commands have no confirmed termination and may still run.`;
    return (
      <div data-device-incident={device.id} role="alert"
        className="border-b p-border p-notice-danger px-3 py-3 text-xs last:border-0">
        <div className="flex items-start gap-2">
          <WarningIcon size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-medium">{device.label}</div>
            <p>A command could not be confirmed stopped when you revoked this device.</p>
            <p>{countLine}</p>
            <p className="p-meta">Acknowledgement records that you saw this warning. It does not stop a command.</p>
          </div>
          <button type="button" disabled={acknowledging}
            onClick={() => {
              setAcknowledging(true);
              void onAcknowledge().finally(() => setAcknowledging(false));
            }}
            className="p-btn-quiet shrink-0 px-2 py-1 disabled:opacity-50">
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
    onRenamed();
  };

  const dropGrant = async (agentName: string) => {
    try { await revokeDeviceConsent(device.id, agentName); }
    catch (e) { onError(`Could not revoke the grant: ${renderThrownChain({ cause: e })}`); }
    onGrantsChanged();
  };

  return (
    <div className="px-3 py-2 border-b p-border last:border-0">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 rounded-full shrink-0 ${device.connected ? "p-dot-success" : "p-dot-neutral"}`} />
        {editing === null ? (
          <>
            <span className="font-medium p-text">{device.label}</span>
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
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setEditing(null);
            }}
            aria-label="Device name"
            className="px-1.5 py-0.5 rounded-sm border p-border p-fill p-text text-xs w-44"
          />
        )}
        {device.hostname && <span className="p-text-3 font-mono">{device.hostname}{device.os ? ` · ${device.os}` : ""}</span>}
        <span className="p-text-3 ml-auto">{device.connected ? "connected" : "offline"}</span>
        <button onClick={onRevoke} title="Revoke device" className="p-text-3 hover:p-danger"><TrashIcon size={13} /></button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 p-meta p-text-3">
        {grants.length === 0 ? (
          <span>No workspace has access yet — the first one to ask will prompt you.</span>
        ) : (
          <>
            <span>Granted:</span>
            {grants.map((g) => (
              <span key={g.agentName} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm p-fill">
                {g.agentName}
                {g.scope === "full_filesystem" && <span className="p-text-3">· full filesystem</span>}
                <button onClick={() => void dropGrant(g.agentName)} title={`Revoke ${g.agentName}'s access`} className="p-text-3 hover:p-danger">
                  <XIcon size={10} />
                </button>
              </span>
            ))}
          </>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 p-meta p-text-3">
        {device.lastIp && <span>Last connected from <code className="font-mono">{device.lastIp}</code></span>}
        {device.replacedAt !== null && (
          <span className="p-danger">
            Another connection took this device's place on {new Date(device.replacedAt).toLocaleString()} —
            if that was not you, revoke it and run <code className="font-mono">kinu connect</code> again.
          </span>
        )}
      </div>
    </div>
  );
}

function CommandCopy({ label, command }: { label: string; command: string }) {
  const { status, copy } = useCopy();
  return (
    <div className="flex items-center gap-2 rounded-md border p-border p-2">
      <div className="w-14 shrink-0 p-meta p-text-3">{label}</div>
      <code className="font-mono p-meta p-text flex-1 truncate">{command}</code>
      <button
        onClick={() => copy(command)}
        className={`px-2 py-1 rounded-sm p-card p-card-hover flex items-center gap-1 text-xs ${status === "failed" ? "p-danger" : "p-text-2"}`}
      >
        <CopyIcon size={11} />{copyLabel(status)}
      </button>
    </div>
  );
}

// ── Cloudflare account selection ────────────────────────────────────

/**
 * Which of the user's Cloudflare accounts serves this workspace's Workers AI.
 * Only rendered when there is a choice to make: a single-account user has
 * nothing to decide and gets no control. Picking an account clears the gateway
 * selection server-side and rediscovers gateways, so the caller reloads.
 */
function CloudflareAccountSection({ status, onChanged }: {
  status: CloudflareAccountStatus | null;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status?.connected || status.accounts.length < 2) return null;

  const choose = async (id: string) => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try { await selectCloudflareAccount(id); onChanged(); }
    catch (e) { setError(renderThrownChain({ cause: e })); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-1.5">
      <div className="text-xs p-text-2">Workers AI account</div>
      <select
        value={status.selectedId ?? ''}
        onChange={(e) => choose(e.target.value)}
        disabled={saving}
        className={inputCls}
      >
        {status.selectedId === null && <option value="">(no account selected)</option>}
        {status.accounts.map((account) => (
          <option key={account.id} value={account.id}>{account.name}</option>
        ))}
      </select>
      <p className="p-meta p-text-3">
        Which Cloudflare account serves this workspace's Workers AI. Changing it clears the AI
        Gateway selection below, because gateways belong to an account.
      </p>
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

// ── Cloudflare AI Gateway selection ─────────────────────────────────

function CloudflareGatewaySection({ status, onChanged }: {
  status: CloudflareGatewayStatus | null;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status?.connected) return null;

  const choose = async (id: string) => {
    setSaving(true);
    setError(null);
    try { await selectCloudflareGateway(id || null); onChanged(); }
    catch (e) { setError(renderThrownChain({ cause: e })); }
    finally { setSaving(false); }
  };

  if (status.error) {
    return (
      <CloudflareAIConnectNotice
        returnTo="/user/settings"
        message={`Your AI Gateways couldn't be listed: ${status.error}`}
      />
    );
  }
  if (status.gateways.length === 0) {
    return (
      <p className="p-meta p-text-3">
        No AI Gateway found in your Cloudflare account. Create one under AI &gt; AI Gateway in the
        Cloudflare dashboard to use your own provider keys (BYOK) or Unified Billing credits here.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="text-xs p-text-2">Your AI Gateway</div>
      {status.gateways.length === 1 && status.selectedId === status.gateways[0].id ? (
        <div className="flex items-center gap-2 text-xs">
          <CheckIcon size={13} className="p-success" />
          <span className="font-mono">{status.selectedId}</span>
        </div>
      ) : (
        <select
          value={status.selectedId ?? ''}
          onChange={(e) => choose(e.target.value)}
          disabled={saving}
          className={inputCls}
        >
          <option value="">(no gateway selected)</option>
          {status.gateways.map((gw) => (
            <option key={gw.id} value={gw.id}>{gw.id}</option>
          ))}
        </select>
      )}
      <p className="p-meta p-text-3">
        Third-party models (spec <code className="p-card px-1">my-gateway/&lt;provider&gt;/&lt;model&gt;</code>) route
        through this gateway using its stored provider keys or your Unified Billing credits.
      </p>
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

// ── Codex device-code flow ──────────────────────────────────────────

function CodexConnect({ status, onChanged }: { status: CodexStatus | null; onChanged: () => void }) {
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const f = await startCodexFlow();
      setFlow(f);
      setPolling(true);
      const stopPolling = () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setPolling(false);
      };
      pollRef.current = setInterval(async () => {
        try {
          const result = await pollCodexFlow();
          if (result.connected) {
            stopPolling();
            setFlow(null);
            onChanged();
          } else if (result.error) {
            // Still-pending polls return { connected: false } with no error;
            // a reported error (expired/denied/no flow) is terminal — stop
            // polling instead of hammering the endpoint forever.
            stopPolling();
            setFlow(null);
            setError(result.error);
          } else {
            setError(null); // still pending — clear any transient poll error
          }
        } catch (e) {
          // Thrown = the poll request itself failed (network blip) — show it
          // but keep polling; the flow may still complete.
          setError(renderThrownChain({ cause: e }));
        }
      }, Math.max(3, f.pollIntervalSec) * 1000);
    } catch (e) {
      setError(renderThrownChain({ cause: e }));
    }
  }, [onChanged]);

  const disconnect = useCallback(async () => {
    if (!confirm('Disconnect ChatGPT? All your agents will lose access to Codex models.')) return;
    try { await disconnectCodex(); onChanged(); } catch (e) { setError(renderThrownChain({ cause: e })); }
  }, [onChanged]);

  if (status?.connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <CheckIcon size={14} className="p-success" />
          <span>Connected{status.accountId ? <span className="p-text-3"> · account {status.accountId.slice(0, 8)}…</span> : null}</span>
        </div>
        <button onClick={disconnect}
          className="text-xs px-3 py-1.5 p-card p-card-hover transition-colors">
          Disconnect
        </button>
      </div>
    );
  }

  if (flow && polling) {
    return (
      <div className="space-y-3">
        <p className="text-xs p-text-2">
          Open <a href={flow.portalURL} target="_blank" rel="noopener noreferrer" className="p-accent underline">{flow.portalURL}</a> and enter:
        </p>
        <div className="flex items-center gap-3">
          <code className="text-2xl font-mono tracking-widest p-card px-4 py-2 select-all">{flow.userCode}</code>
          <CopyButton value={flow.userCode} what="the device code" size={14}
            className="p-2 p-card p-card-hover" />
          <a
            href={flow.portalURL}
            target="_blank" rel="noopener noreferrer"
            className="p-2 p-card p-card-hover"
            title="Open portal"
          ><ArrowSquareOutIcon size={14} /></a>
        </div>
        <p className="p-meta p-text-3 flex items-center gap-2"><Loader size="sm" /> Waiting for you to authorize…</p>
        {error && <p className="text-xs p-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs p-text-2">
        Use your ChatGPT subscription as Kinu's chat backend.
        Authorize a device once. Every agent you create can pick a Codex model afterward.
      </p>
      <button
        onClick={start}
        className="px-3 py-1.5 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 transition-opacity"
      >Connect ChatGPT</button>
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

// ── BYO API keys ────────────────────────────────────────────────────

function ApiKeyManager({ creds, catalog, onChanged }: {
  creds: CredentialSummary[];
  catalog: ProviderCatalogEntry[];
  onChanged: () => void;
}) {
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const remove = useCallback(async (key: string, name: string) => {
    if (!confirm(`Remove the saved API key for "${name}"?`)) return;
    try { await deleteCredential(key); onChanged(); } catch (e) { alert(renderThrownChain({ cause: e })); }
  }, [onChanged]);

  // Connect-a-provider form — any models.dev catalog provider, searchable.
  const byCredKey = new Map(catalog.map((p) => [p.credKey, p]));
  const storedKeys = creds
    .filter((c) => /^[a-z0-9][a-z0-9._-]*\.bearer$/.test(c.key))
    .map((c) => ({ key: c.key, provider: byCredKey.get(c.key) }));
  const [selected, setSelected] = useState<ProviderCatalogEntry | null>(null);
  const [apiKey, setApiKey] = useState('');
  const saveSelected = useCallback(async () => {
    if (!selected || !apiKey.trim()) return;
    setSavingKey(selected.credKey);
    try {
      await setCredential(selected.credKey, { kind: 'bearer', token: apiKey.trim() });
      setSelected(null);
      setApiKey('');
      onChanged();
    } catch (e) {
      alert(renderThrownChain({ cause: e }));
    } finally {
      setSavingKey(null);
    }
  }, [selected, apiKey, onChanged]);

  // openai-compat — user-chosen key suffix.
  const [compatName, setCompatName] = useState('');
  const [compatBaseURL, setCompatBaseURL] = useState('');
  const [compatApiKey, setCompatApiKey] = useState('');
  const saveCompat = useCallback(async () => {
    if (!compatName.trim() || !compatBaseURL.trim() || !compatApiKey.trim()) return;
    const credKey = `openai-compat.${compatName.trim()}`;
    setSavingKey(credKey);
    try {
      await setCredential(credKey, {
        kind: 'openai-compat',
        baseURL: compatBaseURL.trim(),
        apiKey: compatApiKey.trim(),
      });
      setCompatName(''); setCompatBaseURL(''); setCompatApiKey('');
      onChanged();
    } catch (e) {
      alert(renderThrownChain({ cause: e }));
    } finally {
      setSavingKey(null);
    }
  }, [compatName, compatBaseURL, compatApiKey, onChanged]);

  return (
    <div className="space-y-4">
      {/* Stored keys */}
      {storedKeys.length > 0 && (
        <div className="space-y-1.5">
          {storedKeys.map(({ key, provider }) => (
            <div key={key} className="flex items-center gap-2 text-xs px-2 py-1.5 p-card rounded-sm">
              <CheckIcon size={13} className="p-success shrink-0" />
              <span className="font-medium">{provider?.name ?? key}</span>
              {provider?.doc && (
                <a href={provider.doc} target="_blank" rel="noopener noreferrer" className="p-text-3 hover:p-accent" title="Provider docs">
                  <ArrowSquareOutIcon size={12} />
                </a>
              )}
              <span className="p-text-3 font-mono truncate">{key}</span>
              <button
                onClick={() => remove(key, provider?.name ?? key)}
                className="ml-auto flex items-center gap-1 p-text-3 hover:p-danger shrink-0"
              ><TrashIcon size={11} /> Remove</button>
            </div>
          ))}
        </div>
      )}

      {/* Connect any catalog provider */}
      <div className="space-y-2">
        <div className="text-xs font-medium">Connect a provider</div>
        <p className="p-meta p-text-3">
          Paste an API key for any of the {catalog.length} supported providers. Every agent you own can use its models.
        </p>
        <Combobox
          items={catalog}
          value={selected}
          onValueChange={<Next,>(next: Next) => setSelected(providerCatalogEntry(next))}
          itemToStringLabel={<Item,>(item: Item) => providerCatalogEntry(item)?.name ?? ''}
          itemToStringValue={<Item,>(item: Item) => providerCatalogEntry(item)?.id ?? ''}
        >
          <Combobox.TriggerInput placeholder="Search providers (Groq, DeepSeek, Fireworks, …)" />
          <Combobox.Content>
            <Combobox.Empty>No matching provider. Add it below as an OpenAI-compatible endpoint.</Combobox.Empty>
            <Combobox.List>
              {(item: ProviderCatalogEntry) => (
                <Combobox.Item key={item.id} value={item}>
                  <span className="flex w-full items-center gap-2">
                    <span>{item.name}</span>
                    {item.connected && <CheckIcon size={12} className="p-success ml-auto" />}
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Content>
        </Combobox>
        {selected && (
          <div className="space-y-2">
            <p className="p-meta p-text-3">
              {selected.envVar && <>Usually stored as <code className="p-card px-1">{selected.envVar}</code>. </>}
              {selected.doc && (
                <a href={selected.doc} target="_blank" rel="noopener noreferrer" className="p-accent underline">
                  {selected.name} docs <ArrowSquareOutIcon size={10} className="inline" />
                </a>
              )}
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selected.connected ? '••••••• (stored, paste to replace)' : `${selected.name} API key`}
                className={inputCls}
              />
              <button
                onClick={saveSelected}
                disabled={savingKey !== null || !apiKey.trim()}
                className="px-3 py-1.5 p-card p-card-hover disabled:opacity-50 text-xs shrink-0"
              >{savingKey === selected.credKey ? '...' : (selected.connected ? 'Replace' : 'Save')}</button>
            </div>
          </div>
        )}
      </div>

      {/* OpenAI-compat slot */}
      <div className="pt-3 border-t p-border space-y-2">
        <div className="text-xs font-medium">OpenAI-compatible (Groq, Together, …)</div>
        <p className="p-meta p-text-3">Each named entry stores baseURL + apiKey. Use model spec <code className="p-card px-1">openai-compat:&lt;name&gt;/&lt;modelId&gt;</code>.</p>
        <div className="grid grid-cols-3 gap-2">
          <input
            value={compatName}
            onChange={(e) => setCompatName(e.target.value)}
            placeholder="name (e.g. groq)"
            className={inputCls}
          />
          <input
            value={compatBaseURL}
            onChange={(e) => setCompatBaseURL(e.target.value)}
            placeholder="https://api.example.com/v1"
            className={inputCls}
          />
          <input
            type="password"
            value={compatApiKey}
            onChange={(e) => setCompatApiKey(e.target.value)}
            placeholder="api key"
            className={inputCls}
          />
        </div>
        <button
          onClick={saveCompat}
          disabled={savingKey !== null || !compatName.trim() || !compatBaseURL.trim() || !compatApiKey.trim()}
          className="px-3 py-1.5 p-card p-card-hover disabled:opacity-50 text-xs"
        >Add endpoint</button>

        {/* List existing openai-compat */}
        {creds.filter((c) => c.key.startsWith('openai-compat.')).map((c) => (
          <div key={c.key} className="flex items-center justify-between text-xs px-2 py-1.5 p-card rounded-sm">
            <span className="font-mono">{c.key}</span>
            <button onClick={() => remove(c.key, c.key)} className="flex items-center gap-1 p-text-3 hover:p-danger">
              <TrashIcon size={11} /> Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
