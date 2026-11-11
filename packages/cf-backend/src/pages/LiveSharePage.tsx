/**
 * `/shared/live/:workspace/:share`: where a live share is used, and the address its link and its Gallery listing give.
 * A public share opens to anyone; one that names people signs its visitor in first. The visitor is handed the share's
 * ticket where it needs one, and shown the share's host in a frame under a thin bar of Kinu's own. The page is the top of the slate's
 * window, so it runs the slate's personal parts as this visitor and opens the decisions they lead to here, where the
 * slate's script cannot cover them (docs/SLATE-SHARING-NIMBUS.md §3). The host sits on a subdomain of the app's own
 * site, so the ticket's cookie reaches it inside the frame.
 */
import { Button } from "@/components/ui/Button";
import { APP_AGENT_CONSENT, appAgentConsent, readSlateIdentityAsk, slateFrameSrc, VIEWER_EXCHANGE_PATH, type LiveShareOpen, type ShareMode } from "@kinu.run/core";
import { detachPromise } from "@kinu.run/core/obs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { useSlateHostContext } from "@/components/slates/InlineSlate";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { usePartHost } from "@/hooks/use-part-host";
import { acknowledgeShare, openLiveShare } from "@/lib/shared-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { signInAndReturn } from "@/lib/sign-in";
import { Notice } from "@/components/ui/Notice";
import { Surface } from "@/components/ui/Surface";
import { giveConsent, readConsents } from "@/lib/parts-api";
import { AssistantConsentDecision } from "@/components/sharing/PartDecisions";

/** What a share's visitor must do before its app agent answers them (core slates/app-agent.ts). */
type AssistantAsk =
  | { readonly kind: "identity" }
  | { readonly kind: "lent" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "consent"; readonly slate: string; readonly revision: string; readonly reason: ConsentReason };

/** Why the visitor is asked to let the assistant use their models: first, after its code changed, or after the share did. */
type ConsentReason = "new" | "code" | "mode";

/** How the share lends now, as its page last read it, and what its visitor must accept before they ask again. */
interface AssistantState {
  readonly mode: ShareMode | null;
  readonly ask: AssistantAsk | null;
}

/** Allowed at this revision, it is the share that changed; allowed at another, the code; else it is the first ask. */
function consentReason(current: boolean, earlier: boolean): ConsentReason {
  if (current) return "mode";

  return earlier ? "code" : "new";
}

/**
 * Read from Kinu as the share stands now, never from the app's page, which only says that its visitor must act. On the
 * owner's model: say who they are, or, signed in, accept that the owner reads it. On their own: sign in, then let it use
 * their models at this revision of its code. Each, for how the share lends now: a share that changed asks again.
 */
async function assistantState(workspace: string, share: string): Promise<AssistantState> {
  const now = await openLiveShare({ workspace, share });

  if (now === null) return { mode: null, ask: { kind: "sign-in" } };

  if (!now.signedIn) return { mode: now.mode, ask: now.mode === "owner" ? { kind: "identity" } : { kind: "sign-in" } };

  if (now.mode === "owner") return { mode: now.mode, ask: now.acknowledged === "owner" ? null : { kind: "lent" } };
  const given = (await readConsents(workspace, now.slate)).filter((consent) => consent.server === APP_AGENT_CONSENT);
  const current = given.some((consent) => consent.revision === now.revision);

  if (current && now.acknowledged === "own") return { mode: now.mode, ask: null };

  return { mode: now.mode, ask: { kind: "consent", slate: now.slate, revision: now.revision, reason: consentReason(current, given.length > 0) } };
}

/**
 * The share's slate, framed with its host context as the owner's previews frame it, so its page knows the app it answers
 * to and frames its parts from; and the parts it hosts, a decision opening over it.
 */
function SharedSlate({ workspace, share, opened, onMode }: { workspace: string; share: string; opened: LiveShareOpen; onMode: (mode: ShareMode) => void }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const decision = usePartHost({ workspace, slate: opened.slate, title: opened.title, slateFrame: frame });
  const context = useSlateHostContext("pane", "window" in globalThis ? window.innerWidth : 0);
  const contextRef = useRef(context);
  // A snapshot, as the previews' is: a theme flip after it never reloads the slate.
  const src = useMemo(() => slateFrameSrc(opened.url, contextRef.current), [opened.url]);
  const [asking, setAsking] = useState<AssistantAsk | null>(null);

  // The share as it stands now: the bar says how it lends, and the sheet asks what is needed for that.
  const reread = useCallback(async () => {
    const state = await assistantState(workspace, share);

    if (state.mode !== null) onMode(state.mode);
    setAsking(state.ask);
  }, [workspace, share, onMode]);

  // Where the frame goes once its visitor continues anonymously: the share's host gives this browser an id, then the app.
  const [anonymous, setAnonymous] = useState<string | null>(null);

  useEffect(() => {
    const origin = new URL(opened.url).origin;

    const heard = (event: MessageEvent) => {
      if (readSlateIdentityAsk(event, frame.current?.contentWindow, origin)) detachPromise(async () => { await reread(); });
    };

    window.addEventListener("message", heard);

    return () => window.removeEventListener("message", heard);
  }, [opened.url, reread]);

  /** Accepted as the sheet said: kept for how the share lends now, or, changed meanwhile, read again. */
  const accept = (mode: ShareMode): void => detachPromise(async () => {
    if (await acknowledgeShare({ workspace, share, mode })) setAsking(null);
    else await reread();
  });

  const continueAnonymously = (): void => {
    const exchange = new URL(VIEWER_EXCHANGE_PATH, opened.url);

    exchange.searchParams.set("anonymous", "1");
    setAnonymous(slateFrameSrc(exchange.toString(), contextRef.current));
    setAsking(null);
  };

  return (
    <>
      <iframe ref={frame} src={anonymous ?? src} title={opened.title} data-shared-slate={opened.slate} className="block min-h-0 w-full flex-1 border-0" />
      {decision}
      {asking?.kind === "identity" && <IdentitySheet onClose={() => setAsking(null)} onAnonymous={continueAnonymously} />}
      {asking?.kind === "lent" && <LentSheet onClose={() => setAsking(null)} onContinue={() => accept("owner")} />}
      {asking?.kind === "sign-in" && <SignInSheet onClose={() => setAsking(null)} />}
      {asking?.kind === "consent" && (
        <AssistantConsentDecision slate={opened.title} reason={asking.reason} onClose={() => setAsking(null)}
          onAllow={() => detachPromise(async () => {
            await giveConsent(appAgentConsent(workspace, asking.slate, asking.revision));
            accept("own");
          })} />
      )}
    </>
  );
}

