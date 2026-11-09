/**
 * `/shared/live/:workspace/:share`: where a live share is used, and the address its link and its Gallery listing give.
 * A public share opens to anyone; one that names people signs its visitor in first. The visitor is handed the share's
 * ticket where it needs one, and shown the share's host in a frame under a thin bar of Kinu's own. The page is the top of the slate's
 * window, so it runs the slate's personal parts as this visitor and opens the decisions they lead to here, where the
 * slate's script cannot cover them (docs/SLATE-SHARING-NIMBUS.md §3). The host sits on a subdomain of the app's own
 * site, so the ticket's cookie reaches it inside the frame.
 */
import { Button } from "@/components/ui/Button";
import { readSlateIdentityAsk, slateFrameSrc, VIEWER_EXCHANGE_PATH, type LiveShareOpen } from "@kinu.run/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useParams } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { useSlateHostContext } from "@/components/slates/InlineSlate";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { usePartHost } from "@/hooks/use-part-host";
import { openLiveShare } from "@/lib/shared-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { signInAndReturn } from "@/lib/sign-in";
import { Notice } from "@/components/ui/Notice";
import { Surface } from "@/components/ui/Surface";

/**
 * The share's slate, framed with its host context as the owner's previews frame it, so its page knows the app it answers
 * to and frames its parts from; and the parts it hosts, a decision opening over it.
 */
function SharedSlate({ workspace, opened }: { workspace: string; opened: LiveShareOpen }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const decision = usePartHost({ workspace, slate: opened.slate, title: opened.title, slateFrame: frame });
  const context = useSlateHostContext("pane", "window" in globalThis ? window.innerWidth : 0);
  const contextRef = useRef(context);
  // A snapshot, as the previews' is: a theme flip after it never reloads the slate.
  const src = useMemo(() => slateFrameSrc(opened.url, contextRef.current), [opened.url]);
  const [asking, setAsking] = useState(false);
  // Where the frame goes once its visitor continues anonymously: the share's host gives this browser an id, then the app.
  const [anonymous, setAnonymous] = useState<string | null>(null);

  useEffect(() => {
    const origin = new URL(opened.url).origin;

    const heard = (event: MessageEvent) => {
      if (readSlateIdentityAsk(event, frame.current?.contentWindow, origin)) setAsking(true);
    };

    window.addEventListener("message", heard);

    return () => window.removeEventListener("message", heard);
  }, [opened.url]);

  const continueAnonymously = (): void => {
    const exchange = new URL(VIEWER_EXCHANGE_PATH, opened.url);

    exchange.searchParams.set("anonymous", "1");
    setAnonymous(slateFrameSrc(exchange.toString(), contextRef.current));
    setAsking(false);
  };

  return (
    <>
      <iframe ref={frame} src={anonymous ?? src} title={opened.title} data-shared-slate={opened.slate} className="block min-h-0 w-full flex-1 border-0" />
      {decision}
      {asking && <IdentitySheet onClose={() => setAsking(false)} onAnonymous={continueAnonymously} />}
    </>
  );
}

/** What a shared app asked of its visitor needs to know who asks: they sign in, or go on as this browser, anonymously. */
function IdentitySheet({ onClose, onAnonymous }: { onClose: () => void; onAnonymous: () => void }) {
  return (
    <Modal title="Say who's asking" width="md" onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
          <Button variant="secondary" size="sm" onClick={onAnonymous}>Continue anonymously</Button>
          <Button variant="primary" size="sm" onClick={() => signInAndReturn()}>Sign in</Button>
        </>
      )}>
      <p className="t-body p-text-2">This app talks to its owner&apos;s agent for you, and the owner sees the conversation. Sign in, or continue anonymously: this browser keeps your conversation for 30 days.</p>
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
  const signedOut = resource.status === "ready" && resource.value === null;
  const err = resource.status === "error" ? resource.message : null;

  return (
    <Surface look="page" className="flex h-dvh flex-col p-text">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b p-border px-4">
        <a href="/" aria-label="Kinu home" className="flex shrink-0 items-center"><KinuLogo /></a>
        <span className="t-item min-w-0 flex-1 truncate" data-shared-title>{opened?.title ?? "Shared slate"}</span>
      </header>
      {opened !== null && <SharedSlate workspace={workspace} opened={opened} />}
      {signedOut && <SignInToOpen />}
      {opened === null && !signedOut && err === null && <div className="flex flex-1 items-center justify-center"><Loader size="base" /></div>}
      {err !== null && <main className="mx-auto w-full max-w-3xl px-6 py-8"><Notice tone="danger">{err}</Notice></main>}
    </Surface>
  );
}
