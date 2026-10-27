/**
 * Ready to deploy: one screen holding the account, the address, the extras and Deploy. The account's checks run
 * silently on arrival and again when the person comes back from a hand-off; only what needs them shows. The same screen
 * changes an existing Kinu: its Domain step, or mail at its domain.
 */
import { useCallback, useEffect, useState } from "react";
import { CpuIcon, EnvelopeSimpleIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  DEFAULT_INSTANCE_NAME, gatewayCreditsUrl,
  type DeployAction, type DeployChoice, type DeployedKinu, type DeployPreflight, type DeployRunRequest, type DeploySession, type DeployZone,
  type GatewayCredits, type MailPreview, type MailPurpose,
} from "@kinu.run/core/deploy";
import { fmtUsd } from "@kinu.run/core";
import { Button } from "@/components/ui/Button";
import { RadioGroup } from "@/components/ui/Check";
import { Loader } from "@/components/ui/Loader";
import { Select } from "@/components/ui/Select";
import {
  DeployShell, Disclosure, Extra, HandOff, Lack, Line, NeedBox, Refused, Unreadable, WhatGetsMade, type RefusalActions,
} from "@/components/deploy/DeployParts";
import { DeployDomain, type PickedDomain } from "@/components/deploy/DeployDomain";
import { useDeployRead, type Reading } from "@/components/deploy/use-deploy-read";
import { readMailPreview, readPreflight, type DeployRefused } from "@/lib/deploy-page-api";
import { Skeleton } from "@/components/ui/Skeleton";
import { Card } from "@/components/ui/Card";
import { Group } from "@/components/ui/Group";
import { IconTile } from "@/components/ui/IconTile";

/** How often the account is read again while a hand-off to Cloudflare is open. */
const RECHECK_MS = 5000;

/** What this screen does: a new Kinu, or one change to an existing one. */
export type ReadyFor = { readonly kind: "new" } | { readonly kind: "domain" | "mail"; readonly kinu: DeployedKinu };

/** What a change to an existing Kinu asks, past the Kinu it is. */
type ChangeAsked = Omit<Extract<DeployRunRequest, { kind: "change" }>, "kind" | "account" | "name">;

