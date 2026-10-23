/**
 * Providers panel: one list of every provider, each with its own sign-in (Cloudflare, device code, claude.ai, API key); also mounted as a modal.
 * Each read is its own resource and fails visibly: a swallowed rejection shows a connected account as disconnected.
 */
import { Effect } from 'effect';
import { Button } from "@/components/ui/Button";
import { useState, type ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import {
  listCredentials, setCredential, deleteCredential,
  codexStatus, disconnectCodex, startClaudeSignIn, finishClaudeSignIn,
  chatgptPlan, signOutChatGpt,
  listAvailableModels, listProviderCatalog, getProfileCatalog, updateProfileCatalog,
  listCloudflareGateways, selectCloudflareGateway,
  listCloudflareAccounts, selectCloudflareAccount,
  
  type CloudflareGatewayStatus, type CloudflareAccountStatus,
} from "@/lib/user-api";
import type { ProfileCatalogEnvelope } from '@kinu.run/core';
import { Notice } from '@/components/ui/Notice';
import { Card, Choice, Field } from "@/components/ui/form";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { CardSlot } from "@/components/ui/CardSlot";
import { BrandMark, providerBrand } from "@/components/ui/BrandMark";
import { ChatGptConnect, ChatGptPlanUsage, ChatGptWelcome } from "@/components/account/ChatGptConnect";
import { SignInOpen, SignInPaste, SignInRisk, SignInStep, SignInSteps } from "@/components/account/SubscriptionSignIn";
import { useProviderWindow } from "@/hooks/use-provider-window";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { Status } from '@/components/ui/Status';
import { showing, detach } from '@kinu.run/core/obs';
import {
  CHATGPT_CRED_KEY, CLAUDE_CRED_KEY, CLOUDFLARE_OAUTH_CRED_KEY, CODEX_CRED_KEY, MAIN_ACCOUNT, accountCredentialKey, accountOf, baseCredentialKey, catalogProviderOfKey, isAccountName, revokingProviderOf, storedAccounts, type CredentialSummary, type ProviderCatalogEntry,
} from '@kinu.run/core';
import { Group } from "@/components/ui/Group";
import { TextInput } from "@/components/ui/Field";
import { Combobox } from "@/components/ui/Select";

function ConnectedBadge({ detail }: { detail?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Status tone="success">Connected</Status>
      {detail && <span className="t-meta p-text-3">{detail}</span>}
    </div>
  );
}

/** When a login that never renews stops working (Claude Code's `setup-token`); nothing for one that renews. */
function loginEnds(credentials: readonly CredentialSummary[], key: string): ReactNode {
  const ends = credentials.find((credential) => credential.key === key)?.expiresAt;

  return ends === undefined ? null : <>until {new Date(ends).toLocaleString()}, then sign in again</>;
}

/** The panel in its own titled card; `framed` false where its host already says "Connect a provider". */
function Framed({ framed, children }: { framed: boolean; children: ReactNode }) {
  return framed ? <Card title="Connect a provider">{children}</Card> : <>{children}</>;
}

export function ProvidersPanel({ framed = true }: { framed?: boolean }) {
  const creds = useAsyncResource(listCredentials);
  const codex = useAsyncResource(codexStatus);
  const chatgpt = useAsyncResource(chatgptPlan);
  const models = useAsyncResource(listAvailableModels);
  const catalog = useAsyncResource(listProviderCatalog);
  const gateways = useAsyncResource(listCloudflareGateways);
  const accounts = useAsyncResource(listCloudflareAccounts);

  const [chatgptWelcome, setChatgptWelcome] = useState(false);
  /** The last disconnect that asked its provider to revoke and was refused, in the provider's words. */
  const [unrevoked, setUnrevoked] = useState<{ readonly name: string; readonly words: string } | null>(null);
  const answered = (name: string, { unrevoked: words }: { readonly unrevoked: string | null }) => setUnrevoked(words === null ? null : { name, words });

  const reads = [creds, codex, chatgpt, models, catalog, gateways, accounts];
  // Retry re-reads the whole account: mutators invalidate more than their own row.
  const reloadAll = () => { for (const read of reads) read.reload(); };

  return (
    <>
      {chatgptWelcome && <ChatGptWelcome onClose={() => setChatgptWelcome(false)} />}
      {unrevoked !== null && (
        <Notice tone="warning">
          {unrevoked.name} is disconnected from Kinu but not revoked. {unrevoked.words}
        </Notice>
      )}
      <Framed framed={framed}>
        <CardSlot resource={creds.resource} what="your API keys" onRetry={reloadAll}>
          {(credentials) => {
            const held = new Set(credentials.map((c) => c.key));

            return (
              <div className="space-y-5">
                <Group>
                  {models.resource.status === "error" && (
                    <CardSlot resource={models.resource} what="your connected models" onRetry={models.reload}>{() => null}</CardSlot>
                  )}
                  <ProviderEntry provider="workers-ai" name="Cloudflare AI" method="Cloudflare sign-in"
                    connected={held.has(CLOUDFLARE_OAUTH_CRED_KEY) || (lastValue(models.resource)?.models.some((model) => model.provider === 'workers-ai') ?? false)}
                    disconnect={held.has(CLOUDFLARE_OAUTH_CRED_KEY)
                      ? async (revoke) => answered('Cloudflare AI', await deleteCredential(CLOUDFLARE_OAUTH_CRED_KEY, revoke))
                      : undefined}
                    revokesAt={revokingProviderOf(CLOUDFLARE_OAUTH_CRED_KEY)}
                    onChanged={reloadAll}
                    connect={<CloudflareAIConnectNotice onConnected={reloadAll} message="Connect Cloudflare to use your Workers AI quota and AI Gateway." />}>
                    {/* Asked first: the account decides which gateway is reachable. */}
                    <CardSlot resource={accounts.resource} what="your Cloudflare accounts" onRetry={reloadAll}>
                      {(status) => (status.signInExpired
                        ? <CloudflareAIConnectNotice onConnected={reloadAll} action="Sign in to Cloudflare again"
                          message="Your Cloudflare sign-in has expired, so your AI Gateway is off and Kinu pays for your searches until you sign in again." />
                        : <CloudflareAccountSection status={status} onChanged={reloadAll} />)}
                    </CardSlot>
                    <CardSlot resource={gateways.resource} what="your AI gateways" onRetry={reloadAll}>
                      {(status) => <CloudflareGatewaySection status={status} onChanged={reloadAll} />}
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
                              detail={<>{planSignedIn ? <>{planEmail}{plan.account === null && plan.device !== null ? <> on {plan.device.label}</> : null}</> : codexAccount} {loginEnds(credentials, planSignedIn ? CHATGPT_CRED_KEY : CODEX_CRED_KEY)}</>}
                              disconnect={async (revoke) => answered('ChatGPT', planSignedIn ? await signOutChatGpt(revoke) : await disconnectCodex(revoke))}
                              revokesAt={revokingProviderOf(planSignedIn ? CHATGPT_CRED_KEY : CODEX_CRED_KEY)}
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
                    detail={loginEnds(credentials, CLAUDE_CRED_KEY)}
                    disconnect={async () => { await deleteCredential(CLAUDE_CRED_KEY, false); }}
                    onChanged={reloadAll}
                    connect={<ClaudeConnect onChanged={reloadAll} />} />
                  <CardSlot resource={catalog.resource} what="the provider catalog" onRetry={reloadAll}>
                    {(providers) => storedEntries(credentials, providers).map((entry) => (
                      <ProviderEntry key={entry.key} provider={entry.provider} name={entry.name} method={entry.method}
                        detail={<><span className="t-meta t-mono">{entry.key}</span> {loginEnds(credentials, entry.key)}</>}
                        connected
                        disconnect={async (revoke) => {
                          answered(entry.name, await deleteCredential(entry.key, revoke));
                          await forgetDefaultAccount(entry.key);
                        }}
                        revokesAt={revokingProviderOf(entry.key)}
                        onChanged={reloadAll} />
                    ))}
                  </CardSlot>
                </Group>
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
      </Framed>
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
function ProviderEntry({ provider, name, method, connected, detail, disconnect, revokesAt = null, onChanged, connect, children }: {
  provider: string;
  name: string;
  method: string;
  connected: boolean;
  detail?: ReactNode;
  /** `revoke` asks the provider to end the grant too; offered only where `revokesAt` names who can. */
  disconnect?: (revoke: boolean) => Promise<void>;
  revokesAt?: string | null;
  onChanged: () => void;
  connect?: ReactNode;
  /** Settings shown under a connected entry. */
  children?: ReactNode;
}) {
  const brand = providerBrand(provider);

  const { ask, dialog } = useConfirmation();

  const leave = () => {
    if (disconnect === undefined) return;
    ask({
      title: `Disconnect ${name}?`,
      body: revokesAt === null
        ? "Your agents lose its models."
        : `Your agents lose its models. Disconnect removes Kinu's copy of the sign-in; revoking also asks ${revokesAt} to end the sign-in itself.`,
      action: "Disconnect", failed: "Could not disconnect",
      run: async () => { await disconnect(false); onChanged(); },
      ...(revokesAt !== null && { alternate: { action: `Disconnect and revoke at ${revokesAt}`, run: async () => { await disconnect(true); onChanged(); } } }),
    });
  };

  return (
    <div className="space-y-3 px-4 py-3" data-provider={name}>
      <div className="t-meta flex flex-wrap items-center gap-x-2 gap-y-1">
        {brand !== undefined && <BrandMark brand={brand} size={13} bare />}
        <span className="t-item p-text">{name}</span>
        <span className="t-meta p-text-3">{method}</span>
        <span className="ml-auto flex items-center gap-2">
          {connected ? <ConnectedBadge detail={detail} /> : <span className="t-meta p-text-3">Not connected</span>}
          {connected && disconnect !== undefined && (
            <Button variant="danger" size="sm" onClick={leave} aria-label={`Disconnect ${name}`}>Disconnect</Button>
          )}
        </span>
      </div>
      {connected ? children : connect}
      {dialog}
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
      {error && <p className="t-meta p-danger">{error}</p>}
    </Field>
  );
}

function CloudflareGatewaySection({ status, onChanged }: {
  status: CloudflareGatewayStatus | null;
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

  // Signing in again is the account read's to offer (`signInExpired`); a listing that failed is retried.
  if (status.error) {
    return (
      <Notice tone="warning" action={<Button size="sm" className="shrink-0" onClick={onChanged}>Try again</Button>}>
        <p>Could not list your AI Gateways: {status.error}</p>
      </Notice>
    );
  }

  if (status.gateways.length === 0) {
    return (
      <span className="t-meta p-text-3">No AI Gateway</span>
    );
  }

  return (
    <Field label="AI Gateway">
      {status.gateways.length === 1 && status.selectedId === status.gateways[0].id ? (
        <div className="t-meta flex items-center gap-2">
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
      {error && <p className="t-meta p-danger">{error}</p>}
    </Field>
  );
}

/**
 * Claude's PKCE sign-in on the shared card (SubscriptionSignIn): Claude returns the browser to Anthropic's own page,
 * which shows a code with its Copy, and the code is pasted back here. A refused code says why, in Claude's words. Its
 * page opens in a popup this page closes once the code connects (the owner's rule, 2026-10-21).
 */
function ClaudeConnect({ onChanged }: { onChanged: () => void }) {
  const signInWindow = useProviderWindow('claude-sign-in');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
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
    setOpened(false);
    setCode('');
  }));

  const finish = () => run(Effect.gen(function* () {
    const result = yield* Effect.promise(() => finishClaudeSignIn(code.trim()));

    if (result.connected) {
      signInWindow.close();
      onChanged();
    } else setError(result.error ?? 'Claude did not connect.');
  }));

  if (authorizeUrl === null) {
    return (
      <div className="space-y-3" data-claude-connect="start">
        <SignInRisk>Anthropic&apos;s terms limit plan use to its own apps, so connecting is at your own risk.</SignInRisk>
        <Button variant="primary" size="md" onClick={() => detach(start())} disabled={busy}>Sign in with Claude</Button>
        {error && <p role="alert" className="t-meta p-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-claude-connect="paste">
      <SignInSteps>
        <SignInStep n={1} state={opened ? 'done' : 'now'} title="Sign in at Anthropic">
          {!opened && <SignInOpen href={authorizeUrl} label="Open claude.ai" onOpen={(event) => { signInWindow.open(event); setOpened(true); }} />}
        </SignInStep>
        <SignInStep n={2} state={opened ? 'now' : 'next'} title="Claude shows a code with a Copy button: copy it" />
        <SignInStep n={3} state={opened ? 'now' : 'next'} title="Paste it here">
          {opened && (
            <SignInPaste label="The code Claude showed" placeholder="Code#state" value={code} onChange={setCode}
              onSubmit={() => detach(finish())} busy={busy} problem={error} action="Connect" />
          )}
        </SignInStep>
      </SignInSteps>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => { setAuthorizeUrl(null); setError(null); }} disabled={busy}>Cancel</Button>
        {opened && <Button variant="ghost" size="sm" onClick={() => detach(start())} disabled={busy}>Start again</Button>}
      </div>
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
              <TextInput className="max-w-44" value={compatName} onChange={(e) => setCompatName(e.target.value)} placeholder="name (e.g. groq)" aria-label="Endpoint name" />
              <TextInput className="min-w-0 flex-1" value={compatBaseURL} onChange={(e) => setCompatBaseURL(e.target.value)} placeholder="https://api.example.com/v1" aria-label="Base URL" />
              <span className="basis-full" aria-hidden />
              <TextInput before="Context window" after="tokens" className="max-w-72 text-right" invalid={!windowValid}
                value={compatWindow} onChange={(e) => setCompatWindow(e.target.value)} inputMode="numeric" placeholder="optional"
                aria-label="Context window in tokens" />
            </>
          ) : (
            <TextInput className="max-w-44" value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="account (blank: main)" aria-label="Account name" />
          )}
          <TextInput className="min-w-0 flex-1" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={saveWord === 'Replace' ? '••••••• (stored, paste to replace)' : `${selected.name} API key`} aria-label="API key" />
          <Button type="submit" disabled={saving || !ready}>{saving ? '...' : saveWord}</Button>
        </form>
      )}
      {compat && !windowValid && <p className="t-meta mb-1 p-danger">The context window is a whole number of tokens, or blank.</p>}
      {error && <p className="t-meta p-danger">{error}</p>}
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
                <span className="t-body p-text w-32 shrink-0 truncate">{name}</span>
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
