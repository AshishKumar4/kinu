/**
 * The self-deploy flow, redesigned (a wireframe for the owner's approval; docs/SELF-DEPLOY-FLOW.md stays the behaviour
 * spec). It wears onboarding's shell: one centred card, progress dots, one decision per screen, Back and the one action
 * at its foot. Four screens: Start, Ready to deploy (with its Domain step), Deploying, Live. Nothing here signs in to
 * Cloudflare or deploys: its account, domains, prices and Cloudflare's words are fixtures.
 *
 * `&screen=` opens a screen and each screen's own parameters one of its states; every click keeps the address bar on the
 * state it shows, so each is a link. It is the whole app's `/deploy` (gallery-app.tsx), whose design bar lists its
 * states (`SELF_DEPLOY_STATES`) and holds the look, mode and device.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { CloudflareLogo, Loader } from "@cloudflare/kumo";
import { Button } from "@/components/ui/Button";
import {
  ArrowSquareOutIcon, ArrowsClockwiseIcon, CaretDownIcon, CaretRightIcon, CheckIcon, CircleIcon, CpuIcon, EnvelopeSimpleIcon, GlobeHemisphereWestIcon,
  LinkIcon, MagnifyingGlassIcon, TerminalWindowIcon, WarningCircleIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { CopyButton } from "@/components/ui/CopyButton";
import { Switch } from "@/components/ui/Switch";
import { inputCls } from "@/components/ui/form";
import { ChatMascot } from "@/components/Marks";

/** The dots: Start, Ready (and its Domain step), Deploying, Live. */
const SCREENS = ["start", "manage", "ready", "domain", "deploying", "live"] as const;

type Screen = (typeof SCREENS)[number];

const DOT: Record<Screen, number> = { start: 0, manage: 1, ready: 1, domain: 1, deploying: 2, live: 3 };

/** Every state the frame shows, as its address bar names it. */
interface FlowState {
  screen: Screen;
  /** `new`: a first Kinu. `existing`: the person's Kinu is live, and the flow changes it (a domain, mail, a setup link). */
  entry: "new" | "existing";
  /** Cloudflare's consent: `declined` came back without it. */
  consent: "given" | "declined";
  /** How many accounts the person can deploy to: a picker only for more than one. */
  accounts: "one" | "many";
  /** The silent checks after sign-in: still `checking`; `clear`; `r2` R2 is off; `r2-waiting` its hand-off is open;
   *  `name-taken` a Worker named kinu is already there, so `suggestedName` is the next free one and the address says so. */
  preflight: "checking" | "clear" | "r2" | "r2-waiting" | "name-taken";
  /** The address: workers.dev (`none`), or a domain `yours` in the account, being `bought`, or registered `elsewhere`. */
  domain: "none" | "yours" | "bought" | "elsewhere";
  /** The Domain step: what the search shows. `results` for a name; `buying` its Cloudflare hand-off is open. */
  search: "empty" | "results" | "buying";
  /** The computer: `off`; `on` with Workers Paid; `upgrade` asked for on the free plan; `upgrading` its hand-off open. */
  computer: "off" | "on" | "upgrade" | "upgrading";
  /** Mail at the domain: `off`, `on`, or `conflict` the domain already gets mail elsewhere. */
  mail: "off" | "on" | "conflict";
  /** The Live screen's link: `first` a new Kinu's; `new` one minted again for an existing Kinu. */
  link: "first" | "new";
  /** An existing Kinu's build: `behind` the release channel, `current` on it, `blocked` behind but not installable here. */
  update: "behind" | "current" | "blocked";
  /** How many Kinus the person has: `two` lists them first, one made here and one by `kinu deploy cloudflare`. */
  kinus: "one" | "two";
  /** What the run does: `deploy` a new Kinu, `update` an existing one to the channel's build. */
  kind: "deploy" | "update";
  /** The run: `running`; `paused` on a prerequisite; `signin` paused past an hour, so it let go of the account's
   *  access and asks for sign-in again; `refused` with its fix; `resume` an unfinished one found again. */
  run: "running" | "paused" | "signin" | "refused" | "resume";
}

const DEFAULTS: FlowState = {
  screen: "start", entry: "new", consent: "given", accounts: "one", preflight: "clear", domain: "none", search: "empty",
  computer: "off", mail: "off", link: "first", update: "behind", kinus: "one", kind: "deploy", run: "running",
};

/** Each parameter's values, typed by the state it sets. */
type Options = { readonly [K in keyof FlowState]: readonly FlowState[K][] };

const OPTIONS: Options = {
  screen: SCREENS,
  entry: ["new", "existing"],
  consent: ["given", "declined"],
  accounts: ["one", "many"],
  preflight: ["checking", "clear", "r2", "r2-waiting", "name-taken"],
  domain: ["none", "yours", "bought", "elsewhere"],
  search: ["empty", "results", "buying"],
  computer: ["off", "on", "upgrade", "upgrading"],
  mail: ["off", "on", "conflict"],
  link: ["first", "new"],
  update: ["behind", "current", "blocked"],
  kinus: ["one", "two"],
  kind: ["deploy", "update"],
  run: ["running", "paused", "signin", "refused", "resume"],
};

const KEYS = ["screen", "entry", "consent", "accounts", "preflight", "domain", "search", "computer", "mail", "link", "update", "kinus", "kind", "run"] as const satisfies readonly (keyof FlowState)[];

/** The value `said` names among `options`; else `fallback`. */
function oneOf<T extends string>(said: string | null, options: readonly T[], fallback: T): T {
  return options.find((each) => each === said) ?? fallback;
}

