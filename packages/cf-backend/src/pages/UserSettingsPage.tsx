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
import { useEffect, useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import { Combobox, Loader } from "@cloudflare/kumo";
import {
  PlugIcon, KeyIcon, GearSixIcon, CheckIcon, CopyIcon,
  UserCircleIcon, ArrowSquareOutIcon, TrashIcon, ArrowLeftIcon,
  DesktopTowerIcon, WarningIcon,
} from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { ModelPicker } from "@/components/ModelPicker";
import {
  getProfile, listCredentials, setCredential, deleteCredential,
  codexStatus, startCodexFlow, pollCodexFlow, disconnectCodex,
  listAvailableModels, listProviderCatalog, getConfig, setConfig, getCliSetup,
  listCloudflareGateways, selectCloudflareGateway,
  listDevices, registerDevice, revokeDevice,
  type UserProfile, type CredentialSummary, type CodexStatus,
  type ModelMenuEntry, type ProviderCatalogEntry, type DeviceFlowStart, type CliSetup,
  type CloudflareGatewayStatus, type UserDevice,
} from "../lib/user-api";
import { Card, inputCls } from "@/components/ui/form";

export default function UserSettingsPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [models, setModels] = useState<ModelMenuEntry[]>([]);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [gateways, setGateways] = useState<CloudflareGatewayStatus | null>(null);
  const [defaults, setDefaults] = useState<{ model: string | null }>({ model: null });
  const [cliSetup, setCliSetup] = useState<CliSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setErr(null);
      const [p, c, k, m, cat, defaultModel, cli, gw] = await Promise.all([
        getProfile().catch(() => null),
        listCredentials().catch(() => []),
        codexStatus().catch(() => null),
        listAvailableModels().catch(() => []),
        listProviderCatalog().catch(() => []),
        getConfig('default_model').catch(() => ({ key: 'default_model', value: null })),
        getCliSetup().catch(() => null),
        listCloudflareGateways().catch(() => null),
      ]);
      setProfile(p);
      setCreds(c ?? []);
      setCodex(k);
      setModels(m ?? []);
      setCatalog(cat ?? []);
      setDefaults({ model: defaultModel?.value ?? null });
      setCliSetup(cli);
      setGateways(gw);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;
  }
  const workersAIConnected = models.some((model) => model.provider === 'workers-ai');

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header>
          <Link to="/" className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
            <ArrowLeftIcon size={12} /> Back
          </Link>
          <h1 className="text-2xl font-semibold">Account settings</h1>
          <p className="text-xs p-text-3 mt-1">
            Account-level: credentials apply to every agent you own.
          </p>
        </header>

        {err && <div className="p-card rounded-lg p-3 text-xs p-danger">{err}</div>}

        {/* Profile */}
        <Card title="Profile" icon={UserCircleIcon}>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-1">
              <div className="p-text-3">Email</div>
              <div className="font-mono">{profile?.email ?? '—'}</div>
            </div>
            <div className="space-y-1">
              <div className="p-text-3">Member since</div>
              <div>{profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—'}</div>
            </div>
          </div>
        </Card>

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
          {workersAIConnected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs p-success">
                <CheckIcon size={13} /> Connected
              </div>
              <CloudflareGatewaySection status={gateways} onChanged={refresh} />
            </div>
          ) : (
            <CloudflareAIConnectNotice
              returnTo="/user/settings"
              message="Connect Cloudflare so your workspaces can use your Workers AI quota and your own AI Gateway."
            />
          )}
        </Card>

        {/* Codex */}
        <Card title="ChatGPT (Codex)" icon={PlugIcon}>
          <CodexConnect status={codex} onChanged={refresh} />
        </Card>

        {/* BYO API keys */}
        <Card title="API keys" icon={KeyIcon}>
          <ApiKeyManager creds={creds} catalog={catalog} onChanged={refresh} />
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
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md p-card hover:p-card-hover"
            >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
          </div>
        </Card>

        {/* Defaults */}
        <Card title="Defaults" icon={GearSixIcon}>
          <div className="space-y-2">
            <div className="text-xs p-text-2">Default model for new workspaces</div>
            <ModelPicker
              models={models}
              value={defaults.model ?? ''}
              onChange={async (spec) => {
                setDefaults({ model: spec });
                try { await setConfig('default_model', spec); } catch (err) { alert((err as Error).message); }
              }}
              clearable
              placeholder="(use system default)"
            />
            <p className="text-[11px] p-text-3">
              New workspaces pick this up at creation. Existing workspaces keep their own choice (change per-workspace under "Workspace settings").
            </p>
          </div>
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
function DevicesCard() {
  const [devices, setDevices] = useState<UserDevice[] | null>(null);
  const [install, setInstall] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const refreshDevices = useCallback(() => {
    listDevices().then(setDevices).catch(() => setDevices([]));
  }, []);
  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 5000); // running daemon flips connected within seconds
    return () => clearInterval(t);
  }, [refreshDevices]);

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
    catch (e) { setErr(`Could not register device: ${(e as Error).message}`); }
    finally { setIssuing(false); }
  }, [refreshDevices]);

  const revoke = useCallback(async (id: string, label: string) => {
    if (!confirm(`Revoke "${label}"? Agents lose access to this device immediately.`)) return;
    setErr(null);
    try { await revokeDevice(id); }
    catch (e) { setErr(`Could not revoke device: ${(e as Error).message}`); }
    refreshDevices();
  }, [refreshDevices]);

  return (
    <div ref={anchorRef} id="devices">
      <Card title="Devices" icon={DesktopTowerIcon}>
        <p className="text-xs p-text-2">
          Link a laptop or PC to your account — once connected, every one of your agents can use it
          (with your consent). The daemon opens one outbound WebSocket; no inbound ports, runs as
          your user, never root.
        </p>

        {devices && devices.length > 0 && (
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-3 py-2 border-b p-border last:border-0">
                <span className={`size-1.5 rounded-full shrink-0 ${d.connected ? "p-dot-success" : "p-dot-neutral"}`} />
                <span className="font-medium p-text">{d.label}</span>
                {d.hostname && <span className="p-text-3 font-mono">{d.hostname}{d.os ? ` · ${d.os}` : ""}</span>}
                <span className="p-text-3 ml-auto">{d.connected ? "connected" : "offline"}</span>
                <button onClick={() => revoke(d.id, d.label)} title="Revoke device" className="p-text-3 hover:p-danger"><TrashIcon size={13} /></button>
              </div>
            ))}
          </div>
        )}
        {devices && devices.length > 0 && !devices.some((d) => d.connected) && (
          <p className="text-[11px] p-text-3">
            Offline device? Restart the daemon on that machine with <code className="font-mono p-elevated px-1 rounded">proteus connect</code>.
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
            <div className="rounded-md p-elevated border p-border p-3 font-mono text-[11px] p-text break-all select-all leading-relaxed">
              {install}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={() => { navigator.clipboard.writeText(install).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}
                className="px-2 py-1 rounded p-card hover:p-card-hover flex items-center gap-1 p-text-2"
              ><CopyIcon size={11} />{copied ? "copied" : "Copy"}</button>
              <button onClick={() => setInstall(null)} className="p-text-3 hover:p-text">Done</button>
            </div>
            <p className="text-[11px] p-text-3 mt-1 flex items-center gap-1.5">
              <WarningIcon size={11} /> Device secrets are written locally by <code className="font-mono">proteus connect</code>; they are not shown in this command.
            </p>
          </div>
        )}

        <p className="text-[11px] p-text-3">
          Each workspace's file-access tier on a device (consented folder vs full filesystem) is set
          in that workspace's settings.
        </p>
      </Card>
    </div>
  );
}

