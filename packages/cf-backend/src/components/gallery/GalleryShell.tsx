/**
 * A listed slate's page's frame. It is public: signed in, the app's own shell; signed out, a bar with the Kinu mark and
 * Sign in over the same page body (`VisitorShell`, which Explore's pages wear for a visitor too). A page asks
 * `useGallerySignedIn` whether Fork, Install and Star may act or must sign in first, and reads nothing of an account a
 * visitor does not have.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Outlet } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@/components/ui/Loader";
import { detach, showing } from "@kinu.run/core/obs";
import Layout from "@/components/layout";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { AccountProvider } from "@/hooks/use-account";
import { SignedInContext } from "@/hooks/use-gallery-signed-in";
import { signInAndReturn } from "@/lib/sign-in";
import { readSignedIn } from "@/lib/shared-api";
import { Surface } from "@/components/ui/Surface";

/** A visitor's frame: the Kinu mark and Sign in over the page body. */
export function VisitorShell() {
  return (
    <SignedInContext.Provider value={false}>
      <PublicShell />
    </SignedInContext.Provider>
  );
}

function PublicShell() {
  return (
    <Surface look="page" className="flex h-dvh flex-col p-text" data-gallery-public>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b p-border px-3 sm:px-4">
        <a href="/" aria-label="Kinu home" className="flex shrink-0 items-center"><KinuLogo /></a>
        <span className="ml-auto" />
        <Button variant="primary" size="sm" data-gallery-sign-in onClick={() => signInAndReturn()}>Sign in</Button>
      </header>
      <main className="min-h-0 flex-1"><Outlet /></main>
    </Surface>
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

  if (signedIn === null) return <Surface look="page" className="flex h-dvh items-center justify-center"><Loader size="base" /></Surface>;

  return signedIn ? <AccountProvider><Layout /></AccountProvider> : <VisitorShell />;
}
