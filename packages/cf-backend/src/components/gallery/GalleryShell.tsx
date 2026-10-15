/**
 * The Gallery's frame. It is public discovery: signed in, the app's own shell; signed out, a bar with the Kinu mark and
 * Sign in over the same page body. Its pages ask `useGallerySignedIn` whether Fork and Star may act or must sign in first.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@cloudflare/kumo";
import { detach, showing } from "@kinu.run/core/obs";
import Layout from "@/components/layout";
import { FilledButton } from "@/components/ui/FilledButton";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { AccountProvider } from "@/hooks/use-account";
import { signInAndReturn } from "@/hooks/use-room-frames";
import { readSignedIn } from "@/lib/shared-api";

const SignedInContext = createContext(true);

export function useGallerySignedIn(): boolean {
  return useContext(SignedInContext);
}

function PublicShell() {
  return (
    <div data-gallery-public className="flex h-dvh flex-col p-bg p-text">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b p-border px-3 sm:px-4">
        <a href="/" aria-label="Kinu home" className="flex shrink-0 items-center"><KinuLogo /></a>
        <span className="ml-auto" />
        <FilledButton data-gallery-sign-in onClick={() => signInAndReturn()}>Sign in</FilledButton>
      </header>
      <main className="min-h-0 flex-1"><Outlet /></main>
    </div>
  );
}

export default function GalleryShell() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => readSignedIn()), (answer) => { if (current) setSignedIn(answer); }),
      showing((chain) => { if (current) setFailure(chain); }),
    ));

    return () => { current = false; };
  }, [tries]);

  if (failure !== null) {
    return <div className="p-6"><LoadFailure what="the Gallery" message={failure} onRetry={() => { setFailure(null); setTries((count) => count + 1); }} /></div>;
  }

  if (signedIn === null) return <div className="flex h-dvh items-center justify-center p-bg"><Loader size="base" /></div>;

  return (
    <SignedInContext.Provider value={signedIn}>
      {signedIn ? <AccountProvider><Layout /></AccountProvider> : <PublicShell />}
    </SignedInContext.Provider>
  );
}
