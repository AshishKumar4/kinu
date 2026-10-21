/**
 * Settings › Web search, and its onboarding step: what every workspace's agents search the web with, and who pays.
 * The account's chain is its profile catalog's `webSearch`, a key sits beside its other credentials, and the registry
 * (`WEB_SEARCH_PROVIDERS`) names every choice. Each choice saves at once and applies from each agent's next search.
 */
import { useState, type ReactNode } from "react";
import { Effect } from "effect";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import {
  DEFAULT_WEB_SEARCH_CHAIN, WEB_SEARCH_PROVIDER_IDS, WEB_SEARCH_PROVIDERS,
  type CredentialSummary, type ProfileCatalogEnvelope, type WebSearchBilling, type WebSearchProviderId, type WebSearchRoute,
} from "@kinu.run/core";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import {
  deleteCredential, getProfileCatalog, listCloudflareAccounts, listCredentials, setCredential, testWebSearch, updateProfileCatalog,
  type CloudflareAccountStatus, type WebSearchAnswer,
} from "@/lib/user-api";
import { Choice, Field } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { Segmented } from "@/components/ui/Segmented";
import { Status } from "@/components/ui/Status";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Notice } from "@/components/ui/Notice";
import { TextInput } from "@/components/ui/Field";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Choices, type Choice as Option } from "@/components/ui/Choices";

/** What a Test searches for: a question an agent of the owner's asks. */
const TEST_QUERY = "Cloudflare Durable Objects alarms API";

const CLOUDFLARE_INDEXES = WEB_SEARCH_PROVIDER_IDS.filter((id) => WEB_SEARCH_PROVIDERS[id].cloudflare);

const KEYED_PROVIDERS = WEB_SEARCH_PROVIDER_IDS.filter((id) => WEB_SEARCH_PROVIDERS[id].direct !== null);

/** Who pays for a search. Your own key is offered once a provider that takes a key is admitted; until then there is no
 *  such choice to show. */
const BILLINGS: readonly Option<WebSearchBilling>[] = [
  { id: "cloudflare", label: "Cloudflare", aside: <span className="t-meta">Default</span>, detail: "Paid through your Cloudflare account." },
  ...(KEYED_PROVIDERS.length > 0 ? [{ id: "key", label: "Your own key", detail: "Paid to the provider, with your API key." } satisfies Option<WebSearchBilling>] : []),
];

function routeLabel(route: WebSearchRoute): string {
  return `${WEB_SEARCH_PROVIDERS[route.provider].label} · ${route.billing === "cloudflare" ? "Cloudflare" : "your key"}`;
}

const sameRoute = (a: WebSearchRoute) => (b: WebSearchRoute) => a.provider === b.provider && a.billing === b.billing;

/** `run`, with `busy` up while it runs and its failure in its own words; `done` hears what it answered. */
function shown<A>(doing: string, run: () => Promise<A>, on: {
  readonly busy: (busy: boolean) => void;
  readonly failed: (words: string | null) => void;
  readonly done: (value: A) => void;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    on.busy(true);
    on.failed(null);

    return yield* attempt({ doing, otherwise: "io" }, run).pipe(
      Effect.map(on.done),
      Effect.catch((failed) => Effect.sync(() => { on.failed(renderThrownChain({ cause: failed.cause ?? failed })); })),
      Effect.ensuring(Effect.sync(() => { on.busy(false); })),
    );
  });
}

/** Settings, on a card of its own under the section head that titles it; setup, bare in the step's own card and only
 *  the choice itself, so the default passes with one click. */
type Place = "settings" | "setup";

function Framed({ place, children }: { place: Place; children: ReactNode }) {
  return place === "settings" ? <Card>{children}</Card> : <>{children}</>;
}

