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
 * The account reads stay on the PAGE rather than in the sections: they decide
 * the page's own loading and failure states, and a section switch must not
 * re-read an account that has not changed.
 */
import { startTransition, useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Combobox, Loader } from "@cloudflare/kumo";
import {
  PlugIcon, KeyIcon, GearSixIcon, CheckIcon, CloudIcon, OpenAiLogoIcon, PlugsConnectedIcon,
  UserCircleIcon, ArrowSquareOutIcon, TrashIcon, ArrowLeftIcon,
  DesktopTowerIcon, WarningIcon, PencilSimpleIcon, XIcon, TerminalIcon,
} from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { ModelPicker } from "@/components/ModelPicker";
import {
  getProfile, listCredentials, setCredential, deleteCredential,
  codexStatus, startCodexFlow, pollCodexFlow, disconnectCodex,
  listAvailableModels, listProviderCatalog, getConfig, setConfig, getCliSetup,
  listCloudflareGateways, selectCloudflareGateway,
  listCloudflareAccounts, selectCloudflareAccount,
  acknowledgeUnstoppedDevice, registerDevice, renameDevice, revokeDevice,
  listDeviceConsents, revokeDeviceConsent, setDeviceSandboxTier,
  type CredentialSummary, type CodexStatus,
  type ProviderCatalogEntry, type DeviceFlowStart, type CliSetup,
  type CloudflareGatewayStatus, type CloudflareAccountStatus, type UserDevice,
  type DeviceConsent,
} from "../lib/user-api";
import { Card, Field, inputCls } from "@/components/ui/form";
import { LoadFailure } from "@/components/ui/LoadFailure";
import {
  lastValue, useAsyncResource, type AsyncResource, type Revalidate,
} from "@/hooks/use-async-resource";
import { DEVICE_ROSTER_POLL_MS, useDeviceRoster } from "@/hooks/use-device-roster";
import { ConnectDevicePanel, DeviceConnectFlow } from "@/components/ConnectDevicePanel";
import { SettingsRail, SettingsSectionHead, settingsSection } from "@/components/SettingsRail";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilledButton } from "@/components/ui/FilledButton";
import { ProfileCatalogSettings } from "@/components/ProfileCatalogSettings";
import * as v from "valibot";
import { describeGpuNodes, effectiveDeviceMode, sandboxReasonFix, type DeviceMode } from "@kinu.run/core";
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

/** The one spelling of "this provider is connected", so Cloudflare and ChatGPT
 *  say it the same way. A detail is the account or gateway it is connected as. */
function ConnectedBadge({ detail }: { detail?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="p-badge-success inline-flex items-center gap-1 px-2 py-0.5"><CheckIcon size={11} /> Connected</span>
      {detail && <span className="p-meta p-text-3">{detail}</span>}
    </div>
  );
}

/** A quiet destructive action: danger ink in the quiet box, so it reads as an
 *  action and as one that takes something away, without the filled danger the
 *  page reserves for a confirm. */
const dangerQuietCls = "p-btn-quiet inline-flex h-6.5 shrink-0 items-center gap-1 px-2 text-xs p-danger";

/** The page frame both states of the page share: the way back, the title,
 *  and what everything under it applies to. */
