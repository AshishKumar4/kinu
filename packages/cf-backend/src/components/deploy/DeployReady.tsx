/**
 * Ready to deploy: one screen holding the account, the address, the extras and Deploy. The account's checks run
 * silently on arrival and again when the person comes back from a hand-off; only what needs them shows. The same screen
 * changes an existing Kinu: its Domain step, or mail at its domain.
 */
import { useCallback, useEffect, useState } from "react";
import { CpuIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import {
  DEFAULT_INSTANCE_NAME,
  type DeployChoice, type DeployedKinu, type DeployPreflight, type DeployRunRequest, type DeploySession, type DeployZone, type MailPreview, type MailPurpose,
} from "@kinu.run/core/deploy";
import { Button } from "@/components/ui/Button";
import { RadioGroup } from "@/components/ui/Check";
import { Loader } from "@/components/ui/Loader";
import { Select } from "@/components/ui/Select";
import { CloudflareSaid, DeployShell, Disclosure, Extra, Line, NeedBox, WhatGetsMade } from "@/components/deploy/DeployParts";
import { DeployDomain, type PickedDomain } from "@/components/deploy/DeployDomain";
import { useDeployRead, type Reading } from "@/components/deploy/use-deploy-read";
import { readMailPreview, readPreflight, type DeployRefused } from "@/lib/deploy-page-api";

/** How often the account is read again while a hand-off to Cloudflare is open. */
const RECHECK_MS = 5000;

/** What this screen does: a new Kinu, or one change to an existing one. */
export type ReadyFor = { readonly kind: "new" } | { readonly kind: "domain" | "mail"; readonly kinu: DeployedKinu };

/** What a change to an existing Kinu asks, past the Kinu it is. */
type ChangeAsked = Omit<Extract<DeployRunRequest, { kind: "change" }>, "kind" | "account" | "name">;

/** The page's side of the screen: what it is doing, and what it does for the person. */
interface ReadyActions {
  readonly deploying: boolean;
  readonly refusal: DeployRefused | null;
  readonly signingIn: boolean;
  readonly onSignIn: () => void;
  readonly onHandedOff: () => void;
}

const PURPOSE: Record<MailPurpose, string> = {
  receive: "Brings its mail to Cloudflare",
  send: "Lets Cloudflare send for it",
  sign: "A signing key, so mail from it is trusted",
  report: "Where reports of mail sent as it go",
};

/** What mail at a host adds and keeps, from the preview read before anything is written. */
function MailWrites({ preview }: { preview: MailPreview }) {
  const kept = preview.kept.length === 1 ? "One record it needs is there already and stays." : `${String(preview.kept.length)} records it needs are there already and stay.`;

  return (
    <Disclosure summary={`What it adds to ${preview.host}`}>
      <ul className="space-y-1 t-meta p-text-2">
        {preview.writes.map((record) => <li key={`${record.type}/${record.name}/${record.content}`}>{PURPOSE[record.purpose]} ({record.type})</li>)}
      </ul>
      {preview.kept.length > 0 && <p className="mt-2 t-meta">{kept}</p>}
    </Disclosure>
  );
}

/** The zone of the account a host sits in, nearest first. */
function zoneOf(zones: readonly DeployZone[], host: string): DeployZone | undefined {
  return [...zones].sort((a, b) => b.name.length - a.name.length).find((zone) => host === zone.name || host.endsWith(`.${zone.name}`));
}

/** Mail at a domain: its apex, or a subdomain where the apex gets mail elsewhere; what it adds, read first. */
function MailChoice({ account, domain, host, onHost }: { account: string; domain: string; host: string; onHost: (host: string) => void }) {
  const previewed = useDeployRead(`${account}/${host}`, async () => readMailPreview(account, host));
  const conflict = previewed?.state === "read" ? previewed.answer.conflict : null;
  const sub = `mail.${domain}`;

  // The apex already gets mail elsewhere: Kinu's goes on the subdomain the preview suggests, and the apex stays as it is.
  useEffect(() => {
    if (conflict !== null && host !== conflict.suggestion) onHost(conflict.suggestion);
  }, [conflict, host, onHost]);

  return (
    <div className="space-y-3" data-deploy-mail={host}>
      <RadioGroup label="Where mail goes" value={host === domain ? "apex" : "sub"} onChange={(at) => onHost(at === "apex" ? domain : sub)}
        options={[{ value: "apex", label: `At ${domain}, like ada@${domain}` }, { value: "sub", label: `At ${sub}, like ada@${sub}` }]} />
      {previewed?.state === "reading" && <p className="inline-flex items-center gap-2 t-meta"><Loader size="sm" />Reading {host}…</p>}
      {previewed?.state === "refused" && <p role="alert" className="t-body p-danger">{previewed.refusal.error}</p>}
      {previewed?.state === "read" && <MailWrites preview={previewed.answer} />}
      {conflict !== null && <p className="t-meta p-text-2">{domain} already gets mail at {conflict.mx}, so Kinu's mail uses {conflict.suggestion} and leaves yours as it is.</p>}
    </div>
  );
}

/** The refusal the page last heard, in words, with what meets it. */
function Refused({ refusal, actions }: { refusal: DeployRefused; actions: ReadyActions }) {
  if (refusal.need !== null) return <NeedBox need={refusal.need} waiting={false} onHandedOff={actions.onHandedOff} onSignIn={actions.onSignIn} signingIn={actions.signingIn} />;

  return (
    <div data-deploy-refusal className="space-y-2">
      <p role="alert" className="t-body p-danger">{refusal.refused?.sentence ?? refusal.error}</p>
      {refusal.refused !== null && <CloudflareSaid words={refusal.refused.details} />}
    </div>
  );
}

function Checking() {
  return (
    <div data-deploy-checking className="space-y-5" aria-busy="true">
      <p className="inline-flex items-center gap-2 t-body"><Loader size="sm" />Looking at your Cloudflare account…</p>
      {[60, 75, 45].map((width) => (
        <div key={width} className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-4">
          <span className="h-3 w-16 rounded-[var(--r-pill)] p-fill" />
          <span className="h-3 rounded-[var(--r-pill)] p-fill" style={{ width: `${String(width)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** The account's checks, while they run or once they were refused; nothing once they are read. */
function NotYet({ checked, actions }: { checked: Reading<DeployPreflight> | null; actions: ReadyActions }) {
  if (checked?.state === "refused") return <Refused refusal={checked.refusal} actions={actions} />;

  return checked?.state === "read" ? null : <Checking />;
}

function workersAddress(preflight: DeployPreflight, name: string): string {
  return preflight.workersSubdomain === null ? `${name} on workers.dev` : `${name}.${preflight.workersSubdomain}.workers.dev`;
}

// ── A new Kinu ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the person has chosen for a new Kinu. */
interface Choices {
  readonly domain: PickedDomain | null;
  readonly computer: boolean;
  /** The mail host, or null for no mail. */
  readonly mail: string | null;
}

const NO_CHOICES: Choices = { domain: null, computer: false, mail: null };

function costOf(computer: boolean): string {
  return computer ? "$5 a month, on your Cloudflare bill" : "Free";
}

function AccountLine({ accounts, account, onAccount }: { accounts: readonly DeployChoice[]; account: string; onAccount: (id: string) => void }) {
  const named = accounts.find((each) => each.id === account)?.name ?? account;

  if (accounts.length < 2) return <Line label="Account"><span data-deploy-account className="t-body p-text">{named}</span></Line>;

  return (
    <Line label="Account">
      <div className="max-w-xs"><Select label="Cloudflare account" value={account} onChange={onAccount} options={accounts.map((each) => ({ value: each.id, label: each.name }))} /></div>
    </Line>
  );
}

function AddressLine({ preflight, name, domain, onDomain }: { preflight: DeployPreflight; name: string; domain: PickedDomain | null; onDomain: () => void }) {
  return (
    <Line label="Address">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span data-deploy-address className="t-item">{domain === null ? workersAddress(preflight, name) : domain.host}</span>
        <Button variant="ghost" size="sm" onClick={onDomain}>{domain === null ? "Use your own domain" : "Change"}</Button>
      </div>
      {domain?.zone === null && <p className="mt-1 t-meta">Kinu starts at {workersAddress(preflight, name)} and moves to {domain.host} once you point {domain.name} at Cloudflare.</p>}
      {preflight.workersSubdomain === null && domain === null && <p className="mt-1 t-meta">Your account gets its own workers.dev name with this deploy.</p>}
      {name !== DEFAULT_INSTANCE_NAME && <p className="mt-1 t-meta">Your account already has a Worker called {DEFAULT_INSTANCE_NAME}, so this one is {name}.</p>}
    </Line>
  );
}

function MailExtra({ account, domain, mail, onMail, onDomain }: {
  account: string; domain: PickedDomain | null; mail: string | null; onMail: (host: string | null) => void; onDomain: () => void;
}) {
  if (domain?.zone === undefined || domain.zone === null) {
    const copy = domain === null
      ? <>Needs your own domain. <Button variant="ghost" size="sm" onClick={onDomain}>Add one</Button></>
      : `Once ${domain.name} is on Cloudflare, add mail from here.`;

    return <Extra Icon={EnvelopeSimpleIcon} title="Mail at your domain" on={false} onChange={() => undefined} disabled copy={copy} />;
  }

  return (
    <Extra Icon={EnvelopeSimpleIcon} title="Mail at your domain" on={mail !== null} copy={`An inbox for you and your agents, like ada@${mail ?? domain.name}.`}
      onChange={(on) => onMail(on ? domain.name : null)}>
      {mail !== null && <MailChoice account={account} domain={domain.name} host={mail} onHost={onMail} />}
    </Extra>
  );
}

/** Asked of the run for what was chosen. */
function requestOf(account: string, name: string, choices: Choices): DeployRunRequest {
  const picked = choices.domain;

  const address = picked === null
    ? { kind: "workers" as const }
    : { kind: "domain" as const, ...(picked.zone === null ? { domain: picked.name } : { zone: picked.zone }), host: picked.host };

  return { kind: "new", account, name, address, computer: choices.computer, mail: choices.mail === null ? null : { host: choices.mail } };
}

function NewKinu({ session, actions, onDeploy, onBack }: { session: DeploySession; actions: ReadyActions; onDeploy: (asked: DeployRunRequest) => void; onBack: () => void }) {
  const [account, setAccount] = useState(session.accounts[0]?.id ?? "");
  const [handedOff, setHandedOff] = useState(false);
  const checked = useDeployRead(account, async () => readPreflight(account), { onFocus: true, every: handedOff ? RECHECK_MS : null });
  const [choosingDomain, setChoosingDomain] = useState(false);
  const [choices, setChoices] = useState<Choices>(NO_CHOICES);
  const onMail = useCallback((mail: string | null) => setChoices((held) => ({ ...held, mail })), []);
  const handOff = () => { setHandedOff(true); actions.onHandedOff(); };

  const preflight = checked?.state === "read" ? checked.answer : null;
  const name = preflight?.suggestedName ?? "";
  const kept = actions.refusal;

  if (choosingDomain) {
    const keep = preflight === null ? null : workersAddress(preflight, name);

    return (
      <DeployShell dot={1} screen="domain" title="Use your own domain"
        footer={(
          <>
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setChoosingDomain(false)}>Back</Button>
            {keep !== null && <Button variant="ghost" size="sm" onClick={() => { setChoices((held) => ({ ...held, domain: null, mail: null })); setChoosingDomain(false); }}>Keep {keep}</Button>}
          </>
        )}>
        <DeployDomain account={account} name={name === "" ? DEFAULT_INSTANCE_NAME : name} zones={preflight?.zones ?? []}
          onPick={(domain) => { setChoices((held) => ({ ...held, domain, mail: null })); setChoosingDomain(false); }} />
      </DeployShell>
    );
  }

  return (
    <DeployShell dot={1} screen="ready" title="Ready to deploy"
      footer={(
        <>
          {session.deployments.length > 0 && <Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>Back</Button>}
          {preflight !== null && <span className="hidden t-meta sm:inline">{costOf(choices.computer)}</span>}
          <Button variant="primary" busy={actions.deploying} disabled={preflight === null || preflight.needs.length > 0 || name === ""} data-deploy-go
            onClick={() => onDeploy(requestOf(account, name, choices))}>Deploy</Button>
        </>
      )}>
      <NotYet checked={checked} actions={{ ...actions, onHandedOff: handOff }} />
      {preflight !== null && (
        <div className="space-y-5">
          {preflight.needs.map((need) => <NeedBox key={need.id} need={need} waiting={handedOff} onHandedOff={handOff} onSignIn={actions.onSignIn} signingIn={actions.signingIn} />)}
          {kept !== null && <Refused refusal={kept} actions={{ ...actions, onHandedOff: handOff }} />}
          <AccountLine accounts={session.accounts} account={account} onAccount={(id) => { setAccount(id); setChoices(NO_CHOICES); }} />
          {name !== "" && <AddressLine preflight={preflight} name={name} domain={choices.domain} onDomain={() => setChoosingDomain(true)} />}
          <div className="space-y-4 pt-1">
            <p className="t-meta">Optional</p>
            <Extra Icon={CpuIcon} title="Should your agents get their own computers?" on={choices.computer}
              copy="Each can run code, builds and a browser. Needs Workers Paid, $5 a month; if your account isn't on it, Kinu asks when it gets there."
              onChange={(computer) => setChoices((held) => ({ ...held, computer }))} />
            <MailExtra account={account} domain={choices.domain} mail={choices.mail} onMail={onMail} onDomain={() => setChoosingDomain(true)} />
          </div>
          <div className="sm:hidden"><Line label="Cost"><span className="t-body p-text">{costOf(choices.computer)}</span></Line></div>
          <WhatGetsMade name={name === "" ? DEFAULT_INSTANCE_NAME : name} domain={choices.domain?.name ?? null} computer={choices.computer} mail={choices.mail} />
        </div>
      )}
    </DeployShell>
  );
}

// ── A change to an existing Kinu ───────────────────────────────────────────────────────────────────────────────────

function MoveToDomain({ kinu, actions, onChange, onBack }: { kinu: DeployedKinu; actions: ReadyActions; onChange: (asked: ChangeAsked) => void; onBack: () => void }) {
  const checked = useDeployRead(kinu.account, async () => readPreflight(kinu.account), { onFocus: true });
  const zones = checked?.state === "read" ? checked.answer.zones : [];

  return (
    <DeployShell dot={1} screen="domain" title="Move your Kinu to a domain" footer={<Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>Back</Button>}>
      <p className="mb-4 t-body">Your Kinu is live at {new URL(kinu.url).hostname}. Pick a domain and it moves there; the old address keeps working.</p>
      {actions.deploying && <p className="mb-4 inline-flex items-center gap-2 t-meta"><Loader size="sm" />Starting…</p>}
      {actions.refusal !== null && <div className="mb-4"><Refused refusal={actions.refusal} actions={actions} /></div>}
      <DeployDomain account={kinu.account} name={kinu.name} zones={zones}
        onPick={(picked) => onChange({ address: { kind: "domain", ...(picked.zone === null ? { domain: picked.name } : { zone: picked.zone }), host: picked.host } })} />
    </DeployShell>
  );
}

function AddMail({ kinu, actions, onChange, onBack }: { kinu: DeployedKinu; actions: ReadyActions; onChange: (asked: ChangeAsked) => void; onBack: () => void }) {
  const checked = useDeployRead(kinu.account, async () => readPreflight(kinu.account), { onFocus: true });
  const [chosen, setChosen] = useState<string | null>(null);
  const host = new URL(kinu.url).hostname;
  const zone = checked?.state === "read" ? zoneOf(checked.answer.zones, host) : undefined;
  const mailHost = chosen ?? zone?.name ?? null;

  return (
    <DeployShell dot={1} screen="mail" title="Add mail"
      footer={(
        <>
          <Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>Back</Button>
          <Button variant="primary" busy={actions.deploying} disabled={mailHost === null} onClick={() => { if (mailHost !== null) onChange({ mail: { host: mailHost } }); }}>Add mail</Button>
        </>
      )}>
      <NotYet checked={checked} actions={actions} />
      {checked?.state === "read" && (zone === undefined
        ? <p className="t-body">{host} is in no zone of this account Kinu can read, so mail can't be added here.</p>
        : <MailChoice account={kinu.account} domain={zone.name} host={mailHost ?? zone.name} onHost={setChosen} />)}
      {actions.refusal !== null && <div className="mt-4"><Refused refusal={actions.refusal} actions={actions} /></div>}
    </DeployShell>
  );
}

export function DeployReady({ session, readyFor, deploying, refusal, signingIn, onDeploy, onSignIn, onBack }: {
  session: DeploySession;
  readyFor: ReadyFor;
  deploying: boolean;
  refusal: DeployRefused | null;
  signingIn: boolean;
  onDeploy: (asked: DeployRunRequest) => void;
  onSignIn: () => void;
  onBack: () => void;
}) {
  const actions: ReadyActions = { deploying, refusal, signingIn, onSignIn, onHandedOff: () => undefined };

  if (readyFor.kind === "new") return <NewKinu session={session} actions={actions} onDeploy={onDeploy} onBack={onBack} />;

  const { kinu } = readyFor;
  const change = (asked: ChangeAsked) => onDeploy({ kind: "change", account: kinu.account, name: kinu.name, ...asked });

  return readyFor.kind === "domain"
    ? <MoveToDomain kinu={kinu} actions={actions} onChange={change} onBack={onBack} />
    : <AddMail kinu={kinu} actions={actions} onChange={change} onBack={onBack} />;
}
