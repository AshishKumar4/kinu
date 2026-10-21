/** Start: what deploying here makes and costs, and the sign-in to Cloudflare that begins it. Nothing is read yet. */
import type { ReactNode } from "react";
import { CloudflareButton, CloudflareSaid, DeployShell, WhatGetsMade } from "@/components/deploy/DeployParts";

/** Why the last sign-in came back without access, in Cloudflare's words (`?error`, `?error_description`). */
export interface DeclinedSignIn {
  readonly error: string;
  readonly description: string;
}

/** Where the landing shows how to run Kinu on your own computer. */
const LOCAL_INSTALL = "/#platform";

export function DeployStart({ declined, refusal, signingIn, onSignIn }: {
  declined: DeclinedSignIn | null;
  /** The sign-in could not begin here, in this Kinu's words (no OAuth client configured). */
  refusal: string | null;
  signingIn: boolean;
  onSignIn: () => void;
}) {
  let said: ReactNode = null;

  if (declined !== null) {
    said = (
      <div data-deploy-refusal className="mt-5 space-y-2">
        <p className="t-body p-text">Cloudflare didn't give Kinu access, so nothing was made.</p>
        <CloudflareSaid words={{ message: declined.description === "" ? declined.error : `${declined.description} (${declined.error})` }} />
      </div>
    );
  } else if (refusal !== null) {
    said = <p role="alert" data-deploy-refusal className="mt-5 t-body p-danger">{refusal}</p>;
  }

  return (
    <DeployShell dot={0} screen="start"
      footer={<CloudflareButton busy={signingIn} onClick={onSignIn}>{declined === null ? "Continue with Cloudflare" : "Sign in again"}</CloudflareButton>}>
      <div className="space-y-3 t-body">
        <p>Kinu on the web runs on Cloudflare. This sets up a Kinu of your own on your own Cloudflare account, private to you, and takes you through it one step at a time.</p>
        <p>It runs on Cloudflare's free plan. Computers for your agents are $5 a month, and only if you want them.</p>
      </div>
      {said}
      <div className="mt-5"><WhatGetsMade name="kinu" domain={null} computer={false} mail={null} /></div>
      <p data-deploy-local className="mt-6 border-t p-border pt-4 t-meta">
        Or run Kinu on your own computer, with nothing else to set up. <a href={LOCAL_INSTALL} className="p-accent hover:underline">How to install it</a>
      </p>
    </DeployShell>
  );
}
