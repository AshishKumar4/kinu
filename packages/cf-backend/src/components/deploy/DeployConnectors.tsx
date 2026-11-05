/**
 * A Kinu's connectors (core deploy/connectors.ts): GitHub and Google, which need an app of the Kinu's own, each connected
 * by its own steps; then every other plugin of the catalog, which needs nothing here and is connected in the Kinu itself.
 * Before a Kinu is deployed (`ConnectorsBefore`), its apps are made for the address it will have and held until its
 * deploy binds them.
 */
import { useCallback, useState, type ReactNode } from "react";
import { Effect } from "effect";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { APP_ROUTES, MCP_PRESETS } from "@kinu.run/core";
import { GOOGLE_SETUP, googleRedirect, type AddressAsk, type DeployedKinu, type OAuthClient } from "@kinu.run/core/deploy";
import { detach } from "@kinu.run/core/obs";
import { Button } from "@/components/ui/Button";
import { BrandMark, PRESET_MARK, type BrandName } from "@/components/ui/BrandMark";
import { CopyButton } from "@/components/ui/CopyButton";
import { IconTile } from "@/components/ui/IconTile";
import { TextInput } from "@/components/ui/Field";
import { readConnectorsBefore, setGoogleClient, type DeployHeard } from "@/lib/deploy-page-api";
import { readingOf } from "@/components/deploy/deploy-reading";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { useLabelledStep } from "@/hooks/use-labelled-step";

/** GitHub's return to the page once it made a Kinu's app: the app, for the Kinu named (`before` it is deployed, held for
 *  its deploy), or GitHub's or Cloudflare's words. */
export type GithubReturn = { readonly made: string; readonly kinu: string; readonly before: boolean } | { readonly error: string; readonly before: boolean };

/** Where an owner's GitHub Apps are listed, each with its installations. */
const GITHUB_APPS = "https://github.com/settings/apps";

function Connector({ id, brand, title, copy, action, children }: {
  id: string; brand: BrandName; title: string; copy: ReactNode; action: ReactNode; children?: ReactNode;
}) {
  return (
    <li data-deploy-connector={id} className="py-3">
      <div className="flex items-center gap-3">
        <IconTile size="xl"><BrandMark brand={brand} size={18} /></IconTile>
        <span className="min-w-0 flex-1">
          <span className="block t-public-item">{title}</span>
          <span className="mt-px block t-meta">{copy}</span>
        </span>
        <span className="shrink-0">{action}</span>
      </div>
      {children !== undefined && <div className="mt-3 sm:pl-12">{children}</div>}
    </li>
  );
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 t-public-item p-link">
      {children}<ArrowSquareOutIcon size={14} />
    </a>
  );
}

function GitHubConnector({ kinu, made, busy, onConnect }: { kinu: DeployedKinu; made: string | null; busy: boolean; onConnect: () => void }) {
  if (made !== null) {
    return (
      <Connector id="github" brand="github" title="GitHub" copy="Connected. Install it on the repositories its agents may use."
        action={<External href={`https://github.com/apps/${encodeURIComponent(made)}/installations/new`}>Install on GitHub</External>} />
    );
  }

  if (kinu.connectors.github) {
    return <Connector id="github" brand="github" title="GitHub" copy="Connected through its own GitHub app." action={<External href={GITHUB_APPS}>Manage on GitHub</External>} />;
  }

  return (
    <Connector id="github" brand="github" title="GitHub" copy="Lets its agents work in your repositories. GitHub makes the app in one click."
      action={<Button size="sm" variant="secondary" disabled={busy} onClick={onConnect}>Connect</Button>} />
  );
}

/** One numbered step of making a Google client. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="t-meta w-4 shrink-0 text-right">{n}.</span>
      <div className="min-w-0 flex-1 space-y-2 t-body">{children}</div>
    </li>
  );
}

/** Where a Google client is saved: on the Kinu, or held for its deploy. */
type SaveGoogle = (client: OAuthClient) => Promise<DeployHeard<{ readonly google: boolean }>>;