function stateOf(search: string): FlowState {
  const params = new URLSearchParams(search);
  const read = <K extends keyof FlowState>(key: K): FlowState[K] => oneOf(params.get(key), OPTIONS[key], DEFAULTS[key]);

  return {
    screen: read("screen"), entry: read("entry"), consent: read("consent"), accounts: read("accounts"), preflight: read("preflight"),
    domain: read("domain"), search: read("search"), computer: read("computer"), mail: read("mail"), link: read("link"),
    update: read("update"), kinus: read("kinus"), kind: read("kind"), run: read("run"),
  };
}

/** The frame's address for `state`: only what differs from the defaults, keeping the review's own (`theme`, `device`). */
function hrefOf(state: FlowState): string {
  const params = new URLSearchParams(location.search);

  for (const key of KEYS) {
    if (state[key] === DEFAULTS[key]) params.delete(key);
    else params.set(key, state[key]);
  }

  return `${location.pathname}?${params.toString()}`;
}

type Go = (next: Partial<FlowState>) => void;

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: "a1", name: "Ada Lovelace's account" },
  { id: "a2", name: "Flour & Hearth" },
] as const;

const WORKERS_ADDRESS = "kinu.ada.workers.dev";

const workersAddressOf = (state: FlowState): string => `${nameOf(state)}.ada.workers.dev`;

const YOUR_DOMAIN = "flourandhearth.com";

const BOUGHT_DOMAIN = "adalovelace.dev";

const ELSEWHERE_DOMAIN = "ada.dev";

const NAMESERVERS = ["ada.ns.cloudflare.com", "jim.ns.cloudflare.com"] as const;

/** What mail adds to the domain's DNS, as `GET /api/deploy/mail` lists it before anything is written. */
const MAIL_WRITES = [
  "Two records that bring its mail to Cloudflare (MX)",
  "One that lets Cloudflare send for it (SPF)",
  "A signing key, so mail from it is trusted (DKIM)",
] as const;

/** What a search for "adalovelace" finds, as `GET /api/deploy/domains` would answer it. */
const FOUND: readonly { name: string; state: "available" | "taken"; price?: string }[] = [
  { name: "adalovelace.dev", state: "available", price: "$12.18 a year" },
  { name: "adalovelace.app", state: "available", price: "$14.20 a year" },
  { name: "adalovelace.com", state: "taken" },
];

/** The run's phases (`prepare`, `storage`, `upload`, `address`, `mail`, `check`, `live`), in plain words; mail's only when asked. */
const PHASES = [
  "Preparing your account",
  "Creating storage",
  "Uploading Kinu",
  "Putting it on your address",
  "Setting up mail",
  "Checking it answers",
  "Going live",
] as const;

/** Where each run state stands. */
const RUN_AT: Record<FlowState["run"], number> = { running: 2, paused: 1, signin: 1, refused: 3, resume: 3 };

/** The Worker's name: kinu, or the next free one when the account already has a kinu. */
function nameOf(state: FlowState): string {
  return state.preflight === "name-taken" ? "kinu-2" : "kinu";
}

function domainOf(state: FlowState): string | null {
  if (state.domain === "yours") return YOUR_DOMAIN;

  if (state.domain === "bought") return BOUGHT_DOMAIN;

  return state.domain === "elsewhere" ? ELSEWHERE_DOMAIN : null;
}

/** Where Kinu answers once it is live: a domain the account holds now, else workers.dev (an elsewhere domain follows). */
function addressOf(state: FlowState): string {
  const domain = domainOf(state);

  return domain === null || state.domain === "elsewhere" ? WORKERS_ADDRESS : `kinu.${domain}`;
}

/** Your Kinu's face: the product's own mascot in Kinu's amber; bare while it works, in a party hat once it is live. */
const KINU_HUE = 62;

function KinuFace({ activity, live = false }: { activity: "working" | "waiting" | "idle" | "done"; live?: boolean }) {
  return <ChatMascot seed={live ? "deploy/kinu" : "self-deploy/kinu"} colour={KINU_HUE} activity={activity} size={56} />;
}

// ── Parts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one large action a screen has: onboarding's filled button at the size a decision deserves. */
function PrimaryButton({ children, onClick, disabled = false, wide = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; wide?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`p-btn inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold disabled:opacity-50 ${wide ? "w-full" : ""}`}>
      {children}
    </button>
  );
}

/**
 * Cloudflare's cloud, in its own colours on a white tile: its guidelines keep the full-colour mark on white and rule
 * out black on orange, and white would vanish on the light amber of the dark theme.
 */
function CloudflareMark() {
  return (
    <span aria-hidden className="flex h-6 w-8 shrink-0 items-center justify-center rounded-md bg-white">
      <CloudflareLogo variant="glyph" className="w-[18px]" />
    </span>
  );
}

function CloudflareButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <PrimaryButton onClick={onClick}><CloudflareMark />{children}</PrimaryButton>;
}

/** A hand-off to Cloudflare's dashboard: the one action, opening beside the page. */
function HandOffButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border p-border px-3 text-[13px] font-medium p-text transition-colors hover:bg-[var(--c-neutral-tint)]">
      {label}<ArrowSquareOutIcon size={13} className="p-text-3" />
    </button>
  );
}

/** Folded away until asked: what is made, Cloudflare's own words, the CLI. */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 p-meta p-text-3 hover:p-text [&::-webkit-details-marker]:hidden">
        <CaretDownIcon size={11} className="-rotate-90 transition-transform group-open:rotate-0" />{summary}
      </summary>
      <div className="mt-2.5">{children}</div>
    </details>
  );
}

/** Cloudflare's words and code, for whoever wants them: small, plain, copyable. */
function CloudflareSaid({ message, code }: { message: string; code: string }) {
  const details = `${message} (${code})`;

  return (
    <Disclosure summary="Details">
      <div className="flex items-start gap-2 rounded-lg bg-[var(--c-recessed)] px-3 py-2.5">
        <p className="min-w-0 flex-1 p-t-code p-text-2">Cloudflare said: {message} <span className="p-text-3">{code}</span></p>
        <CopyButton value={details} what="the details" className="p-text-3 hover:p-text shrink-0" />
      </div>
    </Disclosure>
  );
}

