/**
 * Providers panel: one list of every provider, each with its own sign-in (Cloudflare, device code, claude.ai, API key); also mounted as a modal.
 * Each read is its own resource and fails visibly: a swallowed rejection shows a connected account as disconnected.
 */
import { Effect } from 'effect';
import { useState, type ReactNode } from "react";
import { Combobox } from "@cloudflare/kumo";
import { CheckIcon, PlugIcon } from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  listCredentials, setCredential, deleteCredential,
  codexStatus, disconnectCodex, startClaudeSignIn, finishClaudeSignIn,
  chatgptPlan, signOutChatGpt,
  listAvailableModels, listProviderCatalog, getProfileCatalog, updateProfileCatalog,
  listCloudflareGateways, selectCloudflareGateway,
  listCloudflareAccounts, selectCloudflareAccount,
  listUnrevokedGrants, dismissUnrevokedGrant, type UnrevokedGrant,
  type CredentialSummary,
  type ProviderCatalogEntry,
  type CloudflareGatewayStatus, type CloudflareAccountStatus,
} from "@/lib/user-api";
import type { ProfileCatalogEnvelope } from '@kinu.run/core';
import { Card, Choice, Field, inputCls } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { FilledButton } from "@/components/ui/FilledButton";
import { BrandMark, providerBrand } from "@/components/ui/BrandMark";
import { ChatGptConnect, ChatGptPlanUsage, ChatGptWelcome } from "@/components/account/ChatGptConnect";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { showing, detach } from '@kinu.run/core/obs';
import {
  CLAUDE_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY, CODEX_CRED_KEY, MAIN_ACCOUNT, accountCredentialKey, accountOf, baseCredentialKey, catalogProviderOfKey, isAccountName, storedAccounts,
} from '@kinu.run/core';

function ConnectedBadge({ detail }: { detail?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="p-badge-success inline-flex items-center gap-1 px-2 py-0.5"><CheckIcon size={11} /> Connected</span>
      {detail && <span className="p-meta p-text-3">{detail}</span>}
    </div>
  );
}

const dangerQuietCls = "p-btn-quiet inline-flex h-6.5 shrink-0 items-center gap-1 px-2 text-xs p-danger";

const GRANT_PROVIDER = new Map([[CODEX_CRED_KEY, 'ChatGPT'], [CLOUDFLARE_OAUTH_CRED_KEY, 'Cloudflare']]);