export function WebSearchSettings({ returnTo, place }: { returnTo: string; place: Place }) {
  const catalog = useAsyncResource(getProfileCatalog);
  const creds = useAsyncResource(listCredentials);
  const accounts = useAsyncResource(listCloudflareAccounts);
  const reloadAll = () => { for (const read of [catalog, creds, accounts]) read.reload(); };

  return (
    <Framed place={place}>
      <CardSlot resource={catalog.resource} what="your web search" onRetry={reloadAll}>
        {(envelope) => (
          <CardSlot resource={creds.resource} what="your search keys" onRetry={reloadAll}>
            {(credentials) => (
              <SearchChoice place={place} envelope={envelope} credentials={credentials} saved={catalog.set} onKeySaved={creds.reload}
                payer={<CardSlot resource={accounts.resource} what="your Cloudflare account" onRetry={reloadAll}>
                  {(status) => <Payer status={status} returnTo={returnTo} />}
                </CardSlot>} />
            )}
          </CardSlot>
        )}
      </CardSlot>
    </Framed>
  );
}

function SearchChoice({ place, envelope, credentials, saved, onKeySaved, payer }: {
  place: Place;
  envelope: ProfileCatalogEnvelope;
  credentials: readonly CredentialSummary[];
  saved: (envelope: ProfileCatalogEnvelope) => void;
  onKeySaved: () => void;
  payer: ReactNode;
}) {
  const chain = envelope.catalog.webSearch ?? DEFAULT_WEB_SEARCH_CHAIN;
  const [primary = DEFAULT_WEB_SEARCH_CHAIN[0], ...backups] = chain;
  // The tile shown open: a key's tile opens before a key is saved, while the chain still searches as before.
  const [opened, setOpened] = useState<WebSearchBilling>(primary.billing);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const stored = new Set(credentials.map((credential) => credential.key));

  const save = (next: readonly WebSearchRoute[]) => {
    const { webSearch: _replaced, ...rest } = envelope.catalog;
    // The default is stored as no choice, so the account follows a better default when Kinu picks one.
    const unchosen = JSON.stringify(next) === JSON.stringify(DEFAULT_WEB_SEARCH_CHAIN);

    return shown("saving your web search", () => updateProfileCatalog(unchosen ? rest : { ...rest, webSearch: next }, envelope.version),
      { busy: setSaving, failed: setFailure, done: saved });
  };

  /** `route` first, the rest of the chain behind it in its order. */
  const lead = (route: WebSearchRoute) => save([route, ...chain.filter((entry) => !sameRoute(route)(entry))]);

  const lastIndex = chain.find((route) => route.billing === "cloudflare")?.provider ?? DEFAULT_WEB_SEARCH_CHAIN[0].provider;
  const lastKeyed = chain.find((route) => route.billing === "key")?.provider ?? KEYED_PROVIDERS.find((id) => stored.has(id));

  /** Opens a tile; it leads the chain at once where it has something to search with. */
  const pick = (billing: WebSearchBilling) => Effect.suspend(() => {
    setOpened(billing);

    if (billing === "cloudflare" && primary.billing !== "cloudflare") return lead({ provider: lastIndex, billing });

    if (billing === "key" && primary.billing !== "key" && lastKeyed !== undefined && stored.has(lastKeyed)) return lead({ provider: lastKeyed, billing });

    return Effect.void;
  });

  return (
    <div className="space-y-6" data-web-search>
      <Field label="Search with" hint={failure ?? (saving ? "Saving…" : undefined)}>
        <Choices tiles label="Search with" marker="data-web-search-tile" value={opened} disabled={saving} onChange={(billing) => detach(pick(billing))}
          options={BILLINGS} />
      </Field>

      {opened === "cloudflare" || KEYED_PROVIDERS.length === 0 ? (
        <div className="space-y-3" data-web-search-cloudflare>
          <Field label="Provider" inline>
            <Segmented label="Search provider"
              segments={CLOUDFLARE_INDEXES.map((id) => ({ id, label: WEB_SEARCH_PROVIDERS[id].label }))}
              value={primary.billing === "cloudflare" ? primary.provider : lastIndex}
              onChange={(provider) => detach(lead({ provider, billing: "cloudflare" }))} />
          </Field>
          {place === "settings" && payer}
        </div>
      ) : (
        <KeyEntry primary={primary} stored={stored} disabled={saving}
          onSaved={(provider) => { onKeySaved(); detach(lead({ provider, billing: "key" })); }}
          onRemoved={(provider) => {
            onKeySaved();
            const kept = chain.filter((route) => !sameRoute({ provider, billing: "key" })(route));

            detach(save(kept.length === 0 ? DEFAULT_WEB_SEARCH_CHAIN : kept));
          }} />
      )}

      {place === "settings" && (
        <>
          <Backups backups={backups} chain={chain} stored={stored} disabled={saving} onChange={(next) => detach(save([primary, ...next]))} />
          <SearchTest route={primary} />
        </>
      )}
    </div>
  );
}