function PageHeader() {
  return (
    <header className="border-b p-border pb-6">
      <Link to="/" className="p-btn-ghost -ml-2 mb-4 inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-xs">
        <ArrowLeftIcon size={12} /> Workspaces
      </Link>
      <p className="p-eyebrow">Account</p>
      <h1 className="p-display mt-1 text-[26px] leading-8">Account settings</h1>
      <p className="mt-1.5 p-row-text p-text-3">
        What you set here applies to every workspace you own.
      </p>
    </header>
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

  // Section state lives in the URL, so a deep link, a reload and the browser's
  // Back button all land on the same section.
  const section = settingsSection(useLocation().hash);

  // Before ANY read settles there is one quiet page loader, and when EVERY read
  // failed there is one failure — eight stacked copies of either say nothing
  // more. Any mixed state renders the page and lets each card speak for itself.
  const failures = reads.flatMap((read) => read.resource.status === "error" ? [read.resource.message] : []);
  const allLoading = reads.every((read) => read.resource.status === "loading");

  if (allLoading || failures.length === reads.length) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 px-5 py-8 sm:px-6">
          <PageHeader />
          {allLoading
            ? <div className="flex justify-center py-10"><Loader size="base" /></div>
            : <LoadFailure what="your account" message={failures[0] ?? ""} onRetry={reloadAll} />}
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
          <Card title="Profile" icon={UserCircleIcon}>
            <CardSlot resource={profile.resource} what="your profile" onRetry={reloadAll}>
              {(p) => (
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
              )}
            </CardSlot>
          </Card>
        )}

        {section === "cli" && (
          <Card title="Install" icon={TerminalIcon}
            description="Install the CLI, sign in, and configure local execution with one command.">
            <CommandCopy command={cliSetup?.installCommand ?? `curl -fsSL '${window.location.origin}/install.sh' | bash`} />
          </Card>
        )}

        {/* Devices — account-level PC/laptop registration; every agent can use
            a connected device (with consent). The workspace surfaces open the
            same connect panel in place; this is where the roster lives. */}
        {section === "devices" && <DevicesCard />}

        {section === "providers" && (
          <>
            <Card title="Cloudflare AI" icon={CloudIcon}
              description="Workers AI models on your quota, and an AI Gateway for provider keys or Unified Billing.">
              <CardSlot resource={models.resource} what="your connected models" onRetry={reloadAll}>
                {(menu) => menu.models.some((model) => model.provider === 'workers-ai') ? (
                  <div className="space-y-5">
                    <ConnectedBadge />
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
                    message="Connect Cloudflare to use your Workers AI quota and AI Gateway."
                  />
                )}
              </CardSlot>
            </Card>

            <Card title="ChatGPT (Codex)" icon={OpenAiLogoIcon}
              description="Your ChatGPT subscription and its Codex models.">
              <CardSlot resource={codex.resource} what="your ChatGPT connection" onRetry={reloadAll}>
                {(status) => <CodexConnect status={status} onChanged={reloadAll} />}
              </CardSlot>
            </Card>

            <Card title="API keys" icon={KeyIcon}
              description="Keys you paste here are stored once and used by every workspace.">
              <CardSlot resource={creds.resource} what="your API keys" onRetry={reloadAll}>
                {(credentials) => (
                  <CardSlot resource={catalog.resource} what="the provider catalog" onRetry={reloadAll}>
                    {(providers) => <ApiKeyManager creds={credentials} catalog={providers} onChanged={reloadAll} />}
                  </CardSlot>
                )}
              </CardSlot>
            </Card>

            <Card title="MCP servers" icon={PlugsConnectedIcon}
              description="Connect an MCP server once. Every agent you own can use its tools.">
              <Link
                to="/user/settings/mcp"
                className="p-btn-quiet inline-flex h-6.5 items-center gap-1 px-2.5 text-xs"
              >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
            </Card>
          </>
        )}

        {section === "models" && (
          <>
            <Card title="Defaults" icon={GearSixIcon}>
              <CardSlot resource={models.resource} what="your connected models" onRetry={reloadAll}>
                {(menu) => (
                  <CardSlot resource={storedDefault.resource} what="your default model" onRetry={reloadAll}>
                    {() => (
                      <Field label="Default model for new workspaces"
                        hint="New workspaces use this default. Change an existing workspace under Workspace settings.">
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
                      </Field>
                    )}
                  </CardSlot>
                )}
              </CardSlot>
            </Card>
            <ProfileCatalogSettings />
          </>
        )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Devices — user-level PC/laptop tunnel registration ──────────────

/** Device links renew themselves on every connect, so the only ones worth
 *  mentioning are the ones close enough to lapsing that the owner may need to
 *  go and start the daemon. Anything further out would be noise. */
const DEVICE_LAPSE_NOTICE_MS = 14 * 24 * 60 * 60 * 1000;

function lapsingDevices(devices: readonly UserDevice[]): UserDevice[] {
  const soon = Date.now() + DEVICE_LAPSE_NOTICE_MS;

  return devices.filter((device) =>
    device.revokedAt === null && device.expiresAt !== null && device.expiresAt <= soon);
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

  const lapsing = lapsingDevices(devices);

  return (
    <>
      {/* What a link MEANS is stated once, by the connect panel below, in the
          words `kinu connect` prints. This card is about the list. */}
      <Card title="Linked machines" icon={DesktopTowerIcon}
        description="Your linked machines, and which workspaces can use them. Revoke a workspace's access from the machine's row.">
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
          <p className="p-row-text p-text-3">No machine is linked yet. Connect one below.</p>
        )}
        {roster.resource.status === "error" && (
          <LoadFailure what="your devices" message={roster.resource.message} onRetry={reloadDevices} />
        )}
        {grantRoster.resource.status === "error" && (
          <LoadFailure what="the device grants" message={grantRoster.resource.message} onRetry={grantRoster.reload} />
        )}
        {devices.some((device) => device.revokedAt === null)
          && !devices.some((device) => device.revokedAt === null && device.connected) && (
          <p className="p-meta p-text-3">
            Offline. Run <code className="font-mono p-fill px-1 rounded-sm">kinu connect</code> on that machine.
          </p>
        )}
        {lapsing.length > 0 && (
          <p className="p-meta p-text-3">
            {lapsing.map((d) => d.label).join(", ")} {lapsing.length > 1 ? "links lapse" : "link lapses"} soon.
            Run <code className="font-mono p-fill px-1 rounded-sm">kinu connect</code> on {lapsing.length > 1 ? "those machines" : "that machine"} to renew {lapsing.length > 1 ? "them" : "it"}.
          </p>
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
  sandboxed: "Commands can use the agent home, selected folders, GPU, and network. Other files stay hidden.",
  raw: "Off. The agent runs as you with full access.",
  files_only: "No sandbox. Nothing runs here.",
} satisfies Record<DeviceMode, string>;

/** A fix from core carries its commands in backticks, as `kinu connect` prints
 *  them. On this page a command is a `<code>` — the treatment this card already
 *  gives `kinu connect` in its offline hint. */
function withCodeSpans(text: string): ReactNode[] {
  return text.split("`").map((segment, index) =>
    index % 2 === 1 ? <code key={index} className="font-mono">{segment}</code> : segment);
}

/**
 * One linked machine: its name (editable — this is the name every surface
 * shows, from the agent's executor row to a bind card), its platform, its
 * liveness, its Sandbox switch, and the workspaces bound to it.
 *
 * The switch is the owner's one decision about what a command may reach on
 * this machine, and it is owner-only: the server answers 403 to anyone else.
 * On by default. Turning it off asks first, because off means the agent runs
 * as the owner. A machine that cannot sandbox is never quietly run unconfined
 * — with the switch on it runs no commands, and the row says so with the fix.
 *
 * Exported for the gallery, which photographs the three modes side by side.
 */
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
      <p className="mt-1.5 p-meta p-text-3" data-sandbox-mode={mode}>
        {SANDBOX_MODE_COPY[mode]}
        {/* The daemon's own line first, when it sent one. For a probe that
            failed in words nobody classified, that line is what the fix
            sentence tells the owner to act on. */}
        {cannotSandbox && sandbox.detail !== null && <> The daemon said: <code className="font-mono">{sandbox.detail}</code>.</>}
        {cannotSandbox && <> {withCodeSpans(sandboxReasonFix(sandbox.reason))}</>}
      </p>
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
      <div className="mt-1 flex flex-wrap items-center gap-1.5 p-meta p-text-3">
        {device.lastIp && <span>Last connected from <code className="font-mono">{device.lastIp}</code></span>}
        {device.replacedAt !== null && (
          <span className="p-danger">
            Another connection replaced this device on {new Date(device.replacedAt).toLocaleString()}.
            If that was not you, revoke it and run <code className="font-mono">kinu connect</code> again.
          </span>
        )}
      </div>
    </div>
  );
}