/** A disconnect the provider would not revoke: the login is gone from Kinu but may still work there. */
function UnrevokedGrants({ grants, onChanged }: { grants: readonly UnrevokedGrant[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);

  if (grants.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md px-3 py-2 text-xs p-notice-warning">
      {grants.map((grant) => (
        <div key={grant.key} className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div>{GRANT_PROVIDER.get(grant.key) ?? grant.key} did not confirm it revoked the login you disconnected. Revoke Kinu&apos;s access in that account&apos;s settings.</div>
            <div className="p-meta">{grant.reasons.join(' · ')}</div>
          </div>
          <button
            className="p-btn-quiet inline-flex h-6.5 shrink-0 items-center px-2 text-xs"
            onClick={() => detach(Effect.catchCause(Effect.gen(function* () { yield* Effect.promise(async () => dismissUnrevokedGrant(grant.key)); onChanged(); }), showing(setError)))}
          >
            I revoked it
          </button>
        </div>
      ))}
      {error && <div className="p-notice-danger rounded-md px-2 py-1">{error}</div>}
    </div>
  );
}

export function ProvidersPanel({ returnTo }: { returnTo: string }) {
  const creds = useAsyncResource(listCredentials);
  const codex = useAsyncResource(codexStatus);
  const chatgpt = useAsyncResource(chatgptPlan);
  const models = useAsyncResource(listAvailableModels);
  const catalog = useAsyncResource(listProviderCatalog);
  const gateways = useAsyncResource(listCloudflareGateways);
  const accounts = useAsyncResource(listCloudflareAccounts);
  const unrevoked = useAsyncResource(listUnrevokedGrants);

  const [chatgptWelcome, setChatgptWelcome] = useState(false);

  const reads = [creds, codex, chatgpt, models, catalog, gateways, accounts, unrevoked];
  // Retry re-reads the whole account: mutators invalidate more than their own row.
  const reloadAll = () => { for (const read of reads) read.reload(); };

  return (
    <>
      <CardSlot resource={unrevoked.resource} what="your disconnected logins" onRetry={reloadAll}>
        {(grants) => <UnrevokedGrants grants={grants} onChanged={reloadAll} />}
      </CardSlot>
      {chatgptWelcome && <ChatGptWelcome onClose={() => setChatgptWelcome(false)} />}
      <Card title="Connect a provider" icon={PlugIcon}>
        <CardSlot resource={creds.resource} what="your API keys" onRetry={reloadAll}>
          {(credentials) => {
            const held = new Set(credentials.map((c) => c.key));
            const forget = (key: string) => async () => { await deleteCredential(key); };

            return (
              <div className="space-y-5">
                <div className="p-group">
                  {models.resource.status === "error" && (
                    <CardSlot resource={models.resource} what="your connected models" onRetry={models.reload}>{() => null}</CardSlot>
                  )}
                  <ProviderEntry provider="workers-ai" name="Cloudflare AI" method="Cloudflare sign-in"
                    connected={held.has(CLOUDFLARE_OAUTH_CRED_KEY) || (lastValue(models.resource)?.models.some((model) => model.provider === 'workers-ai') ?? false)}
                    disconnect={held.has(CLOUDFLARE_OAUTH_CRED_KEY) ? forget(CLOUDFLARE_OAUTH_CRED_KEY) : undefined}
                    onChanged={reloadAll}
                    connect={<CloudflareAIConnectNotice returnTo={returnTo} message="Connect Cloudflare to use your Workers AI quota and AI Gateway." />}>
                    {/* Asked first: the account decides which gateway is reachable. */}
                    <CardSlot resource={accounts.resource} what="your Cloudflare accounts" onRetry={reloadAll}>
                      {(status) => <CloudflareAccountSection status={status} onChanged={reloadAll} />}
                    </CardSlot>
                    <CardSlot resource={gateways.resource} what="your AI gateways" onRetry={reloadAll}>
                      {(status) => <CloudflareGatewaySection status={status} returnTo={returnTo} onChanged={reloadAll} />}
                    </CardSlot>
                  </ProviderEntry>
                  <CardSlot resource={codex.resource} what="your ChatGPT connection" onRetry={reloadAll}>
                    {(status) => (
                      <CardSlot resource={chatgpt.resource} what="your ChatGPT plan" onRetry={reloadAll}>
                        {(plan) => {
                          // Signed in through a machine or pasted back here; a stored Codex credential predates both.
                          const planSignedIn = plan.status?.signedIn === true || plan.account !== null;
                          const planEmail = plan.account?.email ?? plan.status?.email ?? 'signed in';
                          const codexAccount = status.accountId === null ? undefined : <>account {status.accountId.slice(0, 8)}…</>;

                          return (
                            <ProviderEntry provider="chatgpt" name="ChatGPT"
                              method="Sign in with ChatGPT"
                              connected={status.connected || planSignedIn}
                              detail={planSignedIn ? <>{planEmail}{plan.account === null && plan.device !== null ? <> on {plan.device.label}</> : null}</> : codexAccount}
                              disconnect={async () => {
                                if (!planSignedIn) {
                                  await disconnectCodex();

                                  return;
                                }

                                const { unconfirmed } = await signOutChatGpt();

                                if (unconfirmed !== null) alert(`OpenAI did not confirm it revoked the sign-in (${unconfirmed}). Disconnect Kinu under Apps in ChatGPT settings to be sure.`);
                              }}
                              onChanged={reloadAll}
                              connect={<ChatGptConnect plan={plan} onSignedIn={(first) => { reloadAll(); setChatgptWelcome(first); }} />}>
                              {planSignedIn && <ChatGptPlanUsage />}
                            </ProviderEntry>
                          );
                        }}
                      </CardSlot>
                    )}
                  </CardSlot>
                  <ProviderEntry provider="claude" name="Claude" method="claude.ai sign-in"
                    connected={held.has(CLAUDE_CRED_KEY)}
                    disconnect={forget(CLAUDE_CRED_KEY)}
                    onChanged={reloadAll}
                    connect={<ClaudeConnect onChanged={reloadAll} />} />
                  <CardSlot resource={catalog.resource} what="the provider catalog" onRetry={reloadAll}>
                    {(providers) => storedEntries(credentials, providers).map((entry) => (
                      <ProviderEntry key={entry.key} provider={entry.provider} name={entry.name} method={entry.method}
                        detail={<span className="p-annotation">{entry.key}</span>}
                        connected
                        disconnect={async () => { await deleteCredential(entry.key); await forgetDefaultAccount(entry.key); }}
                        onChanged={reloadAll} />
                    ))}
                  </CardSlot>
                </div>
                <CardSlot resource={catalog.resource} what="the provider catalog" onRetry={reloadAll}>
                  {(providers) => (
                    <>
                      <ApiKeyConnect creds={credentials} catalog={providers} onChanged={reloadAll} />
                      <DefaultAccounts keys={credentials.map((c) => c.key)} catalog={providers} />
                    </>
                  )}
                </CardSlot>
              </div>
            );
          }}
        </CardSlot>
      </Card>
    </>
  );
}

const SUBSCRIPTION_NAMES = new Map([[CODEX_CRED_KEY, 'ChatGPT (Codex)'], [CLAUDE_CRED_KEY, 'Claude']]);

/** Every stored key the fixed entries above do not show: API keys, endpoints, and named subscription accounts. */
function storedEntries(creds: readonly CredentialSummary[], catalog: readonly ProviderCatalogEntry[]) {
  const byCredKey = new Map(catalog.map((p) => [p.credKey, p]));

  return creds.flatMap(({ key }) => {
    const account = accountOf(key);
    const suffix = account === MAIN_ACCOUNT ? '' : ` · ${account}`;
    const subscription = SUBSCRIPTION_NAMES.get(baseCredentialKey(key));

    if (subscription !== undefined) {
      return account === MAIN_ACCOUNT ? [] : [{ key, provider: key.split('.')[0] ?? '', name: `${subscription}${suffix}`, method: 'Subscription sign-in' }];
    }

    if (key.startsWith('openai-compat.')) return [{ key, provider: 'openai', name: key.slice('openai-compat.'.length), method: 'OpenAI-compatible' }];
    const provider = catalogProviderOfKey(key);

    if (provider === null) return [];

    return [{ key, provider, name: `${byCredKey.get(baseCredentialKey(key))?.name ?? key}${suffix}`, method: 'API key' }];
  });
}

/**
 * One provider in the list: its sign-in method, whether it is connected, and the way in or out. What
 * connecting takes differs per method, so each passes its own `connect`; status and disconnect are this.
 */
function ProviderEntry({ provider, name, method, connected, detail, disconnect, onChanged, connect, children }: {
  provider: string;
  name: string;
  method: string;
  connected: boolean;
  detail?: ReactNode;
  disconnect?: () => Promise<void>;
  onChanged: () => void;
  connect?: ReactNode;
  /** Settings shown under a connected entry. */
  children?: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const brand = providerBrand(provider);

  const leave = () => Effect.gen(function* () {
    if (disconnect === undefined || !confirm(`Disconnect ${name}? Your agents lose its models.`)) return;
    setError(null);

    return yield* Effect.catchCause(Effect.gen(function* () { yield* Effect.promise(async () => disconnect()); onChanged(); }), showing(setError));
  });

  return (
    <div className="space-y-3 px-4 py-3" data-provider={name}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {brand !== undefined && <BrandMark brand={brand} size={13} bare />}
        <span className="p-row-text font-medium p-text">{name}</span>
        <span className="p-meta p-text-3">{method}</span>
        <span className="ml-auto flex items-center gap-2">
          {connected ? <ConnectedBadge detail={detail} /> : <span className="p-meta p-text-3">Not connected</span>}
          {connected && disconnect !== undefined && (
            <button type="button" onClick={() => detach(leave())} className={dangerQuietCls} aria-label={`Disconnect ${name}`}>Disconnect</button>
          )}
        </span>
      </div>
      {connected ? children : connect}
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
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

  const choose = (id: string) => Effect.gen(function* () {
    if (!id) return;
    setSaving(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () { yield* Effect.promise(async () => selectCloudflareAccount(id)); onChanged(); }), showing(setError)), Effect.sync(() => { setSaving(false); }));
  });

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
        onChange={(id) => detach(choose(id))} />
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

  const choose = (id: string) => Effect.gen(function* () {
    setSaving(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () { yield* Effect.promise(async () => selectCloudflareGateway(id || null)); onChanged(); }), showing(setError)), Effect.sync(() => { setSaving(false); }));
  });

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
          onChange={(id) => detach(choose(id))} />
      )}
      {error && <p className="text-xs p-danger">{error}</p>}
    </Field>
  );
}