/** A thing that waits on the person: one sentence, one action, and how the page will know. */
function Needs({ children, action, waiting, note }: { children: ReactNode; action: ReactNode; waiting: boolean; note: string }) {
  return (
    <div data-deploy-needs className="rounded-xl bg-[var(--c-accent-subtle)] px-4 py-3.5">
      <p className="p-row-text p-text">{children}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {waiting
          ? <span className="inline-flex items-center gap-2 p-meta p-text-2"><Loader size="sm" />{note}</span>
          : action}
      </div>
    </div>
  );
}

/** What gets made, in plain words, behind its disclosure. */
function WhatGetsMade({ state }: { state: FlowState }) {
  const lines = [
    "The Kinu app, as a Worker named kinu",
    "Storage for your files, chats and memory",
    "An AI gateway, so Kinu can use Cloudflare's models",
    ...state.computer === "off" ? [] : ["Computers your agents run code on"],
    ...domainOf(state) === null ? [] : [`An address on ${domainOf(state) ?? ""}`],
    ...state.mail === "off" ? [] : ["Mail records for your domain"],
  ];

  return (
    <Disclosure summary="What gets made in your account">
      <ul className="space-y-1.5 p-meta p-text-2">
        {lines.map((line) => <li key={line} className="flex items-start gap-2"><CheckIcon size={12} className="mt-0.5 shrink-0 p-text-3" />{line}</li>)}
      </ul>
      <p className="mt-2.5 p-meta p-text-3">Nothing else in your account changes, and you can remove all of it from Cloudflare any time.</p>
    </Disclosure>
  );
}

// ── Start ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the landing shows how to run Kinu on your own computer. */
const LOCAL_INSTALL = "/#platform";

function StartScreen({ state, go }: { state: FlowState; go: Go }) {
  return (
    <Card title={null}
      footer={(
        <>
          <span />
          <CloudflareButton onClick={() => go({ screen: "ready", consent: "given", preflight: "checking" })}>
            {state.consent === "declined" ? "Sign in again" : "Continue with Cloudflare"}
          </CloudflareButton>
        </>
      )}>
      <div className="space-y-3 p-row-text p-text-2">
        <p>Kinu on the web runs on Cloudflare. This sets up a Kinu of your own on your own Cloudflare account, private to you, and takes you through it one step at a time.</p>
        <p>It runs on Cloudflare's free plan. Computers for your agents are $5 a month, and only if you want them.</p>
      </div>
      {state.consent === "declined" && (
        <div data-deploy-refusal className="mt-5 space-y-2">
          <p className="p-row-text p-text">Cloudflare didn't give Kinu access, so nothing was made.</p>
          <CloudflareSaid message="The user denied the request." code="access_denied" />
        </div>
      )}
      <div className="mt-5"><WhatGetsMade state={state} /></div>
      <p data-deploy-local className="mt-6 border-t p-border pt-4 p-meta p-text-3">
        Or run Kinu on your own computer, with nothing else to set up. <a href={LOCAL_INSTALL} className="p-accent hover:underline">How to install it</a>
      </p>
    </Card>
  );
}

// ── An existing Kinu ──────────────────────────────────────────────────────────────────────────────────────────────

/** One change an existing Kinu can have: what it is, what it needs, and where it goes. */
function Change({ Icon, title, copy, onPick, disabled = false }: { Icon: PhosphorIcon; title: string; copy: string; onPick: () => void; disabled?: boolean }) {
  return (
    <li>
      <button type="button" onClick={onPick} disabled={disabled}
        className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors enabled:hover:bg-[var(--c-neutral-tint)] disabled:opacity-60">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg p-fill"><Icon size={18} className="p-accent" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold p-text">{title}</span>
          <span className="mt-0.5 block p-meta p-text-3">{copy}</span>
        </span>
        {!disabled && <CaretRightIcon size={14} className="shrink-0 p-text-3" />}
      </button>
    </li>
  );
}

/** A build as `session.deployments[].update` names it. */
interface Build {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
}

const YOUR_BUILD: Build = { version: "0.1.0+3c19318", sha: "3c19318", builtAt: "14 October" };

const LATEST_BUILD: Build = { version: "0.1.0+694e257", sha: "694e257", builtAt: "20 October" };

/** Why an update can't start from this page, as the backend's `reason` says it. */
const UPDATE_BLOCKED = "This Kinu was set up by hand, so update it with kinu deploy cloudflare from your terminal.";

/** The update line: what you have, what is out, and the one action; or that it is current, or why it can't start here. */
function UpdateChange({ state, go }: { state: FlowState; go: Go }) {
  if (state.update === "current") {
    return (
      <li data-deploy-update="current" className="flex items-center gap-3 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg p-fill"><CheckIcon size={16} className="text-[var(--c-success)]" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold p-text">Up to date</span>
          <span className="mt-0.5 block p-meta p-text-3">{LATEST_BUILD.version}, built {LATEST_BUILD.builtAt}</span>
        </span>
      </li>
    );
  }

  const versions = `You have ${YOUR_BUILD.version}, built ${YOUR_BUILD.builtAt}. The latest is ${LATEST_BUILD.version}, built ${LATEST_BUILD.builtAt}.`;

  return state.update === "blocked"
    ? <Change Icon={ArrowsClockwiseIcon} title="An update is out" copy={`${versions} ${UPDATE_BLOCKED}`} disabled onPick={() => {}} />
    : <Change Icon={ArrowsClockwiseIcon} title="Update to the latest" copy={versions} onPick={() => go({ screen: "deploying", kind: "update", run: "running" })} />;
}

/** Every Kinu this Cloudflare user has, made here or with `kinu deploy cloudflare`. */
const KINUS = [
  { address: WORKERS_ADDRESS, account: ACCOUNTS[0].name, made: "Made here" },
  { address: "kinu.flourandhearth.com", account: ACCOUNTS[1].name, made: "Made with kinu deploy cloudflare" },
] as const;