/** The app's assistant on its owner's model needs to know who asks: they sign in, or go on as this browser, anonymously. */
function IdentitySheet({ onClose, onAnonymous }: { onClose: () => void; onAnonymous: () => void }) {
  return (
    <Modal title="Say who's asking" width="md" onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
          <Button variant="secondary" size="sm" data-assistant-anonymous onClick={onAnonymous}>Continue anonymously</Button>
          <Button variant="primary" size="sm" data-assistant-sign-in onClick={() => signInAndReturn()}>Sign in</Button>
        </>
      )}>
      <p className="t-body p-text-2">This app&apos;s assistant runs on its owner&apos;s model, and its owner can read your conversation. Sign in, or continue anonymously: this browser keeps your conversation for 30 days.</p>
    </Modal>
  );
}

/** Signed in on My access: the visitor accepts that the assistant runs on the owner's model, who reads the chat. */
function LentSheet({ onClose, onContinue }: { onClose: () => void; onContinue: () => void }) {
  return (
    <Modal title="Its owner can read this chat" width="md" onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
          <Button variant="primary" size="sm" data-assistant-continue onClick={onContinue}>Continue</Button>
        </>
      )}>
      <p className="t-body p-text-2">This app&apos;s assistant runs on its owner&apos;s model, and its owner can read your conversation with it. Nothing you asked was sent yet.</p>
    </Modal>
  );
}

/** The app's assistant on the visitor's own models needs their account: they sign in, and land back here. */
function SignInSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Sign in to use its assistant" width="md" onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
          <Button variant="primary" size="sm" data-assistant-sign-in onClick={() => signInAndReturn()}>Sign in</Button>
        </>
      )}>
      <p className="t-body p-text-2">This app&apos;s assistant answers on your own models, and its owner can&apos;t read your conversation in Kinu. Sign in to talk to it.</p>
    </Modal>
  );
}

/** A share that names people, entered signed out: its visitor signs in and lands back here. */
function SignInToOpen() {
  return (
    <main data-shared-sign-in className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="t-body max-w-sm p-text-2">This slate is shared with people by name. Sign in to open it.</p>
      <Button variant="primary" size="md" onClick={() => signInAndReturn()}>Sign in</Button>
    </main>
  );
}

export default function LiveSharePage() {
  const { workspace = "", share = "" } = useParams();
  // Null once read: no one is signed in to open it.
  const open = useCallback(() => openLiveShare({ workspace, share }), [workspace, share]);
  const { resource } = useAsyncResource(open);
  const opened = resource.status === "ready" ? resource.value : null;
  // How the share lends as last read: at load, then each time its page asks again.
  const [mode, setMode] = useState<ShareMode | null>(null);
  const lends = mode ?? opened?.mode ?? null;
  const signedOut = resource.status === "ready" && resource.value === null;
  const err = resource.status === "error" ? resource.message : null;

  return (
    <Surface look="page" className="flex h-dvh flex-col p-text">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b p-border px-4">
        <a href="/" aria-label="Kinu home" className="flex shrink-0 items-center"><KinuLogo /></a>
        <span className="t-item min-w-0 flex-1 truncate" data-shared-title>{opened?.title ?? "Shared slate"}</span>
        {lends === "owner" && <span className="t-meta min-w-0 p-text-3" data-shared-lent>Its assistant runs on its owner&apos;s model, and they can read your chat with it.</span>}
      </header>
      {opened !== null && <SharedSlate workspace={workspace} share={share} opened={opened} onMode={setMode} />}
      {signedOut && <SignInToOpen />}
      {opened === null && !signedOut && err === null && <div className="flex flex-1 items-center justify-center"><Loader size="base" /></div>}
      {err !== null && <main className="mx-auto w-full max-w-3xl px-6 py-8"><Notice tone="danger">{err}</Notice></main>}
    </Surface>
  );
}