/**
 * Claude's PKCE sign-in, as `kinu provider connect claude` runs it: Claude sends the browser to a local address
 * that does not open here, so the owner pastes the code Claude shows, or that address, back.
 */
function ClaudeConnect({ onChanged }: { onChanged: () => void }) {
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (step: Effect.Effect<void>) => Effect.suspend(() => {
    setBusy(true);
    setError(null);

    return Effect.ensuring(Effect.catchCause(step, showing(setError)), Effect.sync(() => setBusy(false)));
  });

  const start = () => run(Effect.gen(function* () {
    setAuthorizeUrl((yield* Effect.promise(() => startClaudeSignIn())).url);
    setCode('');
  }));

  const finish = () => run(Effect.gen(function* () {
    const result = yield* Effect.promise(() => finishClaudeSignIn(code.trim()));

    if (result.connected) onChanged();
    else setError(result.error ?? 'Claude did not connect.');
  }));

  return (
    <div className="space-y-3">
      <p className="rounded-md px-3 py-2 text-xs p-notice-warning">
        Signing in with a Claude subscription runs Kinu on your own Claude plan. Anthropic&apos;s terms limit subscription use to its own apps, so you connect at your own risk.
      </p>
      {authorizeUrl === null ? (
        <FilledButton onClick={() => detach(start())} disabled={busy}>Sign in with Claude</FilledButton>
      ) : (
        <Field label={<>Open <a href={authorizeUrl} target="_blank" rel="noopener noreferrer" className="p-accent underline underline-offset-2">claude.ai</a>, approve Kinu, and paste what Claude shows you</>}
          hint="The code Claude shows, or the address your browser ended on if the page did not load.">
          <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); detach(finish()); }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code or address"
              aria-label="Claude sign-in code"
              autoComplete="off"
              className={`${inputCls} min-w-0 flex-1`}
            />
            <button type="submit" disabled={busy || code.trim() === ''}
              className="p-btn-quiet inline-flex h-9 shrink-0 items-center px-3 text-xs">{busy ? '...' : 'Connect'}</button>
            <button type="button" onClick={(...args: Parameters<typeof start>) => detach(Effect.promise(async () => start(...args)))} disabled={busy}
              className="p-btn-quiet inline-flex h-9 shrink-0 items-center px-3 text-xs">Start again</button>
          </form>
        </Field>
      )}
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