function KinuList({ go }: { go: Go }) {
  return (
    <ul className="space-y-1">
      {KINUS.map((kinu) => (
        <Change key={kinu.address} Icon={GlobeHemisphereWestIcon} title={kinu.address} copy={`${kinu.account} · ${kinu.made}`} onPick={() => go({ kinus: "one" })} />
      ))}
    </ul>
  );
}

function ManageScreen({ state, go }: { state: FlowState; go: Go }) {
  const many = state.kinus === "two";

  return (
    <Card title={many ? "Your Kinus" : "Your Kinu"}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={() => go({ screen: "start", entry: "new" })}>Back</Button>
          <button type="button" onClick={() => go({ screen: "ready", entry: "new", preflight: "checking" })} className="p-btn-ghost inline-flex h-6.5 items-center rounded-md px-2 text-xs">Deploy another Kinu</button>
        </>
      )}>
      {many ? <KinuList go={go} /> : (
        <>
          <p className="p-row-text p-text-2">It's live at <a href={`https://${WORKERS_ADDRESS}`} className="font-medium p-text hover:underline">{WORKERS_ADDRESS}</a>, in {ACCOUNTS[0].name}.</p>
          <ul className="mt-4 space-y-1">
            <UpdateChange state={state} go={go} />
            <Change Icon={GlobeHemisphereWestIcon} title="Add a domain" copy="Move it to an address of your own. This one keeps working."
              onPick={() => go({ screen: "domain", entry: "existing", search: "empty" })} />
            <Change Icon={EnvelopeSimpleIcon} title="Add mail" copy="Needs a domain first." disabled onPick={() => {}} />
            <Change Icon={LinkIcon} title="Get a new setup link" copy="If the first one ran out or went missing."
              onPick={() => go({ screen: "live", entry: "existing", link: "new" })} />
          </ul>
        </>
      )}
    </Card>
  );
}

// ── Ready to deploy ───────────────────────────────────────────────────────────────────────────────────────────────

/** One labelled line of the plan: its name on the left at desktop, above at phone width. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr] sm:items-baseline sm:gap-4">
      <span className="p-meta p-text-3">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function AccountLine({ state }: { state: FlowState }) {
  if (state.accounts === "one") return <Line label="Account"><span className="p-row-text p-text">{ACCOUNTS[0].name}</span></Line>;

  return (
    <Line label="Account">
      <select aria-label="Cloudflare account" className={`${inputCls} max-w-xs`} defaultValue={ACCOUNTS[0].id}>
        {ACCOUNTS.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
    </Line>
  );
}

function AddressLine({ state, go }: { state: FlowState; go: Go }) {
  const domain = domainOf(state);

  return (
    <Line label="Address">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span data-deploy-address className="p-row-text font-medium p-text">{domain === null ? workersAddressOf(state) : `${nameOf(state)}.${domain}`}</span>
        <button type="button" onClick={() => go({ screen: "domain", search: "empty" })} className="p-meta p-accent hover:underline">
          {domain === null ? "Use your own domain" : "Change"}
        </button>
      </div>
      {state.domain === "elsewhere" && (
        <p className="mt-1 p-meta p-text-3">Kinu starts at {WORKERS_ADDRESS} and moves to kinu.{ELSEWHERE_DOMAIN} once you point the domain at Cloudflare.</p>
      )}
      {state.preflight === "name-taken" && domain === null && (
        <p className="mt-1 p-meta p-text-3">Your account already has a Worker called kinu, so this one is kinu-2.</p>
      )}
    </Line>
  );
}

/** An optional extra: what it gives, what it costs or needs, and its switch. */
function Extra({ Icon, title, copy, on, onChange, disabled = false, children }: {
  Icon: PhosphorIcon; title: string; copy: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <div className={disabled ? "opacity-60" : undefined}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg p-fill"><Icon size={18} className={on ? "p-accent" : "p-text-3"} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold p-text">{title}</div>
          <div className="mt-0.5 p-meta p-text-3">{copy}</div>
        </div>
        <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
      </div>
      {children !== undefined && <div className="mt-3 sm:pl-12">{children}</div>}
    </div>
  );
}

function ComputerExtra({ state, go }: { state: FlowState; go: Go }) {
  const upgrading = state.computer === "upgrading";

  return (
    <Extra Icon={CpuIcon} title="Should your agents get their own computers?" on={state.computer !== "off"}
      copy={state.computer === "on" ? "Each can run code, builds and a browser. On your Workers Paid plan." : "Each can run code, builds and a browser. Needs Workers Paid, $5 a month."}
      onChange={(on) => go({ computer: on ? "upgrade" : "off" })}>
      {(state.computer === "upgrade" || upgrading) && (
        <Needs waiting={upgrading} note="Waiting for the upgrade. This checks again when you come back."
          action={<HandOffButton label="Upgrade on Cloudflare" onClick={() => go({ computer: "upgrading" })} />}>
          Computers need Workers Paid. Upgrade on Cloudflare if your account isn't on it, then come back here.
        </Needs>
      )}
    </Extra>
  );
}