/** The steps to the Kinu's own Google client at `origin`, and its fields; saved, the Kinu's Google sign-in uses it. */
function GoogleClientSteps({ origin, save: saveClient, onSaved, onCancel }: { origin: string; save: SaveGoogle; onSaved: () => void; onCancel: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const { busy, error: refused, run } = useLabelledStep(onSaved);
  const redirect = googleRedirect(origin);

  const save = (): void => run("save", () => Effect.gen(function* () {
    const heard = yield* Effect.promise(async () => saveClient({ clientId, clientSecret }));

    if ("refusal" in heard) return yield* Effect.fail(heard.refusal.error);
  }));

  return (
    <div className="space-y-4" data-deploy-google-steps>
      <ol className="space-y-3">
        <Step n={1}>
          <p>Turn on the Google APIs it uses: Gmail, Calendar, Drive, Docs, Sheets, Slides and Contacts.</p>
          <External href={GOOGLE_SETUP.apis}>Open Google Cloud</External>
        </Step>
        <Step n={2}>
          <p>Choose who may sign in. Internal suits a Google Workspace domain. Otherwise pick External, add your name and
            email when asked, then Publish app: a test app&apos;s sign-ins end after 7 days.</p>
          <External href={GOOGLE_SETUP.audience}>Open Audience</External>
        </Step>
        <Step n={3}>
          <p>Create an OAuth client of the type Web application, with this redirect URI:</p>
          <div className="flex items-center gap-2">
            <TextInput readOnly value={redirect} aria-label="Redirect URI" className="t-mono" />
            <CopyButton value={redirect} what="the redirect URI" />
          </div>
          <External href={GOOGLE_SETUP.clients}>Open Clients</External>
        </Step>
        <Step n={4}>
          <p>Paste its client ID and secret.</p>
          <TextInput aria-label="Client ID" placeholder="Client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} />
          <TextInput aria-label="Client secret" placeholder="Client secret" type="password" autoComplete="off" value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)} />
        </Step>
      </ol>
      {refused !== null && <p role="alert" className="t-meta p-danger">{refused}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" busy={busy !== null} disabled={clientId.trim() === "" || clientSecret.trim() === ""} onClick={save}>Save</Button>
      </div>
    </div>
  );
}