function CommandCopy({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border p-border p-2">
      <div className="w-14 shrink-0 text-[11px] p-text-3">{label}</div>
      <code className="font-mono text-[11px] p-text flex-1 truncate">{command}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          });
        }}
        className="px-2 py-1 rounded p-card hover:p-card-hover flex items-center gap-1 text-xs p-text-2"
      >
        <CopyIcon size={11} />{copied ? "copied" : "Copy"}
      </button>
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
    catch (e) { setError((e as Error).message); }
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
      <p className="text-[11px] p-text-3">
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
          <option value="">(none — pick a gateway)</option>
          {status.gateways.map((gw) => (
            <option key={gw.id} value={gw.id}>{gw.id}</option>
          ))}
        </select>
      )}
      <p className="text-[11px] p-text-3">
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
          setError((e as Error).message);
        }
      }, Math.max(3, f.pollIntervalSec) * 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onChanged]);

  const disconnect = useCallback(async () => {
    if (!confirm('Disconnect ChatGPT? All your agents will lose access to Codex models.')) return;
    try { await disconnectCodex(); onChanged(); } catch (e) { setError((e as Error).message); }
  }, [onChanged]);

  if (status?.connected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <CheckIcon size={14} className="p-success" />
          <span>Connected{status.accountId ? <span className="p-text-3"> · account {status.accountId.slice(0, 8)}…</span> : null}</span>
        </div>
        <button onClick={disconnect}
          className="text-xs px-3 py-1.5 rounded-md p-card hover:p-card-hover transition-colors">
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
          <code className="text-2xl font-mono tracking-widest p-card rounded-lg px-4 py-2 select-all">{flow.userCode}</code>
          <button
            onClick={() => navigator.clipboard.writeText(flow.userCode)}
            className="p-2 rounded-md p-card hover:p-card-hover"
            title="Copy"
          ><CopyIcon size={14} /></button>
          <a
            href={flow.portalURL}
            target="_blank" rel="noopener noreferrer"
            className="p-2 rounded-md p-card hover:p-card-hover"
            title="Open portal"
          ><ArrowSquareOutIcon size={14} /></a>
        </div>
        <p className="text-[11px] p-text-3 flex items-center gap-2"><Loader size="sm" /> Waiting for you to authorize…</p>
        {error && <p className="text-xs p-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs p-text-2">
        Use your ChatGPT subscription as Proteus's chat backend.
        Authorize a device once — every agent you create can pick a Codex model afterward.
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
    try { await deleteCredential(key); onChanged(); } catch (e) { alert((e as Error).message); }
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
      alert((e as Error).message);
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
      alert((e as Error).message);
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
            <div key={key} className="flex items-center gap-2 text-xs px-2 py-1.5 p-card rounded">
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
        <p className="text-[11px] p-text-3">
          Paste an API key for any of the {catalog.length} supported providers — every agent you own can use its models.
        </p>
        <Combobox
          items={catalog}
          value={selected}
          onValueChange={(next: unknown) => setSelected(next as ProviderCatalogEntry | null)}
          itemToStringLabel={(p: unknown) => (p as ProviderCatalogEntry).name}
          itemToStringValue={(p: unknown) => (p as ProviderCatalogEntry).id}
        >
          <Combobox.TriggerInput placeholder="Search providers (Groq, DeepSeek, Fireworks, …)" />
          <Combobox.Content>
            <Combobox.Empty>No matching provider — add it below as an OpenAI-compatible endpoint.</Combobox.Empty>
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
            <p className="text-[11px] p-text-3">
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
                placeholder={selected.connected ? '••••••• (stored — paste to replace)' : `${selected.name} API key`}
                className={inputCls}
              />
              <button
                onClick={saveSelected}
                disabled={savingKey !== null || !apiKey.trim()}
                className="px-3 py-1.5 rounded-md p-card hover:p-card-hover disabled:opacity-50 text-xs shrink-0"
              >{savingKey === selected.credKey ? '...' : (selected.connected ? 'Replace' : 'Save')}</button>
            </div>
          </div>
        )}
      </div>

      {/* OpenAI-compat slot */}
      <div className="pt-3 border-t p-border space-y-2">
        <div className="text-xs font-medium">OpenAI-compatible (Groq, Together, …)</div>
        <p className="text-[11px] p-text-3">Each named entry stores baseURL + apiKey. Use model spec <code className="p-card px-1">openai-compat:&lt;name&gt;/&lt;modelId&gt;</code>.</p>
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
          className="px-3 py-1.5 rounded-md p-card hover:p-card-hover disabled:opacity-50 text-xs"
        >Add endpoint</button>

        {/* List existing openai-compat */}
        {creds.filter((c) => c.key.startsWith('openai-compat.')).map((c) => (
          <div key={c.key} className="flex items-center justify-between text-xs px-2 py-1.5 p-card rounded">
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
