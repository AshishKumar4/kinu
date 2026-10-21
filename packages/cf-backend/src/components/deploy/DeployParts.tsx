/**
 * The deploy page's parts (pages/DeployPage.tsx): the flow's shell, Cloudflare's button and hand-offs, what waits on
 * the person, and Cloudflare's own words behind Details. Each says one thing and offers one action.
 */
import type { ReactNode } from "react";
import { ArrowSquareOutIcon, CaretDownIcon, CheckCircleIcon, CheckIcon, CircleIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { CloudflareWords, DeployAction, DeployChoice, DeployNeed, DeploySession } from "@kinu.run/core/deploy";
import { Button } from "@/components/ui/Button";
import { InlineAction } from "@/components/ui/InlineAction";
import { openProviderWindow } from "@/lib/connect-window";
import { CopyButton } from "@/components/ui/CopyButton";
import { Loader } from "@/components/ui/Loader";
import { Switch } from "@/components/ui/Switch";
import { ChatMascot } from "@/components/Marks";
import type { DeployRefused } from "@/lib/deploy-page-api";
import { CloudflareTile } from "@/components/ui/BrandMark";
import { Callout } from "@/components/ui/Callout";
import { IconTile } from "@/components/ui/IconTile";
import { Preformatted } from "@/components/ui/Preformatted";
import { FlowPage, FlowStep } from "@/components/ui/FlowCard";

/** Where the page stands, as a dot: Start, Ready (and its Domain step), Deploying, Live. */
export type DeployDot = 0 | 1 | 2 | 3;

const STEPS = ["Start", "Ready", "Deploying", "Live"] as const;

/** The flow's page: one centred card under its title and dots, Back and the one action at its foot. */
export function DeployShell({ dot, screen, title, children, footer }: {
  dot: DeployDot;
  /** The screen's name for its tests (`data-deploy-screen`). */
  screen: string;
  /** The card's own question, above its body. */
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <FlowPage>
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8" data-deploy-screen={screen}>
        <FlowStep title="Your own Kinu" steps={STEPS} at={dot} footer={footer}>
          <div className="px-5 py-5 sm:px-8 sm:py-6">
            {title !== undefined && <h2 className="mb-5 t-title">{title}</h2>}
            {children}
          </div>
        </FlowStep>
      </div>
    </FlowPage>
  );
}


/**
 * A sign-in to Cloudflare with its mark: the flow's one primary wherever it asks for one, at a public page's size; or
 * `secondary`, small, where it is not the screen's primary (the computer's, again for API Tokens).
 */
export function CloudflareButton({ children, busy = false, secondary = false, onClick }: { children: ReactNode; busy?: boolean; secondary?: boolean; onClick: () => void }) {
  return (
    <Button variant={secondary ? "secondary" : "primary"} size={secondary ? "sm" : "lg"} busy={busy} icon={busy ? undefined : <CloudflareTile />} onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * Opens Cloudflare's own page in a window over this one (`openProviderWindow`): Cloudflare will not be framed, so the
 * card waits here and reads again when the person comes back. A refused window goes there in this tab instead, and the
 * page reads again when it is loaded back.
 */
export function openOnCloudflare(name: string, href: string): void {
  if (openProviderWindow(name, href) === null) window.location.assign(href);
}

/** A hand-off to Cloudflare's dashboard: the action, opening in Cloudflare's window, after which the page checks again. */
export function HandOff({ action, onOpened }: { action: DeployAction & { readonly href: string }; onOpened?: () => void }) {
  return (
    <Button variant="secondary" size="sm" data-deploy-handoff={action.href}
      onClick={() => { openOnCloudflare(`kinu-deploy-${action.label}`, action.href); onOpened?.(); }}>
      {action.label}<ArrowSquareOutIcon size={14} className="p-text-3" />
    </Button>
  );
}

/** While Cloudflare's window is open: what to do there, and the way to open it again if it went behind this page. */
export function OnCloudflare({ doing, tip, onAgain }: { doing: string; tip?: string; onAgain: () => void }) {
  return (
    <Callout data-deploy-window="">
      <p className="inline-flex items-center gap-2 t-public-item"><Loader size="sm" />Finish on Cloudflare's window…</p>
      <p className="mt-1 t-public-body">{doing}</p>
      {tip !== undefined && <p data-deploy-tip className="mt-2 t-public-item">{tip}</p>}
      <p className="mt-2 t-meta">Can't see it? It may be behind this page. <InlineAction onClick={onAgain}>Open it again</InlineAction></p>
    </Callout>
  );
}

/** One thing the account lacks before it can take a Kinu: what it is and costs, its one action, ticked once done. */
export function Lack({ name, done, title, copy, action, waiting }: {
  name: string; done: boolean; title: string; copy: string; action: ReactNode; waiting: boolean;
}) {
  return (
    <li data-deploy-lack={name} data-done={done ? "" : undefined} className="flex items-start gap-3 py-3">
      {done
        ? <CheckCircleIcon size={20} weight="fill" className="mt-px shrink-0 p-success" aria-label="Done" />
        : <CircleIcon size={20} className="mt-px shrink-0 p-text-3" aria-hidden />}
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="t-public-item">{title}</div>
          <div className="t-meta">{done ? "Done" : copy}</div>
          {!done && waiting && <p className="mt-1 inline-flex items-center gap-2 t-meta"><Loader size="sm" />Waiting for Cloudflare. This ticks off as soon as it's done.</p>}
        </div>
        {!done && <div className="shrink-0">{action}</div>}
      </div>
    </li>
  );
}

/** Folded away until asked: what is made, Cloudflare's own words, the CLI. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 t-meta hover:p-text [&::-webkit-details-marker]:hidden">
        <CaretDownIcon size={11} className="-rotate-90 transition-transform group-open:rotate-0" />{summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** Cloudflare's words, its code, status and the path it refused, for whoever wants them: small, plain, copyable. */
export function CloudflareSaid({ words }: { words: CloudflareWords }) {
  const tail = [words.code === undefined ? "" : `code ${String(words.code)}`, words.status === undefined ? "" : `HTTP ${String(words.status)}`, words.endpoint ?? ""]
    .filter((part) => part !== "").join(" · ");

  const copied = tail === "" ? words.message : `${words.message} (${tail})`;

  return (
    <Disclosure summary="Details">
      <div data-deploy-words className="flex items-start gap-2">
        <Preformatted className="min-w-0 flex-1">Cloudflare said: {words.message}{tail !== "" && <span className="p-text-3"> {tail}</span>}</Preformatted>
        <CopyButton value={copied} what="the details" className="shrink-0" />
      </div>
    </Disclosure>
  );
}

/** A thing that waits on the person: one sentence, one action, and how the page will know. */
function Needs({ children, action, waiting, note }: { children: ReactNode; action: ReactNode; waiting: boolean; note: string }) {
  return (
    <Callout data-deploy-needs="">
      <div className="t-public-body p-text">{children}</div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {waiting ? <span className="inline-flex items-center gap-2 t-meta p-text-2"><Loader size="sm" />{note}</span> : action}
      </div>
    </Callout>
  );
}

/** A need as the page meets it: Cloudflare's dashboard beside the page, or this page's own sign-in. */
export function NeedBox({ need, waiting, onHandedOff, onSignIn, signingIn }: {
  need: DeployNeed;
  waiting: boolean;
  onHandedOff: () => void;
  onSignIn: () => void;
  signingIn: boolean;
}) {
  const { href } = need.action;

  const action = href === undefined
    ? <CloudflareButton busy={signingIn} onClick={onSignIn}>{need.action.label}</CloudflareButton>
    : <HandOff action={{ label: need.action.label, href }} onOpened={onHandedOff} />;

  return (
    <div className="space-y-2" data-deploy-need={need.id}>
      <Needs waiting={waiting} note="Waiting for Cloudflare. This checks again when you come back." action={action}>{need.sentence}</Needs>
      {need.details !== undefined && <CloudflareSaid words={need.details} />}
    </div>
  );
}

/** One labelled line of the plan: its name on the left at desktop, above at phone width. */
export function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[var(--layout-plan-line)] sm:items-baseline sm:gap-4">
      <span className="t-meta">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** An optional extra: what it gives, what it costs or needs, and its switch. */
export function Extra({ Icon, title, copy, on, onChange, disabled = false, children }: {
  Icon: PhosphorIcon; title: string; copy: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <div className={disabled ? "opacity-60" : undefined}>
      <div className="flex items-start gap-3">
        <IconTile size="xl"><Icon size={18} className={on ? "p-accent-fg" : "p-text-3"} /></IconTile>
        <div className="min-w-0 flex-1">
          <div className="t-public-item">{title}</div>
          <div className="mt-px t-meta">{copy}</div>
        </div>
        <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
      </div>
      {children !== undefined && <div className="mt-3 sm:pl-12">{children}</div>}
    </div>
  );
}

/** What a run makes, in plain words, behind its disclosure. */
export function WhatGetsMade({ name, domain, computer, mail }: { name: string; domain: string | null; computer: boolean; mail: string | null }) {
  const lines = [
    `The Kinu app, as a Worker named ${name}`,
    "Storage for your files, chats and memory",
    "An AI gateway, so Kinu can use Cloudflare's models",
    ...computer ? ["Computers your agents run code on"] : [],
    ...domain === null ? [] : [`An address on ${domain}`],
    ...mail === null ? [] : [`Mail records for ${mail}`],
  ];

  return (
    <Disclosure summary="What gets made in your account">
      <ul className="space-y-2 t-meta p-text-2">
        {lines.map((line) => <li key={line} className="flex items-start gap-2"><CheckIcon size={12} className="mt-px shrink-0 p-text-3" />{line}</li>)}
      </ul>
      <p className="mt-3 t-meta">Nothing else in your account changes, and you can remove all of it from Cloudflare any time.</p>
    </Disclosure>
  );
}

/** Your Kinu's face: the product's own mascot in Kinu's amber; bare while it works, in a party hat once it is live. */
const KINU_HUE = 62;

export function KinuFace({ activity, live = false }: { activity: "working" | "waiting" | "idle" | "done"; live?: boolean }) {
  return <ChatMascot seed={live ? "deploy/kinu" : "self-deploy/kinu"} colour={KINU_HUE} activity={activity} size={56} />;
}

/** What a page that shows a refusal does for the person: sign in again, or open a hand-off. */
export interface RefusalActions {
  readonly signingIn: boolean;
  readonly onSignIn: () => void;
  /** Signs in again for API Tokens, which the computer needs; the screen stays as it is. */
  readonly onApiTokens: () => void;
  readonly onHandedOff: (need: string) => void;
}

/** A refusal the door answered, in words, with what meets it: a need's one action, or Cloudflare's own words. */
export function Refused({ refusal, actions }: { refusal: DeployRefused; actions: RefusalActions }) {
  const { need, refused } = refusal;

  if (need !== null) return <NeedBox need={need} waiting={false} onHandedOff={() => actions.onHandedOff(need.id)} onSignIn={actions.onSignIn} signingIn={actions.signingIn} />;

  return (
    <div data-deploy-refusal className="space-y-2">
      <p role="alert" className="t-public-body p-danger">{refused?.sentence ?? refusal.error}</p>
      {refused !== null && <CloudflareSaid words={refused.details} />}
    </div>
  );
}

/** The account's name as the session lists it, else its id. */
export function accountName(accounts: readonly DeployChoice[], account: string): string {
  return accounts.find((each) => each.id === account)?.name ?? account;
}

/** Accounts whose Kinus could not be read, so none there are listed: said wherever the person starts. */
export function Unreadable({ session }: { session: DeploySession }) {
  return session.unreadable.map(({ account, words }) => (
    <div key={account} data-deploy-unreadable className="mb-4 space-y-1">
      <p className="t-public-body">Kinu couldn't read the Kinus in {accountName(session.accounts, account)}, so any there aren't listed.</p>
      <CloudflareSaid words={words} />
    </div>
  ));
}