const COMPAT_ENTRY: ProviderCatalogEntry = {
  id: 'openai-compat', name: 'OpenAI-compatible endpoint', credKey: 'openai-compat', connected: false,
};

/** API-key providers: the catalog from models.dev, and any OpenAI-compatible endpoint. */
function ApiKeyConnect({ creds, catalog, onChanged }: {
  creds: readonly CredentialSummary[];
  catalog: readonly ProviderCatalogEntry[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<ProviderCatalogEntry | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [accountName, setAccountName] = useState('');
  const [compatName, setCompatName] = useState('');
  const [compatBaseURL, setCompatBaseURL] = useState('');
  const [compatWindow, setCompatWindow] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const named = accountName.trim().toLowerCase();
  const compat = selected?.id === COMPAT_ENTRY.id;
  // Blank is unknown and leaves the field out; anything else must be a whole number of tokens.
  const contextWindow = compatWindow.trim() === '' ? undefined : Number(compatWindow.trim());
  const windowValid = contextWindow === undefined || (Number.isInteger(contextWindow) && contextWindow >= 1);

  const save = () => Effect.gen(function* () {
    if (!selected || !apiKey.trim()) return;
    setSaving(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      if (compat) {
        yield* Effect.promise(async () => setCredential(`openai-compat.${compatName.trim()}`, {
          kind: 'openai-compat', baseURL: compatBaseURL.trim(), apiKey: apiKey.trim(), ...(contextWindow !== undefined && { contextWindow }),
        }));
      } else {
        yield* Effect.promise(async () => setCredential(named === '' ? selected.credKey : accountCredentialKey(selected.credKey, named), { kind: 'bearer', token: apiKey.trim() }));
      }

      setSelected(null);
      setApiKey(''); setAccountName(''); setCompatName(''); setCompatBaseURL(''); setCompatWindow('');
      onChanged();
    }), showing(setError)), Effect.sync(() => {
      setSaving(false);
    }));
  });

  const target = selected === null || compat ? null : formKey(selected.credKey, named);
  const saveWord = creds.some((c) => c.key === target) ? 'Replace' : 'Save';
  const ready = apiKey.trim() !== '' && (!compat || (compatName.trim() !== '' && compatBaseURL.trim() !== '' && windowValid));

  return (
    <Field label="Add an API key">
      <Combobox
        items={[...catalog, COMPAT_ENTRY]}
        value={selected}
        onValueChange={(next: ProviderCatalogEntry | null) => setSelected(next)}
        itemToStringLabel={(item: ProviderCatalogEntry) => item.name}
        itemToStringValue={(item: ProviderCatalogEntry) => item.id}
      >
        <Combobox.TriggerInput placeholder="Search providers (Groq, DeepSeek, Fireworks, …)" />
        <Combobox.Content>
          <Combobox.Empty>No match. Pick OpenAI-compatible endpoint for any other.</Combobox.Empty>
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
        <form className="flex flex-wrap gap-2 [&>input]:h-9" onSubmit={(event) => {
          event.preventDefault();

          detach(save());
        }}>
          {compat ? (
            <>
              <input value={compatName} onChange={(e) => setCompatName(e.target.value)} placeholder="name (e.g. groq)"
                aria-label="Endpoint name" className={`${inputCls} max-w-44`} />
              <input value={compatBaseURL} onChange={(e) => setCompatBaseURL(e.target.value)} placeholder="https://api.example.com/v1"
                aria-label="Base URL" className={`${inputCls} min-w-0 flex-1`} />
              <span className="basis-full" aria-hidden />
              <input value={compatWindow} onChange={(e) => setCompatWindow(e.target.value)} inputMode="numeric" placeholder="context window, tokens (optional)"
                aria-label="Context window in tokens" aria-invalid={windowValid ? undefined : true} className={`${inputCls} max-w-56`} />
            </>
          ) : (
            <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="account (blank: main)"
              aria-label="Account name" className={`${inputCls} max-w-44`} />
          )}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={saveWord === 'Replace' ? '••••••• (stored, paste to replace)' : `${selected.name} API key`}
            aria-label="API key"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button type="submit" disabled={saving || !ready}
            className="p-btn-quiet inline-flex h-9 shrink-0 items-center px-3 text-xs">{saving ? '...' : saveWord}</button>
        </form>
      )}
      {compat && !windowValid && <p className="text-xs p-danger">The context window is a whole number of tokens, or blank.</p>}
      {error && <p className="text-xs p-danger">{error}</p>}
    </Field>
  );
}