function MailExtra({ state, go }: { state: FlowState; go: Go }) {
  const domain = domainOf(state);

  if (domain === null) {
    return (
      <Extra Icon={EnvelopeSimpleIcon} title="Mail at your domain" on={false} onChange={() => go({ screen: "domain" })} disabled
        copy={<>Needs your own domain. <button type="button" onClick={() => go({ screen: "domain" })} className="p-accent hover:underline">Add one</button></>} />
    );
  }

  return (
    <Extra Icon={EnvelopeSimpleIcon} title="Mail at your domain" on={state.mail !== "off"}
      copy={`An inbox for you and your agents, like ada@${state.mail === "conflict" ? `mail.${domain}` : domain}.`}
      onChange={(on) => go({ mail: on ? "on" : "off" })}>
      {state.mail !== "off" && (
        <div className="space-y-2">
          {state.mail === "conflict" && <p className="p-meta p-text-2">{domain} already gets mail somewhere else, so Kinu's mail uses mail.{domain} and leaves yours as it is.</p>}
          <Disclosure summary={`What it adds to ${state.mail === "conflict" ? `mail.${domain}` : domain}`}>
            <ul className="space-y-1 p-meta p-text-2">{MAIL_WRITES.map((line) => <li key={line}>{line}</li>)}</ul>
          </Disclosure>
        </div>
      )}
    </Extra>
  );
}

function costOf(state: FlowState): string {
  return state.computer === "off" ? "Free" : "$5 a month, on your Cloudflare bill";
}

function ReadyScreen({ state, go }: { state: FlowState; go: Go }) {
  const checking = state.preflight === "checking";
  const blocked = state.preflight === "r2" || state.preflight === "r2-waiting" || state.computer === "upgrade" || state.computer === "upgrading";

  // The checks settle on their own a moment after sign-in.
  useEffect(() => {
    if (!checking) return undefined;
    const settled = setTimeout(() => go({ preflight: "clear" }), 1400);

    return () => clearTimeout(settled);
  }, [checking, go]);

  return (
    <Card title="Ready to deploy"
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={() => go({ screen: "start" })}>Back</Button>
          <span className="flex items-center gap-3">
            {!checking && <span className="hidden p-meta p-text-3 sm:inline">{costOf(state)}</span>}
            <PrimaryButton disabled={checking || blocked} onClick={() => go({ screen: "deploying", run: "running" })}>Deploy</PrimaryButton>
          </span>
        </>
      )}>
      {checking
        ? <Checking />
        : (
          <div className="space-y-5">
            {(state.preflight === "r2" || state.preflight === "r2-waiting") && (
              <Needs waiting={state.preflight === "r2-waiting"} note="Waiting for Cloudflare. This checks again when you come back."
                action={<HandOffButton label="Turn on R2" onClick={() => go({ preflight: "r2-waiting" })} />}>
                One thing first: turn on R2, Cloudflare's file storage. It's free, but Cloudflare asks for a card the first time.
              </Needs>
            )}
            <AccountLine state={state} />
            <AddressLine state={state} go={go} />
            <div className="space-y-4 pt-1">
              <p className="p-meta p-text-3">Optional</p>
              <ComputerExtra state={state} go={go} />
              <MailExtra state={state} go={go} />
            </div>
            <div className="sm:hidden"><Line label="Cost"><span className="p-row-text p-text">{costOf(state)}</span></Line></div>
            <WhatGetsMade state={state} />
          </div>
        )}
    </Card>
  );
}

/** The silent checks, while they run: the plan's shape, not a list of what is being read. */
function Checking() {
  return (
    <div data-deploy-checking className="space-y-5" aria-busy="true">
      <p className="inline-flex items-center gap-2 p-row-text p-text-2"><Loader size="sm" />Looking at your Cloudflare account…</p>
      {[60, 75, 45].map((width) => (
        <div key={width} className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-4">
          <span className="h-3 w-16 rounded p-fill" />
          <span className="h-3 rounded p-fill" style={{ width: `${String(width)}%` }} />
        </div>
      ))}
    </div>
  );
}

// ── Domain ────────────────────────────────────────────────────────────────────────────────────────────────────────

function DomainRow({ name, note, action }: { name: string; note: string; action: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2.5">
      <GlobeHemisphereWestIcon size={16} className="shrink-0 p-text-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate p-row-text p-text">{name}</span>
        <span className="block p-meta p-text-3">{note}</span>
      </span>
      {action}
    </li>
  );
}

function UseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-8 shrink-0 items-center rounded-lg border p-border px-3 text-[13px] font-medium p-text hover:bg-[var(--c-neutral-tint)]">
      {label}
    </button>
  );
}

function DomainScreen({ state, go }: { state: FlowState; go: Go }) {
  const existing = state.entry === "existing";
  const back = existing ? { screen: "start" as const, entry: "new" as const } : { screen: "ready" as const };
  const chose = (domain: FlowState["domain"]) => (existing ? go({ screen: "deploying", run: "running", domain }) : go({ screen: "ready", domain, search: "empty" }));

  return (
    <Card title={existing ? "Add a domain to your Kinu" : "Use your own domain"}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={() => go(back)}>Back</Button>
          {!existing && <button type="button" onClick={() => go({ screen: "ready", domain: "none" })} className="p-btn-ghost inline-flex h-6.5 items-center rounded-md px-2 text-xs">Keep {WORKERS_ADDRESS}</button>}
        </>
      )}>
      {existing && <p className="mb-4 p-row-text p-text-2">Your Kinu is live at {WORKERS_ADDRESS}. Pick a domain and it moves there; the old address keeps working.</p>}
      <label className="relative block">
        <MagnifyingGlassIcon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 p-text-3" />
        <input aria-label="Find a domain" placeholder="Find a domain, or type one you own" defaultValue={state.search === "empty" ? "" : "adalovelace"}
          onChange={(event) => go({ search: event.target.value === "" ? "empty" : "results" })} className={`${inputCls} h-10 pl-9`} />
      </label>

      {state.search === "buying" && (
        <div className="mt-4">
          <Needs waiting note={`Finish buying ${BOUGHT_DOMAIN} on Cloudflare, then come back. This page checks for it.`} action={null}>
            Cloudflare's own checkout is open in a new tab. Kinu doesn't see or take any payment.
          </Needs>
          <button type="button" onClick={() => chose("bought")} className="mt-2 p-meta p-accent hover:underline">It's bought (wireframe: as if Cloudflare said so)</button>
        </div>
      )}

      {state.search === "results" && (
        <ul className="mt-3 divide-y divide-[var(--c-border)]">
          {FOUND.map((found) => (
            <DomainRow key={found.name} name={found.name} note={found.state === "taken" ? "Taken" : `Available · ${found.price ?? ""}`}
              action={found.state === "taken" ? null : <HandOffButton label="Buy" onClick={() => go({ search: "buying" })} />} />
          ))}
          <DomainRow name={ELSEWHERE_DOMAIN} note="Yours, registered somewhere else" action={<UseButton label="Use it" onClick={() => chose("elsewhere")} />} />
        </ul>
      )}

      {state.search === "empty" && (
        <div className="mt-5">
          <p className="p-meta p-text-3">In your Cloudflare account</p>
          <ul className="mt-1 divide-y divide-[var(--c-border)]">
            <DomainRow name={YOUR_DOMAIN} note={`Kinu would live at kinu.${YOUR_DOMAIN}`} action={<UseButton label="Use" onClick={() => chose("yours")} />} />
          </ul>
          <p className="mt-4 p-meta p-text-3">Search to buy a new one through Cloudflare, at cost, or type a domain you already own elsewhere.</p>
        </div>
      )}
    </Card>
  );
}