/** A command to run elsewhere, in the block the connect panel hands its
 *  command over in: the well, the selectable text, and the copy action. */
function CommandCopy({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md p-fill border p-border p-3">
      <code className="font-mono p-meta p-text flex-1 break-all select-all leading-relaxed">{command}</code>
      <CopyButton value={command} what="the install command" size={13} className="p-text-3 hover:p-text shrink-0" />
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
    <Field label="Workers AI account" hint="Changing this account clears the AI Gateway selection.">
      <select
        value={status.selectedId ?? ''}
        onChange={(e) => choose(e.target.value)}
        disabled={saving}
        className={`${inputCls} sm:max-w-sm`}
      >
        {status.selectedId === null && <option value="">(no account selected)</option>}
        {status.accounts.map((account) => (
          <option key={account.id} value={account.id}>{account.name}</option>
        ))}
      </select>
      {error && <p className="text-xs p-danger">{error}</p>}
    </Field>
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
        message={`Could not list your AI Gateways: ${status.error}`}
      />
    );
  }

  if (status.gateways.length === 0) {
    return (
      <p className="p-meta p-text-3">
        No AI Gateway found in this account. Create one under AI &gt; AI Gateway in Cloudflare to use
        provider keys or Unified Billing credits.
      </p>
    );
  }

  return (
    <Field label="AI Gateway"
      hint={<>Models matching <code className="p-code-inline">my-gateway/&lt;provider&gt;/&lt;model&gt;</code> use this gateway's provider keys or Unified Billing credits.</>}>
      {status.gateways.length === 1 && status.selectedId === status.gateways[0].id ? (
        <div className="flex items-center gap-2 text-xs">
          <CheckIcon size={13} className="p-success" />
          <span className="font-mono p-text">{status.selectedId}</span>
        </div>
      ) : (
        <select
          value={status.selectedId ?? ''}
          onChange={(e) => choose(e.target.value)}
          disabled={saving}
          className={`${inputCls} sm:max-w-sm`}
        >
          <option value="">(no gateway selected)</option>
          {status.gateways.map((gw) => (
            <option key={gw.id} value={gw.id}>{gw.id}</option>
          ))}
        </select>
      )}
      {error && <p className="text-xs p-danger">{error}</p>}
    </Field>
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
    if (!confirm('Disconnect ChatGPT? Your agents will lose access to Codex models.')) return;

    try { await disconnectCodex(); onChanged(); } catch (e) { setError(renderThrownChain({ cause: e })); }
  }, [onChanged]);

  if (status?.connected) {
    return (
      <Field inline label={<ConnectedBadge detail={status.accountId ? <>account {status.accountId.slice(0, 8)}…</> : undefined} />}>
        <button onClick={disconnect} className={dangerQuietCls}>Disconnect</button>
      </Field>
    );
  }

  if (flow && polling) {
    return (
      <Field label={<>Open <a href={flow.portalURL} target="_blank" rel="noopener noreferrer" className="p-accent underline underline-offset-2">{flow.portalURL}</a> and enter this code</>}>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-md border p-border p-fill px-4 py-2 font-mono text-2xl tracking-widest p-text select-all">{flow.userCode}</code>
          <CopyButton value={flow.userCode} what="the device code" size={14}
            className="p-btn-quiet inline-flex size-8 items-center justify-center" />
          <a
            href={flow.portalURL}
            target="_blank" rel="noopener noreferrer"
            className="p-btn-quiet inline-flex size-8 items-center justify-center"
            title="Open portal"
          ><ArrowSquareOutIcon size={14} /></a>
        </div>
        <p className="p-meta p-text-3 flex items-center gap-2"><Loader size="sm" /> Waiting for you to authorize…</p>
        {error && <p className="text-xs p-danger">{error}</p>}
      </Field>
    );
  }

  return (
    <div className="space-y-2">
      <Field inline label="Not connected"
        hint="Authorize once. Every agent can then use your ChatGPT subscription and its Codex models.">
        <FilledButton onClick={start}>Connect ChatGPT</FilledButton>
      </Field>
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

  const compatKeys = creds.filter((c) => c.key.startsWith('openai-compat.'));

  return (
    <div className="space-y-5">
      {/* Stored keys */}
      {storedKeys.length > 0 && (
        <div className="p-group">
          {storedKeys.map(({ key, provider }) => (
            <div key={key} className="flex items-center gap-2 px-4 py-2.5 text-xs">
              <CheckIcon size={13} className="p-success shrink-0" />
              <span className="p-row-text font-medium p-text">{provider?.name ?? key}</span>
              {provider?.doc && (
                <a href={provider.doc} target="_blank" rel="noopener noreferrer" className="p-text-3 hover:p-accent" title="Provider docs">
                  <ArrowSquareOutIcon size={12} />
                </a>
              )}
              <span className="p-annotation p-text-3 truncate">{key}</span>
              <button onClick={() => remove(key, provider?.name ?? key)} className={`${dangerQuietCls} ml-auto`}>
                <TrashIcon size={11} /> Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Connect any catalog provider */}
      <Field label="Connect a provider"
        hint={`Paste an API key for any of ${catalog.length} providers. Every agent you own can use it.`}>
        <Combobox
          items={catalog}
          value={selected}
          onValueChange={<Next,>(next: Next) => setSelected(providerCatalogEntry(next))}
          itemToStringLabel={<Item,>(item: Item) => providerCatalogEntry(item)?.name ?? ''}
          itemToStringValue={<Item,>(item: Item) => providerCatalogEntry(item)?.id ?? ''}
        >
          <Combobox.TriggerInput placeholder="Search providers (Groq, DeepSeek, Fireworks, …)" />
          <Combobox.Content>
            <Combobox.Empty>No match. Add an OpenAI-compatible endpoint below.</Combobox.Empty>
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
              {selected.envVar && <>Environment variable: <code className="p-code-inline">{selected.envVar}</code>. </>}
              {selected.doc && (
                <a href={selected.doc} target="_blank" rel="noopener noreferrer" className="p-accent underline underline-offset-2">
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
                className="p-btn-quiet inline-flex h-9 shrink-0 items-center px-3 text-xs"
              >{savingKey === selected.credKey ? '...' : (selected.connected ? 'Replace' : 'Save')}</button>
            </div>
          </div>
        )}
      </Field>

      {/* OpenAI-compat slot */}
      <Field label="OpenAI-compatible (Groq, Together, …)"
        hint={<>Each endpoint stores a base URL and API key. Use model spec <code className="p-code-inline">openai-compat:&lt;name&gt;/&lt;modelId&gt;</code>.</>}>
        <div className="grid gap-2 sm:grid-cols-[1fr_1.6fr_1fr]">
          <input
            value={compatName}
            onChange={(e) => setCompatName(e.target.value)}
            placeholder="name (e.g. groq)"
            aria-label="Endpoint name"
            className={inputCls}
          />
          <input
            value={compatBaseURL}
            onChange={(e) => setCompatBaseURL(e.target.value)}
            placeholder="https://api.example.com/v1"
            aria-label="Base URL"
            className={inputCls}
          />
          <input
            type="password"
            value={compatApiKey}
            onChange={(e) => setCompatApiKey(e.target.value)}
            placeholder="api key"
            aria-label="API key"
            className={inputCls}
          />
        </div>
        <button
          onClick={saveCompat}
          disabled={savingKey !== null || !compatName.trim() || !compatBaseURL.trim() || !compatApiKey.trim()}
          className="p-btn-quiet inline-flex h-6.5 items-center px-2.5 text-xs"
        >Add endpoint</button>
        {compatKeys.length > 0 && (
          <div className="p-group">
            {compatKeys.map((c) => (
              <div key={c.key} className="flex items-center gap-2 px-4 py-2.5 text-xs">
                <span className="p-annotation p-text">{c.key}</span>
                <button onClick={() => remove(c.key, c.key)} className={`${dangerQuietCls} ml-auto`}>
                  <TrashIcon size={11} /> Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </Field>
    </div>
  );
}