function formKey(baseKey: string, name: string): string | null {
  if (name === '') return baseKey;

  return isAccountName(name) ? accountCredentialKey(baseKey, name) : null;
}

async function forgetDefaultAccount(key: string): Promise<void> {
  const provider = catalogProviderOfKey(key);

  if (provider === null || accountOf(key) === MAIN_ACCOUNT) return;
  const envelope = await getProfileCatalog();
  const { [provider]: chosen, ...others } = envelope.catalog.accounts ?? {};

  if (chosen === accountOf(key)) await updateProfileCatalog({ ...envelope.catalog, accounts: others }, envelope.version);
}

/** Per multi-account provider: the account an unnamed model runs on. */
function DefaultAccounts({ keys, catalog }: { keys: readonly string[]; catalog: readonly ProviderCatalogEntry[] }) {
  const profile = useAsyncResource(getProfileCatalog);
  const [saving, setSaving] = useState(false);

  const held = catalog.flatMap((entry) => {
    const provider = catalogProviderOfKey(entry.credKey);
    const accounts = storedAccounts(entry.credKey, keys);

    return provider === null || accounts.length < 2 ? [] : [{ name: entry.name, provider, accounts }];
  });

  if (held.length === 0) return null;

  const choose = (envelope: ProfileCatalogEnvelope, provider: string, account: string) => Effect.gen(function* () {
    setSaving(true);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      yield* Effect.promise(async () => updateProfileCatalog({ ...envelope.catalog, accounts: { ...envelope.catalog.accounts, [provider]: account } }, envelope.version));
      profile.reload();
    }), showing(alert)), Effect.sync(() => {
      setSaving(false);
    }));
  });

  return (
    <Field label="Default account">
      <CardSlot resource={profile.resource} what="your default accounts" onRetry={profile.reload}>
        {(envelope) => (
          <div className="space-y-2">
            {held.map(({ name, provider, accounts }) => (
              <div key={provider} className="flex items-center gap-3">
                <span className="p-row-text p-text w-32 shrink-0 truncate">{name}</span>
                <Choice
                  label={`${name} default account`}
                  value={envelope.catalog.accounts?.[provider] ?? (accounts.includes(MAIN_ACCOUNT) ? MAIN_ACCOUNT : '')}
                  options={accounts.map((account) => ({ value: account, label: account }))}
                  onChange={(account) => detach(choose(envelope, provider, account))}
                  disabled={saving}
                  size="sm"
                />
              </div>
            ))}
          </div>
        )}
      </CardSlot>
    </Field>
  );
}
