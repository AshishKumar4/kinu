/**
 * Providers panel (Cloudflare AI, ChatGPT/Codex, BYO keys), also mounted as a modal.
 * Each read is its own resource and fails visibly: a swallowed rejection shows a connected account as disconnected.
 */
import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { Combobox, Loader } from "@cloudflare/kumo";
import {
  KeyIcon, CheckIcon, CloudIcon, OpenAiLogoIcon, ArrowSquareOutIcon, TrashIcon,
} from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  listCredentials, setCredential, deleteCredential,
  codexStatus, startCodexFlow, pollCodexFlow, disconnectCodex,
  listAvailableModels, listProviderCatalog,
  listCloudflareGateways, selectCloudflareGateway,
  listCloudflareAccounts, selectCloudflareAccount,
  type CredentialSummary, type CodexStatus,
  type ProviderCatalogEntry, type DeviceFlowStart,
  type CloudflareGatewayStatus, type CloudflareAccountStatus,
} from "@/lib/user-api";
import { Card, Choice, Field, inputCls } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { CopyButton } from "@/components/ui/CopyButton";
import { FilledButton } from "@/components/ui/FilledButton";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { renderThrownChain } from '@kinu.run/core/obs';

function ConnectedBadge({ detail }: { detail?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="p-badge-success inline-flex items-center gap-1 px-2 py-0.5"><CheckIcon size={11} /> Connected</span>
      {detail && <span className="p-meta p-text-3">{detail}</span>}
    </div>
  );
}

const dangerQuietCls = "p-btn-quiet inline-flex h-6.5 shrink-0 items-center gap-1 px-2 text-xs p-danger";

export function ProvidersPanel({ returnTo }: { returnTo: string }) {
  const creds = useAsyncResource(listCredentials);
  const codex = useAsyncResource(codexStatus);
  const models = useAsyncResource(listAvailableModels);
  const catalog = useAsyncResource(listProviderCatalog);
  const gateways = useAsyncResource(listCloudflareGateways);
  const accounts = useAsyncResource(listCloudflareAccounts);

  const reads = [creds, codex, models, catalog, gateways, accounts];
  // Retry re-reads the whole account: mutators invalidate more than their own row.
  const reloadAll = () => { for (const read of reads) read.reload(); };

  return (
    <>
      <Card title="Cloudflare AI" icon={CloudIcon}>
        <CardSlot resource={models.resource} what="your connected models" onRetry={reloadAll}>
          {(menu) => menu.models.some((model) => model.provider === 'workers-ai') ? (
            <div className="space-y-5">
              <ConnectedBadge />
              {/* Asked first: the account decides which gateway is reachable. */}
              <CardSlot resource={accounts.resource} what="your Cloudflare accounts" onRetry={reloadAll}>
                {(status) => <CloudflareAccountSection status={status} onChanged={reloadAll} />}
              </CardSlot>
              <CardSlot resource={gateways.resource} what="your AI gateways" onRetry={reloadAll}>
                {(status) => <CloudflareGatewaySection status={status} returnTo={returnTo} onChanged={reloadAll} />}
              </CardSlot>
            </div>
          ) : (
            <CloudflareAIConnectNotice
              returnTo={returnTo}
              message="Connect Cloudflare to use your Workers AI quota and AI Gateway."
            />
          )}
        </CardSlot>
      </Card>

      <Card title="ChatGPT (Codex)" icon={OpenAiLogoIcon}>
        <CardSlot resource={codex.resource} what="your ChatGPT connection" onRetry={reloadAll}>
          {(status) => <CodexConnect status={status} onChanged={reloadAll} />}
        </CardSlot>
      </Card>

      <Card title="API keys" icon={KeyIcon}>
        <CardSlot resource={creds.resource} what="your API keys" onRetry={reloadAll}>
          {(credentials) => (
            <CardSlot resource={catalog.resource} what="the provider catalog" onRetry={reloadAll}>
              {(providers) => <ApiKeyManager creds={credentials} catalog={providers} onChanged={reloadAll} />}
            </CardSlot>
          )}
        </CardSlot>
      </Card>
    </>
  );
}

/** Rendered only with multiple accounts. Picking one clears the gateway server-side, so the caller reloads. */
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
    <Field label="Workers AI account">
      <Choice label="Workers AI account"
        className="sm:max-w-sm"
        value={status.selectedId ?? ''}
        disabled={saving}
        options={[
          ...(status.selectedId === null ? [{ value: '', label: '(no account selected)' }] : []),
          ...status.accounts.map((account) => ({ value: account.id, label: account.name })),
        ]}
        onChange={choose} />
      {error && <p className="text-xs p-danger">{error}</p>}
    </Field>
  );
}

function CloudflareGatewaySection({ status, returnTo, onChanged }: {
  status: CloudflareGatewayStatus | null;
  returnTo: string;
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
        returnTo={returnTo}
        message={`Could not list your AI Gateways: ${status.error}`}
      />
    );
  }

  if (status.gateways.length === 0) {
    return (
      <span className="p-meta p-text-3">No AI Gateway</span>
    );
  }

  return (
    <Field label="AI Gateway">
      {status.gateways.length === 1 && status.selectedId === status.gateways[0].id ? (
        <div className="flex items-center gap-2 text-xs">
          <CheckIcon size={13} className="p-success" />
          <span className="font-mono p-text">{status.selectedId}</span>
        </div>
      ) : (
        <Choice label="AI Gateway"
          className="sm:max-w-sm"
          value={status.selectedId ?? ''}
          disabled={saving}
          options={[{ value: '', label: '(no gateway selected)' }, ...status.gateways.map((gw) => ({ value: gw.id, label: gw.id }))]}
          onChange={choose} />
      )}
      {error && <p className="text-xs p-danger">{error}</p>}
    </Field>
  );
}

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
            // A reported error (expired/denied/no flow) is terminal; pending returns { connected: false }.
            stopPolling();
            setFlow(null);
            setError(result.error);
          } else {
            setError(null);
          }
        } catch (e) {
          // The poll request itself failed: show it but keep polling.
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
      <Field inline label="Not connected">
        <FilledButton onClick={start}>Connect ChatGPT</FilledButton>
      </Field>
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

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
  const saveWord = selected?.connected === true ? 'Replace' : 'Save';

  return (
    <div className="space-y-5">
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

      <Field label="Connect a provider">
        <Combobox
          items={catalog}
          value={selected}
          onValueChange={(next: ProviderCatalogEntry | null) => setSelected(next)}
          itemToStringLabel={(item: ProviderCatalogEntry) => item.name}
          itemToStringValue={(item: ProviderCatalogEntry) => item.id}
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
              >{savingKey === selected.credKey ? '...' : saveWord}</button>
            </div>
          </div>
        )}
      </Field>

      <Field label="OpenAI-compatible (Groq, Together, …)">
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
