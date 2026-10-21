/**
 * The deploy page's parts (pages/DeployPage.tsx): the flow's shell, Cloudflare's button and hand-offs, what waits on
 * the person, and Cloudflare's own words behind Details. Each says one thing and offers one action.
 */
import type { ReactNode } from "react";
import { CloudflareLogo } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CaretDownIcon, CheckIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { CloudflareWords, DeployAction, DeployNeed } from "@kinu.run/core/deploy";
import { Button, buttonClass } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { FlowStep } from "@/components/ui/FlowCard";
import { Loader } from "@/components/ui/Loader";
import { Switch } from "@/components/ui/Switch";
import { ChatMascot } from "@/components/Marks";

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
    <div className="fixed inset-0 overflow-y-auto p-bg p-text">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-8" data-deploy-screen={screen}>
        <FlowStep title="Your own Kinu" steps={STEPS} at={dot} footer={footer}>
          <div className="px-5 py-5 sm:px-8 sm:py-7">
            {title !== undefined && <h2 className="mb-5 t-title">{title}</h2>}
            {children}
          </div>
        </FlowStep>
      </div>
    </div>
  );
}

/**
 * Cloudflare's cloud, in its own colours on a white tile: its guidelines keep the full-colour mark on white and rule
 * out black on orange, and white would vanish on the light amber of the dark theme.
 */
function CloudflareMark() {
  return (
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-[var(--r-check)] bg-white">
      <CloudflareLogo variant="glyph" className="w-4" />
    </span>
  );
}

/** The sign-in to Cloudflare: the flow's one primary wherever it asks for one. */
export function CloudflareButton({ children, busy = false, onClick }: { children: ReactNode; busy?: boolean; onClick: () => void }) {
  return <Button variant="primary" busy={busy} icon={busy ? undefined : <CloudflareMark />} onClick={onClick}>{children}</Button>;
}

/** A hand-off to Cloudflare's dashboard: the action, opening beside the page, which then checks again by itself. */
export function HandOff({ action, onOpened }: { action: DeployAction & { readonly href: string }; onOpened?: () => void }) {
  return (
    <a href={action.href} target="_blank" rel="noopener noreferrer" onClick={onOpened} data-deploy-handoff className={buttonClass({ variant: "secondary", size: "sm" })}>
      {action.label}<ArrowSquareOutIcon size={13} className="p-text-3" />
    </a>
  );
}

/** Folded away until asked: what is made, Cloudflare's own words, the CLI. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 t-meta hover:p-text [&::-webkit-details-marker]:hidden">
        <CaretDownIcon size={11} className="-rotate-90 transition-transform group-open:rotate-0" />{summary}
      </summary>
      <div className="mt-2.5">{children}</div>
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
      <div data-deploy-words className="flex items-start gap-2 rounded-[var(--r-control)] p-sunken px-3 py-2.5">
        <p className="min-w-0 flex-1 t-code p-text-2">Cloudflare said: {words.message}{tail !== "" && <span className="p-text-3"> {tail}</span>}</p>
        <CopyButton value={copied} what="the details" className="shrink-0 p-text-3 hover:p-text" />
      </div>
    </Disclosure>
  );
}

/** A thing that waits on the person: one sentence, one action, and how the page will know. */
function Needs({ children, action, waiting, note }: { children: ReactNode; action: ReactNode; waiting: boolean; note: string }) {
  return (
    <div data-deploy-needs className="rounded-[var(--r-row)] bg-[var(--c-selected)] px-4 py-3.5">
      <div className="t-body p-text">{children}</div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {waiting ? <span className="inline-flex items-center gap-2 t-meta p-text-2"><Loader size="sm" />{note}</span> : action}
      </div>
    </div>
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
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr] sm:items-baseline sm:gap-4">
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
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--r-control)] p-fill"><Icon size={18} className={on ? "p-accent" : "p-text-3"} /></span>
        <div className="min-w-0 flex-1">
          <div className="t-item">{title}</div>
          <div className="mt-0.5 t-meta">{copy}</div>
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
      <ul className="space-y-1.5 t-meta p-text-2">
        {lines.map((line) => <li key={line} className="flex items-start gap-2"><CheckIcon size={12} className="mt-0.5 shrink-0 p-text-3" />{line}</li>)}
      </ul>
      <p className="mt-2.5 t-meta">Nothing else in your account changes, and you can remove all of it from Cloudflare any time.</p>
    </Disclosure>
  );
}

/** Your Kinu's face: the product's own mascot in Kinu's amber; bare while it works, in a party hat once it is live. */
const KINU_HUE = 62;

export function KinuFace({ activity, live = false }: { activity: "working" | "waiting" | "idle" | "done"; live?: boolean }) {
  return <ChatMascot seed={live ? "deploy/kinu" : "self-deploy/kinu"} colour={KINU_HUE} activity={activity} size={56} />;
}
