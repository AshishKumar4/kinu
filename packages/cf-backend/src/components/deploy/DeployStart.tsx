/** Start: what deploying here makes and costs, and the sign-in to Cloudflare that begins it. Nothing is read yet. */
import { useState, type ReactNode } from "react";
import { CloudflareButton, CloudflareSaid, DeployShell, OnCloudflare, WhatGetsMade, openOnCloudflare } from "@/components/deploy/DeployParts";
import { InlineAction } from "@/components/ui/InlineAction";

/** Why the last sign-in came back without access, in Cloudflare's words (`?error`, `?error_description`). */
export interface DeclinedSignIn {
  readonly error: string;
  readonly description: string;
}

/** Where the landing shows how to run Kinu on your own computer. */
const LOCAL_INSTALL = "/#platform";

/** Cloudflare's sign-up, for a person with no Cloudflare account yet: made there, then continued here. */
const CLOUDFLARE_SIGN_UP = "https://dash.cloudflare.com/sign-up";

export function DeployStart({ declined, refusal, signingIn, onSignIn }: {
  declined: DeclinedSignIn | null;
  /** The sign-in could not begin here, in this Kinu's words (no OAuth client configured). */
  refusal: string | null;
  /** Cloudflare's sign-in window is open, the page waiting on it. */
  signingIn: boolean;
  onSignIn: () => void;
}) {
  // Cloudflare's sign-up window was opened from here: the card says to come back and continue.
  const [signingUp, setSigningUp] = useState(false);
  let said: ReactNode = null;

  if (declined !== null) {
    said = (
      <div data-deploy-refusal className="mt-5 space-y-2">
        <p className="t-public-body p-text">Cloudflare didn't give Kinu access, so nothing was made.</p>
        <CloudflareSaid words={{ message: declined.description === "" ? declined.error : `${declined.description} (${declined.error})` }} />
      </div>
    );
  } else if (refusal !== null) {
    said = <p role="alert" data-deploy-refusal className="mt-5 t-public-body p-danger">{refusal}</p>;
  }

  let aside: ReactNode = (
    <p data-deploy-no-account className="mt-4 t-public-body">
      No Cloudflare account? <InlineAction onClick={() => { openOnCloudflare("kinu-cloudflare-sign-up", CLOUDFLARE_SIGN_UP); setSigningUp(true); }}>Create one, free</InlineAction>, then come back here.
    </p>
  );

  if (signingIn) {
    aside = <div className="mt-5"><OnCloudflare doing="Sign in there and let Kinu in. This page moves on by itself when you do." onAgain={onSignIn} /></div>;
  } else if (signingUp) {
    aside = (
      <div className="mt-5">
        <OnCloudflare doing="Make your Cloudflare account there. This page stays where it is: come back and continue with it."
          onAgain={() => openOnCloudflare("kinu-cloudflare-sign-up", CLOUDFLARE_SIGN_UP)} />
      </div>
    );
  }

  return (
    <DeployShell dot={0} screen="start"
      footer={<CloudflareButton busy={signingIn} onClick={onSignIn}>{declined === null ? "Continue with Cloudflare" : "Sign in again"}</CloudflareButton>}>
      <div className="space-y-2">
        <p className="t-public-lede">A Kinu of your own, on your own Cloudflare account and private to you.</p>
        <p data-deploy-price className="t-public-body">Kinu runs on Cloudflare's Workers Paid plan, $5 a month.</p>
      </div>
      {aside}
      {said}
      <div className="mt-5"><WhatGetsMade name="kinu" domain={null} computer={false} mail={null} /></div>
      <p data-deploy-local className="mt-6 border-t p-border pt-4 t-meta">
        Or run Kinu on your own computer, with nothing else to set up. <a href={LOCAL_INSTALL} className="p-accent-fg hover:underline">How to install it</a>
      </p>
    </DeployShell>
  );
}
