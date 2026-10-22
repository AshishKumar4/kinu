import { useState } from "react";
import { cloudflareConnectPath, type ConnectEnded } from "@kinu.run/core";
import { beginConnect } from "@/lib/connect-window";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";

interface CloudflareAIConnectNoticeProps {
  /** Rereads what the connection changes, once the connect has connected. */
  onConnected: () => void;
  message?: string;
  action?: string;
}

/** Runs a Cloudflare connect from a click: `onConnected` once it connected, `onFailed` with why it did not. */
export function connectCloudflare(onConnected: () => void, onFailed: (error: string) => void): void {
  const connect = beginConnect();

  connect.start(cloudflareConnectPath(connect.id), (ended: ConnectEnded) => {
    if (ended.error === null) onConnected();
    else onFailed(ended.error);
  });
}

export function CloudflareAIConnectNotice({
  onConnected,
  message = "Cloudflare Workers AI is not connected for this account.",
  action = "Connect Cloudflare Workers AI",
}: CloudflareAIConnectNoticeProps) {
  // Why the last connect did not connect, as Cloudflare or Kinu said it: its finish page closed with the only copy.
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <Notice tone="warning" action={
      <Button size="sm" className="shrink-0" data-connect-cloudflare onClick={() => { setFailed(null); connectCloudflare(onConnected, setFailed); }}>
        {action}
      </Button>}>
      <p>{message}</p>
      {failed !== null && <p data-connect-failed className="p-danger">Cloudflare did not connect: {failed}</p>}
    </Notice>
  );
}