/** Said only where a search through Cloudflare is not paid through the person's own account: then this deployment pays. */
function Payer({ status, returnTo }: { status: CloudflareAccountStatus; returnTo: string }) {
  if (!status.connected) {
    return <CloudflareAIConnectNotice returnTo={returnTo} action="Connect Cloudflare"
      message="No Cloudflare account is connected, so Kinu pays for these searches for now." />;
  }

  if (!status.webSearch) {
    return <CloudflareAIConnectNotice returnTo={returnTo} action="Sign in with Cloudflare again"
      message="Sign in with Cloudflare again so these searches are paid through your account. Until then Kinu pays for them." />;
  }

  return null;
}

/** A provider's key: pasted, stored with the account's credentials, and then its search leads the chain. */
function KeyEntry({ primary, stored, disabled, onSaved, onRemoved }: {
  primary: WebSearchRoute;
  stored: ReadonlySet<string>;
  disabled: boolean;
  onSaved: (provider: WebSearchProviderId) => void;
  /** The key is gone: its entry leaves the chain, and an empty chain is the default again. */
  onRemoved: (provider: WebSearchProviderId) => void;
}) {
  const [provider, setProvider] = useState<WebSearchProviderId | undefined>(primary.billing === "key" ? primary.provider : KEYED_PROVIDERS[0]);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (provider === undefined) return null;
  const direct = WEB_SEARCH_PROVIDERS[provider].direct;
  const has = stored.has(provider);

  const store = () => shown(`storing your ${WEB_SEARCH_PROVIDERS[provider].label} key`, () => setCredential(provider, { kind: "bearer", token: key.trim() }), {
    busy: setSaving, failed: setFailure, done: () => { setKey(""); onSaved(provider); },
  });

  const remove = () => shown(`removing your ${WEB_SEARCH_PROVIDERS[provider].label} key`, () => deleteCredential(provider, false), {
    busy: setSaving, failed: setFailure, done: () => { onRemoved(provider); },
  });

  let action = has ? "Replace" : "Save";

  if (saving) action = "…";

  return (
    <div className="space-y-3" data-web-search-key={provider}>
      <Field label="Provider" inline>
        <Choice label="Search provider" size="sm" className="sm:w-56" value={provider} disabled={disabled || saving}
          options={KEYED_PROVIDERS.map((id) => ({ value: id, label: `${WEB_SEARCH_PROVIDERS[id].label}${stored.has(id) ? " · key stored" : ""}` }))}
          onChange={(next) => {
            setProvider(next);

            if (stored.has(next)) onSaved(next);
          }} />
      </Field>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); detach(store()); }}>
        <TextInput className="min-w-0 flex-1" type="password" value={key} onChange={(event) => setKey(event.target.value)} aria-label={`${WEB_SEARCH_PROVIDERS[provider].label} API key`} placeholder={has ? "••••••• (stored, paste to replace)" : `${WEB_SEARCH_PROVIDERS[provider].label} API key`} />
        <Button type="submit" disabled={saving || disabled || key.trim() === ""}>
          {action}
        </Button>
      </form>
      <div className="t-meta flex flex-wrap items-center gap-x-3 gap-y-1 p-text-3">
        {has && <Status tone="success">Key stored</Status>}
        {has && (
          <Button variant="danger" size="sm" disabled={saving || disabled} onClick={() => detach(remove())}>Remove key</Button>
        )}
        {direct !== null && (
          <a href={direct.keyPage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 p-accent-fg hover:underline">
            Get a {WEB_SEARCH_PROVIDERS[provider].label} key <ArrowSquareOutIcon size={11} />
          </a>
        )}
      </div>
      {failure !== null && <p className="t-meta p-danger">{failure}</p>}
    </div>
  );
}

