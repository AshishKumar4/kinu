/**
 * The Google connection: one grant to Gmail, Calendar, Drive (its Docs, Sheets and Slides) and contacts, which every
 * agent of the account reaches Google through. Shown where this deployment offers it: its operators, for now.
 */
import { useState } from "react";
import { GOOGLE_OAUTH_CRED_KEY, googleConnectPath, type ConnectEnded } from "@kinu.run/core";
import { beginConnect } from "@/lib/connect-window";
import { deleteCredential, googleConnection } from "@/lib/user-api";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { BrandMark } from "@/components/ui/BrandMark";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Status } from "@/components/ui/Status";
import { LoadFailure } from "@/components/ui/LoadFailure";

export function GoogleConnectionCard() {
  const { resource, reload } = useAsyncResource(googleConnection);
  const read = lastValue(resource);
  // How the last connect or disconnect ended, in Google's or Kinu's words: the finish page closed with the only copy.
  const [said, setSaid] = useState<{ readonly tone: "danger" | "warning"; readonly text: string } | null>(null);
  const { ask, dialog } = useConfirmation();

  // A read that failed with nothing shown yet says so, with a retry: hidden, the card could never be reached again.
  if (read === null && resource.status === "error") return <LoadFailure what="your Google connection" message={resource.message} onRetry={reload} />;

  if (read === null || !read.available) return null;
  const { connection } = read;

  const connect = () => {
    setSaid(null);
    const started = beginConnect();

    started.start(googleConnectPath(started.id), (ended: ConnectEnded) => {
      if (ended.error !== null) setSaid({ tone: "danger", text: `Google did not connect: ${ended.error}` });
      reload();
    });
  };

  const leave = (revoke: boolean) => async () => {
    const { unrevoked } = await deleteCredential(GOOGLE_OAUTH_CRED_KEY, revoke);

    setSaid(unrevoked === null ? null : { tone: "warning", text: `Google is disconnected from Kinu but not revoked. ${unrevoked}` });
    reload();
  };

  const disconnect = () => ask({
    title: "Disconnect Google?",
    body: "Your agents lose Gmail, Calendar, Drive and contacts. Disconnect removes Kinu's copy of the sign-in; revoking also asks Google to end it.",
    action: "Disconnect", failed: "Could not disconnect",
    run: leave(false),
    alternate: { action: "Disconnect and revoke at Google", run: leave(true) },
  });

  return (
    <div className="space-y-3 px-4 py-3" data-google-connection={connection === null ? "absent" : "connected"}>
      <div className="t-meta flex flex-wrap items-center gap-x-2 gap-y-1">
        <BrandMark brand="google" size={13} bare />
        <span className="t-item p-text">Google</span>
        <span className="t-meta p-text-3">Gmail, Calendar, Drive, contacts</span>
        <span className="ml-auto flex items-center gap-2">
          {connection === null
            ? <Button size="sm" onClick={connect} data-connect-google>Connect Google</Button>
            : (
              <>
                <Status tone="success">Connected</Status>
                <span className="t-meta p-text-3">as {connection.account}</span>
                <Button variant="danger" size="sm" onClick={disconnect} aria-label="Disconnect Google">Disconnect</Button>
              </>
            )}
        </span>
      </div>
      {said !== null && <Notice tone={said.tone} data-google-said>{said.text}</Notice>}
      {dialog}
    </div>
  );
}
