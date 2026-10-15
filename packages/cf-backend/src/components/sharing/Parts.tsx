/**
 * A part as one person sees it, in the app's frame the slate's page embeds (security §6). Content with a label renders
 * in a nested frame that runs no scripts. When a part cannot simply render it keeps its frame and says why, naming
 * whom to ask: someone's private source, a connection of this person's own, a sign-in, an editor's change, a lend
 * waiting for its holder. Decisions it leads to (Show, Allow, Use again) open in the top page.
 */
import type { ReactNode } from "react";
import { CaretDownIcon, LockSimpleIcon, PlugIcon, SignInIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import type { PartView, RoomSource } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";
import { firstName, holdersOf, sourcesOf } from "./words";

/** What a part's frame does for its person; the decisions among them open in the top page. */
export interface PartActions {
  readonly ask: () => void;
  readonly check: () => void;
  readonly unshow: () => void;
  readonly decideShow: () => void;
  readonly decideAllow: () => void;
  readonly signIn: () => void;
  readonly connect: (service: string) => void;
}

/** A small action inside a part's frame. */
function PartButton({ children, onClick, disabled = false, ...data }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} {...data}
      className="inline-flex min-h-7 items-center gap-1 rounded-md border p-border p-surface px-2.5 py-1 text-left text-xs font-medium leading-4 p-text transition-colors hover:bg-[var(--c-elevated)] disabled:opacity-60">
      {children}
    </button>
  );
}

/** One ask in the part's place, with one action. */
function AskInPlace({ icon, said, action, onAct, detail, ...data }: {
  icon: ReactNode;
  said: string;
  action: string;
  onAct: () => void;
  detail?: string;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <div {...data} className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-8 text-center">
      <span className="p-text-2">{icon}</span>
      <p className="p-row-text font-medium p-text">{said}</p>
      <FilledButton onClick={onAct}>{action}</FilledButton>
      {detail !== undefined && <p className="p-meta p-text-3">{detail}</p>}
    </div>
  );
}

/** Labelled content: in its own frame with no scripts, so nothing of the slate's code ever holds it. */
function Sealed({ content }: { content: string }) {
  // Basis 0, so it takes only what the frame leaves after its label, never its default 150px.
  return <iframe src={content} sandbox="" title="Part" data-part-content className="block h-0 min-h-0 w-full flex-1 border-0 bg-transparent" />;
}

/** Whose data a shown part holds, when it is others' shown to this person. */
function ShownBy({ from }: { from: readonly RoomSource[] }) {
  if (from.length === 0) return null;

  return <p data-part-shown-by className="flex items-center gap-1.5 px-1 pt-1.5 p-meta p-text-3"><LockSimpleIcon size={12} className="shrink-0" />Shown by {holdersOf(from).join(", ")} · from {sourcesOf(from)}</p>;
}

/** A part held back from this person: it fills the part, so the slate's page shows no gap under it. */
const HELD = "flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 rounded-lg p-recessed px-4 py-6 text-center";

/** Someone's private source, which this person can't read: whose, from where, and asking them. */
function Placeholder({ part, signedIn, act }: { part: Extract<PartView, { state: "placeholder" }>; signedIn: boolean; act: PartActions }) {
  const holders = holdersOf(part.sources);
  const holder = holders[0] ?? "";
  const checkable = part.sources.find((source) => source.checkable);

  return (
    <div data-part-private className={HELD}>
      <LockSimpleIcon size={22} className="p-text-3" />
      <p className="p-meta p-text-2">Private to {holders.join(", ")} · from {sourcesOf(part.sources)}</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {signedIn
          ? <PartButton onClick={act.ask} disabled={part.asked} data-part-ask>{part.asked ? `Asked ${holder}` : `Ask ${holder}`}</PartButton>
          : <PartButton onClick={act.signIn} data-part-sign-in>Sign in to ask {holder}</PartButton>}
        {signedIn && checkable !== undefined && (
          <PartButton onClick={act.check} data-part-check><PlugIcon size={12} />Connect {checkable.service.title} to check your access</PartButton>
        )}
      </div>
    </div>
  );
}

/** This person's own private data, labelled, with the way to show it further or take it back. */
function Mine({ part, act }: { part: Extract<PartView, { state: "mine" }>; act: PartActions }) {
  const shown = { me: "Only you can see this", members: "Shown to everyone here", anyone: "Shown to anyone who can open this slate" }[part.shownTo];

  return (
    <>
      <Sealed content={part.content} />
      <div data-part-mine className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1 pt-1.5">
        <span className="flex items-center gap-1.5 p-meta p-text-3"><LockSimpleIcon size={12} className="shrink-0" />{shown} · from {part.source.label}</span>
        {part.shownTo === "me"
          ? <PartButton onClick={act.decideShow} data-part-show>Show to everyone here<CaretDownIcon size={10} /></PartButton>
          : <PartButton onClick={act.unshow} data-part-unshow>Only me</PartButton>}
      </div>
    </>
  );
}

export function PartFrameView({ part, signedIn, act }: { part: PartView; signedIn: boolean; act: PartActions }) {
  switch (part.state) {
    case "running": {
      return <div data-part-running className="flex justify-center py-8"><Loader size="sm" /></div>;
    }

    case "shown": {
      return <><Sealed content={part.content} /><ShownBy from={part.from} /></>;
    }

    case "mine": {
      return <Mine part={part} act={act} />;
    }

    case "placeholder": {
      return <Placeholder part={part} signedIn={signedIn} act={act} />;
    }

    case "needs-connection": {
      const service = part.reach.service.title;

      return part.connected
        ? <AskInPlace data-part-allow icon={<PlugIcon size={26} />} said={`This part uses your own ${service}`} action="Allow…" onAct={act.decideAllow} detail="Everyone here uses their own" />
        : <AskInPlace data-part-connect icon={<PlugIcon size={26} />} said={`This part uses your own ${service}`} action={`Connect ${service}`} onAct={() => act.connect(service)} detail="Everyone here uses their own" />;
    }

    case "needs-sign-in": {
      return <AskInPlace data-part-sign-in icon={<SignInIcon size={26} />} said="Sign in to use this part" action="Sign in" onAct={act.signIn} />;
    }

    case "edited": {
      return (
        <AskInPlace data-part-edited icon={<PlugIcon size={26} />} said={`${firstName(part.editor)} changed this part. Use it with your ${part.reach.service.title} again?`}
          action="Use again" onAct={act.decideAllow} />
      );
    }

    case "waiting": {
      return (
        <div data-part-waiting className={HELD}>
          <LockSimpleIcon size={22} className="p-text-3" />
          <p className="p-meta p-text-2">Waiting for {firstName(part.holder)} to lend this again</p>
          {signedIn
            ? <PartButton onClick={act.ask} data-part-ask>Ask {firstName(part.holder)}</PartButton>
            : <PartButton onClick={act.signIn} data-part-sign-in>Sign in to ask {firstName(part.holder)}</PartButton>}
        </div>
      );
    }

    case "failed": {
      return <p data-part-failed className="flex items-start gap-1.5 rounded-lg p-notice-danger px-3 py-2.5 p-meta"><WarningCircleIcon size={14} className="mt-0.5 shrink-0" />{part.message}</p>;
    }
  }
}

/** A part frame whose top is not the app's live page: it shows nothing of the room and calls nothing. */
export function PartOutsideItsSlate() {
  return <p data-part-outside className="px-3 py-2.5 p-meta p-text-3">Open this part from its slate.</p>;
}