/** The page's side of the screen: what it is doing, the refusal it last heard, and what it does for the person. */
interface ReadyActions extends RefusalActions {
  readonly deploying: boolean;
  readonly refusal: DeployRefused | null;
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

/**
 * Mail at a domain: its apex, or its mail subdomain where the apex gets mail elsewhere; what it adds, read first.
 * `onReady` hears whether the chosen host can take Kinu's mail: read, and getting none elsewhere.
 */
function MailChoice({ account, domain, host, onHost, onReady }: {
  account: string; domain: string; host: string; onHost: (host: string) => void; onReady: (ready: boolean) => void;
}) {
  const previewed = useDeployRead(`${account}/${host}`, async () => readMailPreview(account, host));
  const conflict = previewed?.state === "read" ? previewed.answer.conflict : null;
  const ready = previewed?.state === "read" && conflict === null;
  const sub = `mail.${domain}`;
  // Where the apex's mail goes, once it has moved Kinu's onto the subdomain: said beside the choice, and never moved again.
  const [moved, setMoved] = useState<string | null>(null);

  useEffect(() => {
    if (conflict === null || host !== domain || moved !== null || conflict.suggestion !== sub) return;

    setMoved(conflict.mx);
    onHost(sub);
  }, [conflict, host, domain, sub, moved, onHost]);

  useEffect(() => { onReady(ready); }, [ready, onReady]);

  return (
    <div className="space-y-3" data-deploy-mail={host}>
      <RadioGroup label="Where mail goes" value={host === domain ? "apex" : "sub"} onChange={(at) => onHost(at === "apex" ? domain : sub)}
        options={[{ value: "apex", label: `At ${domain}, like ada@${domain}` }, { value: "sub", label: `At ${sub}, like ada@${sub}` }]} />
      {previewed?.state === "reading" && <p className="inline-flex items-center gap-2 t-meta"><Loader size="sm" />Reading {host}…</p>}
      {previewed?.state === "refused" && <p role="alert" className="t-public-body p-danger">{previewed.refusal.error}</p>}
      {previewed?.state === "read" && conflict === null && <MailWrites preview={previewed.answer} />}
      {moved !== null && host === sub && <p className="t-meta p-text-2">{domain} already gets mail at {moved}, so Kinu's mail uses {sub} and leaves yours as it is.</p>}
      {conflict !== null && <p role="alert" className="t-public-body p-danger">{host} already gets mail at {conflict.mx}. Kinu's mail can't go there without taking it over; choose the other, or leave mail off.</p>}
    </div>
  );
}

function Checking() {
  return (
    <div data-deploy-checking className="space-y-5" aria-busy="true">
      <p className="inline-flex items-center gap-2 t-public-body"><Loader size="sm" />Looking at your Cloudflare account…</p>
      {[60, 75, 45].map((width) => (
        <div key={width} className="grid gap-2 sm:grid-cols-[var(--layout-plan-line)] sm:gap-4">
          <Skeleton width="4rem" />
          <Skeleton width={`${String(width)}%`} />
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

/** The hand-off a credits purchase is: the account is read again until its credits change. */
const CREDITS = "credits";

/**
 * What the deployment's web searches are paid from: AI credits on the account, how many are left, and Cloudflare's page
 * to buy more. Never blocks Deploy: a key of the person's own pays for search as well.
 */
function Credits({ account, credits, waiting, onHandedOff }: { account: string; credits: GatewayCredits | null; waiting: boolean; onHandedOff: () => void }) {
  if (credits === null) return null;
  const empty = credits.balance <= 0;
  const topUp = credits.autoTopUp === null ? "" : `, topped up by ${fmtUsd(credits.autoTopUp.amount)} below ${fmtUsd(credits.autoTopUp.threshold)}`;

  return (
    <div data-deploy-credits={empty ? "empty" : "held"} className="flex items-start gap-3">
      <IconTile size="xl"><MagnifyingGlassIcon size={18} className={empty ? "p-text-3" : "p-accent-fg"} /></IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="t-public-item">AI credits for web search</div>
          <div className="mt-px t-meta">
            {empty
              ? "Web search is paid from these. Your account has none yet, so search won't work until you add some. Cloudflare adds 5%."
              : `${fmtUsd(credits.balance)} left${topUp}. Web search is paid from these.`}
          </div>
          {empty && <div className="mt-1 t-meta">Or add your own Exa key later, in your Kinu's settings.</div>}
          {waiting && <p className="mt-1 inline-flex items-center gap-2 t-meta"><Loader size="sm" />Waiting for Cloudflare…</p>}
        </div>
        <div className="shrink-0">
          <HandOff action={{ label: empty ? "Add credits" : "Manage", href: gatewayCreditsUrl(account) }} onOpened={onHandedOff} />
        </div>
      </div>
    </div>
  );
}

/** What a Kinu costs, whatever the account already had: Workers Paid, which its agents run on. */
const COST = "Workers Paid, $5 a month, on your Cloudflare bill";

/** The needs the Before deploying card lists: the plan and R2, each met on Cloudflare's dashboard. */
const LACKS = {
  plan: { title: "Workers Paid", copy: "$5 a month. Kinu's agents run on it." },
  r2: { title: "R2", copy: "Cloudflare's file storage, for your files. Free; Cloudflare asks for a card the first time, if it hasn't one." },
} satisfies Readonly<Record<string, { readonly title: string; readonly copy: string }>>;

type LackId = keyof typeof LACKS;

const isLack = (id: string): id is LackId => id in LACKS;

/**
 * What the account still lacks before it can take a Kinu, each a row with its one action, ticked here once Cloudflare
 * reports it met: `seen` is every lack this visit read, so one met since stays as done. An account that had everything
 * from the first read never shows it.
 */
function BeforeDeploying({ preflight, seen, waitingOn, onHandedOff }: {
  preflight: DeployPreflight; seen: readonly LackId[]; waitingOn: string | null; onHandedOff: (need: string) => void;
}) {
  if (seen.length === 0) return null;
  const open = preflight.needs.filter((need) => isLack(need.id));
  const left = open.length;
  const things = left === 1 ? "one thing" : `${String(left)} things`;

  return (
    <div data-deploy-before>
      <Card title="Before deploying">
      <p className="t-public-body">
        {left === 0 ? "All done. You can deploy." : `Your account needs ${things} first.`}
      </p>
      <Group list>
        {seen.map((id) => {
          const need = open.find((each) => each.id === id);
          const href = need?.action.href;

          return (
            <Lack key={id} name={id} done={need === undefined} title={LACKS[id].title} copy={LACKS[id].copy} waiting={waitingOn === id}
              action={href === undefined || need === undefined ? null : <HandOff action={{ label: need.action.label, href }} onOpened={() => onHandedOff(id)} />} />
          );
        })}
      </Group>
      </Card>
    </div>
  );
}

/** Cloudflare's dashboard, where a login with no account behind it makes one. */
const CREATE_ACCOUNT = { label: "Create an account", href: "https://dash.cloudflare.com/" } satisfies DeployAction;

/** A login with no Cloudflare account behind it: the one row, to make one; the page reads its session again on coming back. */
function NoAccount() {
  return (
    <div data-deploy-before>
      <Card title="Before deploying">
        <p className="t-public-body">This Cloudflare login has no account yet. Create one, then come back: this page goes on by itself.</p>
        <Group list>
          <Lack name="account" done={false} title="A Cloudflare account" copy="Free to make." waiting={false}
            action={<HandOff action={CREATE_ACCOUNT} />} />
        </Group>
      </Card>
    </div>
  );
}

function AccountLine({ accounts, account, onAccount }: { accounts: readonly DeployChoice[]; account: string; onAccount: (id: string) => void }) {
  const named = accounts.find((each) => each.id === account)?.name ?? account;

  if (accounts.length < 2) return <Line label="Account"><span data-deploy-account className="t-public-body p-text">{named}</span></Line>;

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
        <span data-deploy-address className="t-public-item">{domain === null ? workersAddress(preflight, name) : domain.host}</span>
        <Button variant="ghost" size="sm" onClick={onDomain}>{domain === null ? "Use your own domain" : "Change"}</Button>
      </div>
      {domain?.zone === null && <p className="mt-1 t-meta">Kinu starts at {workersAddress(preflight, name)} and moves to {domain.host} once you point {domain.name} at Cloudflare.</p>}
      {preflight.workersSubdomain === null && domain === null && <p className="mt-1 t-meta">Your account gets its own workers.dev name with this deploy.</p>}
      {name !== DEFAULT_INSTANCE_NAME && <p className="mt-1 t-meta">Your account already has a Worker called {DEFAULT_INSTANCE_NAME}, so this one is {name}.</p>}
    </Line>
  );
}

function MailExtra({ account, domain, mail, onMail, onReady, onDomain }: {
  account: string; domain: PickedDomain | null; mail: string | null; onMail: (host: string | null) => void; onReady: (ready: boolean) => void; onDomain: () => void;
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
      {mail !== null && <MailChoice account={account} domain={domain.name} host={mail} onHost={onMail} onReady={onReady} />}
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

/** A new Kinu's Domain step: a domain picked, or workers.dev kept (`null`). */
function NewDomain({ account, name, preflight, onPick, onBack }: {
  account: string; name: string; preflight: DeployPreflight | null; onPick: (domain: PickedDomain | null) => void; onBack: () => void;
}) {
  const keep = preflight === null ? null : workersAddress(preflight, name);

  return (
    <DeployShell dot={1} screen="domain" title="Use your own domain"
      footer={(
        <>
          <Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>Back</Button>
          {keep !== null && <Button variant="ghost" size="sm" onClick={() => onPick(null)}>Keep {keep}</Button>}
        </>
      )}>
      <DeployDomain account={account} name={name === "" ? DEFAULT_INSTANCE_NAME : name} zones={preflight?.zones ?? []} onPick={onPick} />
    </DeployShell>
  );
}

function NewKinu({ session, actions, onDeploy, onBack }: { session: DeploySession; actions: ReadyActions; onDeploy: (asked: DeployRunRequest) => void; onBack: () => void }) {
  if (session.accounts.length === 0) {
    return (
      <DeployShell dot={1} screen="ready" title="Ready to deploy"
        footer={<Button variant="primary" size="lg" disabled data-deploy-go>Deploy</Button>}>
        <NoAccount />
      </DeployShell>
    );
  }

  return <ForAccount session={session} actions={actions} onDeploy={onDeploy} onBack={onBack} />;
}

/** Every lack this account was read with on this visit, in the order first read: one met since is shown done. */
function useSeenLacks(preflight: DeployPreflight | null): readonly LackId[] {
  const [seen, setSeen] = useState<readonly LackId[]>([]);
  // The lacks this read says, as one key, so a read that says the same leaves `seen` as it was.
  const lacking = (preflight?.needs.map((need) => need.id).filter(isLack) ?? []).join(" ");

  useEffect(() => {
    const now = lacking.split(" ").filter(isLack);

    setSeen((had) => (now.every((id) => had.includes(id)) ? had : [...had, ...now.filter((id) => !had.includes(id))]));
  }, [lacking]);

  return seen;
}

/** The foot of Ready: Back where there are Kinus to go back to, what it costs, and Deploy. */
function ReadyFoot({ back, cost, deploying, blocked, onDeploy, onBack }: {
  back: boolean; cost: boolean; deploying: boolean; blocked: boolean; onDeploy: () => void; onBack: () => void;
}) {
  return (
    <>
      {back && <Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>Back</Button>}
      {cost && <span className="hidden t-meta sm:inline">{COST}</span>}
      <Button variant="primary" size="lg" busy={deploying} disabled={blocked} data-deploy-go onClick={onDeploy}>Deploy</Button>
    </>
  );
}

function ForAccount({ session, actions, onDeploy, onBack }: { session: DeploySession; actions: ReadyActions; onDeploy: (asked: DeployRunRequest) => void; onBack: () => void }) {
  const [account, setAccount] = useState(session.accounts[0]?.id ?? "");
  // The need a hand-off was opened for: the account is read again every few seconds until it is met.
  const [handedOff, setHandedOff] = useState<string | null>(null);
  // The credits a purchase was opened at: any change to them is the purchase landing.
  const [creditsAt, setCreditsAt] = useState<string | null>(null);
  const checked = useDeployRead(account, async () => readPreflight(account), { onFocus: true, every: handedOff === null ? null : RECHECK_MS });
  const [choosingDomain, setChoosingDomain] = useState(false);
  const [choices, setChoices] = useState<Choices>(NO_CHOICES);
  const [mailReady, setMailReady] = useState(false);
  const onMail = useCallback((mail: string | null) => setChoices((held) => ({ ...held, mail })), []);
  const handOff = (need: string) => { setHandedOff(need); actions.onHandedOff(need); };

  const preflight = checked?.state === "read" ? checked.answer : null;
  const name = preflight?.suggestedName ?? "";
  const kept = actions.refusal;

  const met = preflight !== null && handedOff !== null && (handedOff === CREDITS
    ? JSON.stringify(preflight.credits) !== creditsAt
    : !preflight.needs.some((need) => need.id === handedOff));

  const seen = useSeenLacks(preflight);
  const blocked = preflight === null || preflight.needs.length > 0 || name === "" || (choices.mail !== null && !mailReady);

  // The need the hand-off was for is met: stop reading the account every few seconds.
  useEffect(() => {
    if (met) setHandedOff(null);
  }, [met]);

  if (choosingDomain) {
    const pick = (domain: PickedDomain | null) => { setChoices((held) => ({ ...held, domain, mail: null })); setChoosingDomain(false); };

    return <NewDomain account={account} name={name} preflight={preflight} onPick={pick} onBack={() => setChoosingDomain(false)} />;
  }

  return (
    <DeployShell dot={1} screen="ready" title="Ready to deploy"
      footer={<ReadyFoot back={session.deployments.length > 0} cost={preflight !== null} deploying={actions.deploying} blocked={blocked}
        onDeploy={() => onDeploy(requestOf(account, name, choices))} onBack={onBack} />}>
      <Unreadable session={session} />
      <NotYet checked={checked} actions={{ ...actions, onHandedOff: handOff }} />
      {preflight !== null && (
        <div className="space-y-5">
          <BeforeDeploying preflight={preflight} seen={seen} waitingOn={handedOff} onHandedOff={handOff} />
          {preflight.needs.filter((need) => !isLack(need.id)).map((need) => (
            <NeedBox key={need.id} need={need} waiting={handedOff === need.id} onHandedOff={() => handOff(need.id)} onSignIn={actions.onSignIn} signingIn={actions.signingIn} />
          ))}
          {kept !== null && <Refused refusal={kept} actions={{ ...actions, onHandedOff: handOff }} />}
          <AccountLine accounts={session.accounts} account={account} onAccount={(id) => { setAccount(id); setChoices(NO_CHOICES); }} />
          {name !== "" && <AddressLine preflight={preflight} name={name} domain={choices.domain} onDomain={() => setChoosingDomain(true)} />}
          <div className="space-y-4 pt-1">
            <p className="t-meta">Optional</p>
            <Extra Icon={CpuIcon} title="Should your agents get their own computers?" on={choices.computer}
              copy="Each can run code, builds and a browser. Part of Workers Paid."
              onChange={(computer) => setChoices((held) => ({ ...held, computer }))} />
            <MailExtra account={account} domain={choices.domain} mail={choices.mail} onMail={onMail} onReady={setMailReady} onDomain={() => setChoosingDomain(true)} />
            <Credits account={account} credits={preflight.credits} waiting={handedOff === CREDITS}
              onHandedOff={() => { setCreditsAt(JSON.stringify(preflight.credits)); handOff(CREDITS); }} />
          </div>
          <div className="sm:hidden"><Line label="Cost"><span className="t-public-body p-text">{COST}</span></Line></div>
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
      <p className="mb-4 t-public-body">Your Kinu is live at {new URL(kinu.url).hostname}. Pick a domain and it moves there; the old address keeps working.</p>
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
  const [ready, setReady] = useState(false);
  const host = new URL(kinu.url).hostname;
  const zone = checked?.state === "read" ? zoneOf(checked.answer.zones, host) : undefined;
  const mailHost = chosen ?? zone?.name ?? null;

  return (
    <DeployShell dot={1} screen="mail" title="Add mail"
      footer={(
        <>
          <Button variant="ghost" size="sm" className="mr-auto" onClick={onBack}>Back</Button>
          <Button variant="primary" busy={actions.deploying} disabled={mailHost === null || !ready} onClick={() => { if (mailHost !== null) onChange({ mail: { host: mailHost } }); }}>Add mail</Button>
        </>
      )}>
      <NotYet checked={checked} actions={actions} />
      {checked?.state === "read" && (zone === undefined
        ? <p className="t-public-body">{host} is in no zone of this account Kinu can read, so mail can't be added here.</p>
        : <MailChoice account={kinu.account} domain={zone.name} host={mailHost ?? zone.name} onHost={setChosen} onReady={setReady} />)}
      {actions.refusal !== null && <div className="mt-4"><Refused refusal={actions.refusal} actions={actions} /></div>}
    </DeployShell>
  );
}

export function DeployReady({ session, readyFor, deploying, refusal, refusalActions, onDeploy, onBack }: {
  session: DeploySession;
  readyFor: ReadyFor;
  deploying: boolean;
  refusal: DeployRefused | null;
  refusalActions: RefusalActions;
  onDeploy: (asked: DeployRunRequest) => void;
  onBack: () => void;
}) {
  const actions: ReadyActions = { ...refusalActions, deploying, refusal };

  if (readyFor.kind === "new") return <NewKinu session={session} actions={actions} onDeploy={onDeploy} onBack={onBack} />;

  const { kinu } = readyFor;
  const change = (asked: ChangeAsked) => onDeploy({ kind: "change", account: kinu.account, name: kinu.name, ...asked });

  return readyFor.kind === "domain"
    ? <MoveToDomain kinu={kinu} actions={actions} onChange={change} onBack={onBack} />
    : <AddMail kinu={kinu} actions={actions} onChange={change} onBack={onBack} />;
}