// ── Deploying ─────────────────────────────────────────────────────────────────────────────────────────────────────

function PhaseMark({ at, reached, refused }: { at: number; reached: number; refused: boolean }) {
  if (at < reached) return <CheckIcon size={13} weight="bold" className="text-[var(--c-success)]" />;

  if (at > reached) return <CircleIcon size={13} className="p-text-3" />;

  return refused ? <WarningCircleIcon size={14} className="p-accent" /> : <Loader size="sm" />;
}

function Phases({ reached, refused, mail }: { reached: number; refused: boolean; mail: boolean }) {
  return (
    <ol className="space-y-2">
      {PHASES.map((phase, at) => (mail || at !== 4) && (
        <li key={phase} className={`flex items-center gap-2.5 p-meta ${at <= reached ? "p-text-2" : "p-text-3"}`}>
          <span className="flex size-4 items-center justify-center"><PhaseMark at={at} reached={reached} refused={refused} /></span>{phase}
        </li>
      ))}
    </ol>
  );
}

/** Where the run stands, said once in a sentence and drawn as one bar. */
function Progress({ reached, total }: { reached: number; total: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full p-fill" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={reached}>
      <div className="h-full rounded-full bg-[var(--c-accent)] transition-[width] duration-700" style={{ width: `${String(Math.max(6, (reached / total) * 100))}%` }} />
    </div>
  );
}

/** What the run says to the person: a heading, one sentence, and its one action. */
interface RunSaid {
  readonly title: string;
  readonly sentence: ReactNode;
  readonly action: ReactNode;
}

function runWords(state: FlowState, go: Go): RunSaid {
  const phase = PHASES[RUN_AT[state.run]] ?? PHASES[0];

  if (state.run === "paused") {
    return {
      title: "Waiting on Cloudflare",
      sentence: "Cloudflare needs R2, its file storage, turned on before Kinu can keep your files. It's free; Cloudflare asks for a card the first time.",
      action: <HandOffButton label="Turn on R2" onClick={() => go({ run: "running" })} />,
    };
  }

  if (state.run === "signin") {
    return {
      title: "Sign in to carry on",
      sentence: "After an hour of waiting, Kinu gives up its access to your Cloudflare account. Sign in and it carries on from here.",
      action: <CloudflareButton onClick={() => go({ run: "running" })}>Continue with Cloudflare</CloudflareButton>,
    };
  }

  if (state.run === "refused") {
    return {
      title: "One thing to change",
      sentence: `kinu.${YOUR_DOMAIN} already points somewhere else, and Kinu won't overwrite it. The steps before this one are done and won't run again.`,
      action: <PrimaryButton onClick={() => go({ screen: "domain", search: "empty" })}>Use another address</PrimaryButton>,
    };
  }

  if (state.run === "resume") {
    return {
      title: "Welcome back",
      sentence: `Your Kinu stopped at "${phase}". Everything before it is done.`,
      action: <PrimaryButton onClick={() => go({ run: "running" })}>Continue</PrimaryButton>,
    };
  }

  return { title: state.kind === "update" ? "Updating your Kinu" : "Deploying your Kinu", sentence: <span className="p-shimmer-text">{phase}…</span>, action: null };
}

