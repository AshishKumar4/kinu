/**
 * A Kinu's connectors (core deploy/connectors.ts): GitHub and Google, the two that need an app of the Kinu's own, each
 * connected by its own steps. Every other plugin needs nothing here; people connect them in the Kinu's Plugins.
 */
import { useState, type ReactNode } from "react";
import { Effect } from "effect";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { GOOGLE_SETUP, googleRedirect, type DeployedKinu } from "@kinu.run/core/deploy";
import { detach } from "@kinu.run/core/obs";
import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/components/ui/BrandMark";
import { CopyButton } from "@/components/ui/CopyButton";
import { IconTile } from "@/components/ui/IconTile";
import { TextInput } from "@/components/ui/Field";
import { setGoogleClient } from "@/lib/deploy-page-api";

/** GitHub's return to the page once it made a Kinu's app: the app, for the Kinu named, or GitHub's or Cloudflare's words. */
export type GithubReturn = { readonly made: string; readonly kinu: string } | { readonly error: string };

/** Where an owner's GitHub Apps are listed, each with its installations. */
const GITHUB_APPS = "https://github.com/settings/apps";

function Connector({ brand, title, copy, action, children }: {
  brand: "github" | "google"; title: string; copy: ReactNode; action: ReactNode; children?: ReactNode;
}) {
  return (
    <li data-deploy-connector={brand} className="py-3">
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
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 t-public-item p-accent-fg hover:underline">
      {children}<ArrowSquareOutIcon size={14} />
    </a>
  );
}

function GitHubConnector({ kinu, made, busy, onConnect }: { kinu: DeployedKinu; made: string | null; busy: boolean; onConnect: () => void }) {
  if (made !== null) {
    return (
      <Connector brand="github" title="GitHub" copy="Connected. Install it on the repositories its agents may use."
        action={<External href={`https://github.com/apps/${encodeURIComponent(made)}/installations/new`}>Install on GitHub</External>} />
    );
  }

  if (kinu.connectors.github) {
    return <Connector brand="github" title="GitHub" copy="Connected through its own GitHub app." action={<External href={GITHUB_APPS}>Manage on GitHub</External>} />;
  }

  return (
    <Connector brand="github" title="GitHub" copy="Lets its agents work in your repositories. GitHub makes the app in one click."
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

/** The steps to the Kinu's own Google client, and its fields; saved, the Kinu's Google sign-in uses it. */
function GoogleClientSteps({ kinu, onSaved, onCancel }: { kinu: DeployedKinu; onSaved: () => void; onCancel: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const redirect = googleRedirect(kinu.url);

  const save = () => Effect.gen(function* () {
    setSaving(true);
    setRefused(null);
    const heard = yield* Effect.promise(async () => setGoogleClient(kinu.account, kinu.name, { clientId, clientSecret }));

    setSaving(false);

    if ("refusal" in heard) setRefused(heard.refusal.error);
    else onSaved();
  });

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
        <Button size="sm" disabled={saving || clientId.trim() === "" || clientSecret.trim() === ""} onClick={() => detach(save())}>Save</Button>
      </div>
    </div>
  );
}

function GoogleConnector({ kinu, onChanged }: { kinu: DeployedKinu; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  if (kinu.connectors.google) {
    const composio = () => Effect.gen(function* () {
      const heard = yield* Effect.promise(async () => setGoogleClient(kinu.account, kinu.name, null));

      if ("refusal" in heard) setRefused(heard.refusal.error);
      else onChanged();
    });

    return (
      <Connector brand="google" title="Google" copy="Connected through your own Google app."
        action={<Button size="sm" variant="ghost" onClick={() => detach(composio())}>Use Composio instead</Button>}>
        {refused !== null && <p role="alert" className="t-meta p-danger">{refused}</p>}
      </Connector>
    );
  }

  return (
    <Connector brand="google" title="Google" copy="Works through Composio: each person connects Gmail, Drive and Calendar in Kinu's Plugins."
      action={!open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Use your own app</Button>}>
      {open ? <GoogleClientSteps kinu={kinu} onSaved={onChanged} onCancel={() => setOpen(false)} /> : undefined}
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
      </ul>
    </section>
  );
}
