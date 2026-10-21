/**
 * `/shared/live/:workspace/:share`: where a live share is used, and the address its link and its Gallery listing give.
 * A public share opens to anyone; one that names people signs its visitor in first. The visitor is handed the share's
 * ticket where it needs one, and shown the share's host in a frame under a thin bar of Kinu's own. The page is the top of the slate's
 * window, so it runs the slate's personal parts as this visitor and opens the decisions they lead to here, where the
 * slate's script cannot cover them (docs/SLATE-SHARING-NIMBUS.md §3). The host sits on a subdomain of the app's own
 * site, so the ticket's cookie reaches it inside the frame.
 */
import { showing, detach } from "@kinu.run/core/obs";
import { Button } from "@/components/ui/Button";
import { slateFrameSrc, type LiveShareOpen } from "@kinu.run/core";
import { Effect } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { useSlateHostContext } from "@/components/slates/InlineSlate";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { usePartHost } from "@/hooks/use-part-host";
import { openLiveShare } from "@/lib/shared-api";
import { signInAndReturn } from "@/lib/sign-in";

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

  return (
    <>
      <iframe ref={frame} src={src} title={opened.title} data-shared-slate={opened.slate} className="block min-h-0 w-full flex-1 border-0" />
      {decision}
    </>
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
  const [opened, setOpened] = useState<LiveShareOpen | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => openLiveShare({ workspace, share })), (answer) => {
        if (!live) return;

        if (answer === null) setSignedOut(true);
        else setOpened(answer);
      }),
      showing((chain) => { if (live) setErr(chain); }),
    ));

    return () => { live = false; };
  }, [workspace, share]);

  return (
    <div className="flex h-dvh flex-col p-bg p-text">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b p-border px-4">
        <a href="/" aria-label="Kinu home" className="flex shrink-0 items-center"><KinuLogo /></a>
        <span className="t-item min-w-0 flex-1 truncate" data-shared-title>{opened?.title ?? "Shared slate"}</span>
      </header>
      {opened !== null && <SharedSlate workspace={workspace} opened={opened} />}
      {signedOut && <SignInToOpen />}
      {opened === null && !signedOut && err === null && <div className="flex flex-1 items-center justify-center"><Loader size="base" /></div>}
      {err !== null && <main className="mx-auto w-full max-w-3xl px-6 py-8"><div className="t-meta p-notice-danger rounded-md px-3 py-2">{err}</div></main>}
    </div>
  );
}