function DeployingScreen({ state, go }: { state: FlowState; go: Go }) {
  const reached = RUN_AT[state.run];
  const mail = state.mail !== "off";
  const total = mail ? PHASES.length : PHASES.length - 1;
  const words = runWords(state, go);
  const face = state.run === "running" ? "working" : "waiting";
  const idle = state.run === "resume" || state.run === "signin";

  return (
    <Card title={null}>
      <div className="flex flex-col items-center text-center">
        <KinuFace activity={idle ? "idle" : face} />
        <h2 className="mt-4 p-display text-[22px] leading-7 p-text">{words.title}</h2>
        <p data-deploy-now className="mt-1.5 max-w-md p-row-text p-text-2">{words.sentence}</p>
        {(state.run === "running" || state.run === "resume") && <div className="mt-5 w-full max-w-sm"><Progress reached={reached} total={total} /></div>}
        {words.action !== null && <div className="mt-5">{words.action}</div>}
        {state.run === "running" && <p className="mt-5 p-meta p-text-3">A few minutes. You can close this page; it carries on, and opening it again shows where it is.</p>}
        {state.run === "paused" && <p className="mt-3 p-meta p-text-3">Once it's on, Kinu carries on by itself.</p>}
      </div>
      <div className="mt-6 space-y-3 border-t p-border pt-4">
        {state.run === "refused" && <CloudflareSaid message={`A DNS record for kinu.${YOUR_DOMAIN} already exists.`} code="81057" />}
        <Disclosure summary="Every step">
          <Phases reached={reached} refused={state.run === "refused"} mail={mail} />
        </Disclosure>
        {/* Wireframe only: the run's end, as the page would move to it. */}
        {state.run === "running" && <button type="button" onClick={() => go({ screen: "live" })} className="p-meta p-accent hover:underline">Skip to the end (wireframe)</button>}
      </div>
    </Card>
  );
}

// ── Live ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const CELEBRATION = `
@keyframes kinu-live-ring { from { transform: scale(0.7); opacity: 0.5; } to { transform: scale(1.45); opacity: 0; } }
@keyframes kinu-live-spark { 0% { transform: translate(0, 0) scale(0.4); opacity: 0; } 20% { opacity: 1; } 100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0; } }
[data-deploy-live] .kinu-live-ring { animation: kinu-live-ring 1.6s ease-out 0.2s 2 both; }
[data-deploy-live] .kinu-live-spark { animation: kinu-live-spark 1.2s ease-out 0.35s 1 both; }
@media (prefers-reduced-motion: reduce) { [data-deploy-live] .kinu-live-ring, [data-deploy-live] .kinu-live-spark { animation: none; opacity: 0; } }
`;

/** Eight small sparks, once, around the mark: celebrated, and over. */
const SPARKS = Array.from({ length: 8 }, (_, at) => {
  const angle = ((at + 0.5) / 8) * Math.PI * 2;

  const style: CSSProperties & { readonly "--dx": string; readonly "--dy": string } = {
    "--dx": `${String(Math.round(Math.cos(angle) * 46))}px`, "--dy": `${String(Math.round(Math.sin(angle) * 46))}px`,
  };

  return { at, style };
});

function LiveMark() {
  return (
    <div className="relative flex size-24 items-center justify-center">
      <style>{CELEBRATION}</style>
      <span aria-hidden className="kinu-live-ring absolute inset-2 rounded-full border-2 border-[var(--c-accent)]" />
      {SPARKS.map(({ at, style }) => (
        <span key={at} aria-hidden className="kinu-live-spark absolute size-1.5 rounded-full bg-[var(--c-accent)]" style={style} />
      ))}
      <KinuFace activity="done" live />
    </div>
  );
}

const CLI_LINE = `curl -fsSL 'https://${WORKERS_ADDRESS}/install.sh' | bash`;

function LiveScreen({ state, go }: { state: FlowState; go: Go }) {
  const address = addressOf(state);
  const relinked = state.link === "new";
  const updated = state.kind === "update";

  if (updated) return <UpdatedScreen address={address} />;

  return (
    <Card title={null}>
      <div data-deploy-live className="flex flex-col items-center pt-1 text-center">
        {relinked ? <KinuFace activity="idle" /> : <LiveMark />}
        <h2 className="mt-3 p-display text-[22px] leading-7 p-text">{relinked ? "A new setup link" : "Your Kinu is live"}</h2>
        <div className="mt-2 inline-flex max-w-full items-center gap-1.5">
          <span data-deploy-live-address className="truncate text-[17px] font-medium p-text">{address}</span>
          <CopyButton value={`https://${address}`} what="the address" size={13} className="p-text-3 hover:p-text p-1" />
        </div>
        <div className="mt-6 w-full max-w-xs"><PrimaryButton wide onClick={() => {}}>Open and set up<ArrowSquareOutIcon size={15} /></PrimaryButton></div>
        <p className="mt-2.5 max-w-sm p-meta p-text-3">{relinked ? "The old link no longer works. This one makes you the owner, once, within 7 days." : "This link makes you the owner, once, and works for 7 days. If you lose it, come back here for a new one."}</p>
      </div>

      {state.domain === "elsewhere" && (
        <div data-deploy-pending className="mt-6 rounded-xl bg-[var(--c-accent-subtle)] px-4 py-3.5">
          <p className="p-row-text p-text">One more step for {ELSEWHERE_DOMAIN}</p>
          <p className="mt-1 p-meta p-text-2">Where you registered it, change its nameservers to these two. Kinu moves to kinu.{ELSEWHERE_DOMAIN} by itself once they change, usually within a few hours.</p>
          <ul className="mt-2.5 space-y-1">
            {NAMESERVERS.map((server) => (
              <li key={server} className="flex items-center gap-2 rounded-md bg-[var(--c-surface)] px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate p-t-code p-text">{server}</span>
                <CopyButton value={server} what="the nameserver" className="p-text-3 hover:p-text" />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t p-border pt-4">
        <Disclosure summary="Use Kinu from your terminal">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--c-recessed)] px-3 py-2">
            <TerminalWindowIcon size={14} className="shrink-0 p-text-3" />
            <code className="min-w-0 flex-1 truncate p-t-code p-text-2">{CLI_LINE}</code>
            <CopyButton value={CLI_LINE} what="the install command" className="p-text-3 hover:p-text" />
          </div>
        </Disclosure>
        {domainOf(state) === null && (
          <button type="button" onClick={() => go({ screen: "domain", entry: "existing", search: "empty" })} className="p-meta p-accent hover:underline">Add a domain</button>
        )}
      </div>
    </Card>
  );
}

/** An update done: the same address, now on the latest build; there is no new setup link to hand over. */
function UpdatedScreen({ address }: { address: string }) {
  return (
    <Card title={null}>
      <div data-deploy-updated className="flex flex-col items-center pt-1 text-center">
        <KinuFace activity="done" />
        <h2 className="mt-3 p-display text-[22px] leading-7 p-text">Your Kinu is up to date</h2>
        <p className="mt-1.5 p-row-text p-text-2">{address} now runs {LATEST_BUILD.version}, built {LATEST_BUILD.builtAt}.</p>
        <div className="mt-6 w-full max-w-xs"><PrimaryButton wide onClick={() => {}}>Open your Kinu<ArrowSquareOutIcon size={15} /></PrimaryButton></div>
      </div>
    </Card>
  );
}

// ── The shell ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Onboarding's card: the screen's question, its body, and Back and the one action at its foot. */
function Card({ title, children, footer }: { title: string | null; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="p-card overflow-hidden">
      <div className="px-5 py-5 sm:px-8 sm:py-7">
        {title !== null && <h2 className="mb-5 p-title p-text">{title}</h2>}
        {children}
      </div>
      {footer !== undefined && <div className="flex items-center justify-between gap-3 border-t p-border px-5 py-4 sm:px-8">{footer}</div>}
    </section>
  );
}

function dotCls(index: number, current: number): string {
  if (index === current) return "w-8 bg-[var(--c-accent-fg)]";

  return index < current ? "w-4 bg-[var(--c-accent-fg)] opacity-40" : "w-4 p-fill";
}

/** The flow as the address bar names it; the design bar's states move it with `gallery:self-deploy-state`. */
export function SelfDeployFlow() {
  const [state, setState] = useState<FlowState>(() => stateOf(location.search));

  useEffect(() => {
    const follow = () => setState(stateOf(location.search));

    window.addEventListener("gallery:self-deploy-state", follow);

    return () => window.removeEventListener("gallery:self-deploy-state", follow);
  }, []);

  const go: Go = (next) => {
    const moved = { ...state, ...next };

    history.replaceState(null, "", hrefOf(moved));
    setState(moved);
  };

  const body: Record<Screen, ReactNode> = {
    start: <StartScreen state={state} go={go} />,
    manage: <ManageScreen state={state} go={go} />,
    ready: <ReadyScreen state={state} go={go} />,
    domain: <DomainScreen state={state} go={go} />,
    deploying: <DeployingScreen key={state.run} state={state} go={go} />,
    live: <LiveScreen state={state} go={go} />,
  };

  return (
    <div className="fixed inset-0 overflow-y-auto p-bg p-text">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8" data-deploy-screen={state.screen}>
        <div className="mb-6 flex justify-center"><KinuLogo /></div>
        <h1 className="p-display text-center text-[26px] leading-8">Your own Kinu</h1>
        <ol aria-label="Deploy steps" className="mb-5 mt-6 flex items-center justify-center gap-1.5">
          {["Start", "Ready", "Deploying", "Live"].map((label, at) => (
            <li key={label} aria-current={at === DOT[state.screen] ? "step" : undefined} aria-label={label}>
              <span className={`block h-1.5 rounded-full transition-all ${dotCls(at, DOT[state.screen])}`} />
            </li>
          ))}
        </ol>
        {body[state.screen]}
      </div>
    </div>
  );
}

// ── The states under review ────────────────────────────────────────────────────────────────────────────────────

/** Each state the review links. */
const VIEWS: readonly [string, Partial<FlowState>][] = [
  ["Start", { screen: "start" }],
  ["Start: Cloudflare's consent declined", { screen: "start", consent: "declined" }],
  ["Ready: checking the account", { screen: "ready", preflight: "checking" }],
  ["Ready", { screen: "ready" }],
  ["Ready: two accounts", { screen: "ready", accounts: "many" }],
  ["Ready: kinu already taken", { screen: "ready", preflight: "name-taken" }],
  ["Ready: R2 to turn on", { screen: "ready", preflight: "r2" }],
  ["Ready: R2, waiting for Cloudflare", { screen: "ready", preflight: "r2-waiting" }],
  ["Ready: the computer on the free plan", { screen: "ready", computer: "upgrade" }],
  ["Ready: upgrading, waiting for Cloudflare", { screen: "ready", computer: "upgrading" }],
  ["Ready: computer on, own domain, mail", { screen: "ready", computer: "on", domain: "yours", mail: "on" }],
  ["Ready: mail where the domain has mail", { screen: "ready", domain: "yours", mail: "conflict" }],
  ["Ready: a domain registered elsewhere", { screen: "ready", domain: "elsewhere" }],
  ["Domain", { screen: "domain" }],
  ["Domain: search results", { screen: "domain", search: "results" }],
  ["Domain: buying at Cloudflare", { screen: "domain", search: "buying" }],
  ["Deploying", { screen: "deploying" }],
  ["Deploying: paused on R2", { screen: "deploying", run: "paused" }],
  ["Deploying: paused past an hour, sign in", { screen: "deploying", run: "signin" }],
  ["Deploying: one thing to change", { screen: "deploying", run: "refused", domain: "yours" }],
  ["Deploying: an unfinished run, found again", { screen: "deploying", run: "resume" }],
  ["Live", { screen: "live" }],
  ["Live: own domain", { screen: "live", domain: "yours", mail: "on" }],
  ["Live: a domain still moving", { screen: "live", domain: "elsewhere" }],
  ["An existing Kinu, an update out", { screen: "manage", entry: "existing" }],
  ["An existing Kinu, up to date", { screen: "manage", entry: "existing", update: "current" }],
  ["An existing Kinu, an update it can't take here", { screen: "manage", entry: "existing", update: "blocked" }],
  ["Two Kinus, one made with the CLI", { screen: "manage", entry: "existing", kinus: "two" }],
  ["Updating", { screen: "deploying", entry: "existing", kind: "update" }],
  ["Updated", { screen: "live", entry: "existing", kind: "update" }],
  ["An existing Kinu: add a domain", { screen: "domain", entry: "existing" }],
  ["An existing Kinu: a new setup link", { screen: "live", entry: "existing", link: "new" }],
];

/** Each state the design bar links, opening it in place. */
export const SELF_DEPLOY_STATES = VIEWS.map(([label, view]) => ({
  label,
  open: () => {
    history.replaceState(null, "", hrefOf({ ...DEFAULTS, ...view }));
    window.dispatchEvent(new Event("gallery:self-deploy-state"));
  },
}));