function GoogleConnector({ kinu, onChanged }: { kinu: DeployedKinu; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { busy, error: refused, run } = useLabelledStep(onChanged);

  if (kinu.connectors.google) {
    const composio = (): void => run("composio", () => Effect.gen(function* () {
      const heard = yield* Effect.promise(async () => setGoogleClient(kinu.account, kinu.name, null));

      if ("refusal" in heard) return yield* Effect.fail(heard.refusal.error);
    }));

    return (
      <Connector id="google" brand="google" title="Google" copy="Connected through your own Google app."
        action={<Button size="sm" variant="ghost" onClick={composio} busy={busy !== null}>Use Composio instead</Button>}>
        {refused !== null && <p role="alert" className="t-meta p-danger">{refused}</p>}
      </Connector>
    );
  }

  return (
    <Connector id="google" brand="google" title="Google" copy="Works through Composio: each person connects Gmail, Drive and Calendar in Kinu's Plugins."
      action={!open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Use your own app</Button>}>
      {open ? <GoogleClientSteps origin={kinu.url} save={async (client) => setGoogleClient(kinu.account, kinu.name, client)} onSaved={onChanged} onCancel={() => setOpen(false)} /> : undefined}
    </Connector>
  );
}

export function DeployConnectors({ kinu, github, busy, onConnectGithub, onChanged }: {
  kinu: DeployedKinu;
  /** GitHub's return, when this page was arrived at from it. */
  github: GithubReturn | null;
  busy: boolean;
  onConnectGithub: () => void;
  /** A connector changed on the Worker: the page reads the Kinu again. */
  onChanged: () => void;
}) {
  const made = github !== null && "made" in github && github.kinu === kinu.name ? github.made : null;

  return (
    <section className="mt-6" aria-labelledby="deploy-connectors">
      <h2 id="deploy-connectors" className="t-public-item">Connectors</h2>
      <ul className="mt-1">
        <GitHubConnector kinu={kinu} made={made} busy={busy} onConnect={onConnectGithub} />
        <GoogleConnector kinu={kinu} onChanged={onChanged} />
        {MCP_PRESETS.filter((preset) => preset.auth !== "oauth-app").map((preset) => (
          <Connector key={preset.id} id={preset.id} brand={PRESET_MARK[preset.id]} title={preset.title}
            copy={`${preset.description}. Ready: each person connects it in Kinu's Plugins.`}
            action={<External href={`${kinu.url}${APP_ROUTES.plugins}`}>Connect in Kinu</External>} />
        ))}
      </ul>
    </section>
  );
}

/**
 * GitHub and Google for a Kinu not deployed yet (the owner, 2026-10-31: connectors are an optional step before Deploy):
 * each app is made now for the address the Kinu will have, and its deploy binds it. With no address yet (a workers.dev
 * name or a domain the deploy makes first), they wait for the Kinu, as every other plugin does.
 */
export function ConnectorsBefore({ account, name, address, busy, onConnectGithub }: {
  account: string; name: string; address: AddressAsk; busy: boolean; onConnectGithub: () => void;
}) {
  const [changed, setChanged] = useState(0);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const load = useCallback(async () => readConnectorsBefore(account, name, address), [account, name, address]);
  const read = readingOf(useAsyncResource(load, undefined, `${account}/${name}/${JSON.stringify(address)}/${String(changed)}`).resource);
  const held = read.state === "read" ? read.answer : null;
  const later = "Its address is made by the deploy, so connect it once Kinu is live.";

  const composio = () => Effect.gen(function* () {
    const heard = yield* Effect.promise(async () => setGoogleClient(account, name, null, address));

    if ("refusal" in heard) setRefused(heard.refusal.error);
    else setChanged((count) => count + 1);
  });

  if (held === null) return null;

  const github = held.github !== null
    ? <Connector id="github" brand="github" title="GitHub" copy="Its app is made. Kinu takes it when it deploys; install it on your repositories then." action={null} />
    : <Connector id="github" brand="github" title="GitHub" copy={held.origin === null ? later : "Lets its agents work in your repositories. GitHub makes the app in one click."}
      action={held.origin !== null && <Button size="sm" variant="secondary" disabled={busy} onClick={onConnectGithub}>Connect</Button>} />;

  const google = held.google
    ? (
      <Connector id="google" brand="google" title="Google" copy="Your own Google app. Kinu takes it when it deploys."
        action={<Button size="sm" variant="ghost" onClick={() => detach(composio())}>Use Composio instead</Button>}>
        {refused !== null && <p role="alert" className="t-meta p-danger">{refused}</p>}
      </Connector>
    )
    : (
      <Connector id="google" brand="google" title="Google" copy="Works through Composio: each person connects Gmail, Drive and Calendar in Kinu's Plugins."
        action={held.origin !== null && !googleOpen && <Button size="sm" variant="secondary" onClick={() => setGoogleOpen(true)}>Use your own app</Button>}>
        {held.origin !== null && googleOpen
          ? <GoogleClientSteps origin={held.origin} save={async (client) => setGoogleClient(account, name, client, address)}
            onSaved={() => { setGoogleOpen(false); setChanged((count) => count + 1); }} onCancel={() => setGoogleOpen(false)} />
          : undefined}
      </Connector>
    );

  return (
    <section data-deploy-connectors-before aria-labelledby="deploy-connectors-before">
      <h3 id="deploy-connectors-before" className="t-public-item">Connectors</h3>
      <ul className="mt-1">{github}{google}</ul>
      <p className="t-meta">Every other plugin connects in Kinu once it is live.</p>
    </section>
  );
}