/** What runs, in order, when the search before it refuses. */
function Backups({ backups, chain, stored, disabled, onChange }: {
  backups: readonly WebSearchRoute[];
  chain: readonly WebSearchRoute[];
  stored: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: readonly WebSearchRoute[]) => void;
}) {
  const candidates: WebSearchRoute[] = [
    ...CLOUDFLARE_INDEXES.map((provider): WebSearchRoute => ({ provider, billing: "cloudflare" })),
    ...KEYED_PROVIDERS.filter((provider) => stored.has(provider)).map((provider): WebSearchRoute => ({ provider, billing: "key" })),
  ].filter((route) => !chain.some(sameRoute(route)));

  return (
    <Field label="If it fails" hint="Tried in order when the one before it fails.">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Web search backups">
        {backups.map((route, at) => (
          <Chip key={`${route.provider}|${route.billing}`} data-web-search-backup={`${route.provider}|${route.billing}`}
            removeLabel={`Remove ${routeLabel(route)} from the backups`} onRemove={disabled ? undefined : () => onChange(backups.filter((entry) => !sameRoute(route)(entry)))}>
            <span className="p-text-3">{at + 1}.</span>
            {routeLabel(route)}
          </Chip>
        ))}
        {candidates.length > 0 && (
          <Choice<string> label="Add a web search backup" size="sm" className="w-52" disabled={disabled} value=""
            options={[{ value: "", label: backups.length === 0 ? "Add a backup…" : "Add another…" }, ...candidates.map((route) => ({ value: `${route.provider}|${route.billing}`, label: routeLabel(route) }))]}
            onChange={(value) => {
              const route = candidates.find((candidate) => `${candidate.provider}|${candidate.billing}` === value);

              if (route !== undefined) onChange([...backups, route]);
            }} />
        )}
        {candidates.length === 0 && backups.length === 0 && <span className="t-meta p-text-3">None.</span>}
      </div>
    </Field>
  );
}

type Tested = { readonly kind: "answered"; readonly answer: WebSearchAnswer; readonly ms: number } | { readonly kind: "refused"; readonly words: string };

/** One search through the first choice, as an agent's would go. */
function SearchTest({ route }: { route: WebSearchRoute }) {
  const [running, setRunning] = useState(false);
  const [tested, setTested] = useState<{ readonly route: WebSearchRoute; readonly outcome: Tested } | null>(null);

  const run = () => Effect.gen(function* () {
    setRunning(true);
    const started = performance.now();

    const answered = yield* attempt({ doing: `searching with ${routeLabel(route)}`, otherwise: "unavailable" },
      (signal) => testWebSearch(route, TEST_QUERY, signal)).pipe(
      Effect.map((answer): Tested => ({ kind: "answered", answer, ms: performance.now() - started })),
      Effect.catch((failed) => Effect.succeed<Tested>({ kind: "refused", words: renderThrownChain({ cause: failed.cause ?? failed }) })),
    );

    setTested({ route, outcome: answered });
    setRunning(false);
  });

  const outcome = tested !== null && sameRoute(tested.route)(route) ? tested.outcome : null;

  return (
    <div className="space-y-2">
      <Field label="Test" hint={`Searches ${routeLabel(route)} once.`} inline>
        <Button size="sm" variant="secondary" disabled={running} onClick={() => detach(run())} data-web-search-test>
          {running && <Loader size="sm" />} Search
        </Button>
      </Field>
      {outcome?.kind === "answered" && (
        <div className="flex min-w-0 flex-col gap-px" data-web-search-tested="answered">
          <Status tone="success">{outcome.answer.results.length} results from {WEB_SEARCH_PROVIDERS[outcome.answer.source].label} in {(outcome.ms / 1000).toFixed(1)} s</Status>
          {outcome.answer.results[0] !== undefined && <span className="t-meta truncate p-text-3">First: {outcome.answer.results[0].title}</span>}
        </div>
      )}
      {outcome?.kind === "refused" && <Notice tone="danger" data-web-search-tested="refused">{outcome.words}</Notice>}
    </div>
  );
}
